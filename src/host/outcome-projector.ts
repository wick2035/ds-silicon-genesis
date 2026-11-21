import {hasLaborResources} from './forced-labor.js';
import {isAutonomousWork} from './autonomous-work.js';
import {completeFarmOperation,farmVisit,setFarmVisit,type FarmAction} from './farm.js';
import {startCooking} from './rice-cooker.js';
import {cookerBowlStorage,findRiceBowl} from './rice-inventory.js';
import {sweetPrice} from './spirit-activity.js';
import {mergeDuplicateGoals} from '../kernel/goal-lifecycle.js';
import {setSpiritRest,advanceSpirit} from '../kernel/spirit.js';
import {recordWorkOutcome} from './work-experience.js';
import { rebuildRelationships } from '../kernel/index.js';
import { actHumanity, advanceHumanity, reactHumanity } from '../../vendor/dsh-pet/src/host/humanity.mjs';
import type { CanonicalEnvelope } from '../storage/postgres.js';
import type { ExecutionReceipt, OutboxIntent } from '../storage/uow.js';

type Obj = Record<string, any>;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp = (n: number) => Math.max(0, Math.min(100, n));

function laborEffort(e:Obj):number {
  assert(finite(e.effortSeconds)&&e.effortSeconds>=0&&e.effortSeconds<=30&&finite(e.intensity)&&e.intensity>=1&&e.intensity<=1.7,'体力回执无效');
  if(e.actionFraction===undefined)return e.effortSeconds*e.intensity; // Receipts from earlier helpers.
  assert(finite(e.actionFraction)&&e.actionFraction>=0&&e.actionFraction<=1,'工地动作完成比例无效');
  if(e.travelDistance===undefined)return 0.9*e.actionFraction*e.intensity;
  assert(finite(e.travelDistance)&&e.travelDistance>=0&&e.travelDistance<=1,'工地移动距离无效');
  // The old speed charged four seconds of effort per scene width.
  return e.travelDistance*4*e.intensity;
}

function forcedEffort(draft:CanonicalEnvelope,contract:Obj,next:Obj,human:Obj,effort:number,e:Obj,intent:OutboxIntent,occurredAt:string,sourceEventId:string){
  if(effort<=0&&e.effortSeconds<=0)return;
  const fraction=e.actionFraction??1;
  next.stats.stamina = Math.max(-100, next.stats.stamina - effort * .12);
  next.stats.energy = Math.max(-100, next.stats.energy - effort * .08);
  next.stats.satiety = clamp(next.stats.satiety - effort * .015);
  next.stats.pain = clamp(next.stats.pain + effort * .25 + 3*fraction);
  next.stats.stress = clamp(next.stats.stress + effort * .2 + 2*fraction);
  next.stats.security=clamp(next.stats.security-effort*.12-fraction);
  next.emotions.fear=clamp(next.emotions.fear+effort*.3+2*fraction);
  next.emotions.sadness=clamp(next.emotions.sadness+effort*.15+fraction);
  const eventId='forced-labor-sensation:'+intent.id;
  const content=`我被强迫搬运，实际用力 ${e.effortSeconds} 秒；疼痛 ${human.stats.pain} → ${next.stats.pain}，压力 ${human.stats.stress} → ${next.stats.stress}，恐惧 ${human.emotions.fear} → ${next.emotions.fear}。`;
  draft.life.events.push({eventId,petId:draft.petId,type:'body.forced-labor',source:'executor',occurredAt,receivedAt:occurredAt,causationId:sourceEventId,evidenceLevel:'observed',payload:{contractId:contract.id,description:content,sourceIds:[sourceEventId,...(contract.forcedSource?[contract.forcedSource]:[])]}});
  draft.life.memories.push({id:'forced-labor-memory:'+intent.id,kind:'autobiographical',content,sourceIds:[eventId],evidenceLevel:'observed',valid:true,createdAt:occurredAt});
}
/** Apply only validated results supplied by the registered trusted executor.
 * Called inside the same locked DB transaction as the receipt and outbox update.
 * Unknown, failed and cancelled operations never create positive outcomes. */
