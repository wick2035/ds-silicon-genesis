import type {CanonicalEnvelope} from '../storage/postgres.js';
/** Preserve ambiguous old bowls in storage, but never offer them for consumption again. */
export function riceInventory(state:CanonicalEnvelope):Array<{id:string;name:string;status:string}> {
  return ((state.legacy as any).services?.inventory??[]).filter((item:any)=>item.status!=='eaten').slice(0,12).map((item:any)=>({id:item.id,name:item.name,status:state.life.actions.some(a=>a.actionType==='service.eat-rice'&&(!a.parameters?.itemId||a.parameters.itemId===item.id)&&['UNKNOWN','PENDING','DISPATCHED'].includes(a.status))?'unconfirmed':item.status}));
}
export function availableRice(state:CanonicalEnvelope){return riceInventory(state).filter(item=>item.status==='available');}
