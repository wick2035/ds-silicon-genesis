import { createHash, randomUUID } from 'node:crypto';
import {manageLabor} from './labor-management.js';
import {invalidateDependents} from '../kernel/index.js';
import type {LifeState} from '../kernel/types.js';
import { rebuildRelationships } from '../kernel/index.js';
import { attachLaborRuntime } from '../../vendor/pet-plugins/behavior/labor.mjs';
import { CompanionStore } from '../../vendor/pet-plugins/behavior/core.mjs';
import { sanitizeMemoryData } from '../../vendor/pet-plugins/behavior/memory-privacy.mjs';
import {spaceReport,updateSpace} from '../../vendor/pet-plugins/behavior/space.mjs';
import {SOFT_SCENES} from '../../vendor/pet-plugins/behavior/soft-tantrum.mjs';
import type { CanonicalEnvelope } from '../storage/postgres.js';
import type { PetGate, UnitOfWork } from '../storage/uow.js';

interface Reader { loadEnvelope(petId: string): Promise<CanonicalEnvelope | null> }
type Obj = Record<string, any>;
type StoreMethod = 'wallet' | 'configure' | 'grant' | 'configureNetwork' | 'memory' | 'growthControl' | 'record';
const methods = new Set<StoreMethod>(['wallet','configure','grant','configureNetwork','memory','growthControl','record']);
const namespaced = (kind: string, id: string) => `legacy:${kind}:${encodeURIComponent(id)}`;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:-]{8,140}$/.test(value);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');

/** Call only vetted CompanionStore prototype methods. No constructor, file path,
 * importLegacy, arbitrary update callbacks, timers, network or runtime methods. */
function isolatedStore(petId: string, pet: Obj, now: number): CompanionStore {
  const store = Object.create(CompanionStore.prototype) as CompanionStore;
  store.data = { version: 2, pets: { [petId]: structuredClone(pet) } };
  store.loaded = true;
  store.clock = () => now;
  Object.defineProperty(store, 'load', { value: () => {}, writable: false });
  Object.defineProperty(store, 'save', { value: () => { store.data = sanitizeMemoryData(store.data); }, writable: false });
  return store;
}
function invalidateSources(draft: CanonicalEnvelope, ids: string[]): void {
  const invalid = draft.life.invalidSources;
  for (const id of ids) for (const group of ['event','fact','memory','strategy','tombstone']) invalid[namespaced(group,id)] = '旧记忆已删除或纠正';
  invalidateDependents(draft.life as unknown as LifeState);
}
function correction(draft:CanonicalEnvelope,oldId:string,content:string,now:number):string {
  const stamp=new Date(now).toISOString(),eventId=`legacy-correction:${randomUUID()}`;
  draft.life.events.push({eventId,petId:draft.petId,type:'management.memory',source:'user',occurredAt:stamp,receivedAt:stamp,evidenceLevel:'reported',payload:{correctedId:oldId}});
  const id=`memory:${randomUUID()}`;draft.life.memories.push({id,kind:'autobiographical',content,sourceIds:[eventId],evidenceLevel:'reported',valid:true,createdAt:stamp});return id;
}

/** The original laborAction contains domain transitions followed by runtime
 * callbacks. This isolated runtime explicitly disables every callback that
 * would start cognition, timers, an animation or an external effect. */
class LaborDraftRuntime {
  store: CompanionStore;
  laborControllers = new Map<string,AbortController>();
  constructor(store: CompanionStore) { this.store = store; }
  [key: string]: any;
}
attachLaborRuntime(LaborDraftRuntime);
LaborDraftRuntime.prototype.decideLabor = () => {};
LaborDraftRuntime.prototype.advanceLabor = () => {};
LaborDraftRuntime.prototype.settleLaborEffort = (_id: string, command: Obj) => {
  if (Number.isFinite(command?.stepStarted)) throw new Error('进行中的搬砖须先由可信执行回执结算体力');
};
/** Legacy-domain operations are asynchronous. No effects may be dispatched or
 * user-visible success returned before the enclosing UnitOfWork commits. */
