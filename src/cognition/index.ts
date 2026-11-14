import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { rankGoals, validateProposal, workspace } from '../kernel/index.js';
import type { ActionProposal, CognitiveWorkspace, LifeState, Memory } from '../kernel/types.js';

const Draft = z.object({
  actionType: z.string().min(1).max(100), parameters: z.record(z.string(), z.json()),
  priority: z.number().finite().min(0).max(100), interruptPolicy: z.enum(['interruptible', 'safe-point', 'noninterruptible']),
  requiredCapabilities: z.array(z.string().min(1).max(100)).min(1).max(20), sourceIds: z.array(z.string().min(1).max(200)).max(50), goalId: z.string().min(1).max(200).optional(),
}).strict();
const Candidate = z.object({ title: z.string().min(1).max(200), description: z.string().min(1).max(2000), sourceIds: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict();
const GoalCandidate=Candidate.extend({completion:z.object({type:z.literal('read-url'),url:z.string().url().max(2000)}).strict().optional()});
const GoalUpdate=z.object({goalId:z.string().min(1).max(200),kind:z.enum(['progress','reprioritize','complete']),evidenceId:z.string().min(1).max(200),priority:z.number().finite().min(0).max(100).optional()}).strict();
const Step = z.object({ actionType: z.string().min(1).max(100), parameters: z.record(z.string(),z.json()), goalId:z.string().min(1).max(200).optional(), description: z.string().min(1).max(1000), requiredCapabilities: z.array(z.string().min(1).max(100)).min(1).max(20), sourceIds: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict();
const Output = z.object({ action: Draft.nullable(), goals: z.array(GoalCandidate).max(5), goalUpdates:z.array(GoalUpdate).max(5).default([]), plan: z.array(Step).max(10), interests: z.array(Candidate).max(5), selfModel: z.array(Candidate).max(5) }).strict();
type ModelOutput = z.infer<typeof Output>;
export interface CognitiveContext { observation: string[]; recall: string[]; appraisal: string[]; motivations: string[]; rankedGoals: Array<{goalId: string; score: number}> }
/** The model receives an isolated workspace and proposes data; it cannot execute tools. */
export interface CognitiveModel { generate(snapshot: CognitiveWorkspace, signal: AbortSignal, context: CognitiveContext): Promise<unknown> }
/** Atomically and durably reserve before each call; failed calls consume the reservation. */
export interface CognitiveBudget { reserve(petId: string): Promise<object|null>; withReserved<T>(petId:string, ticket:object, fn:()=>Promise<T>):Promise<T> }
export type CognitiveResult = { status: 'proposed'; sourceVersion: number; proposal: ActionProposal | null; candidates: Omit<ModelOutput, 'action'> } | { status: 'degraded'; reason: string };

const ContextGraph = Annotation.Root({
  state: Annotation<LifeState>(), snapshot: Annotation<CognitiveWorkspace>(),
  observation: Annotation<string[]>(), recall: Annotation<string[]>(), appraisal: Annotation<string[]>(),
  motivations: Annotation<string[]>(), rankedGoals: Annotation<Array<{goalId: string; score: number}>>(),
});
// Every graph node is pure. Model invocation, budget accounting, and persistence stay outside the graph.
const contextGraph = new StateGraph(ContextGraph)
  .addNode('Observe', s => ({ observation: [`energy:${s.snapshot.body.energy}`, `hunger:${s.snapshot.body.hunger}`, `pain:${s.snapshot.body.pain}`, `sleeping:${s.snapshot.body.sleeping}`] }))
  .addNode('Recall', s => ({ recall: s.snapshot.relevantMemories.slice(-20).map(m => m.id) }))
  .addNode('Appraise', s => ({ appraisal: [s.snapshot.body.hunger >= 60 ? 'hungry' : '', s.snapshot.body.energy <= 30 ? 'tired' : '', s.snapshot.body.pain >= 50 ? 'pain' : ''].filter(Boolean) }))
  .addNode('GenerateMotivations', s => ({ motivations: [...s.appraisal, ...s.snapshot.commitments.map(c => `commitment:${c.id}`)] }))
  .addNode('EvaluateGoals', s => ({ rankedGoals: rankGoals(s.state) }))
  .addEdge(START, 'Observe').addEdge('Observe', 'Recall').addEdge('Recall', 'Appraise')
  .addEdge('Appraise', 'GenerateMotivations').addEdge('GenerateMotivations', 'EvaluateGoals').addEdge('EvaluateGoals', END).compile();
const PlanGraph = Annotation.Root({ raw: Annotation<unknown>(), parsed: Annotation<ModelOutput | null>(), error: Annotation<string | null>() });
const planGraph = new StateGraph(PlanGraph)
  .addNode('Plan', s => { const parsed = Output.safeParse(s.raw); return parsed.success ? { parsed: parsed.data, error: null } : { parsed: null, error: 'invalid_model_output' }; })
  .addNode('Validate', s => ({ parsed: s.parsed, error: s.error }))
  .addEdge(START, 'Plan').addEdge('Plan', 'Validate').addEdge('Validate', END).compile();

/** A scheduling hint only; model output never changes state until a kernel operation accepts it. */
export function hasCognitiveDemand(state: LifeState): boolean {
  return state.body.hunger >= 60 || state.body.energy <= 30 || state.body.pain >= 50 || state.commitments.some(c => c.status === 'open') || state.goals.some(g => g.status === 'active' && (g.urgency >= 50 || g.priority >= 70));
}
export class Cognition {
  constructor(private readonly model: CognitiveModel | null, private readonly budget: CognitiveBudget, private readonly retrieval: {forCognition(state:LifeState):Promise<Memory[]>; world(state:LifeState):Promise<NonNullable<CognitiveWorkspace['environment']>>}, private readonly timeoutMs = 15000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Invalid cognition timeout');
  }
  async propose(state: LifeState, signal: AbortSignal, reload: () => Promise<LifeState>): Promise<CognitiveResult> {
    if (signal.aborted) return { status: 'degraded', reason: 'stopped' };
    if (state.constraints.paused) return { status: 'degraded', reason: 'paused' };
    if (!this.model) return { status: 'degraded', reason: 'model_unavailable' };
    let reserved: object|null;
    try { reserved = await this.budget.reserve(state.petId); } catch { return { status: 'degraded', reason: 'budget_unavailable' }; }
    if (!reserved) return { status: 'degraded', reason: 'budget_exhausted' };
    if (signal.aborted) return { status: 'degraded', reason: 'stopped' };
    try { const fresh = await reload(); if (fresh.petId !== state.petId) return { status: 'degraded', reason: 'identity_mismatch' }; state = fresh; }
    catch { return { status: 'degraded', reason: 'state_unavailable' }; }
    if (state.constraints.paused) return { status: 'degraded', reason: 'paused' };
    if (signal.aborted) return { status: 'degraded', reason: 'stopped' };
    const controller = new AbortController(); const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = workspace(state);
      const visible=state.events.filter(e=>!Object.hasOwn(state.invalidSources,e.eventId));
      // Financial bookkeeping and scheduler events must not crowd the actual
      // conversation out of the next autonomous decision.
      const selected=new Set([...visible.filter(e=>['conversation.user','conversation.assistant'].includes(e.type)).slice(-10),...visible.filter(e=>!['conversation.user','conversation.assistant'].includes(e.type)).slice(-8)]);
      snapshot.recentEvents = visible.filter(e=>selected.has(e)).map(e=>({eventId:e.eventId,type:e.type,occurredAt:e.occurredAt,evidenceLevel:e.evidenceLevel,payload:JSON.stringify(e.payload)?.slice(0,700) ?? ''}));
      snapshot.relevantMemories = await this.retrieval.forCognition(state);
      snapshot.environment = await this.retrieval.world(state);
      const evaluated = await contextGraph.invoke({ state, snapshot, observation: [], recall: [], appraisal: [], motivations: [], rankedGoals: [] });
      const context: CognitiveContext = { observation: evaluated.observation, recall: evaluated.recall, appraisal: evaluated.appraisal, motivations: evaluated.motivations, rankedGoals: evaluated.rankedGoals };
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs); });
      const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      const raw = await Promise.race([this.budget.withReserved(state.petId, reserved, () => this.model!.generate(snapshot, controller.signal, context)), timeout, stopped]);
      if (signal.aborted) return { status: 'degraded', reason: 'stopped' };
      const result = await planGraph.invoke({ raw, parsed: null, error: null });
      if (!result.parsed) return { status: 'degraded', reason: result.error ?? 'invalid_model_output' };
      const { action, ...candidates } = result.parsed;
      const sourceValid = (id: string) => state.events.some(e => e.eventId === id && !Object.prototype.hasOwnProperty.call(state.invalidSources, id));
      if(candidates.goalUpdates.some(x=>!sourceValid(x.evidenceId)))return {status:'degraded',reason:'invalid_goal_evidence'};
      if ([...candidates.goals, ...candidates.plan, ...candidates.interests, ...candidates.selfModel].some(item => !item.sourceIds.every(sourceValid))) return { status: 'degraded', reason: 'invalid_candidate_source' };
      if (candidates.plan.some(step => !step.requiredCapabilities.includes(step.actionType) || !step.requiredCapabilities.every(name => state.constraints.capabilities.some(cap => cap.name === name && cap.enabled && (!cap.requiresPermission || state.constraints.permissions.includes(cap.requiresPermission)))))) return { status: 'degraded', reason: 'unavailable_plan_capability' };
      const proposal: ActionProposal | null = action ? { ...action, id: randomUUID(), petId: state.petId, expectedStateVersion: state.version } : null;
      if (proposal) { try { validateProposal(state, proposal); } catch { return { status: 'degraded', reason: 'proposal_rejected' }; } }
      return { status: 'proposed', sourceVersion: state.version, proposal, candidates };
    } catch { return { status: 'degraded', reason: signal.aborted ? 'stopped' : controller.signal.aborted ? 'model_timeout' : 'model_unavailable' }; }
    finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}
