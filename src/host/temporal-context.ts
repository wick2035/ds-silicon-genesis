import type {CanonicalEnvelope} from '../storage/postgres.js';
import {companionTime} from './companion-personality.js';

/** Small, independently budgeted timeline of observed events and confirmed actions. */
export function temporalContext(envelope:Readonly<CanonicalEnvelope>, now=Date.now(), excludeIds:string[]=[]) {
  const life=envelope.life, invalid=life.invalidSources??{};
  const live=(id:string)=>!Object.hasOwn(invalid,id);
  const stamp=(at:string)=>({at,localTime:new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Hong_Kong',dateStyle:'short',timeStyle:'medium'}).format(Date.parse(at)),ageSeconds:Math.floor((now-Date.parse(at))/1000)});
  const validTime=(at:string)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now;
  const events=(life.events??[]).filter(e=>live(e.eventId)&&(!e.causationId||live(e.causationId))&&validTime(e.occurredAt));
  const actions=(life.actions??[]).flatMap(a=>{
    if(a.status!=='COMPLETED'||!(a.sourceIds??[]).every(live))return [];
    const r=(life.receipts??[]).find(r=>r.receiptId===a.receiptId&&r.actionId===a.id&&r.status==='COMPLETED'&&live(r.receiptId)&&validTime(r.occurredAt));
    if(!r||!events.some(e=>e.type==='action.receipt'&&e.causationId===r.receiptId))return [];
    if(!['body.sleep','body.wake','service.eat-rice','care.feed','care.water','body.activity','labor.step'].includes(a.actionType))return [];
    return [{type:a.actionType,...stamp(r.occurredAt),...(a.actionType==='body.sleep'?{mode:a.parameters?.mode==='nap'?'nap':'sleep'}:{})}];
  }).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const transitions=actions.filter(a=>a.type==='body.sleep'||a.type==='body.wake');
  const wake=[...transitions].reverse().find(a=>a.type==='body.wake');
  const beforeWake=wake?transitions.filter(a=>Date.parse(a.at)<Date.parse(wake.at)).at(-1):undefined;
  const rest=beforeWake?.type==='body.sleep'?beforeWake:undefined;
  const recentEvents=events.filter(e=>['social.care','body.meal','interaction.worksite','interaction.operation','body.observed'].includes(e.type))
    .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)).slice(-8)
    .map(e=>({type:e.type,...stamp(e.occurredAt),actor:e.actorId??null,detail:JSON.stringify(e.payload)?.slice(0,300)??''}));
  return {clock:companionTime(envelope,now,excludeIds),
    lastConfirmedWake:wake??null,lastRestBeforeWake:rest??null,
    lastRestDurationSeconds:wake&&rest?Math.floor((Date.parse(wake.at)-Date.parse(rest.at))/1000):null,
    recentConfirmedActions:actions.slice(-6),recentEvents};
}

export const TEMPORAL_RULES='时间线的 localTime 是香港时间，ageSeconds 是距此刻的秒数；按发生时间和间隔理解对话及行为，回答几点时可直接使用有确认的时间。lastConfirmedWake 是最近确认醒来，lastRestDurationSeconds 仅是与前一次已确认入睡之间的间隔；不能推断期间一直睡着，也不能把更早的醒来当成现在的状态。近期事件按真实来源归因，喂饭、吃饭与饱腹是不同事实；过去发生过不等于刚发生或现在正在发生。记录缺失、失败或未确认时不猜。';
