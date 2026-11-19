import {farmVisit} from './farm.js';
import {hasForcedWork,laborBlockReason} from './forced-labor.js';
import {setTimeout as delay} from 'node:timers/promises';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {ExecutionReceipt,OutboxIntent} from '../storage/uow.js';

export const autonomousWorkTypes=['work.enter','work.begin','work.stop','work.leave'] as const;
export type AutonomousWorkType=typeof autonomousWorkTypes[number];
export const isAutonomousWork=(type:string):type is AutonomousWorkType=>autonomousWorkTypes.some(name=>name===type);

/** Rechecked when queued, dispatched and immediately before the real operation. */
export function validateAutonomousWork(state:CanonicalEnvelope,type:AutonomousWorkType,now=Date.now(),entryRequested=false):void {
  const pet=state.legacy as any,human=state.humanity as any,site=pet.worksite;
  if(state.life.constraints.paused||pet.config?.autonomousPaused||pet.growth?.stopAt)throw Error('自主活动已暂停');
  const capability=state.life.constraints.capabilities.find(c=>c.name===type&&c.enabled);
  if(!capability)throw Error('工地能力未启用');
  if(capability.requiresPermission&&!state.life.constraints.permissions.includes(capability.requiresPermission))throw Error('工地权限未授予');
  if(hasForcedWork(state))throw Error('强制干活正在进行');
  if(type==='work.enter'||type==='work.begin') {
    const blocked=laborBlockReason(state);if(blocked)throw Error(blocked);
    if(farmVisit(state))throw Error('她在稻田里，请先回桌面');
    if(human.restingUntil>now)throw Error('她正在休息');
  }
  if(type==='work.enter') {
    if(site?.inside||!entryRequested&&site?.requested)throw Error('她已经在工地里或正在前往');
  } else {
    if(!site?.inside)throw Error('她不在工地里');
    if(type==='work.leave') {
      if(site.forced)throw Error('被爸爸放进来后，要等爸爸亲手接我出去');
      if(human.helperReady!==true||human.restrained!==false||human.sleeping||human.restingUntil>now)throw Error('她现在无法离开工地');
    }
  }
}

/** Adapts the existing worksite operations; a request alone is never an entry receipt. */
export function createAutonomousWorkExecutors(reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},operations:{
  enter(id:string,signal:AbortSignal):Promise<unknown>;
  begin(id:string):Promise<unknown>;
  stop(id:string):Promise<unknown>;
  leave(id:string,signal:AbortSignal):Promise<unknown>;
  cancelEntry?(id:string,requestId:string):Promise<unknown>;
},entryTimeoutMs=15000) {
  return new Map(autonomousWorkTypes.map(type=>[type,async(petId:string,intent:OutboxIntent,signal:AbortSignal):Promise<ExecutionReceipt>=>{
    if(signal.aborted)return {status:'cancelled',evidence:{reason:'行动已取消'}};
    const state=await reader.loadEnvelope(petId);if(!state)throw Error('生命状态不可用');
    validateAutonomousWork(state,type);
    if(type==='work.enter') {
      await operations.enter(petId,signal);
      let requestId:string|undefined;
      try {
        const deadline=Date.now()+entryTimeoutMs;
        for(;;) {
          const current=await reader.loadEnvelope(petId),site=(current?.legacy as any)?.worksite;
          requestId??=current?.life.events.filter(e=>e.type==='interaction.worksite'&&(e.payload as any)?.action==='request-entry').at(-1)?.eventId;
          if(signal.aborted||!current||current.life.constraints.paused)throw Error('进工地已取消');
          if(site?.inside===true) {
            if(site.forced)throw Error('工地进入方式已变化');
            break;
          }
          if(!site?.requested||Date.now()>=deadline)break;
          validateAutonomousWork(current,type,Date.now(),true);
          await delay(Math.min(50,Math.max(1,deadline-Date.now())),undefined,{signal});
        }
      } finally {
        if(requestId)await operations.cancelEntry?.(petId,requestId);
      }
    }
    else if(type==='work.begin')await operations.begin(petId);
    else if(type==='work.stop')await operations.stop(petId);
    else await operations.leave(petId,signal);
    const current=await reader.loadEnvelope(petId),site=(current?.legacy as any)?.worksite;
    const confirmed=!!current&&(type==='work.enter'?site?.inside===true:
      type==='work.leave'?site?.inside===false:
      site?.inside===true&&site?.workState===(type==='work.begin'?'running':'stopped'));
    return {status:confirmed?'completed':'unknown',evidence:{actionId:intent.id,kind:type,confirmed,
      ...(confirmed?{inside:site.inside,workState:site.workState}:{reason:'尚未取得工地实际状态确认'})}};
  }]));
}
