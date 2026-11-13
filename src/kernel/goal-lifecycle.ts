import {randomUUID} from 'node:crypto';
import type {LifeState,Goal} from './types.js';
const active=(s:LifeState,id:string)=>!Object.hasOwn(s.invalidSources,id);
/** A model suggestion is accepted only if it points to an actual, related receipt. */
export function applyGoalProposal(s:LifeState,p:{goalId:string;kind:'progress'|'reprioritize'|'complete';evidenceId:string;priority?:number},now:string):void {
 const goal=s.goals.find(g=>g.id===p.goalId);if(!goal||goal.status!=='active'||!goal.sourceIds.every(id=>active(s,id)))throw Error('目标不可用');
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
