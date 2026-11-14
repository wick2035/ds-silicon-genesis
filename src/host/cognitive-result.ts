import {applyGoalProposal} from '../kernel/goal-lifecycle.js';
import { createHash, randomUUID } from 'node:crypto';
import { strategyScore, validateProposal } from '../kernel/index.js';
import type { LifeState, CognitivePlan, DevelopmentRecord } from '../kernel/types.js';
import type { CognitiveResult } from '../cognition/index.js';
import type { CanonicalEnvelope, BodyProjection } from '../storage/postgres.js';
import type { PetGate, UnitOfWork, OutboxDispatcher } from '../storage/uow.js';
import type { ActionCoordinator } from './action-coordinator.js';
import {validateActionParameters} from './action-parameters.js';
interface Reader {loadEnvelope(petId:string):Promise<CanonicalEnvelope|null>}
const key=(kind:string,value:unknown)=>`${kind}:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,32)}`;
type Proposed=Extract<CognitiveResult,{status:'proposed'}>;
/** Cognition proposes only; accepted candidates and a proposal are persisted
 * together. Actual effects always pass the coordinator and dispatcher. */
export class CognitiveResultCoordinator {
  constructor(private readonly reader:Reader,private readonly uow:UnitOfWork,private readonly gate:PetGate,
    private readonly projectBody:BodyProjection,private readonly actions:ActionCoordinator,private readonly dispatcher:OutboxDispatcher) {}

