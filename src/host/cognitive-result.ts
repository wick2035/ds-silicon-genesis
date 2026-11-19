import {advanceSpirit,checkSpirit} from '../kernel/spirit.js';
import {applyGoalProposal,goalIsRunnable,lifeDay,mergeDuplicateGoals,resolveGoalId,reviewGoal} from '../kernel/goal-lifecycle.js';
import { createHash, randomUUID } from 'node:crypto';
import { rankGoals, validateProposal } from '../kernel/index.js';
import type { LifeState, CognitivePlan, DevelopmentRecord } from '../kernel/types.js';
import type { CognitiveResult } from '../cognition/index.js';
import type { CanonicalEnvelope, BodyProjection } from '../storage/postgres.js';
import type { PetGate, UnitOfWork, OutboxDispatcher } from '../storage/uow.js';
import type { ActionCoordinator } from './action-coordinator.js';
import {validateActionParameters} from './action-parameters.js';
import {momentEventType, momentSources} from '../kernel/moments.js';
import {redactDadNames} from '../../vendor/pet-plugins/behavior/memory-privacy.mjs';
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
      const spirit=advanceSpirit(state.life);if(spirit.mode!=='awake'||spirit.value<2)return false;
      const now=Date.now(), prior=state.life.nextCognitionAt;
      if(prior && (!Number.isFinite(Date.parse(prior)) || Date.parse(prior)>now))return false;
      await this.uow.apply(petId,state.version,draft=>{draft.life.nextCognitionAt=new Date(now+intervalSeconds*(.7+Math.random()*1.6)*1000).toISOString();return {};});
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
        if(candidates.thought){
          const t=candidates.thought;if(!t.sourceIds.every(valid))throw Error('念头来源已变化');
          const id='thought:'+randomUUID(),at=new Date().toISOString();
          life.events.push({eventId:id,petId,type:'self.thought',source:'model',occurredAt:at,receivedAt:at,evidenceLevel:'inferred',payload:{...t,sourceIds:t.sourceIds,spirit:life.spirit?.value}});
          life.memories.push({id:'memory:'+id,kind:'autobiographical',content:t.text+'\n当时感受：'+t.feeling+'\n想做的事：'+t.desire,sourceIds:[id,...t.sourceIds],evidenceLevel:'inferred',valid:true,createdAt:at,feeling:t.feeling,salience:t.salience??.5});
        }
        if(candidates.moment){
          const {sourceId}=candidates.moment,now=Date.now();
          const text=redactDadNames(candidates.moment.text).trim();
          const context=momentSources(life,now).get(sourceId);
          if(context&&text){
            const at=new Date(now).toISOString();
            const noteId='memory:'+sourceId;
            const sourceIds=life.memories.some(memory=>memory.id===noteId&&memory.valid)?[sourceId,noteId]:[sourceId];
            life.events.push({eventId:'moment:'+randomUUID(),petId,type:momentEventType,source:'model',occurredAt:at,receivedAt:at,evidenceLevel:'inferred',payload:{text,context,sourceIds}});
          }
        }
        if([...candidates.goals,...candidates.plan,...candidates.interests,...candidates.selfModel].some(x=>!x.sourceIds.length||!x.sourceIds.every(valid))) throw new Error('认知来源无效');
        for(const candidate of candidates.goals){
          const id=key('goal',candidate);if(life.goals.some(g=>g.id===id))continue;
          let completion:typeof candidate.completion;
          if(candidate.completion?.type==='read-url'){const url=candidate.completion.url;const proof=candidate.sourceIds.some(id=>{const e=life.events.find(event=>event.eventId===id);const payload=e?.payload as any;const text=typeof payload?.text==='string'?payload.text:'';const parts=text.trim().split(url);return (e?.source==='user'||e?.source==='desktop'&&e.actorId==='dad') && parts.length===2 && /^(?:请|帮我|请帮我)?\s*(?:读取|阅读|打开|查看|读一下|read)\s*$/i.test(parts[0]) && /^[\s。！!]*$/.test(parts[1]);});if(!proof)throw Error('单步阅读目标缺少明确用户来源');completion=candidate.completion;}
          if(candidate.completion?.type==='stages')completion=candidate.completion;
          const parentId=candidate.parentId&&resolveGoalId(state,candidate.parentId);
          if(parentId){
            const parent=life.goals.find(g=>g.id===parentId);
            if(!parent||parent.status!=='active'||parent.completion?.type!=='stages')throw Error('阶段目标需要活跃的父目标');
            if(life.goals.filter(g=>g.parentId===parentId&&!g.mergedInto).length>=(parent.completion.count??2))throw Error('父目标已具备完整的阶段');
          }
          life.goals.push({id,title:candidate.title,kind:'self-directed',priority:0,urgency:0,status:'active',sourceIds:[...candidate.sourceIds],
            ...(parentId?{parentId}:{}),...(candidate.research?{research:true}:{}),...(completion?{completion}:{})});
        }
        mergeDuplicateGoals({...life,petId},new Date().toISOString());
        state.goals=life.goals;state.events=life.events;state.memories=life.memories;state.selfModel=life.selfModel;
        state.cognitivePlans=life.cognitivePlans;
        if(candidates.goalReviews?.length){
          const balance=(draft.legacy as {wallet?:{balance?:number}}|undefined)?.wallet?.balance;
          for(const review of candidates.goalReviews)reviewGoal(state,review,Date.now(),balance);
        }
        life.legacyGoalReviewDay=state.legacyGoalReviewDay;
        for(const update of candidates.goalUpdates)applyGoalProposal(state,update,new Date().toISOString());
        const topicText=(text:unknown)=>typeof text==='string'?text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,''):'';
        const verified=(ids:string[],topic?:string)=>{
          const term=topicText(topic);
          const evidence=life.events.filter(e=>ids.includes(e.eventId)&&['observed','verified'].includes(e.evidenceLevel));
          if(evidence.length!==new Set(ids).size||topic&&term.length<2)return false;
          const outcomes=evidence.map(e=>{
            const receipt=life.receipts.find(r=>r.receiptId===e.causationId&&r.status==='COMPLETED');
            const action=receipt&&life.actions.find(a=>a.id===receipt.actionId);
            const words=e.payload as Record<string,unknown>|undefined;
            return {at:e.occurredAt,autonomous:action?.autonomous===true,
              matches:!term||[words?.topic,words?.text,words?.description,action?.parameters.query].some(text=>topicText(text).includes(term))};
          }).filter(item=>item.matches);
          return new Set(outcomes.map(item=>lifeDay.format(Date.parse(item.at)))).size>=2&&outcomes.some(item=>item.autonomous);
        };
        const model=life.selfModel;
        const frozen=(draft.legacy as {growth?:{persona?:{frozen?:boolean}}}|undefined)?.growth?.persona?.frozen===true;
        if(model) for(const [category,items] of [['interests',candidates.interests],['personality',frozen?[]:candidates.selfModel]] as const) for(const c of items){
          if(!verified(c.sourceIds,category==='interests'?c.title:undefined))continue;
          const item:DevelopmentRecord={id:key(category,c),label:c.title,value:c.description,sourceIds:[...c.sourceIds],valid:true};
          if(!model[category].some(x=>x.id===item.id))model[category].push(item);
        }
        for(const [index,step] of candidates.plan.entries()) {
          if(step.actionType==='farm.tend')throw Error('农活仅支持当下单步行动');
          if(step.goalId)step.goalId=resolveGoalId(state,step.goalId);
          if(step.readSearchResult){
            const prior=candidates.plan[index-1];
            if(!step.goalId||step.actionType!=='learning.observe'||step.parameters.kind!=='fetch'||step.parameters.url!==undefined||
              prior?.actionType!=='learning.observe'||prior.parameters.kind!=='search'||prior.goalId!==step.goalId)throw Error('阅读步骤须承接同目标的真实搜索');
          }
          validateActionParameters(step.actionType,step.readSearchResult?{...step.parameters,url:'https://example.invalid/'}:step.parameters);
          if(!this.dispatcher.hasExecutor(step.actionType))throw Error('计划执行器不可用');
          if(!step.requiredCapabilities.includes(step.actionType) || !step.requiredCapabilities.every(name=>life.constraints.capabilities.some(cap=>cap.name===name && cap.enabled && (!cap.requiresPermission||life.constraints.permissions.includes(cap.requiresPermission))))) throw new Error('计划能力或权限已变化');
          if(!goalIsRunnable(state,step.goalId))throw new Error('计划目标已变化');
        }
        let plan:CognitivePlan|undefined;
        if(candidates.plan.length){
          const goalId=candidates.plan[0].goalId;
          if(candidates.plan.some(step=>step.goalId!==goalId))throw Error('单份计划只能关联一个目标');
          const sourceIds=[...new Set(candidates.plan.flatMap(s=>s.sourceIds))], baseId=key('plan',candidates.plan);
          const current=(life.cognitivePlans??[]).find(p=>goalId&&p.goalId===goalId&&p.status==='active');
          if(current&&current.id!==baseId&&!current.id.startsWith(baseId+':')){
            if(current.steps.some(step=>step.status==='in_progress'&&!life.actions.some(a=>a.id===step.actionId&&a.status==='UNKNOWN')))throw Error('当前计划正在执行');
            current.status='abandoned';
            current.reviewReason='大肥鱼选择了新的计划';
          }
          const prior=(life.cognitivePlans||[]).find(p=>p.id===baseId);
          const id=prior && ['failed','abandoned'].includes(prior.status)
            ? (current?.id.startsWith(baseId+':')&&current.status==='active'?current.id:`${baseId}:${draft.version}`) : baseId;
          const existing=(life.cognitivePlans||[]).find(p=>p.id===id);
          if(!existing){plan={id,sourceIds,goalId,status:'active',steps:candidates.plan.map((s,i)=>({id:`${id}:${i}`,actionType:s.actionType,parameters:structuredClone(s.parameters),...(s.goalId?{goalId:s.goalId}:{}),description:s.description,...(s.readSearchResult?{readSearchResult:true}:{}),requiredCapabilities:[...s.requiredCapabilities],sourceIds:[...s.sourceIds],status:'pending'}))};(life.cognitivePlans??=[]).push(plan);}
          else if(existing.status==='active')plan=existing;
        }
        if(result.proposal){
          const proposal={...result.proposal,expectedStateVersion:draft.version};
          if(proposal.goalId)proposal.goalId=resolveGoalId(state,proposal.goalId);
          if(proposal.petId!==petId)throw new Error('行动身份不匹配');
          validateActionParameters(proposal.actionType,proposal.parameters);
          if(!this.dispatcher.hasExecutor(proposal.actionType))throw Error('行动执行器不可用');
          validateProposal(state,proposal);
          if(life.actions.some(a=>a.id===proposal.id))throw new Error('行动标识冲突');
          if(!goalIsRunnable(state,proposal.goalId))throw Error('行动目标已暂停或失效');
          const possible=plan??(life.cognitivePlans||[]).find(p=>p.status==='active' && p.goalId===proposal.goalId &&
            p.steps.some(s=>s.status==='pending')&&!p.steps.some(s=>s.status==='awaiting_receipt'));
          if(possible?.steps.some(s=>s.status==='in_progress'||s.status==='awaiting_receipt'))throw Error('当前计划等待动作确认');
          const step=possible?.steps.find(s=>s.status==='pending');
          if(step && (step.readSearchResult || step.actionType!==proposal.actionType || JSON.stringify(step.parameters)!==JSON.stringify(proposal.parameters) || step.goalId!==proposal.goalId || !step.requiredCapabilities.every(x=>proposal.requiredCapabilities.includes(x)))) throw new Error('行动与计划步骤不匹配');
          if(step){step.status='in_progress';step.actionId=proposal.id;proposal.sourceIds=[...new Set([...proposal.sourceIds,...step.sourceIds])];}
          const now=new Date().toISOString();life.actions.push({...structuredClone(proposal),autonomous:true,status:'PROPOSED',createdAt:now,updatedAt:now});
        }
        mergeDuplicateGoals({...life,petId},new Date().toISOString());
        return {};
      });
      if(signal.aborted||this.gate.signal.aborted)throw new Error('认知已停止');
      if(result.proposal)await this.runAction(petId,result.proposal.id,signal);
    });
  }
  private shouldHold(state:CanonicalEnvelope,action:LifeState['actions'][number]):boolean {
    const plan=state.life.cognitivePlans?.find(p=>p.steps.some(step=>step.actionId===action.id));
    if(plan?.status==='paused')return true;
    if(plan?.status==='active'){
      try{checkSpirit(state.life,action.actionType);}catch{return true;}
    }
    const visited=new Set<string>();
    let id=action.goalId;
    while(id&&!visited.has(id)){
      visited.add(id);
      const goal=state.life.goals.find(g=>g.id===id);
      if(goal?.status==='paused'||goal?.status==='deferred')return true;
      id=goal?.parentId;
    }
    return false;
  }

  private async runAction(petId:string,actionId:string,signal:AbortSignal):Promise<void>{
    const state=await this.reader.loadEnvelope(petId);if(!state||state.life.constraints.paused||signal.aborted||this.gate.signal.aborted)return;
    const action=state.life.actions.find(a=>a.id===actionId);if(!action)return;
    if(action.status==='PROPOSED'){
      try {if(!goalIsRunnable(state.life,action.goalId))throw Error('行动目标已暂停或失效');validateActionParameters(action.actionType,action.parameters);if(!this.dispatcher.hasExecutor(action.actionType))throw Error('行动执行器不可用');const latest:LifeState={...structuredClone(state.life),petId,version:state.version,...this.projectBody(state)};validateProposal(latest,{...action,expectedStateVersion:state.version});}
      catch(error){await this.rejectProposal(petId,actionId,error instanceof Error?error.message:'行动不可用');return;}
      try{await this.actions.queue(petId,actionId,state.version);}catch(error){
        const message=error instanceof Error?error.message:'';
        if(!/当前桌面空间或工作状态不允许走动|她在网页工地里|她在稻田里|精神不足|探索权限不可用|探索额度配置无效|今日探索额度已用完|今日联网搜索额度已用完|探索饭钱配置无效|模拟饭钱不足|图片来源无效/.test(message))throw error;
        const fresh=await this.reader.loadEnvelope(petId);if(fresh?.life.actions.find(a=>a.id===actionId)?.status==='PROPOSED')await this.rejectProposal(petId,actionId,message);else throw error;return;
      }
    }
    const fresh=await this.reader.loadEnvelope(petId);
    if(!signal.aborted&&!this.gate.signal.aborted&&fresh?.life.actions.find(a=>a.id===actionId)?.status==='PENDING'){
      const pending=fresh.life.actions.find(a=>a.id===actionId)!;
      if(this.shouldHold(fresh,pending))return;
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
      const action=state.life.actions.find(a=>(a.status==='PROPOSED'||a.status==='PENDING')&&
        !this.shouldHold(state,a));
      if(action){await this.runAction(petId,action.id,signal);return true;}
      const scores=new Map(rankGoals({...state.life,...this.projectBody(state),petId,version:state.version}).map(g=>[g.goalId,g.score]));
      const runnable=(plan:CognitivePlan)=> {
        if(plan.status!=='active'||!goalIsRunnable(state.life,plan.goalId)||
          plan.sourceIds.some(id=>Object.hasOwn(state.life.invalidSources,id))||
          plan.steps.some(step=>['in_progress','awaiting_receipt','failed'].includes(step.status)))return false;
        const next=plan.steps.find(step=>step.status==='pending');
        if(!next)return false;
        try{checkSpirit(state.life,next.actionType);return true;}catch{return false;}
      };
      const plan=(state.life.cognitivePlans??[]).filter(runnable)
        .sort((a,b)=>(scores.get(b.goalId??'')??0)-(scores.get(a.goalId??'')??0))[0];
      const step=plan?.steps.find(s=>s.status==='pending');if(!plan||!step||!step.parameters)return false;
      const id=randomUUID();
      await this.uow.apply(petId,state.version,draft=>{
        const currentPlan=draft.life.cognitivePlans?.find(p=>p.id===plan.id),currentStep=currentPlan?.steps.find(s=>s.id===step.id);
        if(!currentPlan||currentPlan.status!=='active'||!currentStep||currentStep.status!=='pending')throw new Error('计划已变化');
        const parameters=structuredClone(currentStep.parameters);
        const sourceIds=[...currentStep.sourceIds];
        if(currentStep.readSearchResult){
          const previous=currentPlan.steps[currentPlan.steps.indexOf(currentStep)-1];
          const receipt=draft.life.receipts.find(r=>r.actionId===previous?.actionId&&r.status==='COMPLETED');
          const evidence=previous?.receiptEventId;
          if(evidence&&!Object.hasOwn(draft.life.invalidSources,evidence)&&typeof receipt?.details.documentUrl==='string'){
            parameters.url=receipt.details.documentUrl;
            sourceIds.push(evidence);
          }
        }
        const proposal={id,petId,actionType:currentStep.actionType,parameters,priority:50,interruptPolicy:'safe-point' as const,requiredCapabilities:[...currentStep.requiredCapabilities],expectedStateVersion:draft.version,sourceIds:[...new Set(sourceIds)],...(currentStep.goalId?{goalId:currentStep.goalId}:{})};
        const latest:LifeState={...structuredClone(draft.life),petId,version:draft.version,...this.projectBody(draft)};
        try{validateActionParameters(proposal.actionType,proposal.parameters);if(!this.dispatcher.hasExecutor(proposal.actionType))throw Error('执行器不可用');validateProposal(latest,proposal);}catch(error){currentStep.status='failed';currentPlan.status='failed';const now=new Date().toISOString();draft.life.events.push({eventId:'plan-failed:'+randomUUID(),petId,type:'plan.failed',source:'coordinator',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{planId:currentPlan.id,reason:error instanceof Error?error.message:'计划不可用'}});return {};}
        const now=new Date().toISOString();
        currentStep.sourceIds=proposal.sourceIds;
        currentPlan.sourceIds=[...new Set([...currentPlan.sourceIds,...proposal.sourceIds])];
        currentStep.status='in_progress';currentStep.actionId=id;draft.life.actions.push({...proposal,autonomous:true,status:'PROPOSED',createdAt:now,updatedAt:now});return {};
      });
      await this.runAction(petId,id,signal);return true;});
  }
}
