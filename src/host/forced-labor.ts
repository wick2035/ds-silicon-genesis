import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {LifeState,ActionProposal} from '../kernel/types.js';

export function hasLaborResources(draft:CanonicalEnvelope):boolean {
  const stats=(draft.humanity as any).stats;
  return [stats.stamina,stats.energy,stats.satiety,draft.life.spirit?.value??80].some(n=>Number.isFinite(n)&&n>0);
}
export function canChooseLabor(draft:CanonicalEnvelope):boolean {
  const human=draft.humanity as any,cap=draft.life.constraints.capabilities.find(c=>c.name==='labor.step'&&c.enabled);
  return !draft.life.constraints.paused&&!!cap&&(!cap.requiresPermission||draft.life.constraints.permissions.includes(cap.requiresPermission))&&human.helperReady===true&&human.restrained===false&&!human.sleeping&&hasLaborResources(draft);
}

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
  const forced=isForcedLabor(draft,action);
  if(action.actionType!=='labor.step')return state;
  if(!forced&&!canChooseLabor(draft))throw Error('现在身体或权限不允许搬砖：需要清醒、松开且资源未全部耗尽');
  return {...state,body:{...state.body,sleeping:forced?state.body.sleeping:false},constraints:{...state.constraints,paused:forced?false:state.constraints.paused,capabilities:state.constraints.capabilities.map(c=>c.name==='labor.step'?{...c,bodyLimits:{allowSleeping:true,allowRestrained:true,allowInjured:true,minStamina:-101,maxPain:101}}:c)}};
}
