import {randomUUID} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {ExecutionReceipt, OutboxIntent, PetGate, UnitOfWork} from '../storage/uow.js';
import {advanceFarm, changeFarmWeather, farmActionTarget, farmFacts, farmVisit, farmWeather, needsFarmAdvance, setFarmVisit, type FarmOperation, type FarmWeather} from './farm.js';

const CLIP_MS = 1600;
type Reader = {loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
type OpenRequest = {id:string; promise:Promise<void>; finish:(error?:Error)=>void};
type ActiveCommand = {id:string; operation:FarmOperation; epoch:string; target:ReturnType<typeof farmActionTarget>;
  started?:{at:number; visitId:string}; finish:(receipt:ExecutionReceipt)=>void};

export function checkFarmBody(state:CanonicalEnvelope, now:number, autonomous:boolean) {
  const pet = state.legacy as Record<string,any>, human = state.humanity;
  if (pet.worksite?.inside || pet.worksite?.requested || pet.labor?.contracts?.some((c:any)=>c.status==='working' && c.workPermit)) throw Error('她现在在工地或正在忙搬砖');
  if (human.helperReady !== true || human.restrained !== false || human.sleeping || (typeof human.restingUntil === 'number' && human.restingUntil > now)) throw Error('她正在休息或身体暂时无法移动');
  if (autonomous && (state.life.constraints.paused || pet.config?.autonomousPaused || pet.growth?.stopAt || (state.life.spirit && state.life.spirit.mode !== 'awake'))) throw Error('她的自主活动暂时不可用');
}

export function checkFarmReceipt(state:CanonicalEnvelope, intent:OutboxIntent, receipt:ExecutionReceipt, now:number):ExecutionReceipt {
  if (receipt.status !== 'completed') return receipt;
  const {evidence} = receipt;
  try {
    checkFarmBody(state,now,true);
    const operation = (intent.payload.parameters as {operation:FarmOperation}).operation;
    const target = farmActionTarget(state,operation,now);
    if (evidence.confirmed !== true || evidence.actionId !== intent.id || evidence.kind !== intent.type ||
      evidence.date !== target.date || evidence.cropId !== target.cropId || !evidence.visitId || evidence.visitId !== farmVisit(state)?.id) throw Error('稻田动作回执已失效');
    return {...receipt,evidence:{...evidence,settledAt:now}};
  } catch (error) {
    return {status:'cancelled',evidence:{reason:error instanceof Error ? error.message : '稻田动作已中断'}};
  }
}

export function createFarmScene(store:Reader, gate:PetGate, uow:UnitOfWork, clock = Date.now) {
  let epoch = '';
  const openings = new Map<string,OpenRequest>();
  const active = new Map<string,ActiveCommand>();
  const load = async(id:string) => {
    const state = await store.loadEnvelope(id);
    if (!state) throw Error('稻田档案不可用');
    return state;
  };
  const settle = (id:string, activate = false) => gate.run(id,async()=>{
    const state = await load(id), now = clock();
    if (!needsFarmAdvance(state,now) && (!activate || farmFacts(state,now))) return state;
    return uow.apply(id,state.version,draft=>{advanceFarm(draft,now,activate);return {};});
  });
  const clearVisit = (id:string, owner?:string) => gate.run(id,async()=>{
    const state = await load(id), visit = farmVisit(state);
    if (!visit || (owner && visit.epoch !== owner)) return;
    await uow.apply(id,state.version,draft=>{setFarmVisit(draft);return {};});
  });
  const cancel = (id:string, reason:string) => active.get(id)?.finish({status:'cancelled',evidence:{reason}});
  const snapshot = async(id:string) => {
    const latest = await load(id);
    const state = needsFarmAdvance(latest,clock()) ? await settle(id) : latest;
    const cmd = active.get(id), opening = openings.get(id);
    const command = cmd && cmd.epoch === epoch ? {id:cmd.id,operation:cmd.operation,clipMs:CLIP_MS} : null;
    const inside = !!epoch && farmVisit(state)?.epoch === epoch;
    return {field:farmFacts(state,clock()),inside,command,openRequestId:opening?.id,
      worksiteInside:(state.legacy as any).worksite?.inside === true};
  };
  const disconnect = (id:string, owner:string) => {
    if (active.get(id)?.epoch === owner) cancel(id,'稻田窗口已断开');
    openings.get(id)?.finish(Error('稻田窗口已断开'));
    return clearVisit(id,owner);
  };
  return {
    settle, clearVisit,
    pending(id:string) {return openings.has(id) || active.has(id);},
    opened(next:string) {epoch = next;},
    async disconnected(id:string, old:string) {
      if (epoch === old) epoch = '';
      await disconnect(id,old);
    },
    async requestOpen(id:string) {
      if (!epoch) throw Error('桌宠尚未连接');
      const owner = epoch;
      await settle(id,true);
      if (owner !== epoch) throw Error('桌宠已断开');
      const existing = openings.get(id);
      if (existing) return existing.promise;
      let finish!:OpenRequest['finish'];
      const promise = new Promise<void>((resolve,reject)=>{
        const timer = setTimeout(()=>finish(Error('稻田窗口暂未响应，请稍后重试')),8000);
        finish = error => {clearTimeout(timer);openings.delete(id);if(error)reject(error);else resolve();};
      });
      openings.set(id,{id:randomUUID(),promise,finish});
      return promise;
    },
    async weather(id:string, value:unknown) {
      if (typeof value !== 'string' || value === 'sunny' || !Object.hasOwn(farmWeather,value)) throw Error('请选择有效的天气');
      await uow.applyCurrent(id,draft=>{changeFarmWeather(draft,value as FarmWeather,clock());return {};});
      return {field:(await snapshot(id)).field};
    },
    async execute(id:string, intent:OutboxIntent, signal:AbortSignal):Promise<ExecutionReceipt> {
      const owner = epoch, operation = (intent.payload.parameters as {operation:FarmOperation}).operation;
      try {
        if (!owner || signal.aborted) throw Error('稻田窗口尚未连接');
        const state = await settle(id);
        checkFarmBody(state,clock(),true);
        const target = farmActionTarget(state,operation,clock());
        if (owner !== epoch || signal.aborted || active.has(id)) throw Error('稻田窗口暂不可用');
        return await new Promise<ExecutionReceipt>(resolve=>{
          const timeout = setTimeout(()=>cancel(id,'稻田动作等待超时'),15000);
          const aborted = () => cancel(id,'稻田动作已中断');
          const finish:ActiveCommand['finish'] = result => {
            clearTimeout(timeout);signal.removeEventListener('abort',aborted);active.delete(id);resolve(result);
          };
          active.set(id,{id:intent.id,operation,epoch:owner,target,finish});
          signal.addEventListener('abort',aborted,{once:true});
          if (signal.aborted) aborted();
        });
      } catch (error) {
        return {status:'cancelled',evidence:{reason:error instanceof Error ? error.message : '稻田动作未开始'}};
      }
    },
    async helper(id:string, owner:string,input:{action:string;requestId?:string}) {
      if (!owner || epoch !== owner) throw Error('稻田通道已断开');
      if (input.action === 'snapshot') return snapshot(id);
      if (input.action === 'open') {await settle(id,true);return snapshot(id);}
      if (input.action === 'open-ack') {
        const opening = openings.get(id);if (opening?.id === input.requestId) opening?.finish();
        return snapshot(id);
      }
      if (input.action === 'leave') {
        cancel(id,'她已离开稻田');await clearVisit(id,owner);return snapshot(id);
      }
      const cmd = active.get(id);
      if (input.action === 'enter') {
        await settle(id,true);
        await uow.applyCurrent(id,draft=>{
          if (epoch !== owner) throw Error('稻田通道已断开');
          checkFarmBody(draft,clock(),false);
          if (farmVisit(draft)?.epoch !== owner) setFarmVisit(draft,{id:randomUUID(),epoch:owner});
          return {};
        });
      } else if (input.action === 'start' && cmd && cmd.id === input.requestId && cmd.epoch === owner) {
        if (cmd.started) throw Error('这次动作已经开始');
        try {
          const state = await uow.applyCurrent(id,draft=>{
            if (epoch !== owner || active.get(id) !== cmd) throw Error('稻田动作已中断');
            const now = clock();
            checkFarmBody(draft,now,true);
            const target = farmActionTarget(draft,cmd.operation,now);
            if (target.cropId !== cmd.target.cropId || target.date !== cmd.target.date) throw Error('稻田状态已变化');
            if (farmVisit(draft)?.epoch !== owner) setFarmVisit(draft,{id:randomUUID(),epoch:owner,actionId:cmd.id});
            return {};
          });
          cmd.started = {at:clock(),visitId:farmVisit(state)!.id};
        } catch (error) {
          if (active.get(id) === cmd) cancel(id,error instanceof Error ? error.message : '稻田动作未开始');
          throw error;
        }
      } else if (input.action === 'complete' && cmd && cmd.id === input.requestId && cmd.epoch === owner && cmd.started && clock() - cmd.started.at >= CLIP_MS) {
        cmd.finish({status:'completed',evidence:{actionId:cmd.id,kind:'farm.tend',confirmed:true,...cmd.target,visitId:cmd.started.visitId}});
      } else if (input.action === 'interrupt' && cmd?.id === input.requestId) {
        cancel(id,'稻田动作播放中断');
      } else throw Error('稻田动作回执无效');
      return snapshot(id);
    },
  };
}
