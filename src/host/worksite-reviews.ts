import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
import {hasForcedWork} from './forced-labor.js';

type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
type Model={agentDefaultModel:{currentSelection():{provider:string;model:string}};llm:{stream(options:any):AsyncIterable<any>}};
type Budget={runAs<T>(id:string,kind:'autonomous',fn:()=>Promise<T>,label?:string):Promise<T>};

/** A review never holds the pet gate while the model is thinking. The durable
 * watermark prevents duplicate requests, and the session and contract are
 * checked again when a decision is applied. */
export function createWorksiteReviews(reader:Reader,gate:PetGate,uow:UnitOfWork,budget:Budget,model:Model,
  stop:(id:string,expected:{sessionId:string;contractId:string})=>Promise<unknown>) {
  const running=new Set<string>();
  const observe=(snapshot:CanonicalEnvelope)=>{
    const id=snapshot.petId,pet=snapshot.legacy as any,site=pet.worksite;
    const threshold=Math.floor((Number(site?.completedInSession)||0)/15)*15;
    if(gate.signal.aborted||running.has(id)||!site?.inside||site.workState!=='running'||!site.sessionId||threshold<=0||threshold<=(Number(site.reviewedThrough)||0)||hasForcedWork(snapshot))return;
    running.add(id);
    void (async()=>{let claimed=false;try{
      const claim=await gate.run(id,async()=>{
        const current=await reader.loadEnvelope(id);if(!current)return;
        const p=current.legacy as any,s=p.worksite,active=p.labor?.contracts?.find((x:any)=>['working','paused','queued'].includes(x.status)&&x.done<x.trips),c=active??p.labor?.contracts?.find((x:any)=>x.id===s?.lastCompletedContractId);
        const target=(Number(s?.reviewedThrough)||0)+15;
        if(!s?.inside||s.workState!=='running'||!s.sessionId||!c||c.status==='paused'||target>(Number(s.completedInSession)||0)||hasForcedWork(current))return;
        const expected={sessionId:s.sessionId as string,contractId:c.id as string};
        const facts={body:current.humanity.stats,emotions:current.humanity.emotions,spirit:current.life.spirit?.value,completed:target,task:{done:c.done,trips:c.trips},queued:p.labor.contracts.filter((x:any)=>x.status==='queued').length};
        await uow.apply(id,current.version,draft=>{(draft.legacy as any).worksite.reviewedThrough=target;return {};});
        return {expected,facts};
      });
      if(!claim||gate.signal.aborted)return;claimed=true;
      let output='';
      await budget.runAs(id,'autonomous',async()=>{
        for await(const part of model.llm.stream({...model.agentDefaultModel.currentSelection(),system:'你是大肥鱼。根据当前身体、心情和任务，自主决定继续工作还是停工。停工会留在工地。只输出 JSON：{"decision":"continue"} 或 {"decision":"stop"}。',messages:[{role:'user',content:JSON.stringify(claim.facts)}],signal:gate.signal,maxTokens:100,reasoningEffort:'low'}))if(part.type==='text')output+=part.text??'';
      },'搬砖休息决定');
      const match=output.match(/\{[^{}]*"decision"\s*:\s*"(stop|continue)"[^{}]*\}/);
      if(match?.[1]==='stop'&&!gate.signal.aborted)await stop(id,claim.expected).catch(()=>{});
    }catch{/* Model or connection failure never manufactures a decision. */}
    finally{running.delete(id);if(claimed&&!gate.signal.aborted){const latest=await reader.loadEnvelope(id).catch(()=>null);if(latest)observe(latest);}}})();
  };
  return {observe};
}
