import {CognitiveError} from '../cognition/diagnostics.js';
import {checkSpirit,advanceSpirit,spendSpirit,spendConversationSpirit} from '../kernel/spirit.js';
import {budgetView} from './budget-view.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type { CognitiveBudget } from '../cognition/index.js';
import type { KernelStore } from '../kernel/types.js';
import type { PetGate, UnitOfWork } from '../storage/uow.js';
import type { ModelBudget } from './model-facade.js';

type Category='autonomous'|'diary'|'reflection'|'interactive'|'food-request';
type Context={petId:string;category:Category;ticket?:object;consumed:boolean;purpose?:string};
type Charge={id:string;day:string;spiritCost:number};
type Outcome='completed'|'failed'|'not-sent';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const exhausted=Symbol('budget exhausted');
/** The cognition ticket performs a read-only preflight; the actual request is
 * charged under the pet gate immediately before network dispatch. */
export class DurableCognitiveBudget implements CognitiveBudget, ModelBudget {
  private readonly context=new AsyncLocalStorage<Context>();
  private readonly tickets=new WeakMap<object,string>();
  constructor(private readonly store:KernelStore & {loadEnvelope(petId:string):Promise<CanonicalEnvelope|null>},private readonly unitOfWork:UnitOfWork,private readonly gate:PetGate) {}
  private async charge(petId:string,category:Category,purpose:string,provider:string,model:string,signal:AbortSignal):Promise<Charge|null>{
    return this.gate.run(petId,async()=>{
      const state=await this.store.load(petId);if(!state)throw new Error('生命状态不存在');
      let record:Charge|undefined;
      try {await this.unitOfWork.apply(petId,state.version,draft=>{
        if(signal.aborted)throw new Error('模型请求已取消');
        record=this.chargeDraft(draft,category,purpose,provider,model);
        return {};
      });return record!;}catch(error){if(error===exhausted)return null;throw error;}
    });
  }
  private chargeDraft(draft:CanonicalEnvelope,category:Category,purpose='',provider='',model=''):Charge {
    let spiritCost:number;
    try{const before=advanceSpirit(draft.life).value;if(category==='interactive'||category==='food-request')spendConversationSpirit(draft.life);else spendSpirit(draft.life,'thought');spiritCost=Math.max(0,before-draft.life.spirit!.value);}catch{throw exhausted;}
    const pet=draft.legacy as Record<string,any>, constraints=draft.life.constraints;
    const limit=pet.config?.learning?.dailyModelCalls;
    if(category!=='interactive' && (constraints.paused || category!=='food-request'&&(!Number.isSafeInteger(limit) || limit<0)))throw exhausted;
    if(category==='food-request'&&(pet.config?.autonomousPaused||pet.growth?.stopAt||draft.humanity.sleeping))throw exhausted;
    if(!pet.usage || typeof pet.usage!=='object')throw new Error('模型预算记录不可用');
    const day=today();
    const usage=pet.usage[day] ||= {exploreRuns:0,modelCalls:0,diaryAttempts:0,diarySuccess:0,totalCalls:0,newStrategies:0,reflectionAttempts:0};
    usage.totalCalls??=0;usage.modelCalls??=0;usage.interactiveCalls??=0;
    if(![usage.totalCalls,usage.modelCalls,usage.interactiveCalls].every((v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0))throw new Error('模型预算记录损坏');
    const id=randomUUID();
    if(category==='interactive'){
      const cap=pet.config?.modelBudget?.interactiveDailyCalls;
      if(cap!==undefined && (!Number.isSafeInteger(cap)||cap<0||usage.interactiveCalls>=cap))throw exhausted;
      usage.interactiveCalls++;
    } else if(category==='food-request') {
      // Food appeals have their own durable interval/hourly gate. They never
      // consume the daily initiative allowance or interactive conversation cap.
      usage.foodRequestCalls??=0;
      if(!Number.isSafeInteger(usage.foodRequestCalls)||usage.foodRequestCalls<0)throw Error('要饭请求记录损坏');
      usage.foodRequestCalls++;
      (usage.foodRequestDetails??=[]).push({id,at:new Date().toISOString(),category,purpose,provider,model,status:'started'});
    } else {
      const cap=category==='autonomous'?Math.max(0,limit-2):limit;
      if(usage.totalCalls>=cap)throw exhausted;
      usage.totalCalls++;usage.modelCalls++;
      (usage.callDetails??=[]).push({id,at:new Date().toISOString(),category,purpose,provider,model,status:'started'});
    }
    Object.assign(constraints,budgetView(pet,new Date()));
    return {id,day,spiritCost};
  }
  private async finish(petId:string,category:Category,charge:Charge,outcome:Outcome):Promise<void>{
    if(category==='interactive')return;
    await this.gate.run(petId,async()=>{
      const current=await this.store.loadEnvelope(petId);if(!current)throw Error('生命状态不存在');
      await this.unitOfWork.apply(petId,current.version,draft=>{
        const pet=draft.legacy as Record<string,any>,usage=pet.usage?.[charge.day];
        const details=category==='food-request'?usage?.foodRequestDetails:usage?.callDetails;if(!Array.isArray(details))return {};
        const index=details.findIndex((item:any)=>item.id===charge.id);if(index<0||details[index].status!=='started')return {};
        if(outcome==='not-sent'){
          details.splice(index,1);
          if(category==='food-request')usage.foodRequestCalls--;else {usage.totalCalls--;usage.modelCalls--;}
          const spirit=advanceSpirit(draft.life);spirit.value=Math.min(100,spirit.value+charge.spiritCost);
          Object.assign(draft.life.constraints,budgetView(pet,new Date()));
        }else details[index].status=outcome;
        return {};
      });
    });
  }
  /** Charge the first chat generation atomically with its durable user turn. */
  reserveInteractive(draft:CanonicalEnvelope):object {
    try{this.chargeDraft(draft,'interactive');}catch(error){if(error===exhausted)throw Error('模型调用额度不足');throw error;}
    const ticket={};this.tickets.set(ticket,draft.petId);return ticket;
  }
  runInteractiveReserved<T>(petId:string,ticket:object,fn:()=>Promise<T>):Promise<T>{
    if(this.tickets.get(ticket)!==petId)throw Error('模型预算票据无效');
    return this.context.run({petId,category:'interactive',ticket,consumed:false},async()=>{try{return await fn();}finally{this.tickets.delete(ticket);}});
  }
  /** Refresh the read-only daily projection only when day or configured usage changes. */
  async refresh(petId:string):Promise<void> {
    await this.gate.run(petId,async()=>{const current=await this.store.loadEnvelope(petId);if(!current||this.gate.signal.aborted)throw Error('生命状态不可用');const view=budgetView(current.legacy as Record<string,any>,new Date());const c=current.life.constraints;if(c.budgetDay===view.budgetDay && c.remainingBudget===view.remainingBudget && c.interactiveRemaining===view.interactiveRemaining)return;await this.unitOfWork.apply(petId,current.version,draft=>{Object.assign(draft.life.constraints,budgetView(draft.legacy as Record<string,any>,new Date()));return {};});});
  }
  async reserve(petId:string):Promise<object|null>;
  async reserve(provider:string,model:string,signal:AbortSignal):Promise<(outcome?:Outcome) => void | Promise<void>>;
  async reserve(first:string,_model?:string,signal?:AbortSignal):Promise<object|null|((outcome?:Outcome) => void | Promise<void>)>{
    if(signal===undefined){
      const state=await this.store.load(first);if(!state || state.constraints.paused)return null;
      const view=budgetView((await this.store.loadEnvelope(first))?.legacy as Record<string,any>,new Date());
      if(view.remainingBudget<=0)return null;
      try{checkSpirit(structuredClone(state),'thought');}catch{return null;}
      const ticket={};this.tickets.set(ticket,first);return ticket;
    }
    if(signal.aborted)throw new Error('模型请求已取消');
    const context=this.context.getStore();if(!context)throw new Error('模型调用缺少预算上下文');
    if(context.ticket && !context.consumed && this.tickets.get(context.ticket)===context.petId){
      context.consumed=true;this.tickets.delete(context.ticket);
      if(context.category==='interactive')return ()=>{};
    }
    const purpose=context.purpose??({autonomous:'自主行为',diary:'日记整理',reflection:'成长反思',interactive:'互动','food-request':'独立食物决策（不占自主额度）'}[context.category]);
    const charged=await this.charge(context.petId,context.category,purpose,first,_model??'',signal);
    if(!charged)throw new CognitiveError('budget_exhausted','模型调用额度不足');
    if(signal.aborted){await this.finish(context.petId,context.category,charged,'not-sent');throw new Error('模型请求已取消');}
    let finished=false;
    return async (outcome:Outcome='completed')=>{if(finished)return;finished=true;await this.finish(context.petId,context.category,charged,outcome);};
  }
  withReserved<T>(petId:string,ticket:object,fn:()=>Promise<T>):Promise<T>{
    if(this.tickets.get(ticket)!==petId)throw Error('模型预算票据无效');
    return this.context.run({petId,category:'autonomous',purpose:'综合自主决策',ticket,consumed:false},async()=>{try{return await fn();}finally{this.tickets.delete(ticket);}});
  }
  /** Host wraps each non-cognitive entry point with the correct trusted pet
   * and category; callers must not supply this context from model output. */
  runAs<T>(petId:string,category:Category,fn:()=>Promise<T>,purpose?:string):Promise<T>{
    if(!petId || !['autonomous','diary','reflection','interactive','food-request'].includes(category))throw new Error('模型预算类别无效');
    return this.context.run({petId,category,consumed:false,purpose},fn);
  }
}
