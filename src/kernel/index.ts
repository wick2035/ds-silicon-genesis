import {applyGoalProposal} from './goal-lifecycle.js';
import {rebuildOutcomeDevelopment} from './outcome-development.js';
import type { ActionProposal, ActionReceipt, ActionStatus, Belief, CognitiveWorkspace, KernelStore, LifeEvent, LifeState, Memory, Relationship, StrategyObservation, Goal, DevelopmentRecord } from './types.js';
export * from './types.js';

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const same = (a: unknown, b: unknown): boolean => {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};
const activeSource = (state: LifeState, id: string) => !Object.prototype.hasOwnProperty.call(state.invalidSources, id);

export function createInitialState(petId: string, now: string): LifeState {
  assert(nonempty(petId) && validDate(now), 'Invalid pet ID or time');
  return { petId, version: 0, identity: { name: '大肥鱼', role: '幼年蓝鲸娘' }, selfModel: { personality: [], preferences: [], abilities: [], limitations: [], values: [], interests: [], habits: [], autobiography: [] }, worldModel: { facts: [] }, body: { energy: 80, stamina: 80, hunger: 20, hydration: 80, comfort: 70, pain: 0, sleeping: false, restrained: false, injured: false }, emotions: { joy: 50, sadness: 10, anger: 10, fear: 10, love: 64, aversion: 5, longing: 24, curiosity: 60, loneliness: 20 }, goals: [], commitments: [], memories: [], beliefs: [], observations: [], relationships: [], events: [], actions: [], receipts: [], invalidSources: {}, constraints: { paused: true, permissions: [], capabilities: [], remainingBudget: 0 }, lastPhysiologyAt: now };
}

export function workspace(state: LifeState): CognitiveWorkspace {
  return copy({ petId: state.petId, stateVersion: state.version, identity: state.identity, legacyContext:state.legacyContext, selfModel: state.selfModel && Object.fromEntries(Object.entries(state.selfModel).map(([key, records]) => [key, (records as DevelopmentRecord[]).filter((item: DevelopmentRecord) => item.valid && item.sourceIds.every((id: string) => activeSource(state, id)))])) as unknown as LifeState['selfModel'], worldModel: state.worldModel && { facts: state.worldModel.facts.filter(item => item.valid && item.sourceIds.every(id => activeSource(state, id))) }, body: state.body, emotions: state.emotions, activeGoals: state.goals.filter(g => g.status === 'active' && g.sourceIds.every(id => activeSource(state, id))), commitments: state.commitments.filter(c => c.status === 'open' && c.sourceIds.every(id => activeSource(state, id))), relevantMemories: state.memories.filter(m => m.valid && m.sourceIds.every(id => activeSource(state, id))), beliefs: state.beliefs.filter(b => b.valid && b.sourceIds.every(id => activeSource(state, id))), relationships: state.relationships, constraints: state.constraints });
}

export function rankGoals(state: LifeState): Array<{ goalId: string; score: number }> {
  return state.goals.filter(g => g.status === 'active' && g.sourceIds.every(id => activeSource(state, id))).map(g => {
    const commitment = state.commitments.some(c => c.status === 'open' && c.sourceIds.some(id => g.sourceIds.includes(id))) ? 15 : 0;
    const need = g.kind === 'food' ? state.body.hunger * .35 : g.kind === 'rest' ? (100 - state.body.energy) * .35 : g.kind === 'explore' ? state.emotions.curiosity * .15 : 0;
    const dad = state.relationships.find(r => r.personId === 'dad');
    const cost = g.kind === 'work' ? (100 - state.body.stamina) * .3 + state.body.pain * .3 + Math.max(0,50-(dad?.trust ?? 50))*.4 + Math.min(15,(dad?.outstandingWages ?? 0)*.01) : 0;
    return { goalId: g.id, score: g.priority + g.urgency + commitment + need - cost };
  }).sort((a, b) => b.score - a.score || a.goalId.localeCompare(b.goalId));
}

