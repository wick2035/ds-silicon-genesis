import {hasActiveConversation} from './active-conversation.js';
import {settleGroupOpener} from './qq-group-proactive-policy.js';
import {validateRicePurchase} from './rice-purchase.js';
import {validateRiceMeal} from './rice-inventory.js';
import {forcedLaborState} from './forced-labor.js';
import {sweetPrice} from './spirit-activity.js';
import {selfActionState} from './self-action-state.js';
import {checkSpirit,spendSpirit} from '../kernel/spirit.js';
import {completeReceiptGoals} from '../kernel/goal-lifecycle.js';
import {rebuildOutcomeDevelopment} from '../kernel/outcome-development.js';
import {validateManualService} from './manual-service-validation.js';
import { validateQQReply } from './qq-canonical.js';
import {projectActionBody} from './body-projection.js';
import {actionFeedback} from './operation-feedback.js';
import { validateProposal } from '../kernel/index.js';
import { projectOutcome } from './outcome-projector.js';
import type { ActionReceipt, LifeAction, LifeEvent, LifeState } from '../kernel/types.js';
import type { BodyProjection, CanonicalEnvelope } from '../storage/postgres.js';
import type { ActionLifecycle, ExecutionReceipt, OutboxIntent } from '../storage/uow.js';

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

function updateQQ(draft: CanonicalEnvelope, intent: OutboxIntent, status: ActionReceipt['status'], evidence: Record<string,unknown>): void {
  if (intent.type !== 'qq.send') return;
  const qq = (draft.legacy as Record<string,any>).qq;
  const entries = Object.values(qq?.outbound ?? {}) as Array<Record<string,any>>;
  const match = entries.filter(entry => entry.actionId === intent.id);
  assert(match.length === 1 && ['pending','sending','unknown'].includes(match[0].state), 'QQ 发送状态不一致');
  if (status === 'COMPLETED') assert(evidence.actionId === intent.id && evidence.kind === 'qq.send' && typeof evidence.messageId === 'string' && !!evidence.messageId, 'QQ 缺少发送回执');
  match[0].state = status === 'COMPLETED' ? 'sent' : status === 'UNKNOWN' ? 'unknown' : status.toLowerCase();
  if (status === 'COMPLETED') match[0].messageId = evidence.messageId;
  settleGroupOpener(draft,match[0],status,new Date().toISOString());
}
function settleExploration(draft: CanonicalEnvelope, intent: OutboxIntent, status: ActionReceipt['status']): void {
  if (!['learning.observe','image.observe'].includes(intent.type) || status === 'UNKNOWN') return;
  const legacy = draft.legacy as Record<string, any>, charge = legacy.explorationCharges?.[intent.id];
  assert(charge && charge.status === 'reserved' && typeof charge.amount === 'number' && Number.isFinite(charge.amount) && charge.amount >= 0, '探索费用预留无效');
  if (status === 'COMPLETED') { charge.status = 'settled'; return; }
  assert(legacy.wallet && typeof legacy.wallet.balance === 'number' && Number.isFinite(legacy.wallet.balance) && legacy.wallet.balance + charge.amount <= 1000000000, '探索费用无法安全退还');
  legacy.wallet.balance = Math.round((legacy.wallet.balance + charge.amount) * 100) / 100;
  charge.status = 'refunded';
}
function advancePlan(draft: CanonicalEnvelope, actionId: string, status: ActionReceipt['status']): void {
  const matches = (draft.life.cognitivePlans ?? []).flatMap(plan => plan.steps.filter(step => step.actionId === actionId).map(step => ({plan,step})));
  assert(matches.length <= 1, '行动对应多个计划步骤');
  if (!matches.length || status === 'UNKNOWN') return;
  const {plan,step} = matches[0];
  assert(step.status === 'in_progress', '计划步骤不在执行中');
  if (status === 'COMPLETED') {
    step.status = 'completed';
    if (plan.steps.every(item => item.status === 'completed')) plan.status = 'completed';
  } else { step.status = 'failed'; plan.status = 'failed'; }
}
function learnOutcome(draft:CanonicalEnvelope, action:LifeAction, status:ActionReceipt['status'], eventId:string):void {
  if(status==='UNKNOWN')return;
  const sourceIds=[...new Set([eventId,...action.sourceIds])];
  for(const strategy of [action.actionType,...action.requiredCapabilities.map(name=>'capability:'+name)]) {
    const id='outcome:'+action.id+':'+strategy;
    if(!draft.life.observations.some(x=>x.id===id)) draft.life.observations.push({id,strategy,context:'execution',success:status==='COMPLETED',sourceIds,valid:true});
  }
}
/** Payload contract: { actionId, petId, actionType, parameters }.  The
 * dispatcher alone owns this lifecycle and receives receipts from registered
 * executors; neither a model nor an HTTP handler may call complete. */
