import { PgBoss } from 'pg-boss';
import { createHash } from 'node:crypto';
import { Cognition, hasCognitiveDemand, type CognitiveResult } from '../cognition/index.js';
import type { LifeKernel } from '../kernel/index.js';
import type { CognitiveResultCoordinator } from '../host/cognitive-result.js';

const queueFor = (petId: string) => 'life-wakeup-' + createHash('sha256').update(petId).digest('hex').slice(0, 24);
const JOB_SCHEMA = 'silicon_genesis_jobs';
/** Atomically lease due work and coalesce event IDs up to cursor. finish must preserve later events. */
export interface WakeCoordinator {
  claim(petId: string, now: string): Promise<{ cursor: string; changed: boolean } | null>;
  finish(petId: string, cursor: string, nextWakeAt: string): Promise<void>;
  release(petId: string, cursor: string): Promise<void>;
}
/** Must invoke the authoritative body/action adapter, never fabricate outcomes. */
export interface DeterministicActivity { run(petId: string, signal: AbortSignal, options: { allowAutonomous: boolean }): Promise<void> }
export interface SchedulerOptions {
  connectionString: string;
  petId: string;
  intervalSeconds: number;
  signal: AbortSignal;
  wakeCoordinator: WakeCoordinator;
  deterministic: DeterministicActivity;
  resultCoordinator: CognitiveResultCoordinator;
  development?: {run(petId:string,signal:AbortSignal):Promise<void>};
  reminders?: {run(petId:string,signal:AbortSignal):Promise<void>};
  whisper?: {settings():{automaticWhispers:boolean;whisperIntervalSec:number};run(petId:string,signal:AbortSignal):Promise<void>};
  cognitiveIntervalSeconds?: number;
  idle?: {snapshot():{seconds:number;generation:number}|undefined};
  /** Must establish exclusive ownership and disable old autonomous writers before start. */
  assertExclusive: () => Promise<void>;
  onResult?: (result: CognitiveResult) => void;
}