/** Laplace-smoothed observed success rate; no fabricated model scores. */
export function strategyScore(state: LifeState, strategy: string, context: string): { score: number; samples: number } {
  const relevant = state.observations.filter(x => x.valid && x.strategy === strategy && x.context === context && x.sourceIds.every(id => activeSource(state, id)));
  const unpaid = strategy==='labor.step' && context==='execution' ? state.events.filter(e=>e.type==='social.labor.unpaid' && ['observed','verified'].includes(e.evidenceLevel) && activeSource(state,e.eventId)).length : 0;
  return { score: (relevant.filter(x => x.success).length + 1) / (relevant.length + unpaid + 2), samples: relevant.length + unpaid };
}

export function validateProposal(state: LifeState, proposal: ActionProposal): void {
  assert(proposal && nonempty(proposal.id) && nonempty(proposal.petId) && nonempty(proposal.actionType), 'Invalid action identity');
  assert(proposal.petId === state.petId && proposal.expectedStateVersion === state.version, 'Stale or cross-pet proposal');
  assert(!state.constraints.paused, 'Autonomy is paused');
  assert(Number.isFinite(proposal.priority) && proposal.priority >= 0 && proposal.priority <= 100, 'Invalid priority');
  assert(['interruptible', 'safe-point', 'noninterruptible'].includes(proposal.interruptPolicy), 'Invalid interrupt policy');
  assert(proposal.parameters !== null && typeof proposal.parameters === 'object' && !Array.isArray(proposal.parameters), 'Invalid action parameters');
  assert(Array.isArray(proposal.requiredCapabilities) && proposal.requiredCapabilities.includes(proposal.actionType) && proposal.requiredCapabilities.every(nonempty), 'Action type requires its registered capability');
  assert(Array.isArray(proposal.sourceIds) && proposal.sourceIds.every(id => nonempty(id) && activeSource(state, id) && state.events.some(e => e.eventId === id)), 'Unknown or invalid action source');
  if (proposal.goalId) assert(state.goals.some(g => g.id === proposal.goalId && g.status === 'active'), 'Goal is not active');
  for (const name of proposal.requiredCapabilities) {
    const capability = state.constraints.capabilities.find(c => c.name === name && c.enabled);
    assert(capability, `Capability unavailable: ${name}`);
    assert(!capability.requiresPermission || state.constraints.permissions.includes(capability.requiresPermission), `Permission denied: ${name}`);
    if (capability.physical) {
      const limits = capability.name==='service.eat-rice' ? {allowInjured:true,minStamina:-1,maxPain:101,...capability.bodyLimits} : capability.bodyLimits ?? {};
      assert((limits.allowSleeping || !state.body.sleeping) && (limits.allowRestrained || !state.body.restrained) && (limits.allowInjured || !state.body.injured) && state.body.pain < (limits.maxPain ?? 80) && state.body.stamina > (limits.minStamina ?? 5), 'Physical action blocked by capability body limits');
    }
  }
}