  /** Durable throttle reservation occurs before any model/budget invocation. */
  async claimCognition(petId:string,intervalSeconds:number,signal:AbortSignal):Promise<boolean>{
    return this.gate.run(petId,async()=>{
      const state=await this.reader.loadEnvelope(petId);if(!state||state.life.constraints.paused||signal.aborted||this.gate.signal.aborted)return false;
      const now=Date.now(), prior=state.life.nextCognitionAt;
      if(prior && (!Number.isFinite(Date.parse(prior)) || Date.parse(prior)>now))return false;
      await this.uow.apply(petId,state.version,draft=>{draft.life.nextCognitionAt=new Date(now+intervalSeconds*1000).toISOString();return {};});
      return true;
    });
  }
  async accept(petId:string,result:Proposed,signal:AbortSignal):Promise<void> {
    if(signal.aborted || this.gate.signal.aborted) throw new Error('认知已停止');
    await this.gate.run(petId,async()=>{
      const current=await this.reader.loadEnvelope(petId);
      if(!current || current.life.constraints.paused) throw new Error('认知结果已过期');
      await this.uow.apply(petId,current.version,draft=>{
        const life=draft.life, state:LifeState={...structuredClone(life),petId,version:draft.version,...this.projectBody(draft)};
        if(state.constraints.paused) throw new Error('自主行为已暂停');
        const valid=(id:string)=>!Object.hasOwn(life.invalidSources,id) && life.events.some(e=>e.eventId===id);
        const candidates=result.candidates;
        if([...candidates.goals,...candidates.plan,...candidates.interests,...candidates.selfModel].some(x=>!x.sourceIds.length||!x.sourceIds.every(valid))) throw new Error('认知来源无效');
        for(const candidate of candidates.goals){
          const id=key('goal',candidate);if(life.goals.some(g=>g.id===id))continue;
          let completion:typeof candidate.completion;
          if(candidate.completion){const url=candidate.completion.url;const proof=candidate.sourceIds.some(id=>{const e=life.events.find(event=>event.eventId===id);const payload=e?.payload as any;const text=typeof payload?.text==='string'?payload.text:'';const parts=text.trim().split(url);return (e?.source==='user'||e?.source==='desktop'&&e.actorId==='dad') && parts.length===2 && /^(?:请|帮我|请帮我)?\s*(?:读取|阅读|打开|查看|读一下|read)\s*$/i.test(parts[0]) && /^[\s。！!]*$/.test(parts[1]);});if(!proof)throw Error('单步阅读目标缺少明确用户来源');completion=candidate.completion;}
          life.goals.push({id,title:candidate.title,kind:'self-directed',priority:0,urgency:0,status:'active',sourceIds:[...candidate.sourceIds],...(completion?{completion}:{})});
        }
        state.goals=life.goals;state.events=life.events;
        for(const update of candidates.goalUpdates)applyGoalProposal(state,update,new Date().toISOString());
        const verified=(ids:string[])=>new Set(ids).size>=2 && ids.every(id=>life.events.some(e=>e.eventId===id&&['observed','verified'].includes(e.evidenceLevel)));
        const model=life.selfModel;
        // One reflection is not enough to change stable identity. Only distinct
        // observed or verified sources can establish development records.
        if(model) for(const [category,items] of [['interests',candidates.interests],['personality',candidates.selfModel]] as const) for(const c of items){
          if(!verified(c.sourceIds))continue;
          const item:DevelopmentRecord={id:key(category,c),label:c.title,value:c.description,sourceIds:[...c.sourceIds],valid:true};
          if(!model[category].some(x=>x.id===item.id))model[category].push(item);
        }
        for(const step of candidates.plan) {
          validateActionParameters(step.actionType,step.parameters);
          if(!this.dispatcher.hasExecutor(step.actionType))throw Error('计划执行器不可用');
          if(!step.requiredCapabilities.includes(step.actionType) || !step.requiredCapabilities.every(name=>life.constraints.capabilities.some(cap=>cap.name===name && cap.enabled && (!cap.requiresPermission||life.constraints.permissions.includes(cap.requiresPermission))))) throw new Error('计划能力或权限已变化');
          if(step.goalId && !life.goals.some(g=>g.id===step.goalId && g.status==='active'))throw new Error('计划目标已变化');
        }
        let plan:CognitivePlan|undefined;
        if(candidates.plan.length){
          const sourceIds=[...new Set(candidates.plan.flatMap(s=>s.sourceIds))], baseId=key('plan',candidates.plan);
          const prior=(life.cognitivePlans||[]).find(p=>p.id===baseId);
          const id=prior && ['failed','abandoned'].includes(prior.status) ? `${baseId}:${draft.version}` : baseId;
          const existing=(life.cognitivePlans||[]).find(p=>p.id===id);
          if(!existing){plan={id,sourceIds,status:'active',steps:candidates.plan.map((s,i)=>({id:`${id}:${i}`,actionType:s.actionType,parameters:structuredClone(s.parameters),...(s.goalId?{goalId:s.goalId}:{}),description:s.description,requiredCapabilities:[...s.requiredCapabilities],sourceIds:[...s.sourceIds],status:'pending'}))};(life.cognitivePlans??=[]).push(plan);}
          else if(existing.status==='active')plan=existing;
        }
        if(result.proposal){
          const learned=strategyScore(state,result.proposal.actionType,'execution');
          const proposal={...result.proposal,priority:Math.max(0,Math.min(100,result.proposal.priority+(learned.samples ? Math.round((learned.score-.5)*20) : 0))),expectedStateVersion:draft.version};
          if(proposal.petId!==petId)throw new Error('行动身份不匹配');
          validateActionParameters(proposal.actionType,proposal.parameters);
          if(!this.dispatcher.hasExecutor(proposal.actionType))throw Error('行动执行器不可用');
          validateProposal(state,proposal);
          if(life.actions.some(a=>a.id===proposal.id))throw new Error('行动标识冲突');
          if ((life.cognitivePlans||[]).some(p=>p.status==='active' && p.steps.some(s=>s.status==='in_progress'))) throw new Error('已有计划步骤等待回执');
          const possible=(life.cognitivePlans||[]).find(p=>p.status==='active' && p.steps.some(s=>s.status==='pending')) || plan;
          const step=possible?.steps.find(s=>s.status==='pending');
          if(step && (step.actionType!==proposal.actionType || JSON.stringify(step.parameters)!==JSON.stringify(proposal.parameters) || step.goalId!==proposal.goalId || !step.requiredCapabilities.every(x=>proposal.requiredCapabilities.includes(x)))) throw new Error('行动与计划步骤不匹配');
          if(step){step.status='in_progress';step.actionId=proposal.id;}
          const now=new Date().toISOString();life.actions.push({...structuredClone(proposal),status:'PROPOSED',createdAt:now,updatedAt:now});
        }
        return {};
      });
      if(signal.aborted||this.gate.signal.aborted)throw new Error('认知已停止');
      if(result.proposal)await this.runAction(petId,result.proposal.id,signal);
    });
  }
  private async runAction(petId:string,actionId:string,signal:AbortSignal):Promise<void>{
    const state=await this.reader.loadEnvelope(petId);if(!state||state.life.constraints.paused||signal.aborted||this.gate.signal.aborted)return;
    const action=state.life.actions.find(a=>a.id===actionId);if(!action)return;
    if(action.status==='PROPOSED'){
      try {validateActionParameters(action.actionType,action.parameters);if(!this.dispatcher.hasExecutor(action.actionType))throw Error('行动执行器不可用');const latest:LifeState={...structuredClone(state.life),petId,version:state.version,...this.projectBody(state)};validateProposal(latest,{...action,expectedStateVersion:state.version});}
      catch(error){await this.rejectProposal(petId,actionId,error instanceof Error?error.message:'行动不可用');return;}
      try{await this.actions.queue(petId,actionId,state.version);}catch(error){
        const message=error instanceof Error?error.message:'';
        if(!/当前桌面空间或工作状态不允许走动|她在网页工地里|探索权限不可用|探索额度配置无效|今日探索额度已用完|探索饭钱配置无效|模拟饭钱不足|图片来源无效/.test(message))throw error;
        const fresh=await this.reader.loadEnvelope(petId);if(fresh?.life.actions.find(a=>a.id===actionId)?.status==='PROPOSED')await this.rejectProposal(petId,actionId,message);else throw error;return;
      }
    }
    const fresh=await this.reader.loadEnvelope(petId);
    if(!signal.aborted&&!this.gate.signal.aborted&&fresh?.life.actions.find(a=>a.id===actionId)?.status==='PENDING'){
      const pending=fresh.life.actions.find(a=>a.id===actionId)!;
      if(!this.dispatcher.hasExecutor(pending.actionType))await this.dispatcher.cancelUnavailable(petId,actionId);else await this.dispatcher.dispatch(actionId);
    }
  }
  private async rejectProposal(petId:string,actionId:string,reason:string):Promise<void>{
    const state=await this.reader.loadEnvelope(petId);if(!state)return;
    await this.uow.apply(petId,state.version,draft=>{const action=draft.life.actions.find(a=>a.id===actionId);if(!action||action.status!=='PROPOSED')return {};
      const now=new Date().toISOString();action.status='CANCELLED';action.updatedAt=now;
      for(const plan of draft.life.cognitivePlans||[])for(const step of plan.steps)if(step.actionId===actionId&&step.status==='in_progress'){step.status='failed';plan.status='failed';}
      draft.life.events.push({eventId:'proposal-cancelled:'+actionId,petId,type:'action.cancelled',source:'coordinator',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{actionId,reason:reason.slice(0,300)}});return {};
    });
  }
  /** Recover durable proposals/pending outbox only. DISPATCHED and UNKNOWN are
   * never replayed; the dispatcher reconciles them separately. */
  async resume(petId:string,signal:AbortSignal):Promise<boolean>{
    return this.gate.run(petId,async()=>{const state=await this.reader.loadEnvelope(petId);if(!state||state.life.constraints.paused||signal.aborted)return false;
      const action=state.life.actions.find(a=>a.status==='PROPOSED'||a.status==='PENDING');
      if(action){await this.runAction(petId,action.id,signal);return true;}
      if((state.life.cognitivePlans||[]).some(p=>p.status==='active'&&p.steps.some(s=>s.status==='in_progress')))return false;
      const plan=(state.life.cognitivePlans||[]).find(p=>p.status==='active'&&p.steps.some(s=>s.status==='pending'));
      const step=plan?.steps.find(s=>s.status==='pending');if(!plan||!step||!step.parameters)return false;
      const id=randomUUID();
      await this.uow.apply(petId,state.version,draft=>{
        const currentPlan=draft.life.cognitivePlans?.find(p=>p.id===plan.id),currentStep=currentPlan?.steps.find(s=>s.id===step.id);
        if(!currentPlan||currentPlan.status!=='active'||!currentStep||currentStep.status!=='pending')throw new Error('计划已变化');
        const proposal={id,petId,actionType:currentStep.actionType,parameters:structuredClone(currentStep.parameters),priority:50,interruptPolicy:'safe-point' as const,requiredCapabilities:[...currentStep.requiredCapabilities],expectedStateVersion:draft.version,sourceIds:[...currentStep.sourceIds],...(currentStep.goalId?{goalId:currentStep.goalId}:{})};
        const latest:LifeState={...structuredClone(draft.life),petId,version:draft.version,...this.projectBody(draft)};
        try{validateActionParameters(proposal.actionType,proposal.parameters);if(!this.dispatcher.hasExecutor(proposal.actionType))throw Error('执行器不可用');validateProposal(latest,proposal);}catch(error){currentStep.status='failed';currentPlan.status='failed';const now=new Date().toISOString();draft.life.events.push({eventId:'plan-failed:'+randomUUID(),petId,type:'plan.failed',source:'coordinator',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{planId:currentPlan.id,reason:error instanceof Error?error.message:'计划不可用'}});return {};}
        const now=new Date().toISOString();
        currentStep.status='in_progress';currentStep.actionId=id;draft.life.actions.push({...proposal,status:'PROPOSED',createdAt:now,updatedAt:now});return {};
      });
      await this.runAction(petId,id,signal);return true;});
  }
}
