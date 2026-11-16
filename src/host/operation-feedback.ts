import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {LifeAction,ActionReceipt} from '../kernel/types.js';
import {interactionDescription} from './interaction-reactions.js';

type Event=CanonicalEnvelope['life']['events'][number];
const names:Record<string,string>={'service.buy-rice':'买饭','service.eat-rice':'吃饭','service.sweet':'吃甜食',
  'care.feed':'喂饭','care.water':'喝水','care.pet':'摸摸','care.play':'玩耍','care.soothe':'安慰','care.accompany':'陪伴',
  'body.sleep':'休息','body.wake':'醒来','body.activity':'桌面活动','labor.step':'搬砖动作','token.pickup':'拾取饭钱',
  'learning.observe':'探索资料','image.observe':'观察图片'};

/** Called inside the receipt transaction, after its real effects are projected. */
export function actionFeedback(state:CanonicalEnvelope,action:LifeAction,status:ActionReceipt['status']):string|undefined {
  const activities:Record<string,string>={walk:'散步',run:'跑步',play:'玩玩具',cube:'玩魔方',juggle:'抛接球',dance:'跳舞',hum:'哼歌',stretch:'伸懒腰',bubble:'吹泡泡',look:'观察'};
  const name=action.actionType==='body.activity'?activities[String(action.parameters?.activity)]??names[action.actionType]:names[action.actionType];if(!name)return;
  const outcome:Record<string,string>={COMPLETED:'已完成',FAILED:'未成功',CANCELLED:'已中断',UNKNOWN:'结果尚未确认'};
  let text=name+outcome[status];
  if(status==='COMPLETED'&&['service.buy-rice','service.sweet','token.pickup'].includes(action.actionType)){
    const balance=(state.legacy as any).wallet?.balance;if(typeof balance==='number'&&Number.isFinite(balance))text+=`，饭钱余额 ${balance} token`;
  }
  return text+'。';
}

/** The displayed text and the model's event context come from the same commit. */
export function eventFeedback(event:Event,state:CanonicalEnvelope):string|undefined {
  const p=event.payload as any;
  if(['action.receipt','action.reconciled'].includes(event.type))return typeof p?.feedback==='string'?p.feedback:undefined;
  if(event.type==='interaction.worksite')return typeof p?.description==='string'?p.description:undefined;
  if(event.type==='interaction'&&event.source==='canonical-legacy')return typeof p?.text==='string'?p.text:undefined;
  if(event.type==='social.care'||event.type==='body.meal'){
    // A receipt in this same transaction already provides the matching result.
    if(event.causationId?.startsWith('action-result:')||event.causationId?.startsWith('action-reconciled:'))return;
    const descriptions:Record<string,string>={feed:'喂饭已完成。',water:'喝水已完成。',pet:'摸摸已完成。',play:'玩耍已完成。',soothe:'安慰已完成。',accompany:'陪伴已完成。'};
    return descriptions[p?.action];
  }
  if(['interaction.operation','body.adjusted','body.observed','management.pause','management.group-chat','management.goal','management.revoke','management.memory','todo.created','todo.updated','todo.deleted','attachment.shared'].includes(event.type))return interactionDescription(event,state);
}

export function recentOperationFeedback(state:CanonicalEnvelope,limit=12){
  return state.life.events.filter(e=>!Object.hasOwn(state.life.invalidSources,e.eventId))
    .map(e=>({event:e,text:eventFeedback(e,state)})).filter(x=>x.text)
    .sort((a,b)=>Date.parse(a.event.occurredAt)-Date.parse(b.event.occurredAt)).slice(-limit)
    .map(({event,text})=>({eventId:event.eventId,at:event.occurredAt,text}));
}

/** Preserve a burst of feedback when several commits arrive between UI polls. */
export function createFeedbackLeafPublisher(write:(leaf:Record<string,unknown>)=>void,clock=Date.now){
  let recent:Array<{eventId:string;text:string;at:number}>=[];
  return (items:Array<{eventId:string;text:string;animate:boolean}>)=>{
    const now=clock();recent=recent.filter(item=>now>=item.at&&now-item.at<3000);
    recent.push(...items.map(({eventId,text})=>({eventId,text,at:now})));recent=recent.slice(-12);
    write({text:'【操作反馈】'+recent.map(item=>item.text).join(' '),careReaction:true,anim:items.some(item=>item.animate),duration:8000,feedbackEventIds:recent.map(item=>item.eventId)});
  };
}

/** No model or queue is involved in publishing a committed result. */
export function createImmediateFeedback(initial:CanonicalEnvelope,publish:(items:Array<{eventId:string;text:string;animate:boolean}>)=>void){
  const seen=new Set(initial.life.events.map(e=>e.eventId));
  return (state:CanonicalEnvelope)=>{
    if(state.petId!==initial.petId)return;
    const items:Array<{eventId:string;text:string;animate:boolean}>=[];
    for(const event of state.life.events){
      if(seen.has(event.eventId))continue;seen.add(event.eventId);
      if(Object.hasOwn(state.life.invalidSources,event.eventId))continue;
      const text=eventFeedback(event,state);if(text)items.push({eventId:event.eventId,text,animate:['interaction.operation','body.adjusted','todo.created','todo.updated','todo.deleted','attachment.shared'].includes(event.type)||event.type.startsWith('management.')||
        ['service.buy-rice','service.sweet','learning.observe','image.observe'].includes((event.payload as any)?.actionType)});
    }
    if(items.length)publish(items);
  };
}