function validateEvent(event: LifeEvent): void {
  assert(event && nonempty(event.eventId) && !['__proto__', 'constructor', 'prototype'].includes(event.eventId) && nonempty(event.petId) && nonempty(event.type) && nonempty(event.source), 'Invalid event');
  assert(validDate(event.occurredAt) && validDate(event.receivedAt), 'Invalid event time');
  assert(['observed', 'verified', 'reported', 'inferred', 'fictional'].includes(event.evidenceLevel), 'Invalid evidence level');
}
/** Recompute from observed evidence so deleted sources cannot keep affecting trust. */
export function rebuildRelationships(state: Pick<LifeState,'events'|'invalidSources'|'relationships'>): void {
  const result: Record<string, Relationship> = Object.create(null);
  const active = (id:string) => !Object.prototype.hasOwnProperty.call(state.invalidSources,id);
  for (const event of [...state.events].sort((a,b) => Date.parse(a.occurredAt)-Date.parse(b.occurredAt))) {
    if (!active(event.eventId) || !['observed','verified'].includes(event.evidenceLevel)) continue;
    const p = (event.payload ?? {}) as {personId?:unknown;trustDelta?:unknown;familiarityDelta?:unknown;amount?:unknown;outstanding?:unknown};
    const person = event.type === 'relationship.feedback' ? p.personId : event.actorId;
    if (!nonempty(person)) continue;
    let trust=0, familiarity=0;
    if (event.type === 'relationship.feedback') {
      trust = typeof p.trustDelta === 'number' && Number.isFinite(p.trustDelta) ? Math.max(-10, Math.min(10,p.trustDelta)) : 0;
      familiarity = typeof p.familiarityDelta === 'number' && Number.isFinite(p.familiarityDelta) ? Math.max(-5, Math.min(5,p.familiarityDelta)) : 0;
    } else if (event.type === 'social.message') familiarity=.4;
    else if (event.type === 'social.care') { familiarity=.5; trust=.5; }
    else if (event.type === 'social.labor.confirmed') familiarity=.5;
    else if (event.type === 'social.labor.payment') { familiarity=.5; if (typeof p.amount==='number' && p.amount>0) trust=1; }
    else if (event.type !== 'social.labor.unpaid') continue;
    const rel = result[person] ?? {personId:person,trust:50,familiarity:0,sourceIds:[],openCommitments:0,outstandingWages:0};
    rel.trust=clamp(rel.trust+trust); rel.familiarity=clamp(rel.familiarity+familiarity);
    if (event.type === 'social.labor.confirmed') rel.openCommitments=(rel.openCommitments ?? 0)+1;
    if ((event.type === 'social.labor.payment' || event.type === 'social.labor.unpaid') && typeof p.outstanding==='number' && Number.isFinite(p.outstanding) && p.outstanding>=0) {
      rel.outstandingWages=p.outstanding;
      if (event.type === 'social.labor.payment' && p.outstanding===0) rel.openCommitments=Math.max(0,(rel.openCommitments ?? 0)-1);
    }
    rel.sourceIds.push(event.eventId); result[person]=rel;
  }
  state.relationships=Object.values(result);
}
export function invalidateDependents(state: LifeState): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of state.events) {
      const dependencies = (event.payload && typeof event.payload==='object' && Array.isArray((event.payload as {sourceIds?:unknown}).sourceIds)) ? (event.payload as {sourceIds:string[]}).sourceIds : [];
      if (((event.causationId && !activeSource(state, event.causationId)) || dependencies.some((id:string)=>!activeSource(state,id))) && activeSource(state, event.eventId)) { state.invalidSources[event.eventId] = 'Causation invalidated'; changed = true; }
    }
    const development = state.selfModel ? Object.values(state.selfModel).flat() : [];
    for (const item of [...state.memories, ...state.beliefs, ...state.observations, ...development, ...(state.worldModel?.facts ?? [])]) {
      if (item.valid && item.sourceIds.some((id: string) => !activeSource(state, id))) { item.valid = false; state.invalidSources[item.id] = 'Dependency invalidated'; changed = true; }
    }
  }
  rebuildRelationships(state);
  rebuildOutcomeDevelopment(state);
}

