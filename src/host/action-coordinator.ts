import {validateManualService} from './manual-service-validation.js';
import { validateProposal } from '../kernel/index.js';
import type { LifeState } from '../kernel/types.js';
import type { BodyProjection } from '../storage/postgres.js';
import type { UnitOfWork } from '../storage/uow.js';
import { validateActionParameters } from './action-parameters.js';
import {projectActionBody} from './body-projection.js';

/** Converts an already-persisted proposal into an atomic pending intent. */
export class ActionCoordinator {
  constructor(private readonly unitOfWork: UnitOfWork, private readonly body: BodyProjection,
    private readonly now: () => Date = () => new Date()) {}

  async queue(petId: string, actionId: string, expectedVersion: number): Promise<void> {
    await this.unitOfWork.apply(petId, expectedVersion, draft => {
      const matches = draft.life.actions.filter(action => action.id === actionId);
      if (matches.length !== 1 || matches[0].status !== 'PROPOSED') throw new Error('行动不处于可排队状态');
      const action = matches[0];
      if((draft.legacy as Record<string,any>).worksite?.inside && ['service.eat-rice','care.feed','body.sleep','body.wake','token.pickup'].includes(action.actionType))throw Error('她在网页工地里，请先接她回桌面');
      validateActionParameters(action.actionType,action.parameters);
      const state: LifeState = {...structuredClone(draft.life), petId, version:draft.version, ...projectActionBody(draft,this.body(draft),action.actionType)};
      const proposal={...action, expectedStateVersion:draft.version};
      if(action.actionType==='care.feed' && !(draft.legacy as Record<string,any>).manualServiceRequests?.[action.id])throw Error('喂饭须由用户手动发起');
      if((draft.legacy as Record<string,any>).manualServiceRequests?.[action.id])validateManualService(draft,state,proposal);else validateProposal(state,proposal);
      if(action.actionType==='learning.observe'||action.actionType==='image.observe') {
        const pet=draft.legacy as Record<string,any>, wallet=pet.wallet, cost=pet.config?.costs?.explore;
        const kind=action.parameters.kind;
        const ability=action.actionType==='image.observe'?'image':kind==='bili'?'bili':kind==='fetch'?'fetch':'search';
        if((ability!=='image'&&!pet.config?.networkLearning) || pet.abilities?.[ability]?.status!=='granted' || (ability==='search' && pet.abilities?.fetch?.status!=='granted')) throw new Error('探索权限不可用');
        if(ability==='image' && (!pet.attachments?.[action.parameters.attachmentId as string] || Object.hasOwn(draft.life.invalidSources,action.parameters.attachmentSourceId as string) || !draft.life.events.some(e=>e.eventId===action.parameters.attachmentSourceId && (e.payload as any)?.attachmentId===action.parameters.attachmentId)))throw Error('图片来源无效');
        const daily=pet.config?.exploration?.dailyRuns;
        if(!Number.isSafeInteger(daily)||daily<0||!pet.usage||typeof pet.usage!=='object')throw new Error('探索额度配置无效');
        const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        const usage=pet.usage[day] ||= {exploreRuns:0,modelCalls:0,diaryAttempts:0,diarySuccess:0,totalCalls:0,newStrategies:0,reflectionAttempts:0};
        if(!Number.isSafeInteger(usage.exploreRuns)||usage.exploreRuns<0||usage.exploreRuns>=Math.min(1,daily))throw new Error('今日探索额度已用完');
        usage.exploreRuns++;
        if(!wallet || !Number.isFinite(wallet.balance) || !Number.isFinite(cost) || cost<0) throw new Error('探索饭钱配置无效');
        const amount=wallet.frozen===true?0:cost;
        if(wallet.balance<amount) throw new Error('模拟饭钱不足');
        const charges=pet.explorationCharges ||= {};
        if(Object.hasOwn(charges,actionId)) throw new Error('探索费用标识冲突');
        wallet.balance=Math.round((wallet.balance-amount)*100)/100;
        charges[actionId]={amount,status:'reserved'};
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
    });
  }
}
