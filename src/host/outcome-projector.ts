import {settleSimulatedSpending} from './simulated-spending.js';
import { rebuildRelationships } from '../kernel/index.js';
import { actHumanity, advanceHumanity, reactHumanity } from '../../vendor/dsh-pet/src/host/humanity.mjs';
import type { CanonicalEnvelope } from '../storage/postgres.js';
import type { ExecutionReceipt, OutboxIntent } from '../storage/uow.js';

type Obj = Record<string, any>;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp = (n: number) => Math.max(0, Math.min(100, n));
/** Apply only validated results supplied by the registered trusted executor.
 * Called inside the same locked DB transaction as the receipt and outbox update.
 * Unknown, failed and cancelled operations never create positive outcomes. */
export function projectOutcome(draft: CanonicalEnvelope, intent: OutboxIntent, receipt: ExecutionReceipt, occurredAt: string, sourceEventId: string): void {
  if (receipt.status !== 'completed' && !(intent.type==='labor.step' && receipt.status==='cancelled' && receipt.evidence?.confirmed===true)) return;
  const at = Date.parse(occurredAt); assert(Number.isFinite(at), '执行时间无效');
  const e = receipt.evidence as Obj, params = intent.payload.parameters as Obj;
  const pet = draft.legacy as Obj, human = draft.humanity as Obj;
  assert(params && typeof params === 'object' && !Array.isArray(params), '行动参数无效');
  // Each recognized result is explicitly bound to this action and its executor.
  if (!['service.buy-rice','care.feed','service.eat-rice','labor.step','token.pickup','body.sleep','body.wake','image.observe','learning.observe'].includes(intent.type)) return;
  assert(e && e.actionId === intent.id && e.kind === intent.type && e.confirmed === true, '缺少与行动绑定的可信执行结果');
  if (intent.type === 'service.buy-rice') {
    const services = pet.services; const wallet = pet.wallet; const price = pet.config?.costs?.feed;
    assert(services && Array.isArray(services.inventory) && wallet && finite(wallet.balance) && finite(price) && price >= 0, '饭钱或库存状态无效');
    assert(services.inventory.filter((item: Obj) => item.status !== 'eaten').length < 12, '库存已满');
    const charge = wallet.frozen === true ? 0 : price;
    assert(wallet.balance >= charge, '饭钱不足');
    const id = `rice:${intent.id}`;
    assert(!services.inventory.some((item: Obj) => item.id === id), '饭已入账');
    wallet.balance = Math.round((wallet.balance - charge) * 100) / 100;
    services.inventory.push({id,sku:'rice',name:'大白饭',status:'available',price,paid:charge,at});
    return;
  }
  if(intent.type==='care.feed'){assert(e.played===true && e.itemId==='parent','投喂动画未完成');const result=actHumanity(human,'feed',at);assert(result.ok,'当前不能投喂');settleSimulatedSpending(draft,'feed',intent.id);draft.humanity=result.state;draft.life.events.push({eventId:'care-feed:'+intent.id,petId:draft.petId,type:'social.care',source:'executor',actorId:'dad',occurredAt,receivedAt:occurredAt,causationId:sourceEventId,evidenceLevel:'observed',payload:{action:'feed'}});rebuildRelationships(draft.life);return;}
  if (intent.type === 'service.eat-rice') {
    const services = pet.services; const itemId = params.itemId;
    assert(typeof itemId === 'string' && e.itemId === itemId && e.played === true && services && Array.isArray(services.inventory), '吃饭回执无效');
    const item = services.inventory.find((value: Obj) => value.id === itemId);
    assert(item && ['available','reserved'].includes(item.status), '食物不在可食用库存中');
    assert(human && human.stats && human.emotions, '身体状态无效');
    const result = actHumanity(human, 'feed', at);
    assert(result.ok, '身体状态变化，不能结算这次进食');
    const next = result.state; next.serviceActions = {...human.serviceActions,[intent.id]:{ok:true,at,action:'feed'}};
    draft.humanity = next; item.status = 'eaten'; item.eatenAt = at; pet.lastInteraction = at;
    if (services.eating?.itemId === itemId) services.eating = null;
    return;
  }
  if(intent.type==='body.sleep'||intent.type==='body.wake') {const kind=intent.type==='body.sleep'?'sleep':'wake';assert(e.played===true && e.restKind===kind && human.sleeping===(kind==='wake'),'睡眠回执与身体状态不符');draft.humanity=reactHumanity(human,kind,at);return;}
  if(intent.type==='token.pickup') {
    const coin=pet.tokens?.coins?.find((c:Obj)=>c.id===params.coinId);
    assert(coin && coin.status==='floor' && coin.surface==='desktop' && coin.value===100 && e.coinId===coin.id && e.surface==='desktop' && e.played===true && finite(e.x) && finite(e.y) && finite(coin.x) && finite(coin.y) && Math.hypot(e.x-coin.x,e.y-coin.y)<=.045 && finite(pet.wallet?.balance) && finite(pet.tokens.recovered), '拾取结果与碎片不匹配');
    coin.status='recovered';coin.settled=at;pet.wallet.balance+=coin.value;pet.tokens.recovered+=coin.value;
    if(Array.isArray(pet.tokens.plan))pet.tokens.plan=pet.tokens.plan.filter((id:string)=>id!==coin.id);
    return;
  }
  if (intent.type === 'labor.step') {
    if(receipt.status==='cancelled') {
      assert(finite(e.effortSeconds) && e.effortSeconds>=0 && e.effortSeconds<=30 && finite(e.intensity) && e.intensity>=1 && e.intensity<=1.7 && human.stats && human.emotions,'体力回执无效');
      const next=advanceHumanity(human,at),effort=e.effortSeconds*e.intensity;next.stats.stamina=clamp(next.stats.stamina-effort*.08);next.stats.energy=clamp(next.stats.energy-effort*.045);next.stats.satiety=clamp(next.stats.satiety-effort*.015);draft.humanity=next;return;
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
      contract.workPermit = contract.batchRemaining > 0; contract.nextDecision = Math.max(at + 1000,(contract.lastWorkDecision || 0)+60000);
      if (contract.done === contract.trips) {
        contract.status = 'unpaid'; contract.finished = at;
        const id = `labor-unpaid:${intent.id}`;
        draft.life.events.push({eventId:id,petId:draft.petId,type:'social.labor.unpaid',source:'executor',actorId:'dad',occurredAt,receivedAt:occurredAt,causationId:sourceEventId,evidenceLevel:'observed',payload:{contractId:contract.id,outstanding:Math.max(0,contract.wage-(contract.paid||0))}});
        rebuildRelationships(draft.life);
      }
    }
    if (finite(e.effortSeconds)) {
      assert(e.effortSeconds >= 0 && e.effortSeconds <= 30 && finite(e.intensity) && e.intensity >= 1 && e.intensity <= 1.7 && human.stats && human.emotions, '体力回执无效');
      const next = advanceHumanity(human,at), effort = e.effortSeconds * e.intensity;
      next.stats.stamina = clamp(next.stats.stamina - effort * .08); next.stats.energy = clamp(next.stats.energy - effort * .045); next.stats.satiety = clamp(next.stats.satiety - effort * .015);
      next.serviceActions = {...human.serviceActions,[`labor-effort:${intent.id}`]:{ok:true,at,action:'labor-effort',seconds:e.effortSeconds,intensity:e.intensity}};
      draft.humanity = next;
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
    draft.life.memories.push({id,kind:'semantic',content:'外部资料（未经验证，来源：' + e.documentUrl + '）：' + e.content,sourceIds:[sourceId],evidenceLevel:'observed',valid:true,createdAt:occurredAt});
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
      }
    }
  }
}
