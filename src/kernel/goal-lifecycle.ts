import {randomUUID} from 'node:crypto';
import type {LifeState,Goal} from './types.js';
const active=(s:LifeState,id:string)=>!Object.hasOwn(s.invalidSources,id);
export interface GoalUpdate {goalId:string;kind:'progress'|'reprioritize'|'complete'|'understood';evidenceId:string;priority?:number;understanding?:string}
export function isKnowledgeGoal(goal:Goal):boolean {
 return !goal.completion && (goal.kind==='explore'||goal.kind==='self-directed'&&/弄明白|了解|理解|是什么意思|为什么|怎么回事|what|why|understand/i.test(goal.title));
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
  for(const plan of s.cognitivePlans??[])for(const step of plan.steps)if(step.goalId===goal.id)step.goalId=canonical.id;
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
  if(!isKnowledgeGoal(goal)||!source||!['observed','verified'].includes(source.evidenceLevel)||!(owner&&typeof payload?.text==='string'&&payload.text.trim()||document)||!memory||typeof p.understanding!=='string'||p.understanding.trim().length<20||p.understanding.length>1000)throw Error('知识目标缺少解释来源或理解记录');
  const id='goal-understood:'+randomUUID(),summary=p.understanding.trim();
  s.events.push({eventId:id,petId:s.petId,type:'goal.understood',source:'model',occurredAt:now,receivedAt:now,evidenceLevel:'inferred',causationId:source.eventId,payload:{goalId:goal.id,understanding:summary,sourceIds:[source.eventId]}});
  s.memories.push({id:'memory:'+id,kind:'semantic',content:'关于“'+goal.title+'”的理解：'+summary,sourceIds:[source.eventId,id],evidenceLevel:'inferred',valid:true,createdAt:now});
  goal.status='completed';goal.sourceIds=[...new Set([...goal.sourceIds,source.eventId,id])];return;
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
