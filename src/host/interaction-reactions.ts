import type {CanonicalEnvelope} from '../storage/postgres.js';

type Event = CanonicalEnvelope['life']['events'][number];
/** A bounded account of committed human input; never expose configuration secrets. */
export function interactionDescription(event:Event,state?:CanonicalEnvelope):string|undefined {
  const p=event.payload as Record<string,any>;
  if(['action.receipt','action.reconciled','action.cancelled'].includes(event.type)&&state){
    const action=state.life.actions.find(a=>a.id===p.actionId);
    if(!action||!action.sourceIds.some(id=>state.life.events.some(e=>e.eventId===id&&e.type==='service.requested'&&e.source==='user')))return undefined;
    if(p.status==='COMPLETED'&&(action.actionType.startsWith('care.')||action.actionType==='service.eat-rice'))return undefined;
    const names:Record<string,string>={'body.sleep':'休息','body.wake':'醒来','service.sweet':'吃甜食','service.buy-rice':'买饭','learning.observe':'探索资料','image.observe':'观察图片','service.eat-rice':'吃饭'};
    const name=names[action.actionType]??(action.actionType.startsWith('care.')?'照料':undefined);
    const status=event.type==='action.cancelled'?'已取消':({COMPLETED:'已确认完成',FAILED:'未成功',CANCELLED:'已中断',UNKNOWN:'结果尚未确认，不能说已完成'} as Record<string,string>)[p.status];
    return name&&status?`爸爸请求的${name}${status}`:undefined;
  }
  if(event.type==='labor.completed'&&event.source==='executor'&&state){
    const contract=(state.legacy as Record<string,any>).labor?.contracts?.find((c:any)=>c.id===p.contractId);
    if(!contract||!Number.isFinite(p.done)||p.done!==p.trips||contract.done<contract.trips)return undefined;
    return `你按真实完成回执搬完了这份工作，共 ${p.done} 趟。主动找爸爸告诉他，带着自己当下的疲惫、得意和对白饭的惦记自然说一两句；工钱由爸爸聊天商量后手动加饭钱，尚未到账就只能商量，已有到账则认可，不要求去结算页面。`;
  }
  if(event.type==='interaction.operation')return typeof p.description==='string'?p.description:undefined;
  if(event.type.startsWith('management.'))return ({'management.pause':p.paused?'爸爸暂停了你的自主活动，手动互动仍可继续':'爸爸恢复了你的自主活动','management.goal':'爸爸调整了你的目标状态','management.revoke':'爸爸撤回了一项权限','management.memory':'爸爸删除或纠正了记忆，请尊重这次修改，不复述被删除内容'} as Record<string,string>)[event.type];
  if(event.type==='body.adjusted')return '爸爸调整了你的身体数值，请根据当前身体状态回应';
  if(event.type==='attachment.shared')return '爸爸分享了一张图片，目前仅确认收到了图片，尚未观察图片内容';
  if(event.type.startsWith('todo.')&&event.source==='user')return ({'todo.created':'爸爸添加了一条待办','todo.updated':'爸爸更新了一条待办','todo.deleted':'爸爸删除了一条待办'} as Record<string,string>)[event.type];
  if(event.type==='body.observed')return ({pet:'爸爸点击了你',impact:'你的身体刚刚受到晃动',knock:'爸爸刚刚连续敲了你',utensil:'你刚刚被道具碰到了',collision:'你的身体刚刚发生了真实碰撞'} as Record<string,string>)[p.event];
  return undefined;
}

/** Observe once after commit. Batch rapid gestures without losing their sources. */
export function createInteractionReactions(initial:CanonicalEnvelope,
  respond:(petId:string,event:{eventId:string;description:string;sourceIds:string[]},signal:AbortSignal)=>Promise<string>,
  publish:(text:string)=>void,signal:AbortSignal) {
  const seen=new Set(initial.life.events.map(e=>e.eventId));
  let queued:{eventId:string;description:string}[]=[],running=false;
  const run=async()=>{
    if(running||signal.aborted)return;
    running=true;
    try{while(queued.length&&!signal.aborted){
      const batch=queued;queued=[];
      const controller=new AbortController();
      let timer:ReturnType<typeof setTimeout>|undefined;
      const deadline=new Promise<string>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve('');},30000);});
      const aborted=new Promise<string>(resolve=>{const stop=()=>resolve('');controller.signal.addEventListener('abort',stop,{once:true});});
      const stop=()=>controller.abort();signal.addEventListener('abort',stop,{once:true});
      let text='';
      try{text=await Promise.race([Promise.resolve().then(()=>respond(initial.petId,{eventId:batch.at(-1)!.eventId,description:batch.map(e=>e.description).join('；'),sourceIds:batch.map(e=>e.eventId)},AbortSignal.any([signal,controller.signal]))).catch(()=>''),deadline,aborted]);}
      finally{clearTimeout(timer);signal.removeEventListener('abort',stop);}
      if(!signal.aborted)try{publish(text.trim()||'【系统反馈】操作已记录，她暂时未能生成回应。可检查模型连接后继续和她说话。');}catch(error){console.error('[interaction] 无法显示反馈',error);}
    }}finally{running=false;}
  };
  return (state:CanonicalEnvelope)=>{
    if(signal.aborted||state.petId!==initial.petId)return;
    for(const event of state.life.events){
      if(seen.has(event.eventId))continue;seen.add(event.eventId);
      if(Object.hasOwn(state.life.invalidSources,event.eventId))continue;
      if(event.type==='labor.completed')continue;
      const description=interactionDescription(event,state);if(description)queued.push({eventId:event.eventId,description});
    }
    if(queued.length)queueMicrotask(()=>{void run();});
  };
}
