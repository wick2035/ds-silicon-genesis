import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {speechIdentity,speechSources} from '../kernel/speech-provenance.js';
import { rankGoals, validateProposal, workspace } from '../kernel/index.js';
import {goalsDueForReview,isKnowledgeGoal} from '../kernel/goal-lifecycle.js';
import {momentEventType, momentSources, type MomentDraft} from '../kernel/moments.js';
import type { ActionProposal, CognitiveWorkspace, LifeState, Memory } from '../kernel/types.js';

const Draft = z.object({
  actionType: z.string().min(1).max(100), parameters: z.record(z.string(), z.json()),
  priority: z.number().finite().min(0).max(100), interruptPolicy: z.enum(['interruptible', 'safe-point', 'noninterruptible']),
  requiredCapabilities: z.array(z.string().min(1).max(100)).min(1).max(20), sourceIds: z.array(z.string().min(1).max(200)).max(50), goalId: z.string().min(1).max(200).optional(),
}).strict();
const Candidate = z.object({ title: z.string().min(1).max(200), description: z.string().min(1).max(2000), sourceIds: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict();
const GoalCandidate=Candidate.extend({parentId:z.string().max(200).optional(),research:z.boolean().optional(),
  completion:z.discriminatedUnion('type',[
    z.object({type:z.literal('read-url'),url:z.string().url().max(2000)}).strict(),
    z.object({type:z.literal('stages'),count:z.number().int().min(2).max(10)}).strict()
  ]).optional()});
const GoalReview=z.object({goalId:z.string().max(200),decision:z.enum(['resume','defer','abandon']),
  reason:z.string().trim().min(1).max(250),hours:z.number().int().min(1).max(72).optional()}).strict();
const GoalUpdate=z.object({goalId:z.string().min(1).max(200),kind:z.enum(['progress','reprioritize','complete','understood']),evidenceId:z.string().min(1).max(200),priority:z.number().finite().min(0).max(100).optional(),understanding:z.string().trim().min(20).max(1000).optional()}).strict().refine(x=>x.kind!=='understood'||!!x.understanding);
const Step = z.object({ readSearchResult:z.boolean().optional(), actionType: z.string().min(1).max(100), parameters: z.record(z.string(),z.json()), goalId:z.string().min(1).max(200).optional(), description: z.string().min(1).max(1000), requiredCapabilities: z.array(z.string().min(1).max(100)).min(1).max(20), sourceIds: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict();
const Thought=z.object({salience:z.number().finite().min(0).max(1).default(.5),text:z.string().min(1).max(500),feeling:z.string().max(200),desire:z.string().max(300),sourceIds:z.array(z.string().min(1).max(200)).min(1).max(20)}).strict();
const Moment = z.object({text:z.string().trim().min(1).max(160), sourceId:z.string().min(1).max(200)}).strict();
const Output = z.object({ thought:Thought.nullable().default(null), moment:z.unknown().optional(), action: Draft.nullable(), goals: z.array(GoalCandidate).max(5), goalUpdates:z.array(GoalUpdate).max(5).default([]), goalReviews:z.array(GoalReview).max(5).optional(), plan: z.array(Step).max(10), interests: z.array(Candidate).max(5), selfModel: z.array(Candidate).max(5) }).strict();
type ModelOutput = z.infer<typeof Output>;
export interface CognitiveContext { observation: string[]; recall: string[]; appraisal: string[]; motivations: string[]; rankedGoals: Array<{goalId: string; score: number}> }
/** The model receives an isolated workspace and proposes data; it cannot execute tools. */
export interface CognitiveModel { generate(snapshot: CognitiveWorkspace, signal: AbortSignal, context: CognitiveContext): Promise<unknown> }
/** Atomically and durably reserve before each call; failed calls consume the reservation. */
export interface CognitiveBudget { reserve(petId: string): Promise<object|null>; withReserved<T>(petId:string, ticket:object, fn:()=>Promise<T>):Promise<T> }
export type CognitiveResult = { status: 'proposed'; sourceVersion: number; proposal: ActionProposal | null; candidates: Omit<ModelOutput, 'action' | 'moment'> & {moment?:MomentDraft} } | { status: 'degraded'; reason: string };

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
  return momentSources(state,Date.now()).size>0 || goalsDueForReview(state).length>0 || state.body.hunger >= 60 || state.body.energy <= 30 || state.body.pain >= 50 || state.commitments.some(c => c.status === 'open') || state.goals.some(g => g.status === 'active' && (g.urgency >= 50 || g.priority >= 70));
}
export class Cognition {
  constructor(private readonly model: CognitiveModel | null, private readonly budget: CognitiveBudget, private readonly retrieval: {forCognition(state:LifeState):Promise<Memory[]>; world(state:LifeState):Promise<NonNullable<CognitiveWorkspace['environment']>>}, private readonly timeoutMs = 45000) {
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
      snapshot.goalReviews=goalsDueForReview(state);
      if(snapshot.worldModel)snapshot.worldModel.facts=snapshot.worldModel.facts.slice(-18);
      const ongoingGoals=new Set(snapshot.activeGoals.map(g=>g.id));
      snapshot.plans=(state.cognitivePlans??[]).filter(p=>p.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id)))
        .filter(p=>['active','paused','failed'].includes(p.status)||p.status==='completed'&&p.goalId&&ongoingGoals.has(p.goalId)).slice(-6);
      const visible=state.events.filter(e=>e.type!==momentEventType&&!Object.hasOwn(state.invalidSources,e.eventId));
      const momentCandidates=momentSources(state,Date.now());
      // Financial bookkeeping and scheduler events must not crowd the actual
      // conversation out of the next autonomous decision.
      const selected=new Set([...visible.filter(e=>['conversation.user','conversation.assistant'].includes(e.type)).slice(-10),...visible.filter(e=>!['conversation.user','conversation.assistant'].includes(e.type)).slice(-8)]);
      for(const event of visible.filter(e=>momentCandidates.has(e.eventId)).slice(-6))selected.add(event);
      snapshot.recentEvents = visible.filter(e=>selected.has(e)).map(e=>({eventId:e.eventId,type:e.type,occurredAt:e.occurredAt,...speechIdentity(e),speakers:speechSources([e.eventId],state),evidenceLevel:e.evidenceLevel,payload:JSON.stringify(e.payload)?.slice(0,700) ?? '',...(momentCandidates.has(e.eventId)?{momentSource:true}:{})}));
      snapshot.relevantMemories = await this.retrieval.forCognition(state);
      const readingByAction=new Map(state.actions.filter(action=>action.goalId&&ongoingGoals.has(action.goalId)&&
        action.actionType==='learning.observe'&&action.parameters.kind==='fetch'&&action.status==='COMPLETED')
        .map(action=>['knowledge:'+action.id,action]));
      snapshot.goalReadings=snapshot.relevantMemories.flatMap(memory=>{
        const action=readingByAction.get(memory.id);
        if(!action)return [];
        const event=visible.find(event=>event.causationId===action.receiptId&&
          ['action.receipt','action.reconciled'].includes(event.type)&&memory.sourceIds.includes(event.eventId));
        return event?[{goalId:action.goalId!,evidenceId:event.eventId,memoryId:memory.id}]:[];
      });
      snapshot.environment = await this.retrieval.world(state);
      const evaluated = await contextGraph.invoke({ state, snapshot, observation: [], recall: [], appraisal: [], motivations: [], rankedGoals: [] });
      const context: CognitiveContext = { observation: evaluated.observation, recall: evaluated.recall, appraisal: evaluated.appraisal, motivations: evaluated.motivations, rankedGoals: evaluated.rankedGoals };
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs); });
      const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      const raw = await Promise.race([this.budget.withReserved(state.petId, reserved, () => this.model!.generate(snapshot, controller.signal, context)), timeout, stopped]);
      if (signal.aborted) return { status: 'degraded', reason: 'stopped' };
      const result = await planGraph.invoke({ raw, parsed: null, error: null });
      if (!result.parsed) return { status: 'degraded', reason: result.error ?? 'invalid_model_output' };
      const { action, moment, ...candidates } = result.parsed;
      const post=Moment.safeParse(moment);
      const sourceValid = (id: string) => state.events.some(e => e.eventId === id && !Object.prototype.hasOwnProperty.call(state.invalidSources, id));
      if(candidates.goalReviews?.some(review=>![...snapshot.activeGoals,...snapshot.goalReviews!].some(g=>g.id===review.goalId)))return {status:'degraded',reason:'unavailable_goal_review'};
      if(candidates.goalUpdates.some(x=>!sourceValid(x.evidenceId)))return {status:'degraded',reason:'invalid_goal_evidence'};
      // Understanding must cite a memory actually provided to this model call.
      const readSources=new Set(snapshot.relevantMemories.flatMap(m=>m.sourceIds));
      if(candidates.goalUpdates.some(x=>x.kind==='understood'&&(!readSources.has(x.evidenceId)||!snapshot.activeGoals.some(g=>g.id===x.goalId&&isKnowledgeGoal(g)))))return {status:'degraded',reason:'unread_goal_explanation'};
      if ([...candidates.goals, ...candidates.plan, ...candidates.interests, ...candidates.selfModel].some(item => !item.sourceIds.every(sourceValid))) return { status: 'degraded', reason: 'invalid_candidate_source' };
      if (candidates.plan.some(step => !step.requiredCapabilities.includes(step.actionType) || !step.requiredCapabilities.every(name => state.constraints.capabilities.some(cap => cap.name === name && cap.enabled && (!cap.requiresPermission || state.constraints.permissions.includes(cap.requiresPermission)))))) return { status: 'degraded', reason: 'unavailable_plan_capability' };
      const resolvedHere=(id:string)=>candidates.goalUpdates.some(update=>update.goalId===id&&
        (update.kind==='complete'||update.kind==='understood'))||candidates.goalReviews?.some(review=>review.goalId===id&&review.decision!=='resume');
      let proposal: ActionProposal | null = action && !(action.goalId&&resolvedHere(action.goalId))
        ? { ...action, id: randomUUID(), petId: state.petId, expectedStateVersion: state.version } : null;
      if(proposal){
        try{validateProposal(state,proposal);}
        catch{
          if(!candidates.thought&&!post.success&&!candidates.goals.length&&!candidates.goalUpdates.length&&!candidates.goalReviews?.length&&!candidates.plan.length)
            return {status:'degraded',reason:'proposal_rejected'};
          proposal=null;
        }
      }
      const publish=post.success&&snapshot.recentEvents.some(e=>e.momentSource&&e.eventId===post.data.sourceId);
      return { status: 'proposed', sourceVersion: state.version, proposal, candidates:{...candidates,...(publish?{moment:post.data}:{})} };
    } catch { return { status: 'degraded', reason: signal.aborted ? 'stopped' : controller.signal.aborted ? 'model_timeout' : 'model_unavailable' }; }
    finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}
