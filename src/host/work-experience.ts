import {randomUUID} from 'node:crypto';
import {lifeDay} from '../kernel/goal-lifecycle.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {LifeState, StrategyObservation} from '../kernel/types.js';

export type WorkChoice = 'continue' | 'rest';
export interface WorkContext { contractId:string; stamina:'low'|'medium'|'high'; phase:'early'|'late' }
type Strategy = { choice:WorkChoice; context:WorkContext; recommended:WorkChoice; sourceIds:string[]; recovered?:boolean };
const contextKey = (context:WorkContext) => `work:${context.stamina}:${context.phase}`;

export function workContext(draft:CanonicalEnvelope, contract:{id:string;done:number;trips:number}):WorkContext {
  const stamina=Number((draft.humanity.stats as {stamina:number}).stamina);
  return {contractId:contract.id,stamina:stamina<30?'low':stamina<60?'medium':'high',phase:contract.done*2<contract.trips?'early':'late'};
}

export function rankWorkChoices(state:Pick<LifeState,'observations'|'invalidSources'|'selfModel'>, context:WorkContext) {
  const samples=state.observations.filter(o=>o.valid&&o.context===contextKey(context)&&
    o.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id)))
    .sort((a,b)=>(a.work?.observedAt??'').localeCompare(b.work?.observedAt??'')).slice(-12);
  const order:WorkChoice[]=context.stamina==='low'?['rest','continue']:['continue','rest'];
  return order.map((choice,index)=>{
    const matches=samples.filter(o=>o.strategy==='work:'+choice);
    const habit=state.selfModel?.habits.some(h=>h.valid&&h.label==='work:'+choice&&h.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id)));
    return {choice,samples:matches.length,score:samples.length>=3&&matches.length?
      (matches.filter(o=>o.success).length+1)/(matches.length+2)+(habit ? .02 : 0):.5,index,
      sourceIds:[...new Set(matches.flatMap(o=>o.sourceIds))]};
  }).sort((a,b)=>b.score-a.score||a.index-b.index);
}

export function recordWorkChoice(draft:CanonicalEnvelope, strategy:Strategy, occurredAt:string):string {
  const id='work-choice:'+randomUUID();
  const {sourceIds,...decision}=strategy;
  draft.life.events.push({eventId:id,petId:draft.petId,type:'labor.strategy',source:'model',occurredAt,receivedAt:occurredAt,
    evidenceLevel:'inferred',payload:{...decision,recommendationSourceIds:sourceIds,overrodeRecommendation:strategy.choice!==strategy.recommended}});
  return id;
}

export function recordWorkOutcome(draft:CanonicalEnvelope, decisionId:unknown, evidenceId:string, success:boolean, observedAt:string):void {
  if(typeof decisionId!=='string'||Object.hasOwn(draft.life.invalidSources,decisionId))return;
  const decision=draft.life.events.find(e=>e.eventId===decisionId&&e.type==='labor.strategy');
  if(!decision)return;
  const strategy=decision.payload as Pick<Strategy,'choice'|'context'>;
  const id='work-sample:'+decisionId;
  if(draft.life.observations.some(o=>o.id===id))return;
  const observation:StrategyObservation={id,strategy:'work:'+strategy.choice,context:contextKey(strategy.context),success,
    sourceIds:[decisionId,evidenceId],valid:true,work:{contractId:strategy.context.contractId,observedAt}};
  draft.life.observations.push(observation);
  const habits=draft.life.selfModel?.habits;
  if(!success||!habits||habits.some(h=>h.valid&&h.label===observation.strategy))return;
  const evidence=draft.life.observations.filter(o=>o.valid&&o.strategy===observation.strategy&&o.success&&
    o.sourceIds.every(id=>!Object.hasOwn(draft.life.invalidSources,id))).slice(-12);
  const choices=new Map(draft.life.events.filter(e=>e.type==='labor.strategy').map(e=>[e.eventId,e.occurredAt]));
  const days=new Set(evidence.map(o=>choices.get(o.sourceIds[0])).filter((at):at is string=>!!at).map(at=>lifeDay.format(Date.parse(at))));
  if(days.size<2)return;
  habits.push({id:'habit:'+decisionId,label:observation.strategy,value:strategy.choice==='rest'?'我曾在不同日子停下恢复，再继续搬完一趟。':'我曾在不同日子选择继续工作，并顺利搬完下一趟。',
    sourceIds:[...new Set(evidence.flatMap(o=>o.sourceIds))],valid:true});
}

export function laborPaymentHistory(state:Pick<LifeState,'events'|'invalidSources'>, now=Date.now()) {
  const contracts=new Map<string,{opened:number;stillDue:number;settledAt?:number;sourceIds:string[]}>();
  for(const event of state.events){
    if(!['social.labor.unpaid','social.labor.payment'].includes(event.type)||
      !['observed','verified'].includes(event.evidenceLevel)||Object.hasOwn(state.invalidSources,event.eventId))continue;
    const data=event.payload as {contractId?:string;outstanding?:number};
    const at=Date.parse(event.occurredAt);
    if(!data.contractId||typeof data.outstanding!=='number'||!Number.isFinite(at)||at>now)continue;
    const prior=contracts.get(data.contractId);
    if(event.type==='social.labor.unpaid'&&!prior){
      if(data.outstanding>0)contracts.set(data.contractId,{opened:at,stillDue:data.outstanding,sourceIds:[event.eventId]});
    }else if(prior&&event.type==='social.labor.payment'){
      prior.stillDue=data.outstanding;
      prior.sourceIds.push(event.eventId);
      if(data.outstanding===0)prior.settledAt=at;
    }
  }
  const recent=[...contracts.values()].slice(-12);
  const day=86_400_000;
  const overdue=recent.filter(c=>c.stillDue>0&&now-c.opened>=day);
  return {
    awaiting:recent.filter(c=>c.stillDue>0&&now-c.opened<day).length,
    overdue:overdue.length,
    overdueAmount:overdue.reduce((sum,c)=>sum+c.stillDue,0),
    settled:recent.filter(c=>c.stillDue===0).length,
    settledWithinDay:recent.filter(c=>c.settledAt!==undefined&&c.settledAt-c.opened<day).length,
    sourceIds:[...new Set(recent.flatMap(c=>c.sourceIds))]
  };
}
