import type {CanonicalEnvelope} from '../storage/postgres.js';
import {farmDay,farmSettlementDescription,farmWeather,type FarmWeather} from './farm.js';

/** Explicit archive correction, used only by the offline repair tool. */
export function repairFarmSettlement(draft:CanonicalEnvelope,date:string,now=Date.now()) {
  const start=Date.parse(`${date}T00:00:00+08:00`),end=start+86400000;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(start)||farmDay(start)!==date||end>now)
    throw Error('只能修复已结束的有效香港日期');
  const auditId=`farm-settlement-repair:${date}:rain-v1`;
  const previous=draft.life.events.find(e=>e.eventId===auditId);
  if(previous){
    if(Object.hasOwn(draft.life.invalidSources,auditId))throw Error('已有修复记录已失效，需先核对存档');
    return {updated:false,date,alreadyApplied:true};
  }
  const farm=draft.legacy.farm as {day:{date:string};crop:{id:string;growth:number;loss:number;dayLoss:number;rain:number;waters:number;careCompleted?:number;daySources?:string[]}|null}|undefined;
  if(!farm?.crop||farm.day.date<=date)throw Error('没有可修复的当前水稻日结');
  const crop=farm.crop,events=draft.life.events,byId=new Map(events.map(e=>[e.eventId,e]));
  const valid=(id:string,seen=new Set<string>()):boolean=>{
    if(Object.hasOwn(draft.life.invalidSources,id)||seen.has(id))return false;
    const event=byId.get(id);if(!event)return false;
    const sources=(event.payload as {sourceIds?:string[]})?.sourceIds??[];
    const path=new Set(seen).add(id);
    return sources.every(source=>valid(source,path));
  };
  const payload=(event:typeof events[number])=>event.payload as Record<string,any>;
  const settlements=events.filter(e=>e.type==='farm.settled'&&payload(e).seasonId===crop.id)
    .sort((a,b)=>String(payload(a).date).localeCompare(String(payload(b).date)));
  const targets=settlements.filter(e=>payload(e).date===date);
  if(targets.length!==1||new Set(settlements.map(e=>payload(e).date)).size!==settlements.length)
    throw Error('日结缺失或重复，拒绝猜测修复');
  const target=targets[0];
  if(!valid(target.eventId))throw Error('原日结来源已失效或缺失');
  const planting=events.find(e=>e.type==='farm.tended'&&payload(e).seasonId===crop.id&&payload(e).operation==='plant');
  if(!planting||!valid(planting.eventId))throw Error('播种记录及来源不完整');
  const activeStart=Math.max(start,Date.parse(planting.occurredAt));
  if(activeStart>=end)throw Error('该日期尚未播种');
  const weather=events.filter(e=>e.type==='farm.weather'&&payload(e).date===date&&valid(e.eventId))
    .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const initial=weather.filter(e=>Date.parse(e.occurredAt)<=activeStart).at(-1);
  if(!initial)throw Error('缺少播种时或当天起始天气');
  const activeWeather=[initial,...weather.filter(e=>Date.parse(e.occurredAt)>activeStart&&Date.parse(e.occurredAt)<end)];
  const rain=Math.max(...activeWeather.map(e=>{
    const kind=payload(e).weather as FarmWeather;
    if(!Object.hasOwn(farmWeather,kind))throw Error('天气记录无法识别');
    // An empty field's weather event has water=0; its weather still applies at planting.
    return farmWeather[kind].water;
  }));
  const work=events.filter(e=>e.type==='farm.tended'&&payload(e).seasonId===crop.id&&payload(e).date===date&&
    ['water','fertilize'].includes(payload(e).operation)&&Date.parse(e.occurredAt)>=activeStart&&Date.parse(e.occurredAt)<end&&valid(e.eventId));
  const manual=work.length,before=structuredClone(payload(target));
  if(manual!==before.careCompleted)throw Error('人工次数与原日结不一致，拒绝猜测修复');
  const careProgress=Math.min(2,manual+rain),qualified=careProgress===2;
  const oldGrowth=Math.min(3,settlements.filter(e=>payload(e).qualified===true).length);
  if(crop.growth!==oldGrowth)throw Error('当前生长进度与历史日结不一致');
  let growth=0;
  for(const event of settlements){
    if(!valid(event.eventId))throw Error('历史日结证据不完整');
    if(growth===3)throw Error('修复会改变更早的成熟日期，需要单独核对后续日结');
    if(event===target?qualified:payload(event).qualified===true)growth++;
  }
  const description=farmSettlementDescription(manual,rain,qualified);
  const sourceIds=[...new Set([...(before.sourceIds??[]),planting.eventId,...activeWeather.map(e=>e.eventId),...work.map(e=>e.eventId)])];
  const after={...before,careCompleted:manual,rain,careProgress,qualified,description,sourceIds};
  const facts=draft.life.worldModel?.facts.filter(f=>f.topic==='farm.settled'&&f.day===date&&f.sourceIds.includes(target.eventId))??[];
  if(facts.length!==1||!facts[0].valid)throw Error('日结关联知识缺失或已失效');
  target.payload=after;
  facts[0].value=description;
  facts[0].data=Object.fromEntries(Object.entries(after).filter(([key])=>!['description','sourceIds'].includes(key)));
  facts[0].sourceIds=[target.eventId,...sourceIds];
  crop.growth=growth;
  if(growth===3&&oldGrowth<3){
    // A crop that ripened at the previous boundary cannot take today's damage or care.
    crop.dayLoss=0;crop.rain=0;crop.waters=0;crop.careCompleted=0;crop.daySources=[];
  }
  const stamp=new Date(now).toISOString();
  draft.life.events.push({eventId:auditId,petId:draft.petId,type:'farm.settlement.repaired',source:'user-authorized-offline-repair',
    occurredAt:stamp,receivedAt:stamp,evidenceLevel:'observed',payload:{date,seasonId:crop.id,before,after,
      growthBefore:oldGrowth,growthAfter:growth,sourceIds:[target.eventId,...sourceIds],description:`修正 ${date} 的雨水照料计数及日结。`}});
  return {updated:true,date,manual,rain,careProgress,qualified,growthBefore:oldGrowth,growthAfter:growth};
}
