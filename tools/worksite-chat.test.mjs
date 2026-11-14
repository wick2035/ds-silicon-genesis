import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';
import {createWorksite} from '../dist/host/worksite.js';
import {ActionCoordinator} from '../dist/host/action-coordinator.js';
import {projectBody} from '../dist/host/body-projection.js';

function fixture(reply,options={}){
  const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
  const legacy=old.read('main');legacy.labor={contracts:[{id:'work',status:'paused',done:2,trips:5,workPermit:false}]};legacy.services||={};legacy.worksite={inside:false,forced:false};
  const human=createHumanity();human.helperReady=true;human.restrained=false;if(options.tired)human.stats.energy=10;
  let envelope={petId:'main',version:0,legacy,humanity:human,life:{events:[],invalidSources:{},relationships:[],constraints:{permissions:[],capabilities:[{name:'labor.step',enabled:true,physical:true}],paused:false},memories:[],commitments:[],actions:[],receipts:[],legacyContext:{personaDescription:'test',labor:legacy.labor.contracts[0]},body:{},emotions:{}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(envelope),load:async()=>structuredClone(envelope.life)};
  const uow={apply:async(_id,version,change)=>{assert.equal(version,envelope.version);const draft=structuredClone(envelope);change(draft);draft.version++;envelope=draft;}};
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(){yield {type:'text',text:reply};}}};
  const chat=new CanonicalChat(store,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[]);
  return {chat,store,gate,uow,get:()=>envelope};
}

test('her voluntary chat decision resumes one trip and requests the worksite',async()=>{
  const f=fixture('好，我自己去搬一趟。\n[愿意去工地]');
  const reply=await f.chat.turn({requestId:'voluntary',petId:'main',channel:'desktop',actorId:'dad',text:'你想去工地吗？'},new AbortController().signal);
  const s=f.get(),c=s.legacy.labor.contracts[0];assert.doesNotMatch(reply,/愿意去工地/);
  assert.equal(c.status,'working');assert.equal(c.workPermit,true);assert.equal(c.batchRemaining,1);assert.equal(c.done,2);
  assert.equal(s.legacy.worksite.requested,true);assert.equal(s.life.events.find(e=>e.eventId===c.workDecisionEvent).payload.choice,'work');
});

test('the voluntary chat decision enters the page and dispatches a web labor step',async()=>{
  const f=fixture('好，我去搬一趟。\n[愿意去工地]');let dispatched,awakened;
  const actions=new ActionCoordinator(f.uow,projectBody);
  const dispatcher={dispatch:async id=>{dispatched=id;return {status:'completed'};}};
  const life=createDeterministicLife({get:async()=>structuredClone(f.get().humanity)},f.store,async()=>{},f.gate,f.uow,actions,dispatcher,async()=>{});
  const site=createWorksite(f.store,f.gate,f.uow,()=>null,()=>{},()=>{awakened=life.run('main',new AbortController().signal,{allowAutonomous:true});});
  await f.chat.turn({requestId:'flow',petId:'main',channel:'desktop',actorId:'dad',text:'你想去工地吗？'},new AbortController().signal);
  await site.act('main','enter-voluntary');await awakened;
  assert.equal(f.get().legacy.worksite.inside,true);assert.equal(f.get().legacy.world.command.surface,'web');
  assert.equal(f.get().life.actions.find(a=>a.id===dispatched).actionType,'labor.step');assert.equal(f.get().legacy.labor.contracts[0].done,2);
});

test('refusal and insufficient energy do not create a worksite entry',async()=>{
  for(const [reply,tired] of [['我想休息。',false],['我去搬一趟。\n[愿意去工地]',true]]){
    const f=fixture(reply,{tired});const result=await f.chat.turn({requestId:'rest-'+tired,petId:'main',channel:'desktop',actorId:'dad',text:'你想去工地吗？'},new AbortController().signal);
    assert.equal(f.get().legacy.labor.contracts[0].status,'paused');assert.equal(f.get().legacy.worksite.requested,undefined);
    if(tired)assert.match(result,/不允许开工/);
  }
});

test('an old unknown meal is not replayed and does not block an independent worksite decision',async()=>{
  const f=fixture('');const s=f.get();s.legacy.labor.contracts[0].status='working';s.legacy.labor.contracts[0].workPermit=true;
  s.legacy.services.inventory=[{status:'available'}];s.humanity.stats.satiety=10;s.life.actions.push({actionType:'service.eat-rice',status:'UNKNOWN'});
  let meals=0;const life=createDeterministicLife({get:async()=>structuredClone(f.get().humanity)},f.store,async()=>{meals++;},f.gate,f.uow,{}, {},async()=>{});
  await life.run('main',new AbortController().signal,{allowAutonomous:true});
  assert.equal(meals,0);assert.equal(f.get().legacy.worksite.requested,true);assert.equal(f.get().life.actions[0].status,'UNKNOWN');
});