/** The database queue deduplicates wakeups; it never executes proposed actions. */
export class LifeScheduler {
  private readonly boss: PgBoss;
  private readonly queue: string;
  private readonly controller = new AbortController();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private pendingSend?: Promise<void>;
  private bossStarted = false;
  private started = false;
  private stopped = false;
  private nextWhisperAt = 0;
  private readonly ownershipLost = () => { void this.stop().catch(() => this.report({ status: 'degraded', reason: 'stop_failed' })); };
  constructor(private readonly kernel: LifeKernel, private readonly cognition: Cognition, private readonly options: SchedulerOptions) {
    if (!options.resultCoordinator || !options.connectionString || !options.petId || !Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 10 || (options.cognitiveIntervalSeconds !== undefined && (!Number.isInteger(options.cognitiveIntervalSeconds) || options.cognitiveIntervalSeconds < 300))) throw new Error('Invalid scheduler configuration');
    this.queue = queueFor(options.petId);
    this.boss = new PgBoss({ connectionString: options.connectionString, schema: JOB_SCHEMA });
    this.boss.on('error', () => { if (!this.stopped) this.report({ status: 'degraded', reason: 'wakeup_unavailable' }); });
    if (options.signal.aborted) { this.stopped = true; this.controller.abort(); }
    else options.signal.addEventListener('abort', this.ownershipLost, { once: true });
  }
  async start(): Promise<void> {
    if (this.started || this.starting || this.stopped) throw new Error('Scheduler cannot be started');
    const startup = this.startInternal();
    this.starting = startup;
    try { await startup; } finally { this.starting = undefined; }
  }
  private async startInternal(): Promise<void> {
    let attemptedBossStart = false;
    try {
      await this.options.assertExclusive();
      if (this.stopped) throw new Error('Scheduler stopped');
      attemptedBossStart = true;
      await this.boss.start();
      this.bossStarted = true;
      if (this.stopped) throw new Error('Scheduler stopped');
      // exclusive policy admits at most one pending, retrying or active job per key.
      await this.boss.createQueue(this.queue, { policy: 'exclusive' });
      const queue = await this.boss.getQueue(this.queue);
      if (!queue || queue.policy !== 'exclusive') throw new Error('Existing wakeup queue is not exclusive');
      if (this.stopped) throw new Error('Scheduler stopped');
      await this.boss.work<{ petId: string }>(this.queue, async jobs => {
        for (const job of jobs) {
          if (this.controller.signal.aborted) return;
          if (job.data.petId !== this.options.petId) throw new Error('Incorrect pet wakeup');
          const claim = await this.options.wakeCoordinator.claim(this.options.petId, new Date().toISOString());
          if (!claim) continue;
          try {
            if (this.controller.signal.aborted) throw new Error('Scheduler stopped');
            if(this.options.reminders)await this.options.reminders.run(this.options.petId,this.controller.signal);
            const before = await this.kernel.getState(this.options.petId);
            if (this.controller.signal.aborted) throw new Error('Scheduler stopped');
            await this.options.deterministic.run(this.options.petId, this.controller.signal, { allowAutonomous: !before.constraints.paused });
            if (this.controller.signal.aborted) throw new Error('Scheduler stopped');
            const resumed=await this.options.resultCoordinator.resume(this.options.petId,this.controller.signal);
            const state = await this.kernel.getState(this.options.petId);
            if(!state.constraints.paused && this.options.development)await this.options.development.run(this.options.petId,this.controller.signal);
            const idleBefore=this.options.idle?.snapshot();
            const ongoing=(state.cognitivePlans||[]).some(p=>p.status==='active'||p.status==='failed') || state.goals.some(g=>g.status==='active');
            if (!resumed && !state.constraints.paused && (claim.changed || hasCognitiveDemand(state) || ongoing || (idleBefore?.seconds??0)>=120) && await this.options.resultCoordinator.claimCognition(this.options.petId,this.options.cognitiveIntervalSeconds??1800,this.controller.signal)) {
              const fresh=await this.kernel.getState(this.options.petId);
              const result = await this.cognition.propose(fresh, this.controller.signal, () => this.kernel.getState(this.options.petId));
              if (result.status === 'proposed' && !this.controller.signal.aborted) {
                const idleAfter=this.options.idle?.snapshot();
                const wantsWalk=result.proposal?.actionType==='body.activity' || result.candidates.plan.some(step=>step.actionType==='body.activity');
                // The system input or a direct interaction may have changed while the model was thinking.
                if(!wantsWalk || (result.proposal?.actionType==='body.activity' && !result.candidates.plan.some(step=>step.actionType==='body.activity') && idleBefore && idleAfter && idleBefore.seconds>=120 && idleAfter.seconds>=120 && idleBefore.generation===idleAfter.generation))await this.options.resultCoordinator.accept(this.options.petId,result,this.controller.signal);
              }
              this.report(result);
            }
            if (this.controller.signal.aborted) throw new Error('Scheduler stopped');
            await this.options.wakeCoordinator.finish(this.options.petId, claim.cursor, new Date(Date.now() + this.options.intervalSeconds * 1000).toISOString());
          } catch (error) {
            await this.options.wakeCoordinator.release(this.options.petId, claim.cursor);
            throw error;
          }
        }
      });
      if (this.stopped) throw new Error('Scheduler stopped');
      this.started = true;
      await this.pump();
      if (this.stopped) throw new Error('Scheduler stopped');
    } catch (error) {
      if (attemptedBossStart) { try { await this.boss.stop({ graceful: true }); } finally { this.bossStarted = false; } }
      this.started = false;
      throw error;
    }
  }
  private report(result: CognitiveResult): void { try { this.options.onResult?.(result); } catch { /* observers cannot alter job state */ } }
  private async pump(): Promise<void> {
    if (this.stopped || !this.started) return;
    const sending = (async () => {
      try {
        // Exclusive queue + singletonKey deduplicates across restarts and retries.
        await this.boss.send(this.queue, { petId: this.options.petId }, { singletonKey: this.options.petId, retryLimit: 3 });
      } catch { if (!this.stopped) this.report({ status: 'degraded', reason: 'wakeup_unavailable' }); }
    })();
    this.pendingSend = sending;
    try { await sending; } finally { if (this.pendingSend === sending) this.pendingSend = undefined; }
    // This independent timer repairs the wakeup after a job exhausts retries.
    if (!this.stopped && this.started) this.timer = setTimeout(() => { void this.pump(); }, this.options.intervalSeconds * 1000);
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.controller.abort();
    this.options.signal.removeEventListener('abort', this.ownershipLost);
    if (this.timer) clearTimeout(this.timer);
    const stop = (async () => {
      if (this.starting) { try { await this.starting; } catch { /* startup performs cleanup */ } }
      if (this.pendingSend) await this.pendingSend;
      if (this.bossStarted) { await this.boss.stop({ graceful: true }); this.bossStarted = false; }
      this.started = false;
    })();
    this.stopping = stop;
    return stop;
  }
}