export class CanonicalActionLifecycle implements ActionLifecycle {
  constructor(private readonly projectBody: BodyProjection, private readonly clock: () => Date = () => new Date()) {}

  private now(): string {
    const value = this.clock();
    assert(value instanceof Date && Number.isFinite(value.valueOf()), '行动时间无效');
    return value.toISOString();
  }

  private action(draft: CanonicalEnvelope, intent: OutboxIntent): LifeAction {
    assert(draft && draft.petId && draft.life && Array.isArray(draft.life.actions) &&
      Array.isArray(draft.life.events) && Array.isArray(draft.life.receipts), '生命状态信封无效');
    assert(intent && typeof intent.id === 'string' && intent.id && typeof intent.type === 'string' && intent.type &&
      intent.payload && typeof intent.payload === 'object' && !Array.isArray(intent.payload), '行动意图无效');
    const matches = draft.life.actions.filter(a => a.id === intent.id);
    assert(matches.length === 1, '行动不存在或存在重复');
    const action = matches[0], p = intent.payload;
    assert(action.petId === draft.petId && p.petId === draft.petId && p.actionId === action.id &&
      p.actionType === action.actionType && intent.type === action.actionType &&
      p.parameters !== null && typeof p.parameters === 'object' && !Array.isArray(p.parameters) &&
      same(p.parameters, action.parameters), '行动意图与权威状态不一致');
    return action;
  }

  prepare(draft: CanonicalEnvelope, intent: OutboxIntent): {allowed: boolean; reason?: string} {
    const action = this.action(draft, intent);
    assert(action.status === 'PENDING', '行动不处于待执行状态');
    const projection = projectActionBody(draft,this.projectBody(draft),action.actionType);
    const state: LifeState = {...structuredClone(draft.life), petId:draft.petId, version:draft.version, ...projection};
    try {
      // A proposal was accepted earlier. Revalidate it against the locked latest
      // state, not against its historical proposal version.
      if(action.actionType==='body.sleep'&&hasActiveConversation(draft)&&!(draft.legacy as any).manualServiceRequests?.[action.id]&&!action.sourceIds.some(id=>id.startsWith('chat-user:')||id.startsWith('needs:')))throw Error('还有正在进行的决定，先完成这轮');
      if(action.actionType==='service.sweet')sweetPrice(draft);
      if(action.actionType==='service.buy-rice')validateRicePurchase(draft);
      if(action.actionType==='service.eat-rice')validateRiceMeal(draft,action.parameters.itemId);
      if(action.actionType!=='labor.step')checkSpirit(draft.life,action.actionType,this.clock().valueOf());
      const proposal={...action, expectedStateVersion:draft.version};
      if((draft.legacy as Record<string,any>).worksite?.inside && (action.actionType.startsWith('care.') || ['service.eat-rice','body.sleep','body.wake','token.pickup','body.activity'].includes(action.actionType)))throw Error('她在网页工地里，请先接她回桌面');
      if(action.actionType==='body.activity' && ((draft.legacy as Record<string,any>).space?.mode!=='outside' || (draft.legacy as Record<string,any>).labor?.contracts?.some((c:any)=>c.status==='working')))throw Error('当前桌面空间或工作状态不允许走动');
      if(action.actionType==='labor.step'){
        const pet=draft.legacy as Record<string,any>,command=pet.world?.command,contract=pet.labor?.contracts?.find((c:any)=>c.id===action.parameters.contractId);
        if(!pet.worksite?.inside || command?.surface!=='web')throw Error('她不在网页工地里');
        if(command.id!==action.parameters.commandId || command.labor?.id!==contract?.id || command.status!=='queued' || !Number.isFinite(command.expires) || command.expires<=this.clock().valueOf() || contract?.status!=='working' || !contract.workPermit || contract.done>=contract.trips)throw Error('搬砖任务或步骤已变化');
      }
      if(action.actionType.startsWith('care.') && action.actionType!=='care.water' && !(draft.legacy as Record<string,any>).manualServiceRequests?.[action.id])throw Error('照料须由用户手动发起');

      if(action.actionType==='qq.send')validateQQReply(draft,state,proposal);
      else if((draft.legacy as Record<string,any>).manualServiceRequests?.[action.id])validateManualService(draft,state,proposal);
      else validateProposal(forcedLaborState(draft,selfActionState(state,proposal),proposal),proposal);
    } catch (error) {
      return {allowed:false, reason:error instanceof Error ? error.message : '当前状态不允许执行'};
    }
    const now = this.now();
    const eventId = `action-dispatched:${action.id}`;
    assert(!draft.life.events.some(e => e.eventId === eventId), '行动派发事件冲突');
    spendSpirit(draft.life,action.actionType,Date.parse(now),action.actionType==='labor.step');
    action.status = 'DISPATCHED'; action.updatedAt = now;
    if (intent.type === 'qq.send') {
      const qq = (draft.legacy as Record<string,any>).qq;
      const entries = Object.values(qq?.outbound ?? {}) as Array<Record<string,any>>;
      const match = entries.filter(entry => entry.actionId === action.id);
      assert(match.length === 1 && match[0].state === 'pending', 'QQ 发送意图无效'); match[0].state = 'sending';
    }
    draft.life.events.push({eventId, petId:draft.petId, type:'action.dispatched', source:'outbox',
      occurredAt:now, receivedAt:now, payload:{actionId:action.id, actionType:action.actionType}, evidenceLevel:'observed'});
    return {allowed:true};
  }

