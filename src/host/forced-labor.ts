import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {LifeState,ActionProposal} from '../kernel/types.js';

export function hasLaborResources(draft:CanonicalEnvelope):boolean {
  const stats=(draft.humanity as any).stats;
  return [stats.stamina,stats.energy,stats.satiety,draft.life.spirit?.value??80].some(n=>Number.isFinite(n)&&n>0);
}
export function laborBlockReason(draft:CanonicalEnvelope):string|undefined {
  const human=draft.humanity as any,cap=draft.life.constraints.capabilities.find(c=>c.name==='labor.step'&&c.enabled);
  if(draft.life.constraints.paused)return '自主活动已暂停';
  if(!cap)return '搬砖能力未启用';
  if(cap.requiresPermission&&!draft.life.constraints.permissions.includes(cap.requiresPermission))return '搬砖权限未授予';
  if(human.helperReady!==true)return '桌宠连接尚未确认';
  if(human.restrained!==false)return '身体正被抓住，松开后才能工作';
  if(human.sleeping)return '身体正在睡觉';
  if(!hasLaborResources(draft))return '体力、精力、饱腹和精神均已耗尽';
}
export function canChooseLabor(draft:CanonicalEnvelope):boolean {return laborBlockReason(draft)===undefined;}


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
  if(!forced){const reason=laborBlockReason(draft);if(reason)throw Error(reason);}
  return {...state,body:{...state.body,sleeping:forced?state.body.sleeping:false},constraints:{...state.constraints,paused:forced?false:state.constraints.paused,capabilities:state.constraints.capabilities.map(c=>c.name==='labor.step'?{...c,bodyLimits:{allowSleeping:true,allowRestrained:true,allowInjured:true,minStamina:-101,maxPain:101}}:c)}};
}
