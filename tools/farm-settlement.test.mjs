import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceFarm,changeFarmWeather,completeFarmOperation,farmFacts} from '../dist/host/farm.js';
import {repairFarmSettlement} from '../dist/host/farm-settlement-repair.js';

const at=(day,time='08:00:00')=>Date.parse(`2026-11-${day}T${time}+08:00`);
function fixture(weather='sunny'){
  const state={petId:'main',version:0,legacy:{farmSeedBundles:24,wallet:{balance:100}},humanity:{},
    life:{events:[],memories:[],invalidSources:{}}};
  advanceFarm(state,at(19),'fixed');
  changeFarmWeather(state,weather,at(19));
  completeFarmOperation(state,{operation:'plant'},'season',at(19,'18:28:48'));
  return state;
}
const settlement=state=>state.life.events.find(e=>e.type==='farm.settled');
function oldArchive(){
  const state=fixture('light-rain');
  assert.equal(state.life.events.find(e=>e.type==='farm.weather'&&e.payload.weather==='light-rain').payload.water,0);
  completeFarmOperation(state,{operation:'fertilize'},'manual',at(19,'18:59:39'));
  advanceFarm(state,at(20));
  const event=settlement(state);
  event.payload.qualified=false;
  delete event.payload.rain;delete event.payload.careProgress;
  event.payload.description='当天农活未达标，水稻未推进生长。';
  const fact=state.life.worldModel.facts.find(f=>f.topic==='farm.settled');
  fact.value=event.payload.description;fact.data.qualified=false;delete fact.data.rain;delete fact.data.careProgress;
  state.legacy.farm.crop.growth=0;
  return state;
}

test('23:59整分钟仍计入当天，零点才归档且重复补算不重复生长',()=>{
  const state=fixture(),last=at(19,'23:59:59.999');
  completeFarmOperation(state,{operation:'water'},'first',at(19,'19:59:59.999'));
  advanceFarm(state,last);
  assert.equal(settlement(state),undefined);
  completeFarmOperation(state,{operation:'water'},'last',last);
  assert.equal(farmFacts(state,last).careProgress,2);
  assert.equal(farmFacts(state,last).growth,0);
  advanceFarm(state,at(20,'00:00:00'));
  assert.equal(settlement(state).payload.date,'2026-11-19');
  assert.equal(settlement(state).payload.qualified,true);
  assert.equal(farmFacts(state,at(20)).growth,1);
  advanceFarm(state,at(20));
  assert.equal(state.life.events.filter(e=>e.type==='farm.settled').length,1);
});

test('小雨加一次人工达标，人工冷却不因下雨重置',()=>{
  const state=fixture();
  completeFarmOperation(state,{operation:'water'},'manual',at(19,'19:00:00'));
  const lastCareAt=state.legacy.farm.crop.lastCareAt;
  changeFarmWeather(state,'light-rain',at(19,'20:00:00'));
  assert.equal(farmFacts(state,at(19,'20:00:00')).careProgress,2);
  assert.equal(farmFacts(state,at(19,'20:00:00')).careCompleted,1);
  assert.equal(state.legacy.farm.crop.lastCareAt,lastCareAt);
  assert.equal(farmFacts(state,at(19,'20:00:00')).operation,null);
  advanceFarm(state,at(20));
  assert.deepEqual([settlement(state).payload.careCompleted,settlement(state).payload.rain,settlement(state).payload.careProgress],[1,1,2]);
});