  complete(draft: CanonicalEnvelope, intent: OutboxIntent, receipt: ExecutionReceipt): void {
    const action = this.action(draft, intent);
    assert(receipt && ['completed','failed','cancelled','unknown'].includes(receipt.status) &&
      receipt.evidence && typeof receipt.evidence === 'object' && !Array.isArray(receipt.evidence), '执行回执无效');
    const outcome = receipt.status.toUpperCase() as ActionReceipt['status'];
    const receiptId = `action-receipt:${action.id}`;
    const old = draft.life.receipts.filter(r => r.receiptId === receiptId || r.actionId === action.id);
    if (old.length) {
      assert(old.length === 1 && old[0].receiptId === receiptId && old[0].petId === draft.petId &&
        old[0].actionId === action.id && old[0].status === outcome && same(old[0].details, receipt.evidence) &&
        action.receiptId === receiptId && action.status === outcome, '行动回执冲突，须对账');
      return;
    }
    assert(action.status === 'DISPATCHED' || (action.status === 'PENDING' && outcome === 'CANCELLED'), '行动不等待回执');
    const now = this.now(), eventId = `action-result:${action.id}`;
    assert(!draft.life.events.some(e => e.eventId === eventId), '行动结果事件冲突');
    const result: ActionReceipt = {receiptId, petId:draft.petId, actionId:action.id, status:outcome,
      occurredAt:now, source:'outbox', evidenceLevel:'observed', details:structuredClone(receipt.evidence)};
    const event: LifeEvent = {eventId, petId:draft.petId, type:'action.receipt', source:'outbox',
      occurredAt:now, receivedAt:now, causationId:receiptId,
      payload:{actionId:action.id, status:outcome,...(action.actionType==='body.activity'?{activity:action.parameters.activity,...(action.parameters.target?{target:action.parameters.target}:{}),...(receipt.evidence.reason?{interruption:receipt.evidence.reason}:{})}:{})}, evidenceLevel:outcome === 'UNKNOWN' ? 'inferred' : 'observed'};
    projectOutcome(draft, intent, receipt, now, eventId);
    const feedback=actionFeedback(draft,action,outcome);
    Object.assign(event.payload as object,{actionType:action.actionType,...(feedback?{feedback}:{})});
    updateQQ(draft, intent, outcome, receipt.evidence);
    settleExploration(draft, intent, outcome);
    advancePlan(draft, action.id, outcome);
    draft.life.receipts.push(result); draft.life.events.push(event);
    learnOutcome(draft,action,outcome,eventId);
    rebuildOutcomeDevelopment(draft.life as LifeState);
    if(outcome==='COMPLETED')completeReceiptGoals({...draft.life,petId:draft.petId,version:draft.version} as LifeState,action.id,eventId,now);
    action.status = outcome; action.receiptId = receiptId; action.updatedAt = now;
  }

