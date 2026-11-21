import {developmentMaterial,DIARY_INSTRUCTION} from './development-material.js';
import {COMPANION_PERSONALITY,companionContext} from './companion-personality.js';
import {checkSimulatedSpending,settleSimulatedSpending} from './simulated-spending.js';
import {randomUUID} from 'node:crypto';
import {SPEAKER_MEMORY_RULE} from '../kernel/speech-provenance.js';
import {developmentSources,DEVELOPMENT_SOURCE_RULE,DevelopmentResultError} from './development-sources.js';
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
      const events=developmentMaterial(state,date,used);
      if(!events.length)return null;
      const key=kind+':'+date,previous=pet.developmentClaims?.[key];
      // An explicit retry may recover a failed attempt; an in-flight or
      // completed claim is never repeated automatically.
      if(previous && !(manual && previous.status==='failed'))return null;
      if(kind==='diary')checkSimulatedSpending(state,'diary');
      await uow.apply(id,state.version,draft=>{const p=draft.legacy as Record<string,any>;p.developmentClaims||={};const old=p.developmentClaims[key];if(old && !(manual && old.status==='failed'))throw Error('整理已领取');p.developmentClaims[key]={status:'running',at:Date.now(),attempt:(Number(old?.attempt)||0)+1};return {};});
      return {key,companion:companionContext(state),events};
    });
    if(!claim)return false;
    try{
      const sel=model.agentDefaultModel.currentSelection(),system=COMPANION_PERSONALITY+'\n'+(kind==='diary'?DIARY_INSTRUCTION:'结合真实事件及其中标明为主观的 self.thought，保留当时感受，谨慎总结可能的兴趣与习惯，不要把一次经历当稳定性格。只返回 JSON：{"text":"...","sources":["事件ID"]}。')+'\n用大肥鱼自己的口吻记下当时真实的在意，可以是白饭、手机、爸爸或小委屈，没发生就不编。反思可以形成有来源、可放弃的小办法，不把一次经历变成固定台词、人格或操作指令；不改变账本、权限或核心身份。当前上下文只是此刻实况，不能当成过去当天的经历。';
      const attributedSystem=system+'\n'+SPEAKER_MEMORY_RULE+'\n'+DEVELOPMENT_SOURCE_RULE;
      // Reasoning models count their thinking tokens toward the completion
      // limit, even when the final diary itself is short.
      const citations=developmentSources(claim.events),messages=[{role:'user',content:JSON.stringify({date,events:citations.events,...(kind==='reflection'?{currentCompanion:claim.companion}:{})})}];
      const data=await budget.runAs(id,manual?'interactive':kind,async()=>{
        for(let attempt=0;;attempt++){
          let text='';
          for await(const chunk of model.llm.stream({...sel,system:attributedSystem,messages,signal:AbortSignal.any([signal,gate.signal]),maxTokens:4096,temperature:.3,reasoningEffort:'low'}))if(chunk.type==='text'&&typeof chunk.text==='string'){text+=chunk.text;if(text.length>10000)throw Error('整理结果过长');}
          try{return citations.parse(text);}catch(error){
            if(!(error instanceof DevelopmentResultError)||attempt===1)throw error;
            // One bounded correction, within this claim and the normal model
            // budget. Never guess sources, drop unknown IDs or settle twice.
            messages.push({role:'assistant',content:text},{role:'user',content:`上次结果未保存：${error.message}。请纠正 JSON 格式和来源编号，sources 只选原材料中实际采用的 id 或 speakers.id。不要补造经历；只返回完整的 {"text":"...","sources":["E1"]} JSON。`});
          }
        }
      });
      await gate.run(id,async()=>{const state=await store.loadEnvelope(id);if(!state||signal.aborted||gate.signal.aborted)throw Error('整理已取消');
        await uow.apply(id,state.version,draft=>{const p=draft.legacy as Record<string,any>,record=p.developmentClaims?.[claim.key];if(!record||record.status!=='running'||(!manual && draft.life.constraints.paused)||data.sources.some((s:string)=>Object.hasOwn(draft.life.invalidSources,s)||!draft.life.events.some(e=>e.eventId===s)))throw Error('整理来源或状态已变化');
          const at=new Date().toISOString(),eventId='development:'+randomUUID(),memoryId='development-memory:'+randomUUID(),sources=[...new Set<string>(data.sources)];
          if(kind==='diary')settleSimulatedSpending(draft,'diary','diary:'+date);
          if(kind==='diary'){if(p.diaries?.[date]||p.deletedDays?.includes(date))throw Error('日记已变化');p.diaries||={};p.diaries[date]={date,text:data.text.trim(),sources,revision:1,updatedAt:Date.now(),canonicalMemoryId:memoryId};}
          draft.life.events.push({eventId,petId:id,type:'development.'+kind,source:'model',occurredAt:at,receivedAt:at,evidenceLevel:'inferred',payload:{sourceIds:sources}});
          draft.life.memories.push({id:memoryId,kind:kind==='diary'?'autobiographical':'semantic',content:data.text.trim(),sourceIds:[eventId,...sources],evidenceLevel:'inferred',valid:true,createdAt:at});
          record.status='completed';record.finishedAt=Date.now();record.sourceIds=sources;return {};});});return true;
    }catch(error){await gate.run(id,async()=>{const state=await store.loadEnvelope(id);if(!state||gate.signal.aborted)return;await uow.apply(id,state.version,draft=>{const record=(draft.legacy as any).developmentClaims?.[claim.key];if(record?.status==='running'){record.status='failed';record.finishedAt=Date.now();record.reason=error instanceof Error?error.message:'整理失败';}return {};});}).catch(()=>{});throw error;}
  }
  return {task,
    /** Startup only, under the exclusive writer lease: the old caller is gone. */
    async recoverInterrupted(id:string){
      return gate.run(id,async()=>{
        const state=await store.loadEnvelope(id);
        if(!state||!Object.values((state.legacy as any).developmentClaims??{}).some((claim:any)=>claim.status==='running'))return;
        await uow.apply(id,state.version,draft=>{
          for(const claim of Object.values((draft.legacy as any).developmentClaims??{}) as any[])if(claim.status==='running'){
            claim.status='failed';claim.finishedAt=Date.now();claim.reason='进程重启，上次整理未确认完成，可手动重试';
          }
          return {};
        });
      });
    },
    async run(id:string,signal:AbortSignal){const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Hong_Kong',hour:'2-digit',hourCycle:'h23'}).format(new Date()));if(hour<20)return;await task(id,'diary',signal).catch(()=>false);if(!signal.aborted)await task(id,'reflection',signal).catch(()=>false);}};
}
