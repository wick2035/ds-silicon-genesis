import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
import {rankWorkChoices,recordWorkChoice,workContext,type WorkContext,type WorkChoice} from './work-experience.js';
import {hasForcedWork} from './forced-labor.js';

type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
type Model={agentDefaultModel:{currentSelection():{provider:string;model:string}};llm:{stream(options:any):AsyncIterable<any>}};
type Expected={sessionId:string;contractId:string;learning?:{context:WorkContext;recommended:WorkChoice;sourceIds:string[]};recovered?:boolean};
type Budget={runAs<T>(id:string,kind:'autonomous',fn:()=>Promise<T>,label?:string):Promise<T>};

/** A review never holds the pet gate while the model is thinking. The durable
 * watermark prevents duplicate requests, and the session and contract are
 * checked again when a decision is applied. */
export function createWorksiteReviews(reader:Reader,gate:PetGate,uow:UnitOfWork,budget:Budget,model:Model,
  stop:(id:string,expected:Expected)=>Promise<unknown>,
  resume?:(id:string,expected:Expected)=>Promise<unknown>, wake?:(id:string)=>void) {
  const running=new Set<string>();
  const isRecovered=(state:CanonicalEnvelope)=>{
    const site=(state.legacy as any).worksite;
    const rest=site?.learningRest;
    const h=state.humanity as any;
    return !!(resume&&site?.workState==='stopped'&&rest&&!rest.reviewed&&Date.now()-rest.at>=60000&&
      h.helperReady===true&&!h.sleeping&&!h.restrained&&!(h.restingUntil>Date.now())&&state.life.spirit?.mode!=='nap'&&Number(h.stats?.stamina)>=Math.min(100,Math.max(40,rest.stamina+10)));
  };
  const observe=(snapshot:CanonicalEnvelope)=>{
    const id=snapshot.petId,pet=snapshot.legacy as any,site=pet.worksite;
    const recovered=isRecovered(snapshot);
    const threshold=Math.floor((Number(site?.completedInSession)||0)/15)*15;
    if(gate.signal.aborted||snapshot.life.constraints.paused||running.has(id)||!site?.inside||!site.sessionId||hasForcedWork(snapshot))return;
    if(!recovered&&(site.workState!=='running'||threshold<=0||threshold<=(Number(site.reviewedThrough)||0)))return;
    running.add(id);
    void (async()=>{let claimed=false;try{
      const claim=await gate.run(id,async()=>{
        const current=await reader.loadEnvelope(id);if(!current)return;
        const p=current.legacy as any,s=p.worksite,active=p.labor?.contracts?.find((x:any)=>['working','paused','queued'].includes(x.status)&&x.done<x.trips),c=active??p.labor?.contracts?.find((x:any)=>x.id===s?.lastCompletedContractId);
        const target=(Number(s?.reviewedThrough)||0)+15;
        if(!s?.inside||s.sessionId!==site.sessionId||!c||c.status==='paused'||hasForcedWork(current)||current.life.constraints.paused)return;
        if(recovered?(!isRecovered(current)||!active||s.learningRest.contractId!==c.id):(s.workState!=='running'||target>(Number(s.completedInSession)||0)))return;
        const context=workContext(current,c), choices=rankWorkChoices(current.life,context);
        const expected:Expected={sessionId:s.sessionId,contractId:c.id,recovered,learning:{context,recommended:choices[0].choice,sourceIds:choices[0].sourceIds}};
        const facts={body:current.humanity.stats,emotions:current.humanity.emotions,spirit:current.life.spirit?.value,recovered,completed:recovered?s.completedInSession:target,
          task:{done:c.done,trips:c.trips},queued:p.labor.contracts.filter((x:any)=>x.status==='queued').length,choices};
        await uow.apply(id,current.version,draft=>{
          const location=(draft.legacy as any).worksite;
          if(recovered)location.learningRest.reviewed=true;
          else location.reviewedThrough=target;
          return {};
        });
        return {expected,facts};
      });
      if(!claim||gate.signal.aborted)return;claimed=true;
      let output='';
      await budget.runAs(id,'autonomous',async()=>{
        for await(const part of model.llm.stream({...model.agentDefaultModel.currentSelection(),system:'你是大肥鱼。参考按真实经验排序的 choices，结合当前身体、心情和任务，自主决定继续工作还是停工恢复。停工会留在工地。若 recovered 为真，表示停工后身体已恢复，可以自行决定是否接着搬。只输出 JSON：{"decision":"continue"} 或 {"decision":"stop"}。',messages:[{role:'user',content:JSON.stringify(claim.facts)}],signal:gate.signal,maxTokens:100,reasoningEffort:'low'}))if(part.type==='text')output+=part.text??'';
      },'搬砖休息决定');
      const match=output.match(/\{[^{}]*"decision"\s*:\s*"(stop|continue)"[^{}]*\}/);
      if(gate.signal.aborted)return;
      if(claim.expected.recovered){
        if(match?.[1]==='continue')await resume?.(id,claim.expected);
        else if(match?.[1]==='stop')await gate.run(id,async()=>{
          const current=await reader.loadEnvelope(id),s=(current?.legacy as any)?.worksite;
          if(!current||current.life.constraints.paused||hasForcedWork(current)||s?.sessionId!==claim.expected.sessionId||
            s.workState!=='stopped'||s.learningRest?.contractId!==claim.expected.contractId)return;
          await uow.apply(id,current.version,draft=>{
            recordWorkChoice(draft,{...claim.expected.learning!,choice:'rest',recovered:true},new Date().toISOString());
            return {};
          });
        });
      }else if(match?.[1]==='stop'){
        await stop(id,claim.expected);
      }else if(match?.[1]==='continue'){
        await gate.run(id,async()=>{
          const state=await reader.loadEnvelope(id);
          if(!state||state.life.constraints.paused||hasForcedWork(state))return;
          const p=state.legacy as any,s=p.worksite;
          const active=p.labor?.contracts?.find((c:any)=>['working','paused','queued'].includes(c.status)&&c.done<c.trips);
          if(s?.sessionId!==claim.expected.sessionId||s.workState!=='running'||active?.id!==claim.expected.contractId||active.status==='paused')return;
          await uow.apply(id,state.version,draft=>{
            const learning=claim.expected.learning!;
            (draft.legacy as any).worksite.strategyDecisionId=recordWorkChoice(draft,{...learning,choice:'continue'},new Date().toISOString());
            return {};
          });
        });
      }
    }catch{/* Model or connection failure never manufactures a decision. */}
    finally{running.delete(id);if(claimed&&!gate.signal.aborted){const latest=await reader.loadEnvelope(id).catch(()=>null);if(latest)observe(latest);wake?.(id);}}})();
  };
  return {observe,waiting(state:CanonicalEnvelope){
    observe(state);
    return running.has(state.petId);
  }};
}
