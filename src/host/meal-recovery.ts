import {createRequire} from 'node:module';
import {join} from 'node:path';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {ActionReceipt} from '../kernel/types.js';
import type {OutboxIntent,PetGate,UnitOfWork} from '../storage/uow.js';
import {findRiceBowl,riceInventory} from './rice-inventory.js';

const require=createRequire(import.meta.url);
const {createMealReceiptJournal}=require('../../vendor/dsh-pet/runtime/electron-helper/main/meal-receipts.js');
type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
type Journal={read(petId:string,actionId:string):any};
export const mealJournal=(root:string):Journal=>createMealReceiptJournal(join(root,'data/runtime/meal-receipts'));

export function mealReconciler(store:Reader,journal:Journal) {
  return async(petId:string,intent:OutboxIntent,signal:AbortSignal):Promise<ActionReceipt|null>=>{
    if(signal.aborted||intent.type!=='service.eat-rice')return null;
    const state=await store.loadEnvelope(petId),action=state?.life.actions.find(a=>a.id===intent.id);
    if(!state||action?.status!=='UNKNOWN'||action.actionType!==intent.type||action.parameters.itemId!==(intent.payload.parameters as any)?.itemId)return null;
    const discard=(state.legacy as any).services?.mealDiscards?.[intent.id];
    if(discard?.itemId===action.parameters.itemId)return {receiptId:'meal-discard:'+intent.id,petId,actionId:intent.id,status:'CANCELLED',source:'user-meal-discard',occurredAt:discard.at,evidenceLevel:'observed',details:{kind:intent.type,actionId:intent.id,itemId:discard.itemId,resolution:'discarded',outcomeUnknown:true,requestId:discard.requestId,reason:'爸爸将结果不明的旧碗作废；不再扣钱、不补身体数值'}};
    const entry=journal.read(petId,intent.id),r=entry?.receipt;
    if(entry?.version!==1||entry.petId!==petId||!/^[a-f0-9]{32}$/.test(entry.processEpoch)||!Number.isFinite(Date.parse(entry.occurredAt))||Date.parse(entry.occurredAt)<Date.parse(action.createdAt)||!r||r.id!==intent.id||r.actionId!==intent.id||r.itemId!==action.parameters.itemId||r.index!==0||r.surface!=='desktop'||!['completed','interrupted'].includes(r.status)||r.status==='completed'&&r.played!==true)return null;
    return {receiptId:'meal-recovered:'+intent.id,petId,actionId:intent.id,status:r.status==='completed'?'COMPLETED':'CANCELLED',source:'desktop-meal-journal',occurredAt:entry.occurredAt,evidenceLevel:'observed',details:{kind:intent.type,actionId:intent.id,itemId:r.itemId,confirmed:true,played:r.played,recovered:true,reason:r.status==='completed'?'补回真实进食完成回执':'补回真实进食中断回执'}};
  };
}

export function mealSnapshot(state:CanonicalEnvelope) {
  return riceInventory(state).map(bowl=>{
    const action=(state.life.actions??[]).find(a=>a.actionType==='service.eat-rice'&&a.parameters.itemId===bowl.id&&['PENDING','DISPATCHED','UNKNOWN'].includes(a.status));
    return {...bowl,status:action?.status==='UNKNOWN'?'unconfirmed':action?'eating':bowl.status,actionId:action?.id,at:action?.updatedAt};
  });
}

export function authorizeMealDiscard(draft:CanonicalEnvelope,actionId:string,itemId:string,requestId:string,at=new Date().toISOString()) {
  const services=((draft.legacy as any).services??={}),previous=services.mealDiscards?.[actionId];
  if(previous){if(previous.itemId!==itemId)throw Error('作废请求与旧碗不一致');return false;}
  const action=draft.life.actions.find(a=>a.id===actionId),bowl=findRiceBowl(draft,itemId);
  if(action?.actionType!=='service.eat-rice'||action.status!=='UNKNOWN'||action.parameters.itemId!==itemId||!bowl||!['available','reserved'].includes(bowl.status)||draft.life.actions.some(a=>a.id!==actionId&&a.actionType==='service.eat-rice'&&a.parameters.itemId===itemId&&['PENDING','DISPATCHED','UNKNOWN'].includes(a.status)))throw Error('这碗饭的状态已变化，请刷新后重试');
  (services.mealDiscards??={})[actionId]={itemId,requestId,at};return true;
}

export function createMealManagement(store:Reader,gate:PetGate,uow:UnitOfWork,reconcile:(id:string)=>Promise<boolean>) {
  return async(petId:string,input:Record<string,unknown>)=>{
    const {actionId,itemId,requestId,action}=input;
    if(typeof actionId!=='string'||!actionId||actionId.length>200||typeof itemId!=='string'||!itemId||itemId.length>240||typeof requestId!=='string'||!/^[a-zA-Z0-9:-]{8,140}$/.test(requestId)||!['reconcile','discard'].includes(String(action)))throw Error('进食核对请求无效');
    await gate.run(petId,async()=>{
      const state=await store.loadEnvelope(petId);if(!state)throw Error('库存不可用');
      const target=state.life.actions.find(a=>a.id===actionId);
      if(target?.actionType!=='service.eat-rice'||target.parameters.itemId!==itemId)throw Error('进食动作与这碗饭不匹配');
      if(action==='discard'){
        const draft=structuredClone(state);
        if(authorizeMealDiscard(draft,actionId,itemId,requestId))await uow.apply(petId,state.version,value=>{authorizeMealDiscard(value,actionId,itemId,requestId);return {};});
      }
    });
    const state=await store.loadEnvelope(petId),target=state?.life.actions.find(a=>a.id===actionId);
    if(!target||!['UNKNOWN','COMPLETED','FAILED','CANCELLED'].includes(target.status))throw Error('进食仍在进行，请等待回执后再核对');
    const resolved=target.status!=='UNKNOWN'||await reconcile(actionId);
    return {message:resolved?(action==='discard'?'这碗饭已作废，没有再次扣钱或补加饱腹。':'进食结果已核对。'):'尚未找到完成回执。这碗饭暂时保留，也可以选择作废。'};
  };
}
