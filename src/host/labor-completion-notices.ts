import {interactionDescription} from './interaction-reactions.js';
import {REACTION_TIMEOUT_MS} from './reaction-response.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';

/** The existing event journal is the outbox: a committed reply consumes a completion.
 * Reopening a window does not replay it; a paused or failed notice stays discoverable. */
export function createLaborCompletionNotices(
  reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},petId:string,
  respond:(id:string,event:{eventId:string;description:string;sourceIds:string[]},signal:AbortSignal)=>Promise<string>,
  publish:(text:string)=>void,signal:AbortSignal) {
  let running=false;
  const retryAt=new Map<string,number>();
  function candidate(state:CanonicalEnvelope){
    const pet=state.legacy as Record<string,any>;
    if(signal.aborted||state.life.constraints.paused||pet.config?.autonomousPaused||pet.growth?.stopAt)return;
    return state.life.events.find(e=>e.type==='labor.completed'&&e.source==='executor'&&
      !Object.hasOwn(state.life.invalidSources,e.eventId)&&(!e.causationId||!Object.hasOwn(state.life.invalidSources,e.causationId))&&
      (retryAt.get(e.eventId)??0)<=Date.now()&&interactionDescription(e,state)&&
      !state.life.events.some(reply=>reply.type==='conversation.assistant'&&!Object.hasOwn(state.life.invalidSources,reply.eventId)&&
        (reply.payload as any)?.sourceIds?.includes(e.eventId)&&state.life.events.some(request=>request.eventId===reply.causationId&&request.type==='interaction.requested'&&(request.payload as any)?.kind==='completion')));
  }
  async function run(){
    if(running||signal.aborted)return;
    running=true;
    try{
      for(;;){
        const state=await reader.loadEnvelope(petId);if(!state)return;
        const event=candidate(state);if(!event)return;
        try{
          const text=await respond(petId,{eventId:event.eventId,description:interactionDescription(event,state)!,sourceIds:[event.eventId]},
            AbortSignal.any([signal,AbortSignal.timeout(REACTION_TIMEOUT_MS)]));
          // Respond commits the sourced conversation before any desktop/QQ delivery.
          const current=await reader.loadEnvelope(petId);
          if(!signal.aborted&&current&&!current.life.constraints.paused&&!(current.legacy as any).growth?.stopAt&&!(current.legacy as any).config?.autonomousPaused&&
            !Object.hasOwn(current.life.invalidSources,event.eventId)&&(!event.causationId||!Object.hasOwn(current.life.invalidSources,event.causationId))&&text.trim())publish(text);
          retryAt.set(event.eventId,Date.now()+60000);
        }catch{
          retryAt.set(event.eventId,Date.now()+60000);
          return;
        }
      }
    }finally{running=false;}
  }
  return (state:CanonicalEnvelope)=>{if(state.petId===petId&&candidate(state))queueMicrotask(()=>{void run();});};
}
