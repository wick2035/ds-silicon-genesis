import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
import {farmVisit,rawRiceBowls,useRawRice} from './farm.js';
import {availableRice,cookerBowlStorage,riceHold,type RiceBowl} from './rice-inventory.js';

export const COOKER_LIMIT=6;
export const COOKING_MS=20*60_000;
type Batch={id:string; bowls:number; readyAt:number};
type Take={id:string; bowls:number; remaining:number};
type Cooker={batch?:Batch; cooked:RiceBowl[]; reminderId?:string; pendingReplies:Take[]};
const cooker=(state:CanonicalEnvelope):Cooker|undefined=>state.legacy.riceCooker as Cooker|undefined;
const ensure=(state:CanonicalEnvelope):Cooker=>cooker(state)??(state.legacy.riceCooker={cooked:[],pendingReplies:[]});
const takingEvent=(id:string)=>'rice-taken:'+id;

export function cookerFacts(state:CanonicalEnvelope) {
  const stock=cooker(state), raw=rawRiceBowls(state), availableIds:string[]=[];
  let reserved=0;
  for(const bowl of cookerBowlStorage(state)) {
    if(bowl.status!=='available')continue;
    const hold=riceHold(state,bowl.id);
    if(!hold)availableIds.push(bowl.id);
    if(hold==='in-progress')reserved++;
  }
  const remaining=availableIds.length+reserved;
  return {raw,remaining,availableIds,reserved,batch:stock?.batch??null,reminderId:stock?.reminderId??null,
    maxBowls:stock?.batch||remaining?0:Math.min(raw,COOKER_LIMIT)};
}

export function canConsiderCooking(state:CanonicalEnvelope) {
  const facts=cookerFacts(state);
  return facts.maxBowls>0 && (facts.reminderId!==null || availableRice(state).filter(bowl=>bowl.source==='fridge').length<=1);
}

export function clearCookerReminder(state:CanonicalEnvelope,id:string|null) {
  const stock=cooker(state);
  if(stock && stock.reminderId===id)delete stock.reminderId;
}

export function validateStartCooking(state:CanonicalEnvelope,bowls:unknown):asserts bowls is number {
  const pet=state.legacy as Record<string,any>, human=state.humanity;
  if(state.life.constraints.paused || pet.config?.autonomousPaused || pet.growth?.stopAt || human.helperReady!==true ||
    human.restrained || human.sleeping || farmVisit(state) || pet.worksite?.inside)throw Error('大肥鱼现在不方便开锅');
  const {maxBowls}=cookerFacts(state);
  if(typeof bowls!=='number' || !Number.isSafeInteger(bowls) || bowls<1 || bowls>maxBowls)throw Error('请根据米缸和锅里的现状选择可煮碗数');
}

function record(state:CanonicalEnvelope,id:string,type:string,at:number,receivedAt:number,payload:Record<string,unknown>,owner=false) {
  state.life.events.push({eventId:id,petId:state.petId,type,source:owner?'desktop':'canonical',
    ...(owner?{actorId:'dad'}:{}),occurredAt:new Date(at).toISOString(),receivedAt:new Date(receivedAt).toISOString(),
    evidenceLevel:'observed',payload});
}

export function startCooking(state:CanonicalEnvelope,id:string,bowls:unknown,at:number) {
  validateStartCooking(state,bowls);
  useRawRice(state,bowls);
  const stock=ensure(state), readyAt=at+COOKING_MS;
  stock.batch={id,bowls,readyAt};
  delete stock.reminderId;
  record(state,'rice-start:'+id,'rice.cooking',at,at,{bowls,readyAt,description:`我往电饭锅里放了 ${bowls} 碗生米。`});
}

export function settleCooking(state:CanonicalEnvelope,at:number) {
  const stock=cooker(state), batch=stock?.batch;
  if(!stock||!batch||batch.readyAt>at)return false;
  for(let i=1;i<=batch.bowls;i++)stock.cooked.push({id:`cooked:${batch.id}:${i}`,name:'大白饭',status:'available'});
  delete stock.batch;
  record(state,'rice-ready:'+batch.id,'rice.ready',batch.readyAt,at,{bowls:batch.bowls,description:`电饭锅煮好了 ${batch.bowls} 碗大白饭。`});
  return true;
}

