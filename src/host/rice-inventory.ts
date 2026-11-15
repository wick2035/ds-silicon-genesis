import type {CanonicalEnvelope} from '../storage/postgres.js';
import {validateRicePurchase} from './rice-purchase.js';

/** Uncertain consumption belongs to one bowl, never to future purchases. */
export function riceAvailability(state:CanonicalEnvelope) {
  const inventory=riceInventory(state);
  let reason:string|null=null;
  try {validateRicePurchase(state);}catch(error){reason=error instanceof Error?error.message:'购买条件无效';}
  if(state.life.actions.some(a=>a.actionType==='service.buy-rice'&&['PENDING','DISPATCHED','UNKNOWN'].includes(a.status)))reason='还有一笔购买等待结果，先确认该笔购买';
  return {inventory,availableItemIds:inventory.filter(i=>i.status==='available').map(i=>i.id),
    purchase:{allowed:reason===null,reason},
    uncertaintyScope:'unconfirmed 只限制对应旧碗，不能重复吃该碗；不阻止购买和吃另一碗 available 的饭。购买仍须检查饭钱、库存容量和购买回执。'};
}
/** Preserve ambiguous old bowls in storage, but never offer them for consumption again. */
export function riceInventory(state:CanonicalEnvelope):Array<{id:string;name:string;status:string}> {
  return ((state.legacy as any).services?.inventory??[]).filter((item:any)=>item.status!=='eaten').slice(0,12).map((item:any)=>({id:item.id,name:item.name,status:state.life.actions.some(a=>a.actionType==='service.eat-rice'&&(!a.parameters?.itemId||a.parameters.itemId===item.id)&&['UNKNOWN','PENDING','DISPATCHED'].includes(a.status))?'unconfirmed':item.status}));
}
export function availableRice(state:CanonicalEnvelope){return riceInventory(state).filter(item=>item.status==='available');}

export function validateRiceMeal(state:CanonicalEnvelope,itemId:unknown):void {
  if(typeof itemId!=='string'||!(state.legacy as any).services?.inventory?.some((item:any)=>item.id===itemId&&item.status==='available'))throw Error('饭的编号不存在或已经吃完，请使用最新库存中 available 饭的完整 id');
  if(state.life.actions.some(a=>a.actionType==='service.eat-rice'&&a.parameters?.itemId===itemId&&a.status==='UNKNOWN'))throw Error('这碗饭的进食结果未确认，请选择另一碗 available 的饭');
}
