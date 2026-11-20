import {randomUUID} from 'node:crypto';
import {companionContext,COMPANION_PERSONALITY,riceMotivation} from './companion-personality.js';
import {hasRunningChat} from './active-conversation.js';
import {hasForcedWork} from './forced-labor.js';
import {farmVisit} from './farm.js';
import {canConsiderCooking,clearCookerReminder,cookerFacts} from './rice-cooker.js';
import {riceInventory} from './rice-inventory.js';
import {privateConversationHistory,CONVERSATION_CONTINUITY} from './conversation-history.js';
import {promptData} from './prompt-data.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
import type {DurableCognitiveBudget} from './cognitive-budget.js';

type Model={agentDefaultModel:{currentSelection():{provider:string;model:string}};llm:{stream(options:any):AsyncIterable<any>}};
const minute=60000,hour=60*minute;
const bounded=(value:unknown,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback;
const foodKey=(s:CanonicalEnvelope)=>JSON.stringify({body:s.humanity.stats,wallet:(s.legacy as any).wallet,inventory:riceInventory(s),cooker:cookerFacts(s)});
const ownerKey=(s:CanonicalEnvelope)=>privateConversationHistory(s.life).filter(e=>e.role==='user').at(-1)?.eventId;

/** Program facts determine whether a food opportunity is due. A food turn
 * never owns or blocks the next comprehensive cognition opportunity. */
export function foodRequestPolicy(state:CanonicalEnvelope,now=Date.now()) {
  const pet=state.legacy as any,human=state.humanity as any;
  const interval=bounded(pet.config?.begging?.intervalMinutes,10,10,1440)*minute;
  const hourlyMax=Math.floor(bounded(pet.config?.begging?.hourlyMax,4,0,4));
  const recent=(Array.isArray(pet.begs)?pet.begs:[]).filter((at:unknown):at is number=>typeof at==='number'&&Number.isFinite(at)&&at<=now&&now-at<hour);
  const attemptAt=pet.foodRequestAttempt?.at;
  const latest=Math.max(0,...recent,Number.isFinite(attemptAt)?attemptAt:0);
  // A comprehensive turn may just have voiced the same need. Respect that
  // expression too, without imposing the general QQ two-hour contact limit.
  const justSaid=state.life.events.some(e=>e.eventId.startsWith('self-expression:')&&!Object.hasOwn(state.life.invalidSources,e.eventId)&&
    Date.parse(e.occurredAt)<=now&&now-Date.parse(e.occurredAt)<interval&&/饭|饿|吃|肚子/u.test(String((e.payload as any)?.text??'')));
  const eligible=hourlyMax>0&&recent.length<hourlyMax&&(!latest||now-latest>=interval)&&!justSaid&&
    !state.life.constraints.paused&&!pet.config?.autonomousPaused&&!pet.growth?.stopAt&&human.helperReady===true&&!human.sleeping&&
    !hasRunningChat(state,now)&&!hasForcedWork(state)&&!farmVisit(state)&&
    (riceMotivation(human,pet.config??{},now).mealDue||canConsiderCooking(state));
  return {eligible,recent,interval,hourlyMax};
}

/** The existing minute wake checks program facts first. A durable claim limits
 * even failed/silent generations and survives restart; no extra timer is used. */
export function createFoodRequests(reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},gate:PetGate,uow:UnitOfWork,
  budget:DurableCognitiveBudget,model:Model,publish:(text:string)=>void,clock=Date.now) {
  const running=new Set<string>();
  return {async run(petId:string,signal:AbortSignal):Promise<void>{
    if(signal.aborted||gate.signal.aborted||running.has(petId))return;
    running.add(petId);
    const requestId='food-request:'+randomUUID();let snapshot:CanonicalEnvelope|undefined;
    try {
      await gate.run(petId,async()=>{
        const state=await reader.loadEnvelope(petId);if(!state||signal.aborted||gate.signal.aborted)return;
        const now=clock(),policy=foodRequestPolicy(state,now);if(!policy.eligible)return;
        const updated=await uow.apply(petId,state.version,draft=>{
          const pet=draft.legacy as any,at=new Date(now).toISOString();
          pet.begs=[...policy.recent,now];pet.foodRequestAttempt={id:requestId,at:now,status:'running'};
          draft.life.events.push({eventId:requestId,petId,type:'food.request-opportunity',source:'scheduler',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{food:companionContext(draft,now).food}});
          return {};
        });
        snapshot=updated;
      });
      if(!snapshot)return;
      if(signal.aborted||gate.signal.aborted)throw Error('食物决定已取消');
      let text='';
      await budget.runAs(petId,'food-request',async()=>{
        for await(const part of model.llm.stream({...model.agentDefaultModel.currentSelection(),signal,
          embodied:{petId,requestId,sourceIds:[requestId],allowActions:true,actionAllowlist:['service.buy-rice','service.eat-rice','service.cook-rice']},
          system:COMPANION_PERSONALITY+'\n'+CONVERSATION_CONTINUITY+'\n这是独立时限内的一次食物决定，不是爸爸的新消息。程序已读取饥饿、库存与锅况，不必再检查饿没饿。根据实况和最近对话，自主决定要饭、商量饭钱、买饭、吃饭、提前备饭或安静。食物入口不占自主额度；要饭仍受独立间隔与每小时上限限制。上次没回复不等于禁止再次表达，间隔已由程序检查；自然简短，不机械复制上一句、不催迫。爸爸明确叫停就尊重。饿时先吃锅里熟饭，再吃冰箱库存；缺饭时按现有余额与权限决定购买，买到后根据真实新增库存 id 再决定吃，不要求爸爸多发一条消息。米缸是生米，不能直接吃；能开锅时自主选择 service.cook-rice 的 bowls，范围 1 到 cooker.maxBowls，开锅后二十分钟才熟。每次行动等真实回执，不重复同条件失败或未知结果。此入口只允许买饭、吃饭、备饭，不执行旧指令、不改工钱、不进行其他自主活动。一次一至三句，不需要花饭钱才能向爸爸要饭。不想开口只输出 <food-silent/>。',
          messages:[{role:'user',content:promptData({now:new Date(clock()).toISOString(),companion:companionContext(snapshot!),history:privateConversationHistory(snapshot!.life,[],10)},7000)}],maxTokens:300,reasoningEffort:'low'})) {
          if(part.type==='text-reset')text='';if(part.type==='text'&&typeof part.text==='string')text+=part.text;
          if(text.length>2000)throw Error('要饭表达过长');
        }
      });
      text=text.trim();if(!text)throw Error('食物决定未完成');
      const decided=await reader.loadEnvelope(petId);if(!decided)return;
      let published=false;
      await gate.run(petId,async()=>{
        const current=await reader.loadEnvelope(petId);if(!current)return;
        await uow.apply(petId,current.version,draft=>{
          const pet=draft.legacy as any,attempt=pet.foodRequestAttempt;if(attempt?.id!==requestId)return {};
          attempt.status=signal.aborted||gate.signal.aborted?'cancelled':'completed';
          const human=draft.humanity as any;
          if(!signal.aborted&&!gate.signal.aborted&&!draft.life.constraints.paused&&!pet.config?.autonomousPaused&&!pet.growth?.stopAt&&
            !human.sleeping&&human.helperReady===true&&!hasRunningChat(draft,clock())&&!hasForcedWork(draft)&&
            foodKey(draft)===foodKey(decided)&&ownerKey(draft)===ownerKey(snapshot!)&&
            pet.config?.begging?.hourlyMax!==0&&
            text!=='<food-silent/>'&&!/[<>]/u.test(text)) {
            const at=new Date(clock()).toISOString();
            draft.life.events.push({eventId:requestId+':reply',petId,type:'conversation.assistant',source:'desktop',occurredAt:at,receivedAt:at,
              causationId:requestId,evidenceLevel:'inferred',payload:{text,sourceIds:[requestId],autonomous:true,foodRequest:true}});
            attempt.text=text;published=true;
          }
          if(!signal.aborted&&!gate.signal.aborted)clearCookerReminder(draft,cookerFacts(snapshot!).reminderId);
          return {};
        });
      });
      if(published&&!signal.aborted&&!gate.signal.aborted)publish(text);
    } catch(error) {
      if(snapshot)await gate.run(petId,async()=>{
        const state=await reader.loadEnvelope(petId);if(!state)return;
        await uow.apply(petId,state.version,draft=>{const attempt=(draft.legacy as any).foodRequestAttempt;
          if(attempt?.id===requestId){attempt.status=signal.aborted||gate.signal.aborted?'cancelled':'failed';attempt.error=error instanceof Error?error.message:'要饭表达未完成';}return {};});
      });
      throw error;
    } finally {running.delete(petId);}
  }};
}
