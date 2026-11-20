import type {CanonicalEnvelope} from '../storage/postgres.js';
import {farmDay,farmFacts,farmVisit,type FarmOperation} from './farm.js';

type Work = {operation:FarmOperation; actionId:string; eventId:string; receiptEventId:string; bowls?:number};
type Reply = {text:string; sourceIds:string[]};

export const farmTopic = /稻田|田里|水稻|稻苗|秧苗|种子|播种|下种|种地|种米|插秧|浇水|施肥|施.{0,3}肥|收割|农活/u;
const statusQuestion = /库存|还.{0,3}浇|水(?:已经|也|是|都)?够|(?:农活|照料).{0,6}(?:几次|多少|达标|进度|做完)|(?:还能|能不能|可以|要不要).{0,3}(?:浇水|施肥)|(?:施肥|施.{0,3}肥).{0,4}(?:没|了吗|没有|成功)|播种.{0,5}(?:没|失败|成功|了吗|没有)|(?:有没有|怎么|为什么|是否|没|种没)种|种(?:好|上|完|成|下)(?:了|没|吗|没有|成功)|种了(?:吗|没|没有)/u;
const farmActionClaim = /(?:没|未|不能|可以|能|要|已经|刚|才).{0,3}(?:再?种|播种|浇水|施.{0,3}肥|收割)|(?:播种|浇水|施肥|收割|种下|种好|种成)(?:了|过|成功|失败|完)|(?:浇|施)了.{0,5}(?:水|肥)|已经.{0,6}种/u;
const farmStateClaim = /(?:还差|缺|够|补|浇|两|一).{0,7}(?:浇水|次水)|水(?:已经|也|是|都)?(?:够|足)|(?:农活|照料).{0,6}(?:达标|做完)|(?:田里|稻田).{0,10}(?:空|有苗|长|没种)|库存|种子.{0,6}(?:束|用完|剩|没了)|(?:买了|买到|买齐|买完).{0,12}种子/u;
const workText:Record<FarmOperation,string> = {plant:'已播种',water:'已浇水',fertilize:'已施肥',harvest:'已收割'};

function confirmedWork(envelope:CanonicalEnvelope, userEventId?:string, seasonId?:string):Work|undefined {
  const {actions,events,invalidSources,receipts}=envelope.life;
  const valid=(id:string)=>!Object.hasOwn(invalidSources,id);
  for(let index=(actions?.length??0)-1;index>=0;index--){
    const action=actions[index], actionId=action.id;
    if(action.actionType!=='farm.tend'||action.status!=='COMPLETED'||!action.receiptId||!valid(action.receiptId)||
      !action.sourceIds.every(valid)||(userEventId&&!action.sourceIds.includes(userEventId))||(seasonId&&actionId!==seasonId))continue;
    const eventId='farm-tended:'+actionId;
    const event=events.find(e=>e.eventId===eventId&&e.type==='farm.tended'&&e.source==='executor'&&valid(eventId));
    const detail=event?.payload as {operation?:FarmOperation;seasonId?:string;bowls?:number;sourceIds?:string[]}|undefined;
    if(!detail?.operation||!Object.hasOwn(workText,detail.operation)||action.parameters.operation!==detail.operation||
      (seasonId&&(detail.operation!=='plant'||detail.seasonId!==seasonId)))continue;
    const receipt=receipts.find(r=>r.receiptId===action.receiptId&&r.actionId===actionId&&r.status==='COMPLETED');
    const receiptEvent=receipt&&events.find(e=>e.type==='action.receipt'&&e.causationId===receipt.receiptId&&
      valid(e.eventId)&&detail.sourceIds?.includes(e.eventId));
    if(receiptEvent)return {operation:detail.operation,actionId,eventId,receiptEventId:receiptEvent.eventId,bowls:detail.bowls};
  }
}

