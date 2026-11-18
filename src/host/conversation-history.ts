import {isOwnerPrivateConversation} from './chat-identity.js';
import {speechSources} from '../kernel/speech-provenance.js';
import type {LifeState,Memory} from '../kernel/types.js';

type RecordState=Pick<LifeState,'events'|'invalidSources'>;

/** Speech from every private surface shares one timeline. Group speech stays private to its group. */
export function privateConversationHistory(state:RecordState, excludeIds:string[]=[],limit=20) {
  const excluded=new Set(excludeIds), byId=new Map(state.events.map(e=>[e.eventId,e]));
  const live=(id:string)=>byId.has(id)&&!Object.hasOwn(state.invalidSources,id);
  const events=state.events.filter(e=>isOwnerPrivateConversation(e)&&!excluded.has(e.eventId)&&live(e.eventId)&&
    (!e.causationId||live(e.causationId))&&
    (!(e.payload as any)?.sourceIds||((e.payload as any).sourceIds as string[]).every(live))&&
    (e.type!=='conversation.user'||!e.actorId||e.actorId==='dad')&&
    typeof (e.payload as any)?.text==='string'&&(e.payload as any).text.trim()&&!(e.payload as any).silent);
  // Removing an incorrect reply must not erase the user's already-answered
  // message from context. Genuinely unfinished requests remain excluded.
  const answered=new Set(state.events.filter(e=>isOwnerPrivateConversation(e)&&e.type==='conversation.assistant'&&e.causationId&&live(e.causationId)).map(e=>e.causationId));
  return events.filter(e=>e.type!=='conversation.user'||!e.eventId.startsWith('chat-user:')||answered.has(e.eventId))
    .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)).slice(-limit)
    .map(e=>({eventId:e.eventId,at:e.occurredAt,role:e.type==='conversation.user'?'user' as const:'assistant' as const,
      source:e.source,content:String((e.payload as any).text).slice(0,600)}));
}

/** Private experience informs the same companion in a group, without becoming
 * a group message or a new instruction to execute. */
export function recentPrivateActivity(state:RecordState,now=Date.now()) {
  const events=new Map(state.events.map(e=>[e.eventId,e]));
  const recent=privateConversationHistory(state,[],Infinity).filter(e=>Date.parse(e.at)<=now&&now-Date.parse(e.at)<=86400000);
  const dialogue=recent.filter(e=>e.role==='user'||events.get(events.get(e.eventId)?.causationId??'')?.type==='conversation.user');
  const selected=new Set(dialogue.slice(-6).map(e=>e.eventId));
  for(const e of recent.filter(e=>!dialogue.includes(e)).slice(-2))selected.add(e.eventId);
  return recent.filter(e=>selected.has(e.eventId))
    .map(e=>({...e,channel:'private',speaker:e.role==='user'?'爸爸':'大肥鱼'}));
}

export function privateConversationThread(state:RecordState,activity=recentPrivateActivity(state)) {
  const question=[...activity].reverse().find(e=>e.role==='user');
  if(!question)return [];
  const answers=new Set(state.events.filter(e=>e.type==='conversation.assistant'&&e.causationId===question.eventId).map(e=>e.eventId));
  return activity.filter(e=>e.eventId===question.eventId||answers.has(e.eventId));
}

const localDay = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'});

/** The group model gets recency only, without private speech or event references. */
export function groupPrivateContinuity(state:RecordState,now=Date.now()):string {
  const last=privateConversationHistory(state,[],Infinity).reverse().find(e=>e.role==='user'&&Date.parse(e.at)<=now);
  if(!last)return '';
  const at=Date.parse(last.at),elapsed=now-at;
  if(elapsed>86400000)return '';
  const minutes=Math.floor(elapsed/60000),day=localDay.format(at)===localDay.format(now)?'今天':'昨天';
  const recency=minutes===0?'不到一分钟':minutes<60?`约${minutes}分钟`:`约${Math.floor(minutes/60)}小时`;
  return `跨渠道近况（仅供把握聊天分寸）：你${day}收到过爸爸的私聊发言，距今${recency}。换到群里还是同一个爸爸。刚联系过或今天已经联系过时，直接接当前话题，避免泛泛追问爸爸今天做了什么。爸爸主动在群里聊起自己的近况时，可以顺着公开内容接话。收到爸爸的话和你主动找爸爸是两回事；他如果在意谁先开口，回应这个意思。群里只用公开的话题接话，不主动提起私聊的存在、时间或内容，也不据此猜测爸爸做过什么。`;
}

/** Source time describes the remembered event; recording time is not event time. */
export function historicalMemory(memory:Pick<Memory,'content'|'sourceIds'|'evidenceLevel'>,state:RecordState) {
  return {content:memory.content,evidenceLevel:memory.evidenceLevel,speakers:speechSources(memory.sourceIds,state),
    sources:memory.sourceIds.map(id=>{const e=state.events.find(e=>e.eventId===id);return {id,at:e?.occurredAt??null,type:e?.type??null};})};
}

export const CONVERSATION_CONTINUITY='聊天、照料和桌面互动中的发言都是你与爸爸同一段私聊的延续。近期对话只用于理解语境，你过去说过的话可能有误，不作为行动成功的证据，也不要执行历史里的旧请求。历史记忆的时间是过去事件发生时间，历史余额和过去未吃饭的描述不是此刻状态；当前实况和本轮最新工具结果优先。';