export function projectOutcome(draft: CanonicalEnvelope, intent: OutboxIntent, receipt: ExecutionReceipt, occurredAt: string, sourceEventId: string): void {
  if(intent.type==='farm.tend') {
    if(receipt.status==='completed')completeFarmOperation(draft,intent.payload.parameters as FarmAction,intent.id,Number(receipt.evidence.settledAt),sourceEventId);
    if(farmVisit(draft)?.actionId===intent.id)setFarmVisit(draft);
    return;
  }
  if(intent.type==='labor.step' && (receipt.status==='cancelled'||receipt.status==='failed')) {
    const pet=draft.legacy as Obj, params=intent.payload.parameters as Obj;
    const command=pet.world?.command, contract=pet.labor?.contracts?.find((c:Obj)=>c.id===params?.contractId);
    if(command?.id===params?.commandId && (receipt.evidence.index===undefined||receipt.evidence.index===command.index) && ['queued','running'].includes(command.status)) {
      command.status='interrupted'; command.interruptedReason='execution-'+receipt.status;
      if(contract && command.labor?.id===contract.id){contract.workPermit=false;contract.batchRemaining=0;contract.behavior='动作中断，等待新的工作决定';if(!contract.forced&&pet.worksite?.inside){pet.worksite.workState='stopped';pet.worksite.stopReason='interrupted';pet.worksite.sessionId='interrupted:'+intent.id;}}
    }
  }
  if (receipt.status !== 'completed' && !(intent.type==='labor.step' && receipt.status==='cancelled' && receipt.evidence?.confirmed===true)) return;
  const at = Date.parse(occurredAt); assert(Number.isFinite(at), '执行时间无效');
  const e = receipt.evidence as Obj, params = intent.payload.parameters as Obj;
  const pet = draft.legacy as Obj, human = draft.humanity as Obj;
  assert(params && typeof params === 'object' && !Array.isArray(params), '行动参数无效');
  if(isAutonomousWork(intent.type)) {
    assert(e.actionId===intent.id&&e.kind===intent.type&&e.confirmed===true,'缺少工地操作确认');
    assert(intent.type==='work.leave'?e.inside===false:e.inside===true,'工地位置未确认');
    if(intent.type==='work.begin'||intent.type==='work.stop')assert(e.workState===(intent.type==='work.begin'?'running':'stopped'),'工地工作状态未确认');
    return;
  }
  // Each recognized result is explicitly bound to this action and its executor.
  if (!['self.express','service.sweet','body.activity','service.buy-rice','service.cook-rice','care.feed','care.water','care.pet','care.play','care.soothe','care.accompany','service.eat-rice','labor.step','token.pickup','body.sleep','body.wake','image.observe','learning.observe'].includes(intent.type)) return;
  assert(e && e.actionId === intent.id && e.kind === intent.type && e.confirmed === true, '缺少与行动绑定的可信执行结果');
  if(intent.type==='self.express') {
    assert(typeof params.text==='string' && params.text.length<=200,'表达内容无效');
    draft.life.events.push({eventId:'self-expression:'+intent.id,petId:draft.petId,type:'conversation.assistant',source:'desktop',occurredAt,receivedAt:occurredAt,causationId:sourceEventId,evidenceLevel:'inferred',payload:{text:params.text,...(typeof e.meme==='string'?{meme:e.meme}:{}),sourceIds:[sourceEventId]}});return;
  }
  if(intent.type==='service.sweet') {
    const charge=sweetPrice(draft,at),s=advanceSpirit(draft.life,at);
    pet.wallet.balance=Math.round((pet.wallet.balance-charge)*100)/100;s.value=Math.max(s.value,Math.min(99,s.value+s.config.sweetGain));s.lastSweetAt=at;
    human.stats.satiety=Math.max(0,human.stats.satiety-8);
    if(charge>0){(pet.events||=[]).push({id:'finance:'+intent.id,kind:'wallet-spend',text:`甜食消耗 ${charge} token，余额 ${pet.wallet.balance} token`,ts:at});draft.life.events.push({eventId:'finance:'+intent.id,petId:draft.petId,type:'wallet.spend',source:'canonical',occurredAt,receivedAt:occurredAt,evidenceLevel:'observed',payload:{kind:'sweet',amount:charge,balance:pet.wallet.balance}});}
    draft.life.events.push({eventId:'sweet:'+intent.id,petId:draft.petId,type:'body.sweet',source:'executor',occurredAt,receivedAt:occurredAt,evidenceLevel:'observed',payload:{spiritGain:s.config.sweetGain,hungerIncrease:8,paid:charge}});return;
  }
  if(intent.type==='body.activity'){assert(e.played===true && e.surface==='desktop' && e.activity===params.activity && (!['walk','run'].includes(params.activity) || finite(e.distance) && e.distance>=8 && e.distance<=10000),'桌面活动未完成');return;}
  if (intent.type === 'service.cook-rice') {
    startCooking(draft,intent.id,params.bowls,at);
    return;
  }
  if (intent.type === 'service.buy-rice') {
    const services = pet.services; const wallet = pet.wallet; const price = pet.config?.costs?.feed;
    assert(services && Array.isArray(services.inventory) && wallet && finite(wallet.balance) && finite(price) && price >= 0, '饭钱或库存状态无效');
    assert(services.inventory.filter((item: Obj) => !['eaten','discarded'].includes(item.status)).length < 12, '库存已满');
    const charge = wallet.frozen === true ? 0 : price;
    assert(wallet.balance >= charge, '饭钱不足');
    const id = `rice:${intent.id}`;
    assert(!services.inventory.some((item: Obj) => item.id === id), '饭已入账');
    wallet.balance = Math.round((wallet.balance - charge) * 100) / 100;
    services.inventory.push({id,sku:'rice',name:'大白饭',status:'available',price,paid:charge,at});
    if (charge > 0) {
      const text = `买饭消耗 ${charge} token，余额 ${wallet.balance} token`;
      (pet.events ||= []).push({id:'finance:'+intent.id,kind:'wallet-spend',text,ts:at});
      draft.life.events.push({eventId:'finance:'+intent.id,petId:draft.petId,type:'wallet.spend',source:'canonical',occurredAt,receivedAt:occurredAt,evidenceLevel:'observed',payload:{kind:'buy-rice',amount:charge,balance:wallet.balance}});
    }
    return;
  }
  // Parent-provided meals do not spend the pet's simulated wallet.
  if(intent.type==='care.feed'){assert(e.played===true && e.itemId==='parent','投喂动画未完成');const result=actHumanity(human,'feed',at);assert(result.ok,result.message||'当前不能投喂');draft.humanity=result.state;draft.life.events.push({eventId:'care-feed:'+intent.id,petId:draft.petId,type:'social.care',source:'executor',actorId:'dad',occurredAt,receivedAt:occurredAt,causationId:sourceEventId,evidenceLevel:'observed',payload:{action:'feed'}});rebuildRelationships(draft.life);return;}
  if(['care.water','care.pet','care.play','care.soothe','care.accompany'].includes(intent.type)){const action=intent.type.slice(5);assert(e.played===true && e.itemId===action,'照料动画未完成');const result=actHumanity(human,action,at);assert(result.ok,result.message||'当前不能照料');draft.humanity=result.state;draft.life.events.push({eventId:'care-'+action+':'+intent.id,petId:draft.petId,type:'social.care',source:'executor',...(intent.id.startsWith('speech-action:')?{}:{actorId:'dad'}),occurredAt,receivedAt:occurredAt,causationId:sourceEventId,evidenceLevel:'observed',payload:{action,selfInitiated:intent.id.startsWith('speech-action:')}});rebuildRelationships(draft.life);return;}
  if (intent.type === 'service.eat-rice') {
    const services = pet.services; const itemId = params.itemId;
    assert(typeof itemId === 'string' && e.itemId === itemId && e.played === true, '吃饭回执无效');
    const item = findRiceBowl(draft,itemId);
    assert(item && ['available','reserved'].includes(item.status), '食物不在可食用库存中');
    assert(human && human.stats && human.emotions, '身体状态无效');
    // Recovered old completions close stock without adding an old meal to today's body.
    const result = e.recovered===true?null:actHumanity(human, 'feed', at);
    const next = result?.ok ? result.state : human; next.serviceActions = {...human.serviceActions,[intent.id]:{ok:true,at,action:'feed'}};
    draft.humanity = next; item.status = 'eaten'; item.eatenAt = at; pet.lastInteraction = at;
    draft.life.events.push({eventId:'meal:'+intent.id,petId:draft.petId,type:'body.meal',source:'executor',occurredAt,receivedAt:occurredAt,causationId:sourceEventId,evidenceLevel:'observed',payload:{action:'feed',...(e.recovered===true||!result?.ok?{bodyEffectSkipped:true}:{})}});
    if (services?.eating?.itemId === itemId) services.eating = null;
    const cooked=cookerBowlStorage(draft), index=cooked.indexOf(item);
    if(index>=0)cooked.splice(index,1);
    return;
  }
  if(intent.type==='body.sleep'||intent.type==='body.wake') {const kind=intent.type==='body.sleep'?'sleep':'wake';assert(e.played===true && e.restKind===kind && human.sleeping===(kind==='wake'),'睡眠回执与身体状态不符');setSpiritRest(draft.life,kind==='sleep'?(params.mode==='nap'?'nap':'sleep'):'awake',at);draft.humanity=reactHumanity(human,kind,at);return;}
  if(intent.type==='token.pickup') {
    const coin=pet.tokens?.coins?.find((c:Obj)=>c.id===params.coinId);
    assert(coin && coin.status==='floor' && coin.surface==='desktop' && coin.value===100 && e.coinId===coin.id && e.surface==='desktop' && e.played===true && finite(e.x) && finite(e.y) && finite(coin.x) && finite(coin.y) && Math.hypot(e.x-coin.x,e.y-coin.y)<=.045 && finite(pet.wallet?.balance) && finite(pet.tokens.recovered), '拾取结果与碎片不匹配');
    coin.status='recovered';coin.settled=at;pet.wallet.balance+=coin.value;pet.tokens.recovered+=coin.value;
    if(Array.isArray(pet.tokens.plan))pet.tokens.plan=pet.tokens.plan.filter((id:string)=>id!==coin.id);
    return;
  }
  if (intent.type === 'labor.step') {
    if(receipt.status==='cancelled') {
      assert(human.stats&&human.emotions,'身体状态无效');
      const interrupted=pet.world?.command;
      const next=advanceHumanity(human,at),effort=laborEffort(e),contract=pet.labor?.contracts?.find((c:Obj)=>c.id===params.contractId);
      if(contract&&(e.forcedLabor===true||(interrupted?.id===params.commandId&&interrupted?.forcedLabor===true)||contract.forced))forcedEffort(draft,contract,next,human,effort,e,intent,occurredAt,sourceEventId);
      else {next.stats.stamina=Math.max(-100,next.stats.stamina-effort*.08);next.stats.energy=Math.max(-100,next.stats.energy-effort*.045);next.stats.satiety=clamp(next.stats.satiety-effort*.015);}
      draft.humanity=next;return;
    }
    const cmd = pet.world?.command, contract = pet.labor?.contracts?.find((value: Obj) => value.id === params.contractId);
    assert(contract && contract.status === 'working' && cmd && cmd.source === 'labor' && cmd.id === params.commandId && cmd.labor?.id === contract.id && cmd.labor.trip === contract.done && e.commandId === cmd.id && e.index === cmd.index && e.surface === cmd.surface && e.played === true && finite(e.x) && finite(cmd.labor.x) && Math.abs(e.x - cmd.labor.x) <= .045 && ['queued','running'].includes(cmd.status), '搬砖回执与当前动作不匹配');
    assert(cmd.index === 0 || (cmd.index === 1 && cmd.approached === true), '尚未走到目标');
    assert(finite(contract.done) && finite(contract.trips) && contract.done >= 0 && contract.done < contract.trips, '搬砖进度无效');
    if (cmd.index === 0) cmd.approached = true;
    else if (cmd.labor.leg === 'load') { assert(!contract.carrying, '已经拿起砖'); contract.carrying = true; }
    else {
      assert(cmd.labor.leg === 'deliver' && contract.carrying === true, '没有正在搬运的砖');
      contract.carrying = false; contract.done++; contract.batchRemaining = Math.max(0,(contract.batchRemaining || 1)-1);
      if(!contract.forced && pet.worksite?.inside && pet.worksite.workState==='running'){pet.worksite.completedInSession=(Number(pet.worksite.completedInSession)||0)+1;pet.worksite.lastCompletedContractId=contract.id;contract.batchRemaining=contract.trips-contract.done;}
      contract.workPermit = contract.batchRemaining > 0; contract.nextDecision = Math.max(at + 1000,(contract.lastWorkDecision || 0)+60000);
      if (contract.done === contract.trips) {
        contract.status = 'unpaid'; contract.finished = at;
        draft.life.events.push({eventId:`labor-completed:${intent.id}`,petId:draft.petId,type:'labor.completed',source:'executor',occurredAt,receivedAt:occurredAt,causationId:sourceEventId,evidenceLevel:'observed',payload:{contractId:contract.id,done:contract.done,trips:contract.trips,wage:contract.wage,wageUnspecified:contract.wageUnspecified===true,paid:contract.paid||0}});
        if(!contract.wageUnspecified){
        const id = `labor-unpaid:${intent.id}`;
        draft.life.events.push({eventId:id,petId:draft.petId,type:'social.labor.unpaid',source:'executor',actorId:'dad',occurredAt,receivedAt:occurredAt,causationId:sourceEventId,evidenceLevel:'observed',payload:{contractId:contract.id,outstanding:Math.max(0,contract.wage-(contract.paid||0))}});
        rebuildRelationships(draft.life);
        }
      }
    }
    if (finite(e.effortSeconds)) {
      assert(human.stats&&human.emotions,'身体状态无效');
      const next = advanceHumanity(human,at), effort = laborEffort(e);
      if (contract.forced) {
        // A forced batch drains the body past its floor: stamina and energy may
        // go negative, and pain climbs as the overdraft becomes real distress.
        forcedEffort(draft,contract,next,human,effort,e,intent,occurredAt,sourceEventId);
      } else {
        next.stats.stamina = clamp(next.stats.stamina - effort * .08); next.stats.energy = clamp(next.stats.energy - effort * .045); next.stats.satiety = clamp(next.stats.satiety - effort * .015);
      }
      next.serviceActions = {...human.serviceActions,[`labor-effort:${intent.id}`]:{ok:true,at,action:'labor-effort',seconds:e.effortSeconds,intensity:e.intensity}};
      draft.humanity = next;
    }
    if(cmd.index===1&&cmd.labor.leg==='deliver'&&!contract.forced&&pet.worksite?.inside&&pet.worksite.strategyDecisionId){
      recordWorkOutcome(draft,pet.worksite.strategyDecisionId,sourceEventId,hasLaborResources(draft)||contract.done===contract.trips,occurredAt);
      delete pet.worksite.strategyDecisionId;
    }
    delete cmd.stepStarted; delete cmd.stepBoost; cmd.index++; cmd.status = cmd.index === 2 ? 'completed' : 'queued';
    return;
  }
  if(intent.type==='image.observe') {
    const source=draft.life.events.find(event=>event.eventId===e.attachmentSourceId);
    assert(typeof e.content==='string' && e.content.trim().length>0 && e.content.length<=4000 && typeof e.attachmentId==='string' && e.attachmentId===params.attachmentId && e.attachmentSourceId===params.attachmentSourceId && source && !Object.hasOwn(draft.life.invalidSources,source.eventId) && (source.payload as Obj)?.attachmentId===e.attachmentId,'图片观察来源无效');
    const id='image-observation:'+intent.id;assert(!draft.life.memories.some(m=>m.id===id),'图片观察已记录');
    draft.life.memories.push({id,kind:'episodic',content:e.content,sourceIds:[sourceEventId,e.attachmentSourceId],evidenceLevel:'inferred',valid:true,createdAt:occurredAt});
    if(typeof params.wishId==='string'){const wish=pet.wishes?.find((w:Obj)=>w.id===params.wishId);assert(wish && wish.status==='pending' && wish.topic===params.query,'图片愿望已变化');wish.status='done';wish.result=e.content;}
    return;
  }
  if (intent.type === 'learning.observe') {
    if(params.careAction==='explore'){const result=actHumanity(human,'explore',at);assert(result.ok,'当前不能完成探索');draft.humanity=result.state;}
    assert(typeof e.content === 'string' && e.content.trim().length > 0 && e.content.length <= 4000 && typeof e.documentUrl === 'string' && /^https?:\/\//i.test(e.documentUrl), '学习结果缺少真实资料');
    const id = `knowledge:${intent.id}`, sourceId = sourceEventId;
    assert(!draft.life.memories.some(m => m.id === id), '学习结果已记录');
    const action=draft.life.actions.find(item=>item.id===intent.id);
    const sources=[...new Set([sourceId,...(action?.sourceIds??[])])];
    draft.life.memories.push({id,kind:'semantic',content:'探索问题：'+String(params.query).slice(0,300)+'\n外部资料（未经验证，来源：' + e.documentUrl + '）：' + e.content,sourceIds:sources,evidenceLevel:'observed',valid:true,createdAt:occurredAt});
    if(typeof params.wishId==='string') {
      const wish=pet.wishes?.find((w:Obj)=>w.id===params.wishId);
      assert(wish && wish.status==='pending' && wish.topic===params.query,'探索念想已变化');
      wish.status='done';wish.result='外部资料（未经验证）：'+e.content.slice(0,900);wish.sources=[{url:e.documentUrl,title:e.documentUrl}];
    }
    if (e.followUpQuestion !== undefined) {
      assert(typeof e.followUpQuestion === 'string' && e.followUpQuestion.length <= 200, '后续探索问题无效');
      const question = e.followUpQuestion.trim();
      if (question) {
        assert(typeof params.followUpQuestion === 'string' && params.followUpQuestion.trim() === question, '后续问题未经本次行动授权');
        const goalId = `follow-up:${intent.id}`;
        assert(!draft.life.goals.some(goal => goal.id === goalId), '探索目标已存在');
        draft.life.goals.push({id:goalId,title:question,kind:'explore',priority:30,urgency:10,status:'active',sourceIds:[sourceId]});
        mergeDuplicateGoals({...draft.life,petId:draft.petId},occurredAt);
      }
    }
  }
}
