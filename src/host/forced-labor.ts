import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {LifeState,ActionProposal} from '../kernel/types.js';

/** A committed manual command can override voluntary rest, never receipt truth. */
const validForced=(draft:CanonicalEnvelope,c:any)=>c.status==='working'&&c.forced&&c.done<c.trips&&c.forcedSource&&
  !Object.hasOwn(draft.life.invalidSources,c.forcedSource)&&draft.life.events.some(e=>e.eventId===c.forcedSource&&e.type==='interaction.worksite'&&e.source==='user'&&(e.payload as any)?.action==='force-work');
export function hasForcedWork(draft:CanonicalEnvelope):boolean {
  return (draft.legacy as any).worksite?.inside===true&&!!(draft.legacy as any).labor?.contracts?.some((c:any)=>validForced(draft,c));
}
export function isForcedLabor(draft:CanonicalEnvelope,action:{actionType:string;parameters:Record<string,unknown>}):boolean {
  return action.actionType==='labor.step'&&hasForcedWork(draft)&&!!(draft.legacy as any).labor.contracts.find((c:any)=>c.id===action.parameters.contractId&&validForced(draft,c));
}
export function forcedLaborState(draft:CanonicalEnvelope,state:LifeState,action:ActionProposal):LifeState {
  if(!isForcedLabor(draft,action))return state;
  return {...state,constraints:{...state.constraints,paused:false,capabilities:state.constraints.capabilities.map(c=>c.name==='labor.step'?{...c,bodyLimits:{allowSleeping:true,allowRestrained:true,allowInjured:true,minStamina:-101,maxPain:101}}:c)}};
}
