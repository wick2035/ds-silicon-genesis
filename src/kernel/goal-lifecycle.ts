import {randomUUID} from 'node:crypto';
import type {LifeState,Goal} from './types.js';
const active=(s:Pick<LifeState,'invalidSources'>,id:string)=>!Object.hasOwn(s.invalidSources,id);
export const lifeDay = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'});

export function goalConditions(s:LifeState, balance?:number):string {
 const {body,constraints,legacyContext}=s;
 const companion=legacyContext?.companion as {wallet?:{balance?:number}}|undefined;
 return JSON.stringify([body.sleeping,body.restrained,body.injured,body.stamina>=40,body.pain>=50,
  constraints.remainingBudget>0,constraints.permissions.slice().sort(),constraints.capabilities.filter(c=>c.enabled).map(c=>c.name).sort(),
  Math.floor((balance??companion?.wallet?.balance??0)/20)]);
}

export function goalsDueForReview(s:LifeState,now=Date.now(),balance?:number):Goal[] {
 const sources=new Map(s.events.map(e=>[e.eventId,e.occurredAt]));
 const due=s.goals.filter(g=>g.status==='deferred'&&!g.mergedInto&&g.sourceIds.length
  &&g.sourceIds.every(id=>active(s,id)&&sources.has(id))
  &&(!g.parentId||s.goals.some(parent=>parent.id===g.parentId&&parent.status==='active')));
 const conditions=goalConditions(s,balance);
 const firstSource=(g:Goal)=>g.sourceIds.map(id=>sources.get(id)!).sort()[0];
 const legacy=s.legacyGoalReviewDay===lifeDay.format(now)?undefined:due.filter(g=>!g.review)
  .sort((a,b)=>firstSource(a).localeCompare(firstSource(b))||a.id.localeCompare(b.id))[0];
 return [...(legacy?[legacy]:[]),...due.filter(g=>g.review&&(Date.parse(g.review.at)<=now||g.review.conditions!==conditions))].slice(0,5);
}

export function reviewGoal(s:LifeState,input:{goalId:string;decision:'resume'|'defer'|'abandon';reason:string;hours?:number},now:number,balance?:number):void {
 const goal=s.goals.find(g=>g.id===input.goalId);
 const due=goalsDueForReview(s,now,balance);
 if(!goal||!(goal.status==='active'||due.some(g=>g.id===goal.id))||!goal.sourceIds.every(id=>active(s,id)))throw Error('目标暂不可复核');
 if(goal.status==='deferred'&&!goal.review)s.legacyGoalReviewDay=lifeDay.format(now);
 goal.status={resume:'active',defer:'deferred',abandon:'abandoned'}[input.decision] as Goal['status'];
 goal.review={at:new Date(now+(input.hours??24)*3600000).toISOString(),reason:input.reason,conditions:goalConditions(s,balance)};
 for(const plan of s.cognitivePlans??[]){
  if(plan.goalId!==goal.id||!['active','paused'].includes(plan.status))continue;
  setGoalPlanStatus(plan,goal.status);
  plan.reviewReason=input.reason;
 }
 const at=new Date(now).toISOString();
 s.events.push({eventId:'goal-reviewed:'+randomUUID(),petId:s.petId,type:'goal.reviewed',source:'model',occurredAt:at,receivedAt:at,
  evidenceLevel:'inferred',payload:{goalId:goal.id,decision:input.decision,description:input.reason,sourceIds:[...goal.sourceIds]}});
}

export function setGoalPlanStatus(plan:NonNullable<LifeState['cognitivePlans']>[number], status:Goal['status']):void {
 if(status==='abandoned'){plan.status='abandoned';return;}
 if(status==='paused'||status==='deferred'){plan.status='paused';return;}
 if(status==='active'){
  plan.status=plan.steps.some(step=>step.status==='failed')?'failed':
    plan.steps.every(step=>step.status==='completed')?'completed':'active';
 }
}

export function invalidatePlans(s:LifeState):void {
 for(const plan of s.cognitivePlans??[]){
  if(!['active','paused'].includes(plan.status)||plan.sourceIds.every(id=>active(s,id)))continue;
  plan.status='failed';
  plan.reviewReason='计划的依据已变更，等待重新规划';
 }
}

export function goalIsRunnable(s:Pick<LifeState,'goals'|'invalidSources'>,id?:string):boolean {
 if(!id)return true;
 const visited=new Set<string>();
 while(id){
  if(visited.has(id))return false;
  visited.add(id);
  const goal:Goal|undefined=s.goals.find(g=>g.id===id);
  if(!goal||goal.status!=='active'||!goal.sourceIds.every(source=>active(s,source)))return false;
  id=goal.parentId;
 }
 return true;
}