export function farmReply(envelope:CanonicalEnvelope,userEventId:string,question:string,draft:string,group:boolean,now=Date.now()):Reply|undefined {
  if(Object.hasOwn(envelope.life.invalidSources,userEventId))return;
  const sameTurn=confirmedWork(envelope,userEventId);
  const farmQuestion=farmTopic.test(question);
  const asksStatus=statusQuestion.test(question)&&(farmQuestion||
    (!!farmVisit(envelope)&&/种|浇|水够/u.test(question)&&!/口渴|喝|冰箱|杯/u.test(question)));
  const discussesFarm=farmQuestion||farmTopic.test(draft);
  if(!sameTurn&&!asksStatus&&!(draft&&discussesFarm&&(farmActionClaim.test(draft)||farmStateClaim.test(draft))))return;

  const field=farmFacts(envelope,now);
  const currentDay=field?.date===farmDay(now)&&!Object.hasOwn(envelope.life.invalidSources,field.weatherEventId);
  const crop=(envelope.legacy.farm as {crop?:{id:string;daySources?:string[]}}|undefined)?.crop;
  const work=sameTurn ?? (crop&&confirmedWork(envelope,undefined,crop.id));
  const sourceIds=new Set([userEventId]);
  if(work){sourceIds.add(work.eventId);sourceIds.add(work.receiptEventId);}
  if(currentDay){
    sourceIds.add(field.weatherEventId);
    for(const id of crop?.daySources??[])if(!Object.hasOwn(envelope.life.invalidSources,id))sourceIds.add(id);
  }
  const growing=field?.stage==='seedling'||field?.stage==='heading';

  if(group){
    const result=work?workText[work.operation]:field?.stage==='empty'?'田里现在是空的':field?.stage==='ripe'?'水稻已成熟':growing?'田里有水稻':'稻田状态待确认';
    const care=currentDay&&field.weatherBlocked?'，灾害期间暂停进田':currentDay&&growing
      ? `，照料${field.careProgress}/${field.careTarget}` : '';
    return {text:result+care+'。',sourceIds:[...sourceIds]};
  }

  const lines:string[]=[];
  if(work?.operation==='plant'&&field)lines.push(`本鱼用 ${field.seeds.perSeason} 束种子种下了一季水稻。`);
  if(work?.operation==='water')lines.push('本鱼给水稻浇了一次水。');
  if(work?.operation==='fertilize')lines.push('本鱼给水稻施了一次肥。');
  if(work?.operation==='harvest')lines.push(`本鱼收割了水稻${work.bowls ? `，收了 ${work.bowls} 碗生米` : '，这季颗粒无收'}。`);
  if(sameTurn?.operation==='plant'){
    const purchase=envelope.life.events.find(e=>e.eventId===`finance:${sameTurn.actionId}`&&e.type==='wallet.spend'&&
      !Object.hasOwn(envelope.life.invalidSources,e.eventId));
    const detail=purchase?.payload as {kind?:string;count?:number;amount?:number}|undefined;
    if(purchase&&detail?.kind==='farm-seeds'&&typeof detail.count==='number'&&typeof detail.amount==='number'){
      lines.push(`买了 ${detail.count} 束种子，花了 ${detail.amount} token。`);
      sourceIds.add(purchase.eventId);
    }
  }
  if(field){
    if(field.stage==='empty')lines.push('田里现在是空的。');
    if(field.stage==='seedling')lines.push('田里现在是幼苗期。');
    if(field.stage==='heading')lines.push('田里的水稻已经抽穗了。');
    if(field.stage==='ripe')lines.push(field.operation==='harvest'?'水稻已经成熟，可以收割了。':'水稻已经成熟。');
    if(sameTurn?.operation==='plant'||/库存|种子/u.test(question+' '+draft))lines.push(`种子库存还剩 ${field.seeds.stock} 束。`);
    if(currentDay&&growing){
      const remaining=field.careTarget-field.careProgress;
      const available=field.operation==='water'?'，现在可以浇水':field.operation==='fertilize'?'，现在可以施肥':'';
      if(field.rain)lines.push(`雨水已补 ${field.rain} 次${field.waterNeeded?'':'，今天的水够了'}。`);
      else if(!field.waterNeeded)lines.push('今天的水够了。');
      lines.push(`人工照料 ${field.careCompleted} 次。`);
      lines.push(remaining?`今天还差 ${remaining} 次照料${available}。`:'今天的照料已达标。');
    }
    if(currentDay&&field.weatherBlocked)lines.push(`${field.weatherLabel}期间先暂停进田。`);
  }
  return {text:lines.join('')||'本鱼还没确认稻田的状态。',sourceIds:[...sourceIds]};
}