  /**
   * Internal reconciliation only: the caller must obtain executor-specific,
   * trusted evidence and invoke this inside the same locked transaction that
   * updates the outbox from unknown to its confirmed outcome. This method does
   * not itself authenticate a caller or perform that outbox update.
   */
  reconcile(draft: CanonicalEnvelope, intent: OutboxIntent, confirmed: ActionReceipt): void {
    const action = this.action(draft, intent);
    const unknownId = `action-receipt:${action.id}`;
    const unknown = draft.life.receipts.filter(r => r.receiptId === unknownId);
    assert(unknown.length === 1 && unknown[0].actionId === action.id &&
      unknown[0].petId === draft.petId && unknown[0].status === 'UNKNOWN', '缺少待对账的未知回执');
    assert(confirmed && typeof confirmed.receiptId === 'string' && confirmed.receiptId.trim() &&
      confirmed.receiptId !== unknownId && confirmed.actionId === action.id && confirmed.petId === draft.petId &&
      ['COMPLETED','FAILED','CANCELLED'].includes(confirmed.status) &&
      ['observed','verified'].includes(confirmed.evidenceLevel) &&
      typeof confirmed.source === 'string' && confirmed.source.trim() &&
      typeof confirmed.occurredAt === 'string' && Number.isFinite(Date.parse(confirmed.occurredAt)) &&
      confirmed.details && typeof confirmed.details === 'object' && !Array.isArray(confirmed.details), '对账回执无效');
    const existing = draft.life.receipts.filter(r => r.receiptId === confirmed.receiptId);
    if (existing.length) {
      assert(existing.length === 1 && same(existing[0], confirmed) && action.receiptId === confirmed.receiptId &&
        action.status === confirmed.status, '对账回执冲突');
      return;
    }
    assert(action.status === 'UNKNOWN' && action.receiptId === unknownId &&
      !draft.life.receipts.some(r => r.actionId === action.id && r.receiptId !== unknownId), '行动已对账或状态冲突');
    const eventId = `action-reconciled:${action.id}`;
    assert(!draft.life.events.some(e => e.eventId === eventId), '对账事件冲突');
    const receivedAt = this.now();
    projectOutcome(draft, intent, {status:confirmed.status.toLowerCase() as ExecutionReceipt['status'],evidence:confirmed.details}, confirmed.occurredAt, eventId);
    updateQQ(draft, intent, confirmed.status, confirmed.details);
    settleExploration(draft, intent, confirmed.status);
    advancePlan(draft, action.id, confirmed.status);
    draft.life.receipts.push(structuredClone(confirmed));
    const feedback=actionFeedback(draft,action,confirmed.status);
    draft.life.events.push({eventId, petId:draft.petId, type:'action.reconciled', source:confirmed.source,
      occurredAt:confirmed.occurredAt, receivedAt, causationId:confirmed.receiptId,
      payload:{actionId:action.id, actionType:action.actionType, status:confirmed.status, previousReceiptId:unknownId,...(feedback?{feedback}:{})},
      evidenceLevel:confirmed.evidenceLevel});
    learnOutcome(draft,action,confirmed.status,eventId);
    rebuildOutcomeDevelopment(draft.life as LifeState);
    if(confirmed.status==='COMPLETED')completeReceiptGoals({...draft.life,petId:draft.petId,version:draft.version} as LifeState,action.id,eventId,receivedAt);
    action.status = confirmed.status; action.receiptId = confirmed.receiptId; action.updatedAt = receivedAt;
  }

}
