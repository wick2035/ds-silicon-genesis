import {farmVisit} from './farm.js';
import {reserveExploration} from './exploration-budget.js';
import {hasActiveConversation} from './active-conversation.js';
import {validateRicePurchase} from './rice-purchase.js';
import {forcedLaborState} from './forced-labor.js';
import {sweetPrice} from './spirit-activity.js';
import {selfActionState} from './self-action-state.js';
import {checkSpirit} from '../kernel/spirit.js';
import {validateManualService} from './manual-service-validation.js';
import { validateProposal } from '../kernel/index.js';
import type { LifeState } from '../kernel/types.js';
import type { BodyProjection, CanonicalEnvelope } from '../storage/postgres.js';
import type { OutboxIntent, UnitOfWork } from '../storage/uow.js';
import { validateActionParameters } from './action-parameters.js';
import {projectActionBody} from './body-projection.js';

/** Converts an already-persisted proposal into an atomic pending intent. */
export class ActionCoordinator {
  constructor(private readonly unitOfWork: UnitOfWork, private readonly body: BodyProjection,
    private readonly now: () => Date = () => new Date()) {}

  async queue(petId: string, actionId: string, expectedVersion: number): Promise<void> {
    await this.unitOfWork.apply(petId, expectedVersion, draft => this.queueDraft(draft,actionId));
  }

  queueDraft(draft:CanonicalEnvelope,actionId:string):{intents:OutboxIntent[]} {
      const petId=draft.petId;
      const matches = draft.life.actions.filter(action => action.id === actionId);
      if (matches.length !== 1 || matches[0].status !== 'PROPOSED') throw new Error('行动不处于可排队状态');
      const action = matches[0];
      if((draft.legacy as Record<string,any>).worksite?.inside && (action.actionType.startsWith('care.') || ['service.eat-rice','body.sleep','body.wake','token.pickup','body.activity'].includes(action.actionType)))throw Error('她在网页工地里，请先接她回桌面');
      if(farmVisit(draft) && (action.actionType.startsWith('care.') || ['service.eat-rice','body.sleep','body.wake','token.pickup','body.activity'].includes(action.actionType)))throw Error('她在稻田里，请先接她回桌面');
      if(action.actionType==='body.activity' && ((draft.legacy as Record<string,any>).space?.mode!=='outside' || (draft.legacy as Record<string,any>).labor?.contracts?.some((c:any)=>c.status==='working')))throw Error('当前桌面空间或工作状态不允许走动');
      if(action.actionType==='body.sleep'&&hasActiveConversation(draft)&&!(draft.legacy as any).manualServiceRequests?.[action.id]&&!action.sourceIds.some(id=>id.startsWith('chat-user:')||id.startsWith('needs:')))throw Error('还有正在进行的决定，先完成这轮');
      if(action.actionType==='service.sweet')sweetPrice(draft);
      if(action.actionType==='service.buy-rice')validateRicePurchase(draft);
      if(action.actionType!=='labor.step')checkSpirit(draft.life,action.actionType,this.now().valueOf());
      validateActionParameters(action.actionType,action.parameters);
      const state: LifeState = {...draft.life, petId, version:draft.version, ...projectActionBody(draft,this.body(draft),action.actionType)};
      const proposal={...action, expectedStateVersion:draft.version};
      if(action.actionType.startsWith('care.') && action.actionType!=='care.water' && !(draft.legacy as Record<string,any>).manualServiceRequests?.[action.id])throw Error('照料须由用户手动发起');

      if((draft.legacy as Record<string,any>).manualServiceRequests?.[action.id])validateManualService(draft,state,proposal);else validateProposal(forcedLaborState(draft,selfActionState(state,proposal),proposal),proposal);
      if(action.actionType==='learning.observe'||action.actionType==='image.observe') {
        const pet=draft.legacy as Record<string,any>;
        const kind=action.parameters.kind;
        const ability=action.actionType==='image.observe'?'image':kind==='bili'?'bili':kind==='fetch'?'fetch':'search';
        if((ability!=='image'&&!pet.config?.networkLearning) || pet.abilities?.[ability]?.status!=='granted' || (ability==='search' && pet.abilities?.fetch?.status!=='granted')) throw new Error('探索权限不可用');
        if(ability==='image' && (!pet.attachments?.[action.parameters.attachmentId as string] || Object.hasOwn(draft.life.invalidSources,action.parameters.attachmentSourceId as string) || !draft.life.events.some(e=>e.eventId===action.parameters.attachmentSourceId && (e.payload as any)?.attachmentId===action.parameters.attachmentId)))throw Error('图片来源无效');
        reserveExploration(pet,ability,this.now());
        const charges=pet.explorationCharges ||= {};
        if(Object.hasOwn(charges,actionId))throw Error('探索费用标识冲突');
        charges[actionId]={amount:0,status:'reserved'};
      }
      const timestamp = this.now();
      if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.valueOf())) throw new Error('时间无效');
      const eventId = `action-pending:${actionId}`;
      if (draft.life.events.some(event => event.eventId === eventId)) throw new Error('行动事件冲突');
      action.status = 'PENDING'; action.updatedAt = timestamp.toISOString();
      draft.life.events.push({eventId,petId,type:'action.pending',source:'coordinator',
        occurredAt:action.updatedAt,receivedAt:action.updatedAt,payload:{actionId},evidenceLevel:'observed'});
      return {intents:[{id:actionId,type:action.actionType,
        payload:{actionId,petId,actionType:action.actionType,parameters:structuredClone(action.parameters)}}]};
  }
}
