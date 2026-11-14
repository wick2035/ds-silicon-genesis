import type {LifeState} from '../kernel/types.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';

/** Only committed, bounded facts; an intent or dispatch is never a receipt. */
export function conversationContext(state:LifeState, envelope:CanonicalEnvelope) {
  const pet=envelope.legacy as Record<string,any>, config=pet.config??{}, wallet=pet.wallet??{};
  const abilities=pet.abilities??{}, inventory=Array.isArray(pet.services?.inventory)?pet.services.inventory:[];
  const actions=state.actions.filter(a=>(a.actionType.startsWith('care.')||['service.buy-rice','service.eat-rice','learning.observe','image.observe','body.sleep','body.wake'].includes(a.actionType)) && a.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id))).slice(-8).map(a=>{
    const receipt=state.receipts.find(r=>r.actionId===a.id && r.receiptId===a.receiptId && state.events.some(e=>e.causationId===r.receiptId && !Object.hasOwn(state.invalidSources,e.eventId)));
    const details=receipt?.details as Record<string,unknown>|undefined;
    const status=receipt?.status??(['COMPLETED','FAILED','CANCELLED','UNKNOWN'].includes(a.status)?'UNCONFIRMED':a.status);
    return {type:a.actionType,status,at:receipt?.occurredAt??a.updatedAt,
      ...(typeof a.parameters?.query==='string'?{question:a.parameters.query.slice(0,300)}:{}),
      ...(typeof details?.reason==='string'?{reason:details.reason.slice(0,300)}:{})};
  });
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return {
    food:{balance:wallet.balance??null,frozen:wallet.frozen===true,price:config.costs?.feed??null,
      inventory:inventory.filter((i:any)=>i.status!=='eaten').slice(0,12).map((i:any)=>({name:i.name,status:i.status})),eating:pet.services?.eating??null},
    phone:{open:config.networkLearning===true,search:abilities.search?.status==='granted',fetch:abilities.fetch?.status==='granted',
      dailyLimit:config.exploration?.dailyRuns??null,used:pet.usage?.[day]?.exploreRuns??0},actions
  };
}