test('雨中播种记下雨水，小雨重复切换不累加，大雨独立达标',()=>{
  const state=fixture('light-rain');
  assert.equal(farmFacts(state,at(19,'18:29:00')).careProgress,1);
  assert.equal(state.life.events.find(e=>e.type==='farm.tended').payload.rain,1);
  changeFarmWeather(state,'sunny',at(19,'19:00:00'));
  changeFarmWeather(state,'light-rain',at(19,'20:00:00'));
  assert.equal(farmFacts(state,at(19,'20:00:00')).rain,1);
  changeFarmWeather(state,'heavy-rain',at(19,'21:00:00'));
  assert.equal(farmFacts(state,at(19,'21:00:00')).careProgress,2);
  assert.equal(farmFacts(state,at(19,'21:00:00')).careCompleted,0);
  advanceFarm(state,at(20));
  assert.equal(settlement(state).payload.rain,2);
  assert.equal(settlement(state).payload.qualified,true);
  assert.match(settlement(state).payload.description,/人工照料 0 次，雨水补给 2 次/);
  changeFarmWeather(state,'sunny',at(20));
  assert.equal(farmFacts(state,at(20)).careProgress,0);
});

test('雨水即使没有增加已满水量也保留其照料来源和记忆',()=>{
  const state=fixture();
  completeFarmOperation(state,{operation:'water'},'first',at(19,'19:00:00'));
  completeFarmOperation(state,{operation:'water'},'second',at(19,'23:00:00'));
  changeFarmWeather(state,'light-rain',at(19,'23:30:00'));
  const event=state.life.events.at(-1);
  assert.equal(event.payload.water,0);
  assert.equal(event.payload.rain,1);
  assert.ok(state.legacy.farm.crop.daySources.includes(event.eventId));
  assert.ok(state.life.memories.some(m=>m.sourceIds.includes(event.eventId)));
});

test('昨日旧档按天气而非空田补水量修复，日结知识同步且重复执行无变化',()=>{
  const state=oldArchive(),wallet=structuredClone(state.legacy.wallet),humanity=structuredClone(state.humanity);
  const result=repairFarmSettlement(state,'2026-11-19',at(20));
  assert.deepEqual([result.manual,result.rain,result.careProgress,result.growthBefore,result.growthAfter],[1,1,2,0,1]);
  assert.equal(settlement(state).payload.qualified,true);
  const fact=state.life.worldModel.facts.find(f=>f.topic==='farm.settled');
  assert.equal(fact.data.rain,1);assert.equal(fact.data.qualified,true);
  assert.equal(fact.value,settlement(state).payload.description);
  assert.deepEqual(state.legacy.wallet,wallet);assert.deepEqual(state.humanity,humanity);
  const once=structuredClone(state);
  assert.equal(repairFarmSettlement(state,'2026-11-19',at(20)).alreadyApplied,true);
  assert.deepEqual(state,once);
});

test('播种前已结束的大雨不追溯计入当天新作物',()=>{
  const state=oldArchive();
  const weather=state.life.events.find(e=>e.type==='farm.weather'&&e.payload.weather==='light-rain');
  weather.payload.weather='sunny';
  state.life.events.unshift({...structuredClone(weather),eventId:'rain-before-plant',occurredAt:new Date(at(19,'07:00:00')).toISOString(),payload:{date:'2026-11-19',weather:'heavy-rain',water:0}});
  const result=repairFarmSettlement(state,'2026-11-19',at(20));
  assert.equal(result.rain,0);assert.equal(result.qualified,false);assert.equal(result.growthAfter,0);
});

test('证据失效、缺失、重复日结及尚未结束日期均拒绝修改',()=>{
  for(const alter of [
    s=>{s.life.invalidSources['farm-tended:manual']='已撤销';},
    s=>{s.life.events=s.life.events.filter(e=>e.eventId!=='farm-tended:manual');},
    s=>{s.life.events.push({...structuredClone(settlement(s)),eventId:'duplicate'});},
    s=>{s.legacy.farm.crop.growth=2;},
  ]){
    const state=oldArchive();alter(state);const before=structuredClone(state);
    assert.throws(()=>repairFarmSettlement(state,'2026-11-19',at(20)));
    assert.deepEqual(state,before);
  }
  assert.throws(()=>repairFarmSettlement(oldArchive(),'2026-11-20',at(20)),/已结束/);
});
