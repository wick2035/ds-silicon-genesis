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
export type RiceBowl = {id:string; name:string; status:string; eatenAt?:number};

export function cookerBowlStorage(state:CanonicalEnvelope):RiceBowl[] {
  return (state.legacy as any).riceCooker?.cooked ?? [];
}

function fridgeBowls(state:CanonicalEnvelope):RiceBowl[] {
  return (state.legacy as any).services?.inventory ?? [];
}

export function findRiceBowl(state:CanonicalEnvelope,itemId:unknown) {
  return cookerBowlStorage(state).find(bowl=>bowl.id===itemId) ?? fridgeBowls(state).find(bowl=>bowl.id===itemId);
}

export function riceHold(state:CanonicalEnvelope,itemId:string) {
  const actions=(state.life.actions??[]).filter(a=>a.actionType==='service.eat-rice'&&(!a.parameters?.itemId||a.parameters.itemId===itemId));
  if(actions.some(a=>a.status==='UNKNOWN'))return 'unknown';
  if(actions.some(a=>a.status==='PENDING'||a.status==='DISPATCHED'))return 'in-progress';
  return null;
}

/** Preserve ambiguous bowls for reconciliation and exclude them from selection. */
export function riceInventory(state:CanonicalEnvelope) {
  const project=(item:RiceBowl,source:'cooker'|'fridge')=>({id:item.id,name:item.name,source,status:riceHold(state,item.id)?'unconfirmed':item.status});
  return [
    ...cookerBowlStorage(state).filter(item=>item.status!=='eaten').map(item=>project(item,'cooker')),
    ...fridgeBowls(state).filter(item=>item.status!=='eaten').slice(0,12).map(item=>project(item,'fridge')),
  ];
}
export function availableRice(state:CanonicalEnvelope){return riceInventory(state).filter(item=>item.status==='available');}

export function validateRiceMeal(state:CanonicalEnvelope,itemId:unknown):void {
  if(typeof itemId!=='string'||findRiceBowl(state,itemId)?.status!=='available')throw Error(
    typeof itemId==='string'&&itemId.startsWith('cooked:')?'这碗锅饭已不可用，请刷新熟饭库存':'饭的编号不存在或已经吃完，请使用最新库存中 available 饭的完整 id');
  if(state.life.actions.some(a=>a.actionType==='service.eat-rice'&&a.parameters?.itemId===itemId&&a.status==='UNKNOWN'))throw Error('这碗饭的进食结果未确认，请选择另一碗 available 的饭');
}
