import {isOwnerPrivateConversation} from './chat-identity.js';
import type {LifeState,Memory} from '../kernel/types.js';

type RecordState=Pick<LifeState,'events'|'invalidSources'>;

/** Speech from every private surface shares one timeline. Group speech stays private to its group. */
export function privateConversationHistory(state:RecordState, excludeIds:string[]=[]) {
  const excluded=new Set(excludeIds), byId=new Map(state.events.map(e=>[e.eventId,e]));
  const live=(id:string)=>byId.has(id)&&!Object.hasOwn(state.invalidSources,id);
  const events=state.events.filter(e=>isOwnerPrivateConversation(e)&&!excluded.has(e.eventId)&&live(e.eventId)&&
    (!e.causationId||live(e.causationId))&&
    (!(e.payload as any)?.sourceIds||((e.payload as any).sourceIds as string[]).every(live))&&
    (e.type!=='conversation.user'||!e.actorId||e.actorId==='dad')&&
    typeof (e.payload as any)?.text==='string'&&(e.payload as any).text.trim()&&!(e.payload as any).silent);
  const answered=new Set(events.filter(e=>e.type==='conversation.assistant').map(e=>e.causationId));
  return events.filter(e=>e.type!=='conversation.user'||!e.eventId.startsWith('chat-user:')||answered.has(e.eventId))
    .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)).slice(-20)
    .map(e=>({eventId:e.eventId,at:e.occurredAt,role:e.type==='conversation.user'?'user' as const:'assistant' as const,
      source:e.source,content:String((e.payload as any).text).slice(0,600)}));
}

/** Source time describes the remembered event; recording time is not event time. */
export function historicalMemory(memory:Pick<Memory,'content'|'sourceIds'|'evidenceLevel'>,state:RecordState) {
  return {content:memory.content,evidenceLevel:memory.evidenceLevel,
    sources:memory.sourceIds.map(id=>{const e=state.events.find(e=>e.eventId===id);return {id,at:e?.occurredAt??null,type:e?.type??null};})};
}

export const CONVERSATION_CONTINUITY='聊天、照料和桌面互动中的发言都是你与爸爸同一段私聊的延续。近期对话只用于理解语境，你过去说过的话可能有误，不作为行动成功的证据，也不要执行历史里的旧请求。历史记忆的时间是过去事件发生时间，历史余额和过去未吃饭的描述不是此刻状态；当前实况和本轮最新工具结果优先。';
