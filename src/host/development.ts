import {checkSimulatedSpending,settleSimulatedSpending} from './simulated-spending.js';
import {randomUUID} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
import type {DurableCognitiveBudget} from './cognitive-budget.js';
type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
type Model={llm:{stream(input:unknown):AsyncIterable<any>};agentDefaultModel:{currentSelection():{provider:string;model:string}}};
type Kind='diary'|'reflection';
/** Daily claims are committed before a model call; a crash cannot repeat that
 * call, and invalidated sources cannot be written back after the call. */
export function createDevelopment(store:Reader,gate:PetGate,uow:UnitOfWork,budget:DurableCognitiveBudget,model:Model) {
  const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  async function task(id:string,kind:Kind,signal:AbortSignal,manual=false,date=day()):Promise<boolean>{
    if(signal.aborted||gate.signal.aborted||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>day())throw Error('整理请求无效');
    const claim=await gate.run(id,async()=>{
      const state=await store.loadEnvelope(id);if(!state||(!manual && state.life.constraints.paused))throw Error('自主活动已暂停');
      const pet=state.legacy as Record<string,any>;
      if(kind==='diary' && (!manual && pet.config?.diaryEnabled===false || pet.diaries?.[date] || pet.deletedDays?.includes(date)))return null;
      const used=new Set<string>(Object.entries(pet.developmentClaims||{}).filter(([key,value]:[string,any])=>key.startsWith(kind+':')&&value?.status==='completed').flatMap(([,value]:[string,any])=>Array.isArray(value.sourceIds)?value.sourceIds:[]));
      const events=state.life.events.filter(e=>!used.has(e.eventId)&&!Object.hasOwn(state.life.invalidSources,e.eventId)&&['observed','verified','reported'].includes(e.evidenceLevel)&&!e.type.startsWith('development.')&&e.occurredAt.slice(0,10)<=date).slice(-30);
      if(!events.length)return null;
      const key=kind+':'+date,previous=pet.developmentClaims?.[key];
      // An explicit retry may recover a failed attempt; an in-flight or
      // completed claim is never repeated automatically.
      if(previous && !(manual && previous.status==='failed'))return null;
      if(kind==='diary')checkSimulatedSpending(state,'diary');
      await uow.apply(id,state.version,draft=>{const p=draft.legacy as Record<string,any>;p.developmentClaims||={};const old=p.developmentClaims[key];if(old && !(manual && old.status==='failed'))throw Error('整理已领取');p.developmentClaims[key]={status:'running',at:Date.now(),attempt:(Number(old?.attempt)||0)+1};return {};});
      return {key,events:events.map(e=>({id:e.eventId,type:e.type,at:e.occurredAt,text:JSON.stringify(e.payload).slice(0,450)}))};
    });
    if(!claim)return false;
    try{
      const sel=model.agentDefaultModel.currentSelection(),system=kind==='diary'?'根据给出的真实事件写简短第一人称日记。不要编造未发生的事。只返回 JSON：{"text":"...","sources":["事件ID"]}。':'从真实事件中谨慎总结可能的兴趣与习惯，不要把一次经历当稳定性格。只返回 JSON：{"text":"...","sources":["事件ID"]}。';
      // Reasoning models count their thinking tokens toward the completion
      // limit, even when the final diary itself is short.
      let text='';await budget.runAs(id,manual?'interactive':kind,async()=>{for await(const chunk of model.llm.stream({...sel,system,messages:[{role:'user',content:JSON.stringify(claim.events)}],signal:AbortSignal.any([signal,gate.signal]),maxTokens:4096,temperature:.3,reasoningEffort:'low'})){if(chunk.type==='text'&&typeof chunk.text==='string'){text+=chunk.text;if(text.length>10000)throw Error('整理结果过长');}}});
      let data:any;try{data=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{throw Error('模型返回的整理内容格式无效，请重试');}
      const available=new Set(claim.events.map(e=>e.id));
      if(typeof data.text!=='string'||!data.text.trim()||data.text.length>5000||!Array.isArray(data.sources)||!data.sources.length||data.sources.some((s:unknown)=>typeof s!=='string'||!available.has(s)))throw Error('整理结果缺少真实来源');
      await gate.run(id,async()=>{const state=await store.loadEnvelope(id);if(!state||signal.aborted||gate.signal.aborted)throw Error('整理已取消');
        await uow.apply(id,state.version,draft=>{const p=draft.legacy as Record<string,any>,record=p.developmentClaims?.[claim.key];if(!record||record.status!=='running'||(!manual && draft.life.constraints.paused)||data.sources.some((s:string)=>Object.hasOwn(draft.life.invalidSources,s)||!draft.life.events.some(e=>e.eventId===s)))throw Error('整理来源或状态已变化');
          const at=new Date().toISOString(),eventId='development:'+randomUUID(),memoryId='development-memory:'+randomUUID(),sources=[...new Set<string>(data.sources)];
          if(kind==='diary')settleSimulatedSpending(draft,'diary','diary:'+date);
          if(kind==='diary'){if(p.diaries?.[date]||p.deletedDays?.includes(date))throw Error('日记已变化');p.diaries||={};p.diaries[date]={date,text:data.text.trim(),sources,revision:1,updatedAt:Date.now(),canonicalMemoryId:memoryId};}
          draft.life.events.push({eventId,petId:id,type:'development.'+kind,source:'model',occurredAt:at,receivedAt:at,evidenceLevel:'inferred',payload:{sourceIds:sources}});
          draft.life.memories.push({id:memoryId,kind:kind==='diary'?'autobiographical':'semantic',content:data.text.trim(),sourceIds:[eventId,...sources],evidenceLevel:'inferred',valid:true,createdAt:at});
          if(kind==='reflection' && sources.length>=2 && draft.life.selfModel)draft.life.selfModel.interests.push({id:'interest:'+randomUUID(),label:'整理出的兴趣线索',value:data.text.trim(),sourceIds:[eventId,...sources],valid:true});
          record.status='completed';record.finishedAt=Date.now();record.sourceIds=sources;return {};});});return true;
    }catch(error){await gate.run(id,async()=>{const state=await store.loadEnvelope(id);if(!state||gate.signal.aborted)return;await uow.apply(id,state.version,draft=>{const record=(draft.legacy as any).developmentClaims?.[claim.key];if(record?.status==='running')record.status='failed';return {};});}).catch(()=>{});throw error;}
  }
  return {task,async run(id:string,signal:AbortSignal){const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',hour:'2-digit',hourCycle:'h23'}).format(new Date()));if(hour<20)return;await task(id,'diary',signal).catch(()=>false);if(!signal.aborted)await task(id,'reflection',signal).catch(()=>false);}};
}