export class LegacyDomain {
  readonly #observerAuthority: object;
  constructor(private readonly reader: Reader, private readonly uow: UnitOfWork, private readonly gate: PetGate,
    observerAuthority: object, private readonly clock: () => number = Date.now) {
    if (!observerAuthority || typeof observerAuthority !== 'object') throw new Error('缺少可信观察者凭据');
    this.#observerAuthority = observerAuthority;
  }
  private async mutate(petId: string, operationId: string, kind: string, input: unknown,
    apply: (store: CompanionStore, draft: CanonicalEnvelope) => unknown): Promise<unknown> {
    if (!identity(operationId)) throw new Error('操作需要稳定标识');
    return this.gate.run(petId, async () => {
      const envelope = await this.reader.loadEnvelope(petId);
      if (!envelope || envelope.petId !== petId) throw new Error('生命状态不存在');
      if (this.gate.signal.aborted) throw new Error('写入租约已失去');
      const now = this.clock(); if (!Number.isFinite(now)) throw new Error('时间无效');
      let output: unknown;
      await this.uow.apply(petId, envelope.version, draft => {
        const previous = (draft.legacy.canonicalOperations as Obj | undefined)?.[operationId];
        if (previous) {
          if (previous.kind !== kind || previous.inputHash !== fingerprint(input)) throw new Error('操作标识冲突');
          output = structuredClone(previous.output); return {};
        }
        const store = isolatedStore(petId, draft.legacy, now);
        output = sanitizeMemoryData(apply(store, draft));
        const pet = store.data.pets[petId] as Obj;
        pet.canonicalOperations = {...pet.canonicalOperations,[operationId]:{kind,inputHash:fingerprint(input),output:structuredClone(output)}};
        draft.legacy = pet;
        const descriptions:Record<string,string>={wallet:'爸爸调整了你的饭钱',configure:'爸爸调整了你的生活设置',grant:'爸爸调整了你的能力授权',configureNetwork:'爸爸调整了联网学习开关',memory:'爸爸修改了记忆，请尊重修改，不复述删除内容',growthControl:'爸爸调整了成长设置',diary:'爸爸整理了日记',wish:'爸爸处理了你的念想','world-stop':'爸爸停止了当前活动',soft:'爸爸与你进行了情绪互动','labor-action':'爸爸调整了工作约定或进度','token-drop':'爸爸放下了饭钱','token-collect':'爸爸收回了地上的饭钱'};
        if(descriptions[kind]){const stamp=new Date(now).toISOString();draft.life.events.push({eventId:'operation:'+operationId,petId,type:'interaction.operation',source:'user',actorId:'dad',occurredAt:stamp,receivedAt:stamp,evidenceLevel:'observed',payload:{operation:kind,description:descriptions[kind]}});draft.life.memories.push({id:'operation-memory:'+operationId,kind:'autobiographical',content:descriptions[kind],sourceIds:['operation:'+operationId],evidenceLevel:'observed',valid:true,createdAt:stamp});}

        for (const event of Array.isArray(pet.events) ? pet.events : []) {
          if (typeof event.id !== 'string' || !event.id || !Number.isFinite(event.ts)) continue;
          const id = namespaced('event',event.id);
          if (draft.life.events.some(e => e.eventId === id) || Object.hasOwn(draft.life.invalidSources,id)) continue;
          const stamp = new Date(event.ts).toISOString();
          draft.life.events.push({eventId:id,petId,type:typeof event.kind === 'string' && event.kind ? event.kind : 'legacy.event',source:'canonical-legacy',...(event.kind==='wallet'?{actorId:'dad'}:{}),occurredAt:stamp,receivedAt:stamp,evidenceLevel:event.kind === 'explicit' ? 'reported' : 'observed',payload:structuredClone(event)});
          // A manual wallet adjustment (add/subtract/set/freeze) is a deliberate
          // action by dad that she should remember as an event, not just a number
          // change. Mirror it into long-term memory with the same source binding.
          if (event.kind === 'wallet') {
            const memoryId = namespaced('memory',event.id);
            if (!draft.life.memories.some(m => m.id === memoryId)) {
              draft.life.memories.push({id:memoryId,kind:'autobiographical',content:typeof event.text === 'string' && event.text ? event.text : '爸爸调整了饭钱',sourceIds:[id],evidenceLevel:'observed',valid:true,createdAt:stamp});
            }
          }
        }
        return {};
      });
      return structuredClone(output);
    });
  }
  private call(petId: string, requestId: string, method: StoreMethod, args: unknown[]): Promise<unknown> {
    if (!methods.has(method)) throw new Error('不支持的旧领域操作');
    return this.mutate(petId, requestId, method, args, (store,draft) => {
      let old: Obj | undefined;
      let factsBefore:Set<string>|undefined;
      if (method === 'memory' || method === 'growthControl') {
        const input = args[0] as Obj;
        const pet = store.read(petId) as Obj;
        if(method==='memory' && input?.action==='add')factsBefore=new Set((pet.facts||[]).map((f:Obj)=>f.id));
        if (method === 'memory' && ['edit','delete'].includes(input?.action)) old = pet.facts?.find((x: Obj) => x.id === input.id && !x.deleted);
        if (method === 'growthControl' && ['edit-memory','delete-memory'].includes(input?.action)) old = pet.growth?.memories?.find((x: Obj) => x.id === input.id && !x.deleted);
      }
      const result = store[method](petId,...args);
      if(factsBefore){
        const pet=store.data.pets[petId] as Obj;
        for(const fact of (pet.facts||[]).filter((f:Obj)=>!f.deleted && !factsBefore!.has(f.id))){
          const id=namespaced('fact',fact.id),sources=(fact.sources||[]).map((source:string)=>namespaced('event',source));
          if(!draft.life.memories.some(m=>m.id===id))draft.life.memories.push({id,kind:'semantic',content:fact.text,sourceIds:sources,evidenceLevel:'reported',valid:true,createdAt:new Date(fact.ts).toISOString()});
        }
      }
      if(method==='grant' && args[1]!=='grant') draft.life.constraints.permissions=draft.life.constraints.permissions.filter(p=>p!=='network');
      if(method==='configure' && typeof (args[0] as Obj)?.autonomousPaused==='boolean') draft.life.constraints.paused=(args[0] as Obj).autonomousPaused;
      if(method==='growthControl' && (args[0] as Obj)?.action==='pause' && typeof (args[0] as Obj).paused==='boolean')draft.life.constraints.paused=(args[0] as Obj).paused;
      if(method==='configure' || method==='grant' || method==='configureNetwork') {
        const pet=store.data.pets[petId] as Obj;
        const allowed=pet.config?.networkLearning===true && ['search','fetch','bili'].some(name=>pet.abilities?.[name]?.status==='granted');
        draft.life.constraints.permissions=draft.life.constraints.permissions.filter(p=>p!=='network');
        if(allowed)draft.life.constraints.permissions.push('network');
      }
      if (old) {
        const group=method==='memory'?'fact':'memory',id=namespaced(group,old.id);
        const pet=store.data.pets[petId] as Obj,prior=pet.canonicalCorrections?.[id];
        if(typeof prior==='string'){draft.life.invalidSources[prior]='旧记忆已删除或纠正';const memory=draft.life.memories.find(m=>m.id===prior);if(memory)memory.valid=false;}
        invalidateSources(draft, [old.id,...(Array.isArray(old.sources) ? old.sources : [])].filter((x): x is string => typeof x === 'string'));
        const input=args[0] as Obj;
        if(['edit','edit-memory'].includes(input.action)&&typeof input.text==='string'&&input.text.trim()){pet.canonicalCorrections||={};pet.canonicalCorrections[id]=correction(draft,id,input.text.trim(),store.clock());}
      }
      return result;
    });
  }
  wallet(petId: string, requestId: string, input: Record<string, unknown>): Promise<unknown> {
    return this.mutate(petId,requestId,'wallet',[input],store=>{
      const wallet=(store.read(petId) as Obj).wallet;
      if (input.expectedBalance !== undefined && input.expectedBalance !== wallet.balance) throw Error('饭钱余额已变化，请刷新后重试');
      if (input.expectedFrozen !== undefined && input.expectedFrozen !== wallet.frozen) throw Error('消耗状态已变化，请刷新后重试');
      return store.wallet(petId,input);
    });
  }
  configure(petId: string, requestId: string, input: Record<string, unknown>): Promise<unknown> { return this.call(petId,requestId,'configure',[input]); }
  grant(petId: string, requestId: string, ability: string, action: string): Promise<unknown> { return this.call(petId,requestId,'grant',[ability,action]); }
  configureNetwork(petId: string, requestId: string, enabled: boolean): Promise<unknown> { return this.call(petId,requestId,'configureNetwork',[enabled]); }
  memory(petId: string, requestId: string, input: Record<string, unknown>): Promise<unknown> { return this.call(petId,requestId,'memory',[input]); }
  growthControl(petId: string, requestId: string, input: Record<string, unknown>): Promise<unknown> { return this.call(petId,requestId,'growthControl',[input]); }
  diary(petId:string, requestId:string, input:Record<string,unknown>):Promise<unknown> {
    return this.mutate(petId,requestId,'diary',input,(store,draft)=>store.update(petId,(pet:Obj)=>{
      const date=input.date;if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('日期无效');
      const entry=pet.diaries?.[date];if(!entry)throw Error('没有这天的日记');
      if(input.expectedText!==undefined && input.expectedText!==entry.text)throw Error('日记已变化，请刷新后重试');
      if(input.expectedRevision!==undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision!==(Number(entry.revision)||0)))throw Error('日记已变化，请刷新后重试');
      const id=typeof entry.canonicalMemoryId==='string'?entry.canonicalMemoryId:namespaced('diary',date),memory=draft.life.memories.find(m=>m.id===id);if(memory){memory.valid=false;draft.life.invalidSources[id]='旧日记已删除或纠正';invalidateDependents(draft.life as unknown as LifeState);}
      if(input.action==='delete'){delete pet.diaries[date];pet.deletedDays ||= [];if(!pet.deletedDays.includes(date))pet.deletedDays.push(date);return {deleted:true};}
      if(input.action!=='edit'||typeof input.text!=='string'||!input.text.trim()||input.text.length>5000)throw Error('日记内容无效');
      entry.text=input.text;entry.revision=(Number(entry.revision)||0)+1;entry.updatedAt=store.clock();entry.canonicalMemoryId=correction(draft,id,input.text.trim(),store.clock());return structuredClone(entry);
    }));
  }
  wish(petId:string, requestId:string, input:Record<string,unknown>):Promise<unknown> {
    return this.mutate(petId,requestId,'wish',input,store=>store.update(petId,(pet:Obj)=>{
      if(input.action==='dismiss'){const wish=pet.wishes.find((w:Obj)=>w.id===input.id);if(!wish)throw Error('没有这个念想');wish.status='dismissed';return structuredClone(wish);}
      if(typeof input.topic!=='string'||!input.topic.trim()||input.topic.length>120||!['search','fetch','bili','image'].includes(String(input.ability)))throw Error('念想内容无效');
      store.wishIn(pet,input.topic,input.ability);return {created:true};
    }));
  }
  observeSpace(petId:string,requestId:string,input:unknown,authority:object):Promise<unknown> {
    if(authority!==this.#observerAuthority)throw Error('活动空间缺少可信观察');
    const report=spaceReport(input);if(report.surface!=='desktop')throw Error('活动端不匹配');
    return this.mutate(petId,requestId,'space',report,store=>store.update(petId,(pet:Obj)=>{
      const {next,change}=updateSpace(pet.space,report,{display:'desktop',confined:pet.space?.confined===true});pet.space=next;
      if(change)store.eventIn(pet,'space',change.text,`space:${requestId}`);
      return structuredClone(next);
    }));
  }
  tokenLayout(petId:string,requestId:string,positions:unknown,authority:object):Promise<unknown> {
    if(authority!==this.#observerAuthority || !Array.isArray(positions)||positions.length>24)throw Error('碎片布局无效');
    const points=positions.map((p:Obj)=>{if(typeof p?.id!=='string'||![p.x,p.y].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1))throw Error('碎片位置无效');return {id:p.id,x:p.x,y:p.y};});
    return this.mutate(petId,requestId,'token-layout',points,store=>store.update(petId,(pet:Obj)=>{
      for(const point of points){const coin=pet.tokens?.coins?.find((c:Obj)=>c.id===point.id&&c.surface==='desktop'&&c.status==='floor');if(coin)Object.assign(coin,{x:point.x,y:point.y});}
      return {updated:true};
    }));
  }
  stopWorld(petId:string,requestId:string):Promise<unknown> {
    return this.mutate(petId,requestId,'world-stop',{},store=>store.update(petId,(pet:Obj)=>{
      const command=pet.world?.command;if(command&&['queued','running'].includes(command.status))command.status='interrupted';
      return {stopped:true};
    }));
  }
  soft(petId:string,requestId:string,input:Obj):Promise<unknown> {
    return this.mutate(petId,requestId,'soft',input,(store,draft)=>store.update(petId,(pet:Obj)=>{
      pet.world||={};const soft=pet.world.soft||={current:null};let current=soft.current;
      if(current?.expires<=store.clock())current=soft.current=null;
      if(input.action==='dismiss'){if(current&&current.id!==input.id)throw Error('这段小剧场已变化');soft.current=null;return {current:null};}
      if(input.action==='start'){
        if(!Object.hasOwn(SOFT_SCENES,input.scene))throw Error('没有这个小剧场');
        const h=draft.humanity as Obj;if(h.sleeping||h.restingUntil>store.clock()||h.stats?.pain>=80||pet.labor?.contracts?.some((c:Obj)=>c.status==='working'))throw Error('她正在休息或工作，稍后再玩');
        const def=SOFT_SCENES[input.scene];current=soft.current={id:randomUUID(),scene:input.scene,pose:def.pose,status:'waiting',expires:store.clock()+60000,choices:def.choices.map(c=>({id:c.id,label:c.label}))};
      } else if(input.action==='choose'){
        if(!current||current.id!==input.id||current.status!=='waiting')throw Error('这段小剧场已结束');
        const selected=SOFT_SCENES[current.scene]?.choices.find(c=>c.id===input.choice);if(!selected)throw Error('没有这个回应');
        current.status='settled';current.choice=selected.id;current.pose=selected.id==='tuck'?'sulk_blanket':'coax';current.choices=[];current.expires=store.clock()+10000;
        store.eventIn(pet,'play',`爸爸在小剧场里选择：${selected.label}`,'soft:'+current.id+':'+selected.id,{scene:current.scene,choice:selected.id,roleplay:true});
      }else throw Error('未知互动');
      return {current:structuredClone(current)};
    }));
  }
  record(petId: string, requestId: string, kind: string, text: string, source: string, extra: Record<string, unknown>, authority: object): Promise<unknown> {
    if (authority !== this.#observerAuthority || !identity(source) || !kind || typeof text !== 'string' || !extra || Object.keys(extra).some(k => ['id','kind','text','ts'].includes(k))) throw new Error('事件缺少可信来源或包含保留字段');
    return this.call(petId,requestId,'record',[kind,text,source,extra]);
  }
  /** Domain-only offer, negotiation, confirmation, interruption and simulated
   * settlement. Execution and decisions are separate approved workflows. */
  laborAction(petId: string, requestId: string, input: Record<string, unknown>, authority?: object): Promise<unknown> {
    if (!input || !['offer','confirm','decline','pause','resume','counter','nudge','disturb','pay','adjust','cancel','settle-cancelled'].includes(String(input.action))) throw new Error('不支持的工作操作');
    if (input.action === 'disturb' && authority !== this.#observerAuthority) throw new Error('搬砖打扰缺少可信观察');
    return this.mutate(petId,requestId,'labor-action',input,(store,draft) => {
      const runtime = new LaborDraftRuntime(store);
      const result = ['adjust','cancel','settle-cancelled'].includes(String(input.action))?manageLabor(store,petId,input):runtime.laborAction(petId,input);
      if(['adjust','cancel','settle-cancelled'].includes(String(input.action))){
        const event=store.read(petId).events.at(-1),eventId='labor-change:'+requestId,at=new Date(store.clock()).toISOString();
        draft.life.events.push({eventId,petId,type:'labor.changed',source:'user',actorId:'dad',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{contractId:input.id,action:input.action,description:event.text}});
        draft.life.memories.push({id:'labor-memory:'+requestId,kind:'autobiographical',content:event.text,sourceIds:[eventId],evidenceLevel:'observed',valid:true,createdAt:at});
      }
      if (input.action === 'confirm' || input.action === 'pay') {
        const contract = store.read(petId).labor?.contracts?.find((c: Obj) => c.id===input.id);
        if (!contract) throw new Error('工作约定不存在');
        const id = 'social-labor:'+requestId, now = new Date(store.clock()).toISOString();
        draft.life.events.push({eventId:id,petId,type:input.action==='confirm'?'social.labor.confirmed':'social.labor.payment',source:'user',actorId:'dad',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{contractId:contract.id,amount:input.action==='pay'?input.amount:0,outstanding:Math.max(0,contract.wage-contract.paid)}});
        rebuildRelationships(draft.life);
      }
      return result;
    });
  }
  laborDecision(petId:string,requestId:string,input:{id:string;trips:number;wage:number;choice:'accept'|'bargain'|'decline';counterTrips?:number;counterWage?:number}):Promise<unknown> {
    return this.mutate(petId,requestId,'labor-decision',input,(store,draft)=>store.update(petId,(pet:Obj)=>{
      const c=pet.labor?.contracts?.find((item:Obj)=>item.id===input.id && item.status==='offered');
      if(!c||c.trips!==input.trips||c.wage!==input.wage||c.accepted||c.counter)throw Error('工作约定已变化，请刷新后重试');
      c.accepted=input.choice==='accept';
      c.counter=input.choice==='bargain'?{trips:input.counterTrips,wage:input.counterWage}:null;
      if(input.choice==='decline')c.status='declined';
      const text=input.choice==='accept'?'她答应了这份工作，等待确认开工。':input.choice==='bargain'?`她提出 ${input.counterTrips} 趟、${input.counterWage} token 的还价。`:'她拒绝了这份工作。';
      store.eventIn(pet,'labor',text,'labor-decision:'+requestId);
      const at=new Date(store.clock()).toISOString();
      draft.life.events.push({eventId:'labor-response:'+requestId,petId,type:'labor.offer.decision',source:'model',occurredAt:at,receivedAt:at,evidenceLevel:'inferred',payload:{contractId:c.id,choice:input.choice,trips:c.trips,wage:c.wage}});
      return {choice:input.choice};
    }));
  }
  /** A dropped fragment must be an authenticated observed physical event. */
  dropToken(petId: string, requestId: string, input: Record<string, unknown>, authority: object): Promise<unknown> {
    if (authority !== this.#observerAuthority) throw new Error('饭钱掉落缺少可信观察');
    return this.mutate(petId,requestId,'token-drop',input,store => store.dropToken(petId,input));
  }
  collectToken(petId: string, requestId: string, coinId: string, authority: object): Promise<unknown> {
    if (authority !== this.#observerAuthority || typeof coinId !== 'string' || !coinId) throw new Error('饭钱收取缺少可信观察');
    return this.mutate(petId,requestId,'token-collect',{coinId},store => store.collectToken(petId,coinId));
  }  async workStatus(petId: string): Promise<unknown> {
    const envelope = await this.reader.loadEnvelope(petId); if (!envelope) throw new Error('生命状态不存在');
    const legacy = envelope.legacy as Obj;
    return structuredClone({labor:legacy.labor ?? {contracts:[]}, command:legacy.world?.command ?? null, jobs:legacy.jobs ?? []});
  }
  /** Only user-authorized contract state changes; no travel, trips or payment are fabricated. */
  laborControl(petId: string, requestId: string, contractId: string, action: 'pause' | 'resume'): Promise<unknown> {
    if (!['pause','resume'].includes(action)) throw new Error('不支持的工作操作');
    return this.mutate(petId,requestId,'labor-control',{contractId,action}, (store) => store.update(petId,(pet: Obj) => {
      const contract = pet.labor?.contracts?.find((c: Obj) => c.id === contractId);
      if (!contract || !['working','paused'].includes(contract.status)) throw new Error('现在没有可暂停或继续的工作');
      contract.status = action === 'pause' ? 'paused' : 'working'; contract.nextDecision = store.clock();
      if (action === 'resume') contract.workDecisions = 0;
      if (action === 'pause' && pet.world?.command?.source === 'labor') pet.world.command.status = 'interrupted';
      return structuredClone(contract);
    }));
  }
}
