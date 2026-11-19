import type {LifeState} from './types.js';

export interface Spirit {
  value:number; updatedAt:number; awakeSince:number; lastSleepHours:number;
  mode:'awake'|'sleep'|'nap'; sleepStartedAt?:number; sleepStartValue?:number;
  lastSweetAt?:number; sleepRecoveryAt?:number; sleepRecoveryValue?:number;
  config:{sleepHours:number; awakeHours:number; hourlyDrain:number; napPerHour:number; sweetGain:number; sweetCooldownHours:number};
}
type Life=Pick<LifeState,'spirit'>;
const HOUR=3600000;
const clamp=(n:number)=>Math.max(0,Math.min(100,n));
export function ensureSpirit(life:Life,now=Date.now()):Spirit {
  return life.spirit??= {value:80,updatedAt:now,awakeSince:now,lastSleepHours:0,mode:'awake',config:{sleepHours:8,awakeHours:14,hourlyDrain:2,napPerHour:6,sweetGain:8,sweetCooldownHours:4}};
}
/** A normalized exponential reaches one at x hours, never before. */
export function sleepRecovery(hours:number,required:number):number {
  if(!Number.isFinite(hours)||!Number.isFinite(required)||required<=0)throw Error('睡眠时间无效');
  return hours>=required?1:(1-Math.exp(-3*Math.max(0,hours)/required))/(1-Math.exp(-3));
}
export function fatigueMultiplier(s:Spirit,now:number):number {
  const window=Math.min(s.config.awakeHours,12+s.lastSleepHours/4);
  return 2**Math.min(4,Math.max(0,(now-s.awakeSince)/HOUR-window)/2);
}
export function advanceSpirit(life:Life,now=Date.now()):Spirit {
  const s=ensureSpirit(life,now);
  if(now<=s.updatedAt)return s;
  if(s.mode==='sleep') {
    const start=s.sleepRecoveryAt??s.sleepStartedAt!, base=s.sleepRecoveryValue??s.sleepStartValue!;
    const elapsed=(now-start)/HOUR;
    s.value=base>=100||elapsed>=s.config.sleepHours?100:Math.min(99.999999,base+(100-base)*sleepRecovery(elapsed,s.config.sleepHours));
  } else if(s.mode==='nap') {
    // A nap lasts at most twenty minutes and never clears sleep debt.
    const end=s.sleepStartedAt!+HOUR/3;
    const recovered=Math.max(0,Math.min(now,end)-s.updatedAt)/HOUR*s.config.napPerHour;
    s.value=Math.max(s.value,Math.min(99,s.value+recovered));
    if(now>end)s.value=clamp(s.value-(now-Math.max(end,s.updatedAt))/HOUR*s.config.hourlyDrain*fatigueMultiplier(s,(now+Math.max(end,s.updatedAt))/2));
  } else {
    // Integrate the late-wake exponential exactly; settlement frequency cannot change fatigue.
    const start=s.awakeSince+Math.min(s.config.awakeHours,12+s.lastSleepHours/4)*HOUR;
    const integral=(t:number)=>{const h=(t-start)/HOUR;if(h<=0)return h;if(h<=8)return (2**(h/2)-1)*2/Math.LN2;return 30/Math.LN2+(h-8)*16;};
    s.value=clamp(s.value-s.config.hourlyDrain*(integral(now)-integral(s.updatedAt)));
  }
  s.updatedAt=now;return s;
}
export function setSpiritRest(life:Life,mode:Spirit['mode'],now=Date.now()):void {
  const s=advanceSpirit(life,now);if(s.mode===mode)return;
  if(s.mode==='sleep' && mode==='awake') {s.lastSleepHours=Math.max(0,(now-s.sleepStartedAt!)/HOUR);s.awakeSince=now;}
  s.mode=mode;
  delete s.sleepRecoveryAt;delete s.sleepRecoveryValue;
  if(mode!=='awake'){s.sleepStartedAt=now;s.sleepStartValue=s.value;}
  else {delete s.sleepStartedAt;delete s.sleepStartValue;}
}
export function spiritCost(kind:string):number {
  if(['body.sleep','body.wake','service.sweet','service.buy-rice','service.cook-rice','service.eat-rice','qq.send'].includes(kind)||kind.startsWith('care.'))return 0;
  if(kind==='learning.observe'||kind==='image.observe')return 4;
  if(kind==='labor.step')return 2;
  if(kind==='body.activity')return 1;
  return .5;
}
export function checkSpirit(life:Life,kind:string,now=Date.now()):void {
  const s=advanceSpirit(life,now),cost=spiritCost(kind)*fatigueMultiplier(s,now);
  if(cost && (s.mode!=='awake'||s.value<cost))throw Error('精神不足或正在睡觉，需要休息');
}
export function spendSpirit(life:Life,kind:string,now=Date.now(),forcedLabor=false):number {
  if(!forcedLabor||kind!=='labor.step')checkSpirit(life,kind,now);else advanceSpirit(life,now);
  const s=ensureSpirit(life,now),cost=spiritCost(kind)*fatigueMultiplier(s,now);
  s.value=clamp(s.value-cost);return cost;
}

/** User-initiated conversation remains possible when exhausted; fatigue is retained. */
export function spendConversationSpirit(life:Life,now=Date.now()):number {
  const s=advanceSpirit(life,now),cost=spiritCost('thought')*fatigueMultiplier(s,now);
  s.value=clamp(s.value-cost);return cost;
}
