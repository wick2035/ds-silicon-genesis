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
  const legacy=old.read('main');legacy.labor={contracts:[{id:'work',status:'queued',done:2,trips:5,workPermit:false}]};legacy.services||={};legacy.worksite={inside:false,forced:false};
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

test('a newly queued task does not automatically start its first trip',async()=>{
  const f=fixture('');let dispatched=0;
  const life=createDeterministicLife({get:async()=>structuredClone(f.get().humanity)},f.store,async()=>{},f.gate,f.uow,{}, {dispatch:async()=>{dispatched++;}},async()=>{});
  await life.run('main',new AbortController().signal,{allowAutonomous:true});
  assert.equal(f.get().legacy.labor.contracts[0].workPermit,false);
  assert.equal(f.get().legacy.labor.contracts[0].done,2);
  assert.equal(f.get().legacy.worksite.requested,undefined);
  assert.equal(dispatched,0);
});

test('an unverified claim of entry is not published as completed',async()=>{
  const f=fixture('那我进去了，爸爸。等会儿记得看我搬完。');const now=new Date().toISOString();
  f.get().life.events.push({eventId:'old-user',petId:'main',type:'conversation.user',source:'qq-c2c',actorId:'dad',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{text:'你先搬砖'}});
  await assert.rejects(f.chat.turn({requestId:'contextual-entry',petId:'main',channel:'qq-c2c',actorId:'dad',text:'可以 那你自己进去'},new AbortController().signal));
  assert.equal(f.get().legacy.worksite.requested,undefined);assert.equal(f.get().legacy.labor.contracts[0].workPermit,false);
});

test('an unmarked clear promise to work now starts the existing contract, but a deferred promise does not',async()=>{
  for(const [reply,willing] of [['看就看，我这就去搬一块，不嘴上说说。',true],['我现在就动身去工地，你不能笑我。',true],['愿意啊，精神好了我就去试一趟。不过说好啊，搬完一块我可得吃饭。',true],['我现在就去工地，不过得先喝口水。',false],['我先休息，等我好了再去搬砖。',false],['我现在不去搬，太累了。',false]]){
    const f=fixture(reply);await f.chat.turn({requestId:'plain-'+willing+reply.length,petId:'main',channel:'desktop',actorId:'dad',text:'你说你会搬砖，可以搬一个我看看嘛？'},new AbortController().signal);
    assert.equal(f.get().legacy.worksite.requested===true,willing);
  }
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

test('refusal and total exhaustion do not create a worksite entry',async()=>{
  for(const [reply,tired] of [['我想休息。',false],['我去搬一趟。\n[愿意去工地]',true]]){
    const f=fixture(reply,{tired});if(tired){Object.assign(f.get().humanity.stats,{stamina:0,energy:0,satiety:0});f.get().life.spirit={value:0,updatedAt:Date.now(),awakeSince:Date.now(),lastSleepHours:0,mode:'awake',config:{sleepHours:8,awakeHours:14,hourlyDrain:2,napPerHour:6,sweetGain:8,sweetCooldownHours:4}};}const turn=f.chat.turn({requestId:'rest-'+tired,petId:'main',channel:'desktop',actorId:'dad',text:'你想去工地吗？'},new AbortController().signal);
    const answer=await turn;if(tired){assert.match(answer,/不允许开工/);assert.doesNotMatch(answer,/我去搬一趟/);}
    assert.equal(f.get().legacy.labor.contracts[0].status,'queued');assert.equal(f.get().legacy.worksite.requested,undefined);
  }
});

test('an old unknown meal is not replayed and does not block an independent worksite decision',async()=>{
  const f=fixture('');const s=f.get();s.legacy.labor.contracts[0].status='working';s.legacy.labor.contracts[0].workPermit=true;
  s.legacy.services.inventory=[{status:'available'}];s.humanity.stats.satiety=10;s.life.actions.push({actionType:'service.eat-rice',status:'UNKNOWN'});
  let meals=0;const life=createDeterministicLife({get:async()=>structuredClone(f.get().humanity)},f.store,async()=>{meals++;},f.gate,f.uow,{}, {},async()=>{});
  await life.run('main',new AbortController().signal,{allowAutonomous:true});
  assert.equal(meals,0);assert.equal(f.get().legacy.worksite.requested,true);assert.equal(f.get().life.actions[0].status,'UNKNOWN');
});

test('paused task blocks the queued task even if she suggests working',async()=>{
  const f=fixture('好，我自己去搬一趟。');const first=f.get().legacy.labor.contracts[0];first.status='paused';
  f.get().legacy.labor.contracts.push({id:'next',status:'queued',done:0,trips:4,workPermit:false});
  await f.chat.turn({requestId:'paused-block',petId:'main',channel:'desktop',actorId:'dad',text:'想搬吗？'},new AbortController().signal);
  assert.equal(f.get().legacy.labor.contracts[0].status,'paused');assert.equal(f.get().legacy.labor.contracts[1].workPermit,false);
});

test('聊天谈论任务不创建提案或直接改动任务',async()=>{
  const f=fixture('好，我们可以再说说。');
  await f.chat.turn({requestId:'normal-labor-chat',petId:'main',channel:'desktop',actorId:'dad',text:'搬十趟，给你一百工钱，好吗？'},new AbortController().signal);
  assert.equal(f.get().legacy.labor.contracts.length,1);assert.equal(f.get().legacy.labor.contracts[0].trips,5);assert.equal(f.get().legacy.chatLaborProposals,undefined);
});
