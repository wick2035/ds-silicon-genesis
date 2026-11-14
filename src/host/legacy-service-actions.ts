import {createHash} from 'node:crypto';
import {actHumanity} from '../../vendor/dsh-pet/src/host/humanity.mjs';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork,OutboxDispatcher} from '../storage/uow.js';
import type {ActionCoordinator} from './action-coordinator.js';

/** Manual requests are persisted before dispatch; a repeat key never replays a
 * dispatched or unknown operation. Actual success requires a trusted receipt. */
export function createLegacyServiceActions(store:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},gate:PetGate,uow:UnitOfWork,actions:ActionCoordinator,dispatcher:OutboxDispatcher) {
  return async(petId:string,input:Record<string,unknown>,origin:'user'|'autonomous'='user')=>{
    const key=input.key,command=input.command;
    if(typeof key!=='string'||!/^[a-zA-Z0-9:-]{8,100}$/.test(key)||typeof command!=='string'||command.length>160)throw Error('服务请求无效');
    const hash=createHash('sha256').update(petId+'\0'+key).digest('hex'),id='legacy-service:'+hash;
    const phone=/^\/手机\s+([^\r\n]+)$/u.exec(command.trim());
    const kind=command.trim()==='/休息'?'body.sleep':command.trim()==='/醒来'?'body.wake':command.trim()==='/喂'?'care.feed':/^\/冰箱\s+(?:我要|给我|买|取)?(?:一碗)?(?:大白饭|白饭|白米饭|米饭)[。！!]?$/u.test(command.trim().replace(/\s+/g,' '))?'service.buy-rice':/^\/吃(?:\s+(?:大白饭|白饭|白米饭|米饭))?$/u.test(command.trim())?'service.eat-rice':phone?(input.ability==='image'?'image.observe':'learning.observe'):null;
    if(!kind)throw Error('没有这个生活服务');
    if(kind==='care.feed'&&origin!=='user')throw Error('喂饭须由用户手动发起');
    return gate.run(petId,async()=>{
      let state=await store.loadEnvelope(petId);if(!state||gate.signal.aborted)throw Error('生命状态不可用');
      const wish=typeof input.wishId==='string'?(state.legacy as any).wishes?.find((w:any)=>w.id===input.wishId):undefined;
      let action=state.life.actions.find(a=>a.id===id);
      if(action && (action.actionType!==kind || (action.parameters as any).legacyCommand!==command || (action.parameters as any).wishId!==input.wishId))throw Error('服务请求编号冲突');
      if(kind==='care.feed' && (!action || action.status==='PROPOSED')) {
        const result=actHumanity(state.humanity,'feed',Date.now());
        if(!result.ok)throw Error(result.reason==='resting'?'正在休息，请等休息结束后再投喂':result.reason==='cooldown'?'刚投喂过，请稍等一分钟再试':result.message||'当前不能投喂');
      }
      if(!action){
        if(input.wishId!==undefined && (!wish || wish.status!=='pending' || wish.topic!==phone?.[1].trim() || wish.ability!==input.ability || !['search','fetch','bili','image'].includes(wish.ability)))throw Error('念想或能力已变化');
        const item=kind==='service.eat-rice'?(state.legacy as any).services?.inventory?.find((x:any)=>x.status==='available'):null;
        if(kind==='service.eat-rice'&&!item)throw Error('没有可吃的饭，先从冰箱买一碗');
        const fetchUrl=wish?.ability==='fetch'?phone?.[1].match(/https?:\/\/[^\s]+/i)?.[0]:undefined;
        if(wish?.ability==='fetch'&&!fetchUrl)throw Error('网页念想需要有效的公开网址');
        const attachment=kind==='image.observe'?[...state.life.events].reverse().find(e=>e.type==='attachment.shared'&&!Object.hasOwn(state!.life.invalidSources,e.eventId)&&(state!.legacy as any).attachments?.[(e.payload as any)?.attachmentId]):undefined;
        if(kind==='image.observe'&&!attachment)throw Error('还没有可观察的已分享图片');
        const now=new Date().toISOString(),parameters={legacyCommand:command,...(item?{itemId:item.id}:{}),...(phone?{kind:wish?.ability||'search',query:phone[1].trim(),...(input.careAction==='explore'?{careAction:'explore'}:{}),...(fetchUrl?{url:fetchUrl}:{}),...(typeof input.wishId==='string'?{wishId:input.wishId}:{}),...(attachment?{attachmentId:(attachment.payload as any).attachmentId,attachmentSourceId:attachment.eventId}:{})}:{})};
        await uow.apply(petId,state.version,draft=>{const sourceId='manual-service:'+hash;
          if(origin==='user') { const legacy=draft.legacy as Record<string,any>; (legacy.manualServiceRequests ||= {})[id]={kind,sourceId}; draft.life.events.push({eventId:sourceId,petId,type:'service.requested',source:'user',actorId:'dad',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{actionId:id,kind}}); }
          draft.life.actions.push({id,petId,actionType:kind,parameters,priority:60,interruptPolicy:'safe-point',requiredCapabilities:[kind],expectedStateVersion:draft.version,sourceIds:origin==='user'?[sourceId]:[],status:'PROPOSED',createdAt:now,updatedAt:now});return {};});
      }
      state=await store.loadEnvelope(petId);action=state?.life.actions.find(a=>a.id===id);if(!state||!action)throw Error('服务状态不可用');
      if(action.status==='PROPOSED')await actions.queue(petId,id,state.version);
      state=await store.loadEnvelope(petId);action=state?.life.actions.find(a=>a.id===id);if(action?.status==='PENDING')await dispatcher.dispatch(id);
      state=await store.loadEnvelope(petId);action=state?.life.actions.find(a=>a.id===id);
      const status=action?.status;return {key,command,ok:status==='COMPLETED'||status==='PENDING'||status==='DISPATCHED',status:status==='COMPLETED'?'done':status==='PENDING'||status==='DISPATCHED'?'pending':String(status||'unknown').toLowerCase(),message:status==='COMPLETED'?(kind==='service.buy-rice'?'已得到一碗饭':kind==='service.eat-rice'?'已确认吃完':kind==='care.feed'?'已完成喂饭':kind==='body.sleep'?'已经休息':kind==='body.wake'?'已经醒来':'已读取真实资料，来源可在记忆中查看'):status==='PENDING'||status==='DISPATCHED'?'行动正在等待桌宠完成':status==='UNKNOWN'?'结果待确认，不能重复执行':'行动未完成'};
    });
  };
}
