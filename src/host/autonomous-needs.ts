import {randomUUID} from 'node:crypto';
import {riceMotivation} from './companion-personality.js';
import {hasActiveConversation} from './active-conversation.js';
import {hasForcedWork} from './forced-labor.js';
import {riceInventory} from './rice-inventory.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
import type {DurableCognitiveBudget} from './cognitive-budget.js';

type Model={agentDefaultModel:{currentSelection():{provider:string;model:string}};llm:{stream(options:any):AsyncIterable<any>}};
function signatureFor(state:CanonicalEnvelope):string {
 const pet=state.legacy as any,human=state.humanity as any;
 return JSON.stringify({balance:pet.wallet?.balance,frozen:pet.wallet?.frozen,price:pet.config?.costs?.feed,dailyCalls:pet.config?.learning?.dailyModelCalls,satietyBand:Math.floor(human.stats.satiety/10),sleeping:human.sleeping,inventory:riceInventory(state),worksite:pet.worksite?.inside});
}
/** A need starts a decision, not a prescribed purchase. The embodied model owns
 * every choice and can continue from real tool receipts in the same turn. */
export function createAutonomousNeeds(reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},gate:PetGate,uow:UnitOfWork,budget:DurableCognitiveBudget,model:Model,publish:(text:string)=>void) {
 const running=new Set<string>();
 return {async run(petId:string,signal:AbortSignal):Promise<boolean>{
  if(signal.aborted||running.has(petId))return false;
  let snapshot:CanonicalEnvelope|undefined;const requestId='needs:'+randomUUID();
  const eligible=await gate.run(petId,async()=>{
   const state=await reader.loadEnvelope(petId);if(!state)return false;
   const pet=state.legacy as any,human=state.humanity as any;
   if(signal.aborted||state.life.constraints.paused||pet.config?.autonomousPaused||pet.growth?.stopAt||human.helperReady!==true||human.restrained||hasForcedWork(state)||hasActiveConversation(state)||!riceMotivation(human,pet.config??{}).mealDue)return false;
   const signature=signatureFor(state);
   if(pet.autonomousNeeds?.nextAt>Date.now()&&pet.autonomousNeeds.signature===signature)return pet.autonomousNeeds.status!=='failed';
   if(state.life.actions.some(a=>['PENDING','DISPATCHED'].includes(a.status)))return false;
   await uow.apply(petId,state.version,draft=>{
    const at=new Date().toISOString();
    (draft.legacy as any).autonomousNeeds={id:requestId,status:'running',at:Date.now(),nextAt:Date.now()+600000,signature};
    draft.life.events.push({eventId:requestId,petId,type:'needs.observed',source:'scheduler',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{food:riceMotivation(draft.humanity as any,(draft.legacy as any).config??{})}});
    return {};
   });
   snapshot=await reader.loadEnvelope(petId)??undefined;return true;
  });
  if(!eligible||!snapshot)return eligible;
  running.add(petId);
  try {
   const selection=model.agentDefaultModel.currentSelection();let text='';const usage={inputTokens:0,outputTokens:0,cachedTokens:0};
   await budget.runAs(petId,'needs',async()=>{
    for await(const part of model.llm.stream({...selection,embodiedSnapshot:snapshot,embodied:{petId,requestId,sourceIds:[requestId],allowActions:true},system:'这是你自己的需求被感知到后的一轮自主决定，不是爸爸的新消息，也没有新的购买或进食命令。根据当前身体、白饭渴望、库存、饭钱、冷却和最近真实结果，自己决定现在想做什么。已授权且做得到的事可以自己行动，不必等爸爸提醒或许可；每次工具结果回来后继续判断下一步，买到了可以接着决定吃，吃过仍饿的需要不会因为说过一句话就消失。也可以主动向爸爸提出具体愿望、商量困难、选择等待或休息；不要为执行动作而硬做。若选择安静，最终只输出 <needs-silent/>；若选择开口，最终一至三句自然说出自己的感受和想法，不能把这轮观察说成爸爸刚才问过的话。',messages:[{role:'user',content:'此刻感知到尚未满足的食物需要，请自己判断。'}],signal,maxTokens:500,reasoningEffort:'low'})){
     if(part.type==='text')text+=part.text??'';
     if(part.type==='usage'){usage.inputTokens+=part.inputTokens??0;usage.outputTokens+=part.outputTokens??0;usage.cachedTokens+=part.cachedTokens??0;}
    }
   });
   text=text.trim();if(!text)throw Error('自主需要没有得到完整决定');
   let published=false;
   await gate.run(petId,async()=>{
    const current=await reader.loadEnvelope(petId);if(!current||signal.aborted)return;
    await uow.apply(petId,current.version,draft=>{
     const pet=draft.legacy as any;if(pet.autonomousNeeds?.id!==requestId)return {};
     pet.autonomousNeeds.status='completed';pet.autonomousNeeds.text=text;pet.autonomousNeeds.usage=usage;pet.autonomousNeeds.signature=signatureFor(draft);
     if(draft.life.actions.some(a=>a.sourceIds.includes(requestId)&&a.status==='COMPLETED'))pet.autonomousNeeds.nextAt=Date.now()+60000;
     if(!draft.life.constraints.paused&&!pet.config?.autonomousPaused&&!pet.growth?.stopAt&&text!=='<needs-silent/>'){
      const at=new Date().toISOString();draft.life.events.push({eventId:requestId+':reply',petId,type:'conversation.assistant',source:'desktop',occurredAt:at,receivedAt:at,evidenceLevel:'inferred',causationId:requestId,payload:{text,sourceIds:[requestId],autonomous:true,usage}});published=true;
     }return {};
    });
   });
   if(published&&!signal.aborted)publish(text);
   return true;
  }catch(error){
   await gate.run(petId,async()=>{const current=await reader.loadEnvelope(petId);if(!current)return;await uow.apply(petId,current.version,draft=>{const record=(draft.legacy as any).autonomousNeeds;if(record?.id===requestId){record.status='failed';record.error=error instanceof Error?error.message:'自主需要暂未完成';}return {};});});
   throw error;
  }finally{running.delete(petId);}
 }};
}