export function takeCookedRice(state:CanonicalEnvelope,id:string,expectedIds:string[],bowls:number,at:number) {
  if(!Number.isSafeInteger(bowls)||bowls<1)throw Error('盛饭碗数无效');
  const eventId=takingEvent(id), prior=state.life.events.find(event=>event.eventId===eventId);
  if(prior) {
    const payload=prior.payload as {bowls:number; expectedIds:string[]};
    if(payload.bowls!==bowls || JSON.stringify(payload.expectedIds)!==JSON.stringify(expectedIds))throw Error('盛饭请求编号冲突');
    return;
  }
  const {availableIds,remaining}=cookerFacts(state);
  if(JSON.stringify(availableIds)!==JSON.stringify(expectedIds) || bowls>availableIds.length)throw Error('锅里的饭变了，请确认碗数后再盛');
  const stock=ensure(state), takenIds=new Set(availableIds.slice(0,bowls)), left=remaining-bowls;
  stock.cooked=stock.cooked.filter(bowl=>!takenIds.has(bowl.id));
  const description=`爸爸从我的电饭锅盛走了 ${bowls} 碗大白饭，当时锅里还剩 ${left} 碗。`;
  record(state,eventId,'rice.taken',at,at,{bowls,remaining:left,description,expectedIds},true);
  state.life.memories.push({id:'memory:'+eventId,kind:'autobiographical',content:description,sourceIds:[eventId],
    evidenceLevel:'observed',valid:true,createdAt:new Date(at).toISOString()});
  stock.pendingReplies.push({id:eventId,bowls,remaining:left});
}

type Input={action:string; requestId?:string; expectedIds?:string[]; bowls?:number};
export function createRiceCooker(reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},gate:PetGate,uow:UnitOfWork,clock=Date.now) {
  const load=async(id:string)=>{
    const state=await reader.loadEnvelope(id);
    if(!state)throw Error('电饭锅存档不可用');
    return state;
  };
  const settle=async(id:string)=>{
    const state=await load(id);
    if((cooker(state)?.batch?.readyAt??Infinity)>clock())return state;
    return gate.run(id,async()=>{
      const latest=await load(id), now=clock();
      if((cooker(latest)?.batch?.readyAt??Infinity)>now)return latest;
      return uow.apply(id,latest.version,draft=>{settleCooking(draft,now);return {};});
    });
  };
  const view=(state:CanonicalEnvelope)=>({
    ...cookerFacts(state), now:clock(),
    replies:cooker(state)?.pendingReplies.filter(reply=>!Object.hasOwn(state.life.invalidSources,reply.id)).slice(0,1)??[],
  });
  return {settle, async helper(id:string,input:Input) {
    const {action,requestId,expectedIds,bowls}=input;
    if(action==='snapshot')return view(await settle(id));
    if(typeof requestId!=='string' || !/^[a-zA-Z0-9:-]{8,110}$/.test(requestId))throw Error('电饭锅请求编号无效');
    await settle(id);
    return gate.run(id,async()=>{
      const state=await load(id), now=clock();
      if(action==='ack') {
        if(!cooker(state)?.pendingReplies.some(reply=>reply.id===requestId))return view(state);
        return view(await uow.apply(id,state.version,draft=>{
          const stock=ensure(draft);
          stock.pendingReplies=stock.pendingReplies.filter(reply=>reply.id!==requestId);
          return {};
        }));
      }
      if(action==='remind') {
        const eventId='rice-reminder:'+requestId;
        if(cooker(state)?.reminderId || state.life.events.some(event=>event.eventId===eventId))return view(state);
        if(!cookerFacts(state).maxBowls)throw Error('有生米且空锅时才能提醒');
        return view(await uow.apply(id,state.version,draft=>{
          ensure(draft).reminderId=eventId;
          record(draft,eventId,'rice.reminded',now,now,{description:'爸爸提醒我可以自己决定煮几碗饭。'},true);
          return {};
        }));
      }
      if(action!=='take'||typeof bowls!=='number'||!Number.isSafeInteger(bowls)||bowls<1||!Array.isArray(expectedIds)||
        expectedIds.length>60||expectedIds.some(value=>typeof value!=='string'||value.length>200))throw Error('盛饭请求无效');
      if(state.life.events.some(event=>event.eventId===takingEvent(requestId))) {
        takeCookedRice(state,requestId,expectedIds,bowls,now);
        return view(state);
      }
      return view(await uow.apply(id,state.version,draft=>{takeCookedRice(draft,requestId,expectedIds,bowls,now);return {};}));
    });
  }};
}
