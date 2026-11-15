import {spendSpirit} from '../kernel/spirit.js';
import {budgetView} from './budget-view.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CognitiveBudget } from '../cognition/index.js';
import type { KernelStore } from '../kernel/types.js';
import type { PetGate, UnitOfWork } from '../storage/uow.js';
import type { ModelBudget } from './model-facade.js';

type Category='autonomous'|'diary'|'reflection'|'interactive';
type Context={petId:string;category:Category;ticket?:object;consumed:boolean};
const exhausted=Symbol('budget exhausted');
/** Shared UOW-backed reservation; a call already reserved by Cognition receives
 * a one-use in-memory ticket scoped to that invocation via AsyncLocalStorage. */
export class DurableCognitiveBudget implements CognitiveBudget, ModelBudget {
  private readonly context=new AsyncLocalStorage<Context>();
  private readonly tickets=new WeakMap<object,string>();
  constructor(private readonly store:KernelStore & {loadEnvelope(petId:string):Promise<CanonicalEnvelope|null>},private readonly unitOfWork:UnitOfWork,private readonly gate:PetGate) {}
  private async charge(petId:string,category:Category):Promise<boolean>{
    return this.gate.run(petId,async()=>{
      const state=await this.store.load(petId);if(!state)throw new Error('生命状态不存在');
      try {await this.unitOfWork.apply(petId,state.version,draft=>{
        try{spendSpirit(draft.life,'thought');}catch{throw exhausted;}
        const pet=draft.legacy as Record<string,any>, constraints=draft.life.constraints;
        const limit=pet.config?.learning?.dailyModelCalls;
        if(category!=='interactive' && (constraints.paused || !Number.isSafeInteger(limit) || limit<0))throw exhausted;
        if(!pet.usage || typeof pet.usage!=='object')throw new Error('模型预算记录不可用');
        const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        const usage=pet.usage[day] ||= {exploreRuns:0,modelCalls:0,diaryAttempts:0,diarySuccess:0,totalCalls:0,newStrategies:0,reflectionAttempts:0};
        usage.totalCalls??=0;usage.modelCalls??=0;usage.interactiveCalls??=0;
        if(![usage.totalCalls,usage.modelCalls,usage.interactiveCalls].every((v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0))throw new Error('模型预算记录损坏');
        if(category==='interactive'){
          const cap=pet.config?.modelBudget?.interactiveDailyCalls;
          if(cap!==undefined && (!Number.isSafeInteger(cap)||cap<0||usage.interactiveCalls>=cap))throw exhausted;
          usage.interactiveCalls++;
        } else {
          const cap=category==='autonomous'?Math.max(0,limit-2):limit;
          if(usage.totalCalls>=cap)throw exhausted;
          usage.totalCalls++;usage.modelCalls++;
          constraints.remainingBudget=Math.max(0,Math.max(0,limit-2)-usage.totalCalls);
        }
        Object.assign(constraints,budgetView(pet,new Date()));
        return {};
      });return true;}catch(error){if(error===exhausted)return false;throw error;}
    });
  }
  /** Refresh the read-only daily projection only when day or configured usage changes. */
  async refresh(petId:string):Promise<void> {
    await this.gate.run(petId,async()=>{const current=await this.store.loadEnvelope(petId);if(!current||this.gate.signal.aborted)throw Error('生命状态不可用');const view=budgetView(current.legacy as Record<string,any>,new Date());const c=current.life.constraints;if(c.budgetDay===view.budgetDay && c.remainingBudget===view.remainingBudget && c.interactiveRemaining===view.interactiveRemaining)return;await this.unitOfWork.apply(petId,current.version,draft=>{Object.assign(draft.life.constraints,budgetView(draft.legacy as Record<string,any>,new Date()));return {};});});
  }
  async reserve(petId:string):Promise<object|null>;
  async reserve(provider:string,model:string,signal:AbortSignal):Promise<() => void>;
  async reserve(first:string,_model?:string,signal?:AbortSignal):Promise<object|null|(() => void)>{
    if(signal===undefined){if(!await this.charge(first,'autonomous'))return null;const ticket={};this.tickets.set(ticket,first);return ticket;}
    if(signal.aborted)throw new Error('模型请求已取消');
    const context=this.context.getStore();if(!context)throw new Error('模型调用缺少预算上下文');
    if(context.ticket && !context.consumed && this.tickets.get(context.ticket)===context.petId){context.consumed=true;this.tickets.delete(context.ticket);return ()=>{};}
    if(!await this.charge(context.petId,context.category))throw new Error('模型调用额度不足');
    if(signal.aborted)throw new Error('模型请求已取消');return ()=>{};
  }
  withReserved<T>(petId:string,ticket:object,fn:()=>Promise<T>):Promise<T>{
    if(this.tickets.get(ticket)!==petId)throw new Error('模型预算票据无效');
    return this.context.run({petId,category:'autonomous',ticket,consumed:false},async()=>{try{return await fn();}finally{this.tickets.delete(ticket);}});
  }
  /** Host wraps each non-cognitive entry point with the correct trusted pet
   * and category; callers must not supply this context from model output. */
  runAs<T>(petId:string,category:Category,fn:()=>Promise<T>):Promise<T>{
    if(!petId || !['autonomous','diary','reflection','interactive'].includes(category))throw new Error('模型预算类别无效');
    return this.context.run({petId,category,consumed:false},fn);
  }
}
