import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {ActionReceipt} from '../kernel/types.js';
import type {OutboxIntent} from '../storage/uow.js';

export function validateRicePurchase(state:CanonicalEnvelope):void {
 const pet=state.legacy as any,price=pet.config?.costs?.feed,wallet=pet.wallet,inventory=pet.services?.inventory;
 if(!Number.isFinite(price)||price<0||!Number.isFinite(wallet?.balance)||!Array.isArray(inventory))throw Error('饭钱或库存状态无效');
 if(wallet.frozen!==true&&wallet.balance<price)throw Error(`饭钱不足：还剩 ${wallet.balance}，一碗需要 ${price}`);
 if(inventory.filter((i:any)=>!['eaten','discarded'].includes(i.status)).length>=12)throw Error('库存已满');
}

/** Buying rice and starting a batch have no external effect. Their canonical
 * markers are committed together with the corresponding stock change. */
export function localRiceReconciler(reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>}) {
 return async(petId:string,intent:OutboxIntent,signal:AbortSignal):Promise<ActionReceipt|null>=>{
  if(signal.aborted||!['service.buy-rice','service.cook-rice'].includes(intent.type))return null;
  const state=await reader.loadEnvelope(petId);if(!state)return null;
  const action=state.life.actions.find(a=>a.id===intent.id);
  if(action?.status!=='UNKNOWN'||action.actionType!==intent.type)return null;
  if(intent.type==='service.cook-rice') {
    if(state.life.events.some(e=>e.eventId==='rice-start:'+intent.id))return null;
    return {receiptId:'local-cooking-reconciled:'+intent.id,petId,actionId:intent.id,status:'FAILED',occurredAt:new Date().toISOString(),source:'canonical-local-cooking',evidenceLevel:'observed',details:{kind:intent.type,actionId:intent.id,confirmed:true,reason:'这次开锅未开始，米缸生米未扣除'}};
  }
  if((state.legacy as any).services?.inventory?.some((i:any)=>i.id==='rice:'+intent.id)||state.life.events.some(e=>e.eventId==='finance:'+intent.id))return null;
  return {receiptId:'local-purchase-reconciled:'+intent.id,petId,actionId:intent.id,status:'FAILED',occurredAt:new Date().toISOString(),source:'canonical-local-purchase',evidenceLevel:'observed',details:{kind:intent.type,actionId:intent.id,confirmed:true,reason:'本地购买未入账，未扣饭钱、未新增饭；可以按当前条件重新决定'}};
 };
}