export class LifeKernel {
  readonly #executorAuthority: object;
  constructor(private readonly store: KernelStore, executorAuthority: object) { assert(executorAuthority !== null && typeof executorAuthority === 'object', 'Executor authority is required'); this.#executorAuthority = executorAuthority; }
  async getState(petId: string): Promise<LifeState> { const state = await this.store.load(petId); assert(state && state.petId === petId, 'Life state not found'); return copy(state); }
  async setPaused(petId: string, paused: boolean): Promise<LifeState> {
    assert(typeof paused === 'boolean', 'Invalid pause setting');
    return this.update(petId, state => {
      if (state.constraints.paused === paused) return false;
      state.constraints.paused = paused;
      return true;
    });
  }
  private async update(petId: string, apply: (state: LifeState) => boolean): Promise<LifeState> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const state = await this.getState(petId); const version = state.version;
      if (!apply(state)) return state;
      state.version = version + 1;
      if (await this.store.commit(petId, version, state)) return copy(state);
    }
    throw new Error('Concurrent state update; retry');
  }
  async ingest(event: LifeEvent): Promise<LifeState> {
    validateEvent(event);
    return this.update(event.petId, state => {
      const old = state.events.find(e => e.eventId === event.eventId);
      if (old) { assert(same(old, event), 'Event ID reused with different content'); return false; }
      assert(activeSource(state, event.eventId), 'Invalidated event ID cannot be reused');
      state.events.push(copy(event));
      if (event.causationId && !activeSource(state, event.causationId)) state.invalidSources[event.eventId] = 'Causation invalidated';
      invalidateDependents(state); return true;
    });
  }
  async propose(proposal: ActionProposal): Promise<LifeState> {
    return this.update(proposal.petId, state => {
      const old = state.actions.find(a => a.id === proposal.id);
      if (old) { const { status: _s, createdAt: _c, updatedAt: _u, receiptId: _r, ...original } = old; assert(same(original, proposal), 'Action ID reused with different content'); return false; }
      validateProposal(state, proposal);
      const now = new Date().toISOString(); state.actions.push({ ...copy(proposal), status: 'PROPOSED', createdAt: now, updatedAt: now }); return true;
    });
  }
  async transition(petId: string, actionId: string, status: ActionStatus, expectedVersion: number): Promise<LifeState> {
    return this.update(petId, state => {
      const action = state.actions.find(a => a.id === actionId); assert(action, 'Action not found');
      if (action.status === status) return false;
      assert(state.version === expectedVersion, 'Stale action transition');
      const next: Partial<Record<ActionStatus, ActionStatus[]>> = { PROPOSED: ['VALIDATED', 'CANCELLED'], VALIDATED: ['PENDING', 'CANCELLED'], PENDING: ['DISPATCHED', 'CANCELLED'], DISPATCHED: ['UNKNOWN'] };
      assert(next[action.status]?.includes(status), 'Invalid action transition; terminal results require a receipt');
      if (status === 'VALIDATED' || status === 'PENDING' || status === 'DISPATCHED') validateProposal(state, { ...action, expectedStateVersion: state.version });
      action.status = status; action.updatedAt = new Date().toISOString(); return true;
    });
  }
  async receipt(receipt: ActionReceipt, authority: object): Promise<LifeState> {
    assert(authority === this.#executorAuthority, 'Executor authority required');
    assert(receipt && nonempty(receipt.receiptId) && nonempty(receipt.petId) && nonempty(receipt.actionId) && nonempty(receipt.source) && validDate(receipt.occurredAt), 'Invalid receipt');
    assert(['COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(receipt.status) && ['observed', 'verified'].includes(receipt.evidenceLevel), 'Invalid receipt status or evidence');
    assert(receipt.details !== null && typeof receipt.details === 'object' && !Array.isArray(receipt.details), 'Invalid receipt details');
    return this.update(receipt.petId, state => {
      const old = state.receipts.find(r => r.receiptId === receipt.receiptId);
      if (old) { assert(same(old, receipt), 'Receipt ID reused with different content'); return false; }
      const action = state.actions.find(a => a.id === receipt.actionId); assert(action, 'Action not found');
      assert(action.status === 'DISPATCHED' || (action.status === 'UNKNOWN' && receipt.status !== 'UNKNOWN'), 'Action is not awaiting reconciliation');
      state.receipts.push(copy(receipt)); action.status = receipt.status; action.receiptId = receipt.receiptId; action.updatedAt = receipt.occurredAt; return true;
    });
  }
  /** Persist only evidence-backed learning. At least two distinct real events support beliefs. */
  async recordLearning(petId: string, entry: Memory | Belief | StrategyObservation, kind: 'memory' | 'belief' | 'observation'): Promise<LifeState> {
    assert(entry && nonempty(entry.id) && Array.isArray(entry.sourceIds) && entry.sourceIds.length > 0 && entry.sourceIds.every(nonempty) && entry.valid === true, 'Invalid learning record');
    assert(!['__proto__', 'constructor', 'prototype'].includes(entry.id), 'Reserved record ID');
    return this.update(petId, state => {
      const target = kind === 'memory' ? state.memories : kind === 'belief' ? state.beliefs : state.observations;
      const previous = target.find(x => x.id === entry.id);
      if (previous) { assert(same(previous, entry), 'Learning ID reused with different content'); return false; }
      assert(activeSource(state, entry.id), 'Invalidated learning cannot be restored');
      const evidence = entry.sourceIds.map(id => state.events.find(e => e.eventId === id));
      assert(evidence.every(e => e && activeSource(state, e.eventId)), 'Learning requires valid source events');
      if (kind !== 'memory') assert(evidence.every(e => e && (e.evidenceLevel === 'observed' || e.evidenceLevel === 'verified')), 'Beliefs and strategy learning require real evidence');
      if (kind === 'belief') {
        const belief = entry as Belief;
        assert(nonempty(belief.subject) && nonempty(belief.value) && Number.isFinite(belief.confidence) && belief.confidence >= 0 && belief.confidence <= 1 && new Set(entry.sourceIds).size >= 2, 'Belief requires multiple sources and valid confidence');
        state.beliefs.push(copy(belief));
      } else if (kind === 'observation') {
        const observation = entry as StrategyObservation;
        assert(nonempty(observation.strategy) && nonempty(observation.context) && typeof observation.success === 'boolean', 'Invalid strategy observation');
        assert(evidence.some(e => e && state.receipts.some(r => r.receiptId === e.causationId && r.status !== 'UNKNOWN')), 'Strategy observation requires a real action receipt');
        state.observations.push(copy(observation));
      } else {
        const memory = entry as Memory;
        assert(nonempty(memory.content) && validDate(memory.createdAt) && ['episodic', 'semantic', 'procedural', 'autobiographical', 'social', 'commitment'].includes(memory.kind) && evidence.every(e => e && e.evidenceLevel === memory.evidenceLevel), 'Memory must preserve source evidence level');
        state.memories.push(copy(memory));
      }
      return true;
    });
  }
  async createGoal(petId: string, goal: Goal): Promise<LifeState> {
    assert(goal && nonempty(goal.id) && nonempty(goal.title) && nonempty(goal.kind) && goal.status === 'active' && Number.isFinite(goal.priority) && goal.priority >= 0 && goal.priority <= 100 && Number.isFinite(goal.urgency) && goal.urgency >= 0 && goal.urgency <= 100 && Array.isArray(goal.sourceIds) && goal.sourceIds.length > 0, 'Invalid goal');
    return this.update(petId, state => {
      const previous = state.goals.find(g => g.id === goal.id);
      if (previous) { assert(same(previous, goal), 'Goal ID reused'); return false; }
      assert(activeSource(state, goal.id) && goal.sourceIds.every(id => activeSource(state, id) && state.events.some(e => e.eventId === id)), 'Goal requires valid events');
      if (goal.parentId) assert(state.goals.some(g => g.id === goal.parentId && g.status === 'active') && goal.parentId !== goal.id, 'Parent goal is not active');
      state.goals.push(copy(goal)); return true;
    });
  }
  async changeGoal(petId: string, goalId: string, status: Goal['status'], expectedVersion: number, evidenceId?: string): Promise<LifeState> {
    return this.update(petId, state => {
      const goal = state.goals.find(g => g.id === goalId); assert(goal, 'Goal not found');
      if (goal.status === status) return false;
      assert(state.version === expectedVersion && goal.sourceIds.every(id => activeSource(state, id)), 'Stale or invalid goal');
      const allowed: Record<Goal['status'], Goal['status'][]> = { active: ['paused', 'deferred', 'completed', 'failed', 'abandoned'], paused: ['active', 'deferred', 'abandoned'], deferred: ['active', 'paused', 'abandoned'], completed: [], failed: ['active', 'abandoned'], abandoned: [] };
      assert(allowed[goal.status]?.includes(status), 'Invalid goal transition');
      if(status==='completed'){assert(typeof evidenceId==='string','Goal outcome requires real evidence');applyGoalProposal(state,{goalId,kind:'complete',evidenceId},new Date().toISOString());return true;}
      if(status==='failed'){const event=state.events.find(e=>e.eventId===evidenceId&&activeSource(state,e.eventId));const action=state.actions.find(a=>a.id===(event?.payload as any)?.actionId&&a.goalId===goalId);assert(event&&action&&state.receipts.some(r=>r.receiptId===event.causationId&&r.actionId===action.id&&r.status==='FAILED'),'Goal failure requires related receipt');goal.sourceIds.push(event.eventId);}
      goal.status = status; return true;
    });
  }
  async recordDevelopment(petId: string, category: 'personality' | 'preferences' | 'abilities' | 'limitations' | 'values' | 'interests' | 'habits' | 'autobiography' | 'world', record: DevelopmentRecord): Promise<LifeState> {
    assert(record && nonempty(record.id) && nonempty(record.label) && nonempty(record.value) && record.valid === true && Array.isArray(record.sourceIds) && new Set(record.sourceIds).size >= 2 && !['__proto__', 'constructor', 'prototype'].includes(record.id), 'Development requires multiple evidence sources');
    return this.update(petId, state => {
      const model = state.selfModel ?? (state.selfModel = { personality: [], preferences: [], abilities: [], limitations: [], values: [], interests: [], habits: [], autobiography: [] });
      const world = state.worldModel ?? (state.worldModel = { facts: [] });
      const target = category === 'world' ? world.facts : model[category];
      assert(Array.isArray(target), 'Invalid development category');
      const existing = target.find(item => item.id === record.id);
      if (existing) { assert(same(existing, record), 'Development ID reused'); return false; }
      assert(activeSource(state, record.id) && record.sourceIds.every(id => activeSource(state, id) && state.events.some(e => e.eventId === id && ['observed', 'verified'].includes(e.evidenceLevel))), 'Development requires valid real events');
      target.push(copy(record)); return true;
    });
  }
  async invalidate(petId: string, sourceId: string, reason: string): Promise<LifeState> {
    assert(nonempty(sourceId) && nonempty(reason) && !['__proto__', 'constructor', 'prototype'].includes(sourceId), 'Invalid correction');
    return this.update(petId, state => {
      if (!activeSource(state, sourceId)) return false;
      assert(state.events.some(e => e.eventId === sourceId) || state.memories.some(x => x.id === sourceId) || state.beliefs.some(x => x.id === sourceId) || state.observations.some(x => x.id === sourceId) || (state.selfModel ? Object.values(state.selfModel).flat().some(x => x.id === sourceId) : false) || (state.worldModel?.facts ?? []).some(x => x.id === sourceId), 'Unknown source');
      state.invalidSources[sourceId] = reason;
      for (const item of [...state.memories, ...state.beliefs, ...state.observations, ...(state.selfModel ? Object.values(state.selfModel).flat() : []), ...(state.worldModel?.facts ?? [])]) if (item.id === sourceId) item.valid = false;
      invalidateDependents(state); return true;
    });
  }
  async tick(petId: string, now: string): Promise<LifeState> {
    assert(validDate(now), 'Invalid tick time');
    return this.update(petId, state => {
      const elapsed = (Date.parse(now) - Date.parse(state.lastPhysiologyAt)) / 3600000;
      assert(Number.isFinite(elapsed) && elapsed >= 0, 'Tick cannot move backwards'); if (!elapsed) return false;
      // The existing body engine owns physiology; this checkpoint never writes its projection.
      state.lastPhysiologyAt = now; return true;
    });
  }
}
