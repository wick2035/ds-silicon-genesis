import {createHash} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {LifeEvent} from '../kernel/types.js';
import {assertGroupReplyAllowed} from './qq-group-access.js';

export const GROUP_SLEEP_REPLY='本鱼正在睡觉，晚点回';
export type QQTurnResult=string|null|{replies:Array<{anchorEventId:string;text:string;mentionActorId?:string;freshOnly?:boolean}>};

/** QQ allows five minutes; leave two minutes for queued generation and delivery. */
export function groupReplyWindow(event:LifeEvent,now=Date.now()):boolean {
  const age=now-Date.parse(event.occurredAt);
  return Number.isFinite(age)&&age>=-60000&&age<=180000;
}

export function sleepReplyAnchor(state:CanonicalEnvelope,preferred:LifeEvent[]):LifeEvent|undefined {
  const identity=(state.legacy as any).qq?.identity;
  if(!identity?.groupOpenid)return;
  const groupId=createHash('sha256').update(identity.appId+':'+identity.groupOpenid).digest('hex');
  for(const event of [...state.life.events,...preferred].reverse()){
    const p=event.payload as any;
    if(event.source!=='qq'||event.type!=='social.message'||p?.scene!=='group'||p.groupId!==groupId||!groupReplyWindow(event)||
      state.life.actions.filter(a=>a.actionType==='qq.send'&&a.parameters.scene==='group'&&a.parameters.replyTo===p.messageId).length>=3)continue;
    try{assertGroupReplyAllowed(state,event.eventId);if(!Object.hasOwn(state.life.invalidSources,event.eventId))return event;}catch{/* Retired source. */}
  }
}

/** Read the actual rest state without advancing or spending spirit. */
export function groupSleeping(state:CanonicalEnvelope,now=Date.now()):boolean {
  return state.humanity?.sleeping===true || Number(state.humanity?.restingUntil)>now ||
    state.life.spirit?.mode==='sleep' || state.life.spirit?.mode==='nap';
}

export function trustedGroupMessages(state:CanonicalEnvelope,ids:string[]):LifeEvent[] {
  const events=ids.map(id=>{
    const event=state.life.events.find(e=>e.eventId===id);
    if(!event || event.source!=='qq' || event.type!=='social.message' || (event.payload as any)?.scene!=='group' ||
      !event.actorId || Object.hasOwn(state.life.invalidSources,id))throw Error('群聊来源不可用');
    assertGroupReplyAllowed(state,id);return event;
  });
  if(events.some(e=>(e.payload as any)?.groupId!==(events[0]?.payload as any)?.groupId))throw Error('群聊消息不在同一个群');
  return events;
}

export function deferSleepingMessages(state:CanonicalEnvelope,events:LifeEvent[]):void {
  for(const event of events)if(event.actorId!=='dad')(event.payload as Record<string,unknown>).sleepDeferred=true;
  const qq=(state.legacy as any).qq;
  if(!qq)return;
  const ids=new Set<string>([...(qq.sleepInbox?.eventIds??[]),...events.filter(e=>e.actorId!=='dad').map(e=>e.eventId)]);
  qq.sleepInbox={...qq.sleepInbox,eventIds:state.life.events.filter(e=>ids.has(e.eventId)&&!Object.hasOwn(state.life.invalidSources,e.eventId)).slice(-3).map(e=>e.eventId)};
}

/** Deterministic, idempotent conversation evidence; no model/budget/tool path. */
export function recordSleepingReply(state:CanonicalEnvelope,ids:string[]):string {
  const events=trustedGroupMessages(state,ids);
  if(!events.length||events.some(e=>e.actorId==='dad'))throw Error('睡眠回复来源无效');
  const id=createHash('sha256').update(ids.join('|')).digest('hex'),userId='qq-sleep-user:'+id,answerId='qq-sleep-answer:'+id;
  if(state.life.events.some(e=>e.eventId===answerId))return GROUP_SLEEP_REPLY;
  const at=new Date().toISOString(),groupId=(events[0].payload as any).groupId;
  state.life.events.push({eventId:userId,petId:state.petId,type:'conversation.user',source:'qq-group',
    ...(events.length===1?{actorId:events[0].actorId}:{}),occurredAt:at,receivedAt:at,evidenceLevel:'observed',causationId:ids[0],
    payload:{text:events.length===1?(events[0].payload as any).text:JSON.stringify(events.map(e=>({actorId:e.actorId,text:(e.payload as any).text}))),groupId,sourceIds:ids,groupBatch:events.length>1}});
  state.life.events.push({eventId:answerId,petId:state.petId,type:'conversation.assistant',source:'qq-group',
    occurredAt:at,receivedAt:at,evidenceLevel:'observed',causationId:userId,
    payload:{text:GROUP_SLEEP_REPLY,groupId,sourceIds:[userId,...ids],localReply:true,reason:'sleep'}});
  return GROUP_SLEEP_REPLY;
}
