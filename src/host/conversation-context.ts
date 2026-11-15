import {riceAvailability} from './rice-inventory.js';
import type {LifeState} from '../kernel/types.js';
import {companionContext,riceMotivation} from './companion-personality.js';
import {laborHistory} from './labor-management.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';

/** Only committed, bounded facts; an intent or dispatch is never a receipt. */
export function conversationContext(state:LifeState, envelope:CanonicalEnvelope, excludeEventIds:string[]=[]) {
  const pet=envelope.legacy as Record<string,any>, config=pet.config??{}, wallet=pet.wallet??{};
  const abilities=pet.abilities??{}, inventory=Array.isArray(pet.services?.inventory)?pet.services.inventory:[];
  const actions=(state.actions??[]).filter(a=>(a.actionType.startsWith('care.')||['service.buy-rice','service.eat-rice','learning.observe','image.observe','body.sleep','body.wake'].includes(a.actionType)) && a.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id))).slice(-8).map(a=>{
    const receipt=(state.receipts??[]).find(r=>r.actionId===a.id && r.receiptId===a.receiptId && state.events.some(e=>e.causationId===r.receiptId && !Object.hasOwn(state.invalidSources,e.eventId)));
    const details=receipt?.details as Record<string,unknown>|undefined;
    const status=receipt?.status??(['COMPLETED','FAILED','CANCELLED','UNKNOWN'].includes(a.status)?'UNCONFIRMED':a.status);
    return {type:a.actionType,status,at:receipt?.occurredAt??a.updatedAt,
      ...(typeof a.parameters?.query==='string'?{question:a.parameters.query.slice(0,300)}:{}),
      ...(typeof details?.reason==='string'?{reason:details.reason.slice(0,300)}:{})};
  });
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const recentMoney=Array.isArray(pet.events)?pet.events.filter((e:any)=>['wallet','wallet-spend'].includes(e.kind)).slice(-6).map((e:any)=>e.text):[];
  return {
    companion:companionContext({...envelope,life:envelope.life??state},Date.now(),excludeEventIds),
    food:{...riceMotivation(envelope.humanity??{},config),balance:wallet.balance??null,frozen:wallet.frozen===true,price:config.costs?.feed??null,
      ...riceAvailability({...envelope,life:envelope.life??state}),eating:pet.services?.eating??null,recentChanges:recentMoney},
    worksite:worksiteFacts({...envelope,life:envelope.life??state}),
    laborHistory:laborHistory(pet),
    resources:{coins:(pet.tokens?.coins??[]).filter((c:any)=>c.status==='floor').slice(0,12).map((c:any)=>({id:c.id,surface:c.surface})),attachments:state.events.filter(e=>e.type==='attachment.shared'&&!Object.hasOwn(state.invalidSources,e.eventId)).slice(-3).map(e=>({sourceId:e.eventId,attachmentId:(e.payload as any)?.attachmentId}))},
    phone:{open:config.networkLearning===true,search:abilities.search?.status==='granted',fetch:abilities.fetch?.status==='granted',
      dailyLimit:config.exploration?.dailyRuns??null,used:pet.usage?.[day]?.exploreRuns??0},actions
  };
}

/** Historical contract totals are not evidence of activity in the current visit. */
export function worksiteFacts(envelope:CanonicalEnvelope) {
  const pet=envelope.legacy as Record<string,any>, site=pet.worksite??{};
  const contract=(pet.labor?.contracts??[]).find((c:any)=>['working','paused','unpaid'].includes(c.status));
  const transition=envelope.life.events.filter(e=>e.type==='interaction.worksite' && !Object.hasOwn(envelope.life.invalidSources,e.eventId) && ['enter-forced','enter-voluntary','release','leave-voluntary'].includes(String((e.payload as any)?.action))).at(-1);
  const enteredAt=site.inside===true && transition && ['enter-forced','enter-voluntary'].includes(String((transition.payload as any)?.action)) ? Date.parse(transition.occurredAt) : Infinity;
  // A trip is finished when its "deliver" leg completes: the leg is encoded on
  // the command at dispatch time, not on the receipt. The receipt's index is the
  // command index reported by the helper (0 for the walk+lift leg, 1 for the
  // walk+putdown/deliver leg), so a completed deliver trip is simply the last
  // COMPLETED labor.step for this contract whose receipt index is 1. Matching on
  // a hard-coded x coordinate (0.78) is fragile — the target depends on which
  // side the brick is loaded from, and a slightly-off final position should not
  // erase a real, confirmed delivery.
  const completedTrips=(envelope.life.actions??[]).filter(a=>a.actionType==='labor.step' && a.parameters?.contractId===contract?.id && a.sourceIds.every(id=>!Object.hasOwn(envelope.life.invalidSources,id))).filter(a=>(envelope.life.receipts??[]).some(r=>{const details=r.details as Record<string,unknown>;return r.actionId===a.id && r.receiptId===a.receiptId && r.status==='COMPLETED' && details?.index===1 && Date.parse(r.occurredAt)>=enteredAt && envelope.life.events.some(e=>e.causationId===r.receiptId && !Object.hasOwn(envelope.life.invalidSources,e.eventId));})).length;
  return {inside:site.inside===true,forced:site.forced===true,status:contract?.status??null,completedTotal:contract?.done??null,trips:contract?.trips??null,workPermit:contract?.workPermit===true,completedTripsThisVisit:completedTrips};
}

/** Reject definite, unsupported current-visit work claims at commit time. */
export function groundWorksiteReply(reply:string,envelope:CanonicalEnvelope):string {
  const facts=worksiteFacts(envelope);
  if(!facts.inside)return reply;
  const inactive=facts.status!=='working' || !facts.workPermit || !envelope.life.actions.some(a=>a.actionType==='labor.step' && a.status==='DISPATCHED');
  const falseActive=inactive && /(?:我(?:一直|现在|正在|还在)?(?:忙着|正在|还在)?搬(?:砖|着|呢)|我(?:可)?没(?:有)?偷懒|我(?:一直|正在)干活)/u.test(reply);
  const falseCompletion=facts.completedTripsThisVisit===0 && /(?:我(?:刚才|刚刚|刚|已经|都|这次|这趟|又)?(?:已经|都)?搬(?:完|好了|了一趟|了一块|了一个)|(?:这趟|这块砖)(?:我)?(?:已经|刚刚|刚)?搬完)/u.test(reply);
  if(!falseActive && !falseCompletion)return reply;
  const total=Number.isFinite(facts.completedTotal)?`以前记录的累计进度是 ${facts.completedTotal} 趟。`:'';
  return `我现在还没有确认完成这一趟。${total}${inactive?'目前还没有确认正在搬砖。':'我会等实际动作完成再告诉你。'}`;
}