export function completeStages(s:LifeState,goal:Goal,eventId:string):void {
 let parent=s.goals.find(g=>g.id===goal.parentId);
 while(parent?.status==='active'&&parent.completion?.type==='stages'){
  const children=s.goals.filter(g=>g.parentId===parent!.id&&!g.mergedInto);
  if(children.length!==(parent.completion.count??2)||children.some(g=>g.status!=='completed'||!g.sourceIds.every(id=>active(s,id))))break;
  parent.status='completed';
  parent.sourceIds=[...new Set([...parent.sourceIds,eventId,...children.flatMap(g=>g.sourceIds)])];
  parent=s.goals.find(g=>g.id===parent!.parentId);
 }
}
export interface GoalUpdate {goalId:string;kind:'progress'|'reprioritize'|'complete'|'understood';evidenceId:string;priority?:number;understanding?:string}
export function isKnowledgeGoal(goal:Goal):boolean {
 return !goal.completion && (goal.research===true||goal.kind==='explore'||goal.kind==='self-directed'&&/弄明白|了解|理解|是什么意思|为什么|怎么回事|what|why|understand/i.test(goal.title));
}
export function resolveGoalId(s:Pick<LifeState,'goals'>,id:string):string {
 const visited=new Set<string>();let goal=s.goals.find(g=>g.id===id);
 while(goal?.mergedInto&&!visited.has(goal.id)){visited.add(goal.id);id=goal.mergedInto;goal=s.goals.find(g=>g.id===id);}return id;
}
/** Exact question identity only. Similar questions can require different answers. */
export function mergeDuplicateGoals(s:Pick<LifeState,'petId'|'goals'|'events'|'actions'|'cognitivePlans'|'invalidSources'>,now:string):number {
 const seen=new Map<string,Goal>();let count=0;
 for(const goal of s.goals){
  if(goal.status!=='active'||!goal.sourceIds.every(id=>!Object.hasOwn(s.invalidSources,id)))continue;
  const title=goal.title.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu,'');
  const key=JSON.stringify([title,goal.parentId??'',goal.completion??null,isKnowledgeGoal(goal)?'knowledge':goal.kind]);
  const canonical=seen.get(key);if(!canonical){seen.set(key,goal);continue;}
  canonical.sourceIds=[...new Set([...canonical.sourceIds,...goal.sourceIds])];
  canonical.priority=Math.max(canonical.priority,goal.priority);canonical.urgency=Math.max(canonical.urgency,goal.urgency);
  goal.status='abandoned';goal.mergedInto=canonical.id;
  for(const action of s.actions)if(action.goalId===goal.id)action.goalId=canonical.id;
  const current=(s.cognitivePlans??[]).find(p=>p.goalId===canonical.id&&['active','paused'].includes(p.status));
  for(const plan of s.cognitivePlans??[]){
   if(plan.goalId===goal.id){
    plan.goalId=canonical.id;
    if(current&&['active','paused'].includes(plan.status)){
     plan.status='abandoned';
     plan.reviewReason='目标已合并，沿用原目标的计划';
    }
   }
   for(const step of plan.steps)if(step.goalId===goal.id)step.goalId=canonical.id;
  }
  for(const child of s.goals)if(child.parentId===goal.id)child.parentId=canonical.id;
  s.events.push({eventId:'goal-merged:'+randomUUID(),petId:s.petId,type:'goal.merged',source:'kernel',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{goalId:goal.id,mergedInto:canonical.id,sourceIds:[...goal.sourceIds]}});count++;
 }
 return count;
}
/** A model suggestion is accepted only if it points to an actual, related receipt. */
export function applyGoalProposal(s:LifeState,p:GoalUpdate,now:string):void {
 const goal=s.goals.find(g=>g.id===resolveGoalId(s,p.goalId));
 if(p.kind==='understood'&&goal?.status==='completed'&&goal.sourceIds.includes(p.evidenceId)&&goal.sourceIds.every(id=>active(s,id)))return;
 if(!goal||goal.status!=='active'||!goal.sourceIds.every(id=>active(s,id)))throw Error('目标不可用');
 if(p.kind==='understood'){
  const source=s.events.find(e=>e.eventId===p.evidenceId&&active(s,e.eventId));
  const payload=source?.payload as Record<string,unknown>|undefined;
  const owner=source?.type==='conversation.user'&&source.actorId==='dad'&&['desktop','user','qq-c2c'].includes(source.source);
  const document=!!source&&['action.receipt','action.reconciled'].includes(source.type)&&s.receipts.some(r=>r.receiptId===source.causationId&&r.status==='COMPLETED'&&s.actions.some(a=>a.id===r.actionId&&a.actionType==='learning.observe'&&a.sourceIds.every(id=>active(s,id))));
  const memory=s.memories.some(m=>m.valid&&m.sourceIds.includes(p.evidenceId)&&m.sourceIds.every(id=>active(s,id))&&m.content.trim());
  const linkedRead=!goal.research||s.receipts.some(r=>r.receiptId===source?.causationId&&r.status==='COMPLETED'&&s.actions.some(a=>
   a.id===r.actionId&&a.goalId===goal.id&&a.actionType==='learning.observe'&&a.parameters.kind==='fetch'));
  if(!linkedRead||!isKnowledgeGoal(goal)||!source||!['observed','verified'].includes(source.evidenceLevel)||!(owner&&typeof payload?.text==='string'&&payload.text.trim()||document)||!memory||typeof p.understanding!=='string'||p.understanding.trim().length<20||p.understanding.length>1000)throw Error('知识目标缺少解释来源或理解记录');
  const id='goal-understood:'+randomUUID(),summary=p.understanding.trim();
  s.events.push({eventId:id,petId:s.petId,type:'goal.understood',source:'model',occurredAt:now,receivedAt:now,evidenceLevel:'inferred',causationId:source.eventId,payload:{goalId:goal.id,understanding:summary,sourceIds:[source.eventId]}});
  s.memories.push({id:'memory:'+id,kind:'semantic',content:'关于“'+goal.title+'”的理解：'+summary,sourceIds:[source.eventId,id],evidenceLevel:'inferred',valid:true,createdAt:now});
  goal.status='completed';goal.sourceIds=[...new Set([...goal.sourceIds,source.eventId,id])];completeStages(s,goal,id);return;
 }
 const event=s.events.find(e=>e.eventId===p.evidenceId&&active(s,e.eventId)&&['observed','verified'].includes(e.evidenceLevel));
 const action=s.actions.find(a=>a.id===(event?.payload as any)?.actionId&&a.goalId===goal.id), receipt=s.receipts.find(r=>r.receiptId===event?.causationId&&r.actionId===action?.id&&r.status==='COMPLETED');
 if(!event||!action||!receipt)throw Error('目标进度缺少对应的真实完成回执');
 if(p.kind==='complete'){
   const c=goal.completion;if(c?.type!=='read-url'||action.actionType!=='learning.observe'||action.parameters.kind!=='fetch'||action.parameters.url!==c.url)throw Error('目标完成条件与回执不匹配');
   goal.status='completed';
 } else if(p.kind==='reprioritize'){if(!Number.isFinite(p.priority)||p.priority!<0||p.priority!>100)throw Error('目标优先度无效');goal.priority=p.priority!;}
 const eventId='goal-progress:'+randomUUID();s.events.push({eventId,petId:s.petId,type:'goal.progress',source:'kernel',occurredAt:now,receivedAt:now,evidenceLevel:'observed',causationId:event.eventId,payload:{goalId:goal.id,kind:p.kind,sourceIds:[event.eventId]}});
 if(!goal.sourceIds.includes(event.eventId))goal.sourceIds.push(event.eventId);
 if(goal.status==='completed'){completeStages(s,goal,eventId);}
}
/** Only commitments with an explicit deadline can be marked broken by time. */
export function expireCommitments(s:Pick<LifeState,'petId'|'commitments'|'events'|'invalidSources'>,now:string):void {
 const at=Date.parse(now);if(!Number.isFinite(at))throw Error('时间无效');
 for(const c of s.commitments){if(c.status!=='open'||!c.dueAt||!Number.isFinite(Date.parse(c.dueAt))||Date.parse(c.dueAt)>at||!c.sourceIds.every(id=>!Object.hasOwn(s.invalidSources,id)))continue;c.status='broken';const id='commitment-expired:'+randomUUID();s.events.push({eventId:id,petId:s.petId,type:'commitment.expired',source:'clock',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{commitmentId:c.id,dueAt:c.dueAt,sourceIds:[...c.sourceIds]}});c.sourceIds.push(id);}
}
/** Completion requires an explicit action link, never text matching. */
export function completeReceiptGoals(s:LifeState,actionId:string,eventId:string,now:string):void {
 const action=s.actions.find(a=>a.id===actionId), event=s.events.find(e=>e.eventId===eventId);if(!action||!event)return;
 if(action.goalId){const g=s.goals.find(x=>x.id===action.goalId);if(g?.status==='active'&&g.completion?.type==='read-url'&&action.actionType==='learning.observe'&&action.parameters.kind==='fetch'&&action.parameters.url===g.completion.url)applyGoalProposal(s,{goalId:g.id,kind:'complete',evidenceId:eventId},now);}
 for(const c of s.commitments){if(c.status!=='open'||c.actionId!==actionId||!c.sourceIds.every(id=>active(s,id)))continue;const receipt=s.receipts.find(r=>r.receiptId===event.causationId&&r.actionId===actionId&&r.status==='COMPLETED');if(!receipt)continue;c.status='fulfilled';c.sourceIds.push(eventId);}
}
