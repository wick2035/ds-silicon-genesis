import {createHash} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import {groupChatBlocked} from './qq-group-access.js';

export const GROUP_QUIET_INTERVAL=4*60*60*1000,GROUP_OPENER_PRICE=0.4;
export const boundGroupId=(draft:Readonly<CanonicalEnvelope>)=>{
  const identity=(draft.legacy as any).qq?.identity;
  return identity?.groupOpenid?createHash('sha256').update(identity.appId+':'+identity.groupOpenid).digest('hex'):undefined;
};
export function groupProactiveState(draft:Readonly<CanonicalEnvelope>,now=Date.now(),ignoreActionId?:string) {
  const qq=(draft.legacy as any).qq,groupId=boundGroupId(draft),settings=qq?.groupProactive;
  const enabled=!!groupId&&qq?.identity?.groupEnabled===true&&qq.identity.groupMode==='all'&&settings?.groupId===groupId&&Number.isFinite(settings?.enabledAt);
  let lastActivity=enabled?settings.enabledAt:now;
  for(const event of draft.life.events){
    if(event.type==='social.message'&&event.source==='qq'&&(event.payload as any)?.scene==='group'&&(event.payload as any)?.groupId===groupId || event.type==='management.group-chat'){
      const at=Date.parse(event.receivedAt||event.occurredAt);if(Number.isFinite(at))lastActivity=Math.max(lastActivity,at);
    }
  }
  for(const action of draft.life.actions??[]){
    if(action.id!==ignoreActionId&&action.actionType==='qq.send'&&action.parameters.scene==='group'&&action.parameters.destination===qq?.identity?.groupOpenid){
      const at=Date.parse(action.createdAt);if(Number.isFinite(at))lastActivity=Math.max(lastActivity,at);
    }
  }
  const nextAllowedAt=Math.max(lastActivity,Number.isFinite(settings?.lastAttemptAt)?settings.lastAttemptAt:0)+GROUP_QUIET_INTERVAL;
  const available=enabled&&!groupChatBlocked(draft)&&!draft.life.constraints.paused&&!(draft.humanity as any).sleeping&&
    (!draft.life.spirit||draft.life.spirit.mode==='awake')&&draft.life.constraints.permissions.includes('qq.send')&&
    draft.life.constraints.capabilities.some(c=>c.name==='qq.send'&&c.enabled);
  return {enabled,available,groupId,lastActivity,nextAllowedAt,ready:available&&now>=nextAllowedAt,price:GROUP_OPENER_PRICE};
}

/** Recheck the silence window after generation and again at dispatch. */
export function assertGroupOpportunity(draft:CanonicalEnvelope,sourceId:string,now=Date.now(),ignoreActionId?:string):void {
  const source=draft.life.events.find(e=>e.eventId===sourceId),settings=(draft.legacy as any).qq?.groupProactive;
  const status=groupProactiveState(draft,now,ignoreActionId),at=Date.parse(source?.occurredAt??'');
  if(!status.available||source?.type!=='social.group-opportunity'||source.source!=='qq-group'||source.evidenceLevel!=='observed'||
    Object.hasOwn(draft.life.invalidSources,sourceId)||(source.payload as any)?.groupId!==status.groupId||
    !((source.payload as any)?.contextSourceIds??[]).every((id:string)=>!Object.hasOwn(draft.life.invalidSources,id)&&draft.life.events.some(e=>e.eventId===id))||
    settings?.lastAttemptId!==sourceId||!Number.isFinite(at)||now<at||now-at>120000||at-status.lastActivity<GROUP_QUIET_INTERVAL)
    throw Error('群聊主动表达机会已失效');
}

export function settleGroupOpener(draft:CanonicalEnvelope,entry:Record<string,any>,status:string,at:string):void {
  if(!entry.groupProactive||entry.chargeState!=='reserved'||status==='UNKNOWN')return;
  if(status==='COMPLETED'){entry.chargeState='settled';return;}
  if(!['FAILED','CANCELLED'].includes(status))return;
  const legacy=draft.legacy as any;
  if(entry.amount!==GROUP_OPENER_PRICE||!Number.isFinite(legacy.wallet?.balance))throw Error('群聊费用预留无效');
  legacy.wallet.balance=Math.round((legacy.wallet.balance+entry.amount)*100)/100;
  entry.chargeState='refunded';
  const id='finance-refund:'+entry.actionId;
  draft.life.events.push({eventId:id,petId:draft.petId,type:'wallet.refund',source:'canonical',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{kind:'group-proactive',amount:entry.amount,balance:legacy.wallet.balance,actionId:entry.actionId}});
  (legacy.events||=[]).push({id,kind:'wallet-refund',text:'群聊主动消息未发送，退回 0.4 饭钱',ts:Date.parse(at)});
}
