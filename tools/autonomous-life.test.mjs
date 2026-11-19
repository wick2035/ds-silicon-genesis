import test from 'node:test';
import assert from 'node:assert/strict';
import {PgBoss} from 'pg-boss';
import {LifeScheduler} from '../dist/scheduler/index.js';
import {createInitialState} from '../dist/kernel/index.js';
import {ensureSpirit,setSpiritRest} from '../dist/kernel/spirit.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {projectBody} from '../dist/host/body-projection.js';
import {legacyContext} from '../dist/host/legacy-context.js';
import {Cognition} from '../dist/cognition/index.js';
import {createCognitiveModel} from '../dist/host/cognitive-model.js';
import {CognitiveResultCoordinator} from '../dist/host/cognitive-result.js';
import {ActionCoordinator} from '../dist/host/action-coordinator.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';
import {createWorksite} from '../dist/host/worksite.js';
import {autonomousWorkTypes,createAutonomousWorkExecutors} from '../dist/host/autonomous-work.js';
import {autonomousContext,autonomousDecisionKey,repeatedAutonomousAction} from '../dist/host/autonomous-context.js';
import {validateActionParameters} from '../dist/host/action-parameters.js';

const empty={thought:null,action:null,goals:[],goalUpdates:[],plan:[],interests:[],selfModel:[]};
function fixture(){
 const at=new Date().toISOString(),life=createInitialState('main',at),humanity=createHumanity();
 humanity.stats.satiety=20;humanity.helperReady=true;humanity.restrained=false;
 life.constraints={paused:false,remainingBudget:18,permissions:['network'],capabilities:[
  ...[...autonomousWorkTypes,'labor.step','service.buy-rice','service.cook-rice','service.eat-rice','self.express'].map(name=>({name,enabled:true})),
  {name:'learning.observe',enabled:true,requiresPermission:'network'}]};
 life.events.push({eventId:'experience',petId:'main',type:'conversation.user',source:'desktop',actorId:'dad',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{text:'鲸鱼为什么会唱歌？'}});
 ensureSpirit(life);
 let state={petId:'main',version:0,life,humanity,legacy:{config:{learning:{dailyModelCalls:20},costs:{feed:20},networkLearning:true,exploration:{dailyRuns:10,dailySearches:20}},
  abilities:{search:{status:'granted'},fetch:{status:'granted'}},usage:{},wallet:{balance:100},services:{inventory:[]},worksite:{inside:false,forced:false},labor:{contracts:[]}}};
 const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},intents=new Map();
 const reader={loadEnvelope:async()=>structuredClone(state),load:async()=>({...structuredClone(state.life),petId:'main',version:state.version,...projectBody(state),legacyContext:legacyContext('大肥鱼')(state)})};
 const uow={apply:async(_id,v,fn)=>{assert.equal(v,state.version);const draft=structuredClone(state),result=fn(draft);draft.version++;state=draft;for(const intent of result?.intents??[])intents.set(intent.id,intent);return structuredClone(state);}};
 const worksite=createWorksite(reader,gate,uow,()=>null,()=>{});
 const executors=createAutonomousWorkExecutors(reader,{
  enter:async id=>{await worksite.act(id,'request-entry');await worksite.act(id,'enter-voluntary');},
  begin:id=>worksite.act(id,'resume-work',undefined,undefined,'scheduler'),
  stop:id=>worksite.act(id,'stop-work',undefined,undefined,'scheduler'),
  leave:id=>worksite.act(id,'leave-voluntary'),
 });
 for(const type of ['service.buy-rice','service.cook-rice','service.eat-rice','self.express','learning.observe'])executors.set(type,async(_id,intent)=>({status:'completed',evidence:{actionId:intent.id,kind:type,confirmed:true,
  ...(type==='service.eat-rice'?{itemId:intent.payload.parameters.itemId,played:true}:{}),
  ...(type==='learning.observe'?{documentUrl:'https://example.test/whales',content:'座头鲸会唱歌，研究者用水听器记录它们的交流。'}:{})}}));
 const lifecycle=new CanonicalActionLifecycle(projectBody),dispatched=[];
 const dispatcher={hasExecutor:type=>executors.has(type),dispatch:async id=>{
  const intent=intents.get(id);let prepared;
  await uow.apply('main',state.version,draft=>{prepared=lifecycle.prepare(draft,intent);return {};});
  assert.equal(prepared.allowed,true,prepared.reason);dispatched.push(intent.type);
  const receipt=await executors.get(intent.type)('main',intent,gate.signal);
  await uow.apply('main',state.version,draft=>{lifecycle.complete(draft,intent,receipt);return {};});return receipt;
 }};
 const actions=new ActionCoordinator(uow,projectBody),coordinator=new CognitiveResultCoordinator(reader,uow,gate,projectBody,actions,dispatcher);
 let serial=0;
 const accept=async(type,parameters={},extra={})=>{
  const id='autonomy:'+ ++serial;
  await coordinator.accept('main',{status:'proposed',sourceVersion:state.version,
   proposal:type?{id,petId:'main',actionType:type,parameters,priority:50,interruptPolicy:'safe-point',requiredCapabilities:[type],sourceIds:['experience'],expectedStateVersion:state.version}:null,
   candidates:structuredClone(empty),...extra},gate.signal);
  return state.life.actions.find(a=>a.id===id);
 };
 return {get state(){return state;},gate,reader,uow,actions,dispatcher,coordinator,executors,dispatched,accept};
}

test('comprehensive turns receive real opportunities and can choose learning despite hunger',async()=>{
 const f=fixture();f.state.legacy.wallet.balance=0;f.state.legacy.riceCooker={cooked:[],pendingReplies:[],reminderId:'reminder'};
 let requests=0;
 const model=createCognitiveModel({async *stream(input){
  requests++;const snapshot=JSON.parse(input.messages[0].content).当前;
  assert.equal(snapshot.legacyContext.companion.food.hunger,80);
  assert.equal(snapshot.legacyContext.autonomy.activities.learning.available,true);
  assert.equal(snapshot.legacyContext.autonomy.cookerReminderId,'reminder');
  assert.match(input.system,/综合自主决策/);
  yield {type:'text',text:JSON.stringify({...empty,action:{actionType:'learning.observe',parameters:{kind:'search',query:'座头鲸唱歌'},priority:50,interruptPolicy:'safe-point',requiredCapabilities:['learning.observe'],sourceIds:['experience']}})};
 }},()=>({provider:'test',model:'test'}));
 const cognition=new Cognition(model,{reserve:async()=>({}),withReserved:async(_id,_ticket,fn)=>fn()},
  {forCognition:async()=>[],world:async()=>({space:{},inventory:[],capabilities:[],recentResults:[]})});
 const result=await cognition.propose(await f.reader.load(),f.gate.signal,()=>f.reader.load());
 assert.equal(result.status,'proposed');assert.equal(requests,1);
 await f.coordinator.accept('main',result,f.gate.signal);
 assert.deepEqual(f.dispatched,['learning.observe']);assert.equal(f.state.legacy.riceCooker.reminderId,undefined);
 assert.equal(f.state.life.memories.some(m=>m.id.startsWith('knowledge:')),true);
});

test('deterministic upkeep never buys or eats, whether hungry or stocked',async()=>{
 for(const stocked of [false,true]){
  const f=fixture();if(stocked)f.state.legacy.services.inventory.push({id:'rice',status:'available'});
  const calls=[];
  const deterministic=createDeterministicLife({get:async()=>structuredClone(f.state.humanity)},f.reader,async(_id,input)=>calls.push(input),f.gate,f.uow,f.actions,f.dispatcher,async()=>{});
  await deterministic.run('main',f.gate.signal,{allowAutonomous:true});assert.deepEqual(calls,[]);
  assert.equal(f.state.legacy.services.inventory.length,stocked?1:0);
 }
});

test('food decisions use actual purchase and cooking receipts in comprehensive turns',async()=>{
 const f=fixture();await f.accept('service.buy-rice');
 assert.equal(f.state.legacy.wallet.balance,80);const bowl=f.state.legacy.services.inventory[0];
 await f.accept('service.eat-rice',{itemId:bowl.id});
 assert.equal(f.state.legacy.services.inventory[0].status,'eaten');assert.ok(f.state.humanity.stats.satiety>20);
 const g=fixture();g.state.humanity.stats.satiety=80;g.state.legacy.farm={rawBowls:5,day:{date:'2026-01-01',weather:'sunny'},crop:null};
 await g.accept('service.cook-rice',{bowls:3});
 assert.equal(g.state.legacy.riceCooker.batch.bowls,3);assert.equal(g.state.legacy.farm.rawBowls,2);assert.equal(g.state.humanity.stats.satiety,80);
});

test('autonomy enters, stops, resumes and leaves work using confirmed state and self attribution',async()=>{
 const f=fixture();
 for(const type of ['work.enter','work.stop','work.begin','work.leave'])assert.equal((await f.accept(type)).status,'COMPLETED');
 assert.deepEqual(f.dispatched,['work.enter','work.stop','work.begin','work.leave']);
 assert.equal(f.state.legacy.worksite.inside,false);assert.deepEqual(f.state.legacy.labor.contracts,[]);
 const resumed=f.state.life.events.find(e=>e.type==='interaction.worksite'&&e.payload.action==='resume-work');
 assert.equal(resumed.source,'scheduler');assert.equal(resumed.actorId,undefined);
 for(const type of autonomousWorkTypes)assert.throws(()=>validateActionParameters(type,{forced:true}),/未知参数/);
});

test('entry requests without helper confirmation stay unknown; revoked work grants cannot execute',async()=>{
 const f=fixture();const executors=createAutonomousWorkExecutors(f.reader,{enter:async()=>{},begin:async()=>{},stop:async()=>{},leave:async()=>{}});
 const receipt=await executors.get('work.enter')('main',{id:'entry',type:'work.enter',payload:{}},f.gate.signal);
 assert.equal(receipt.status,'unknown');assert.equal(receipt.evidence.confirmed,false);
 f.state.life.constraints.capabilities.find(c=>c.name==='work.enter').enabled=false;
 await assert.rejects(f.accept('work.enter'),/Capability unavailable/);assert.deepEqual(f.dispatched,[]);
 await assert.rejects(executors.get('work.enter')('main',{id:'entry',type:'work.enter',payload:{}},f.gate.signal),/能力未启用/);
 f.state.life.constraints.paused=true;await assert.rejects(f.accept('work.enter'),/暂停|过期/);
});

test('same failed purchase and completed search are suppressed until relevant conditions change',async()=>{
 const f=fixture();f.state.legacy.wallet.balance=0;
 assert.equal((await f.accept('service.buy-rice')).status,'CANCELLED');
 f.state.humanity.stats.satiety=2;
 assert.equal((await f.accept('service.buy-rice')).status,'CANCELLED');assert.deepEqual(f.dispatched,[]);
 assert.match(f.state.life.events.at(-1).payload.reason,/相同条件/);
 f.state.legacy.wallet.balance=40;
 assert.equal((await f.accept('service.buy-rice')).status,'COMPLETED');
 const query={kind:'search',query:'座头鲸唱歌'};
 assert.equal((await f.accept('learning.observe',query)).status,'COMPLETED');
 assert.equal(repeatedAutonomousAction(f.state,'learning.observe',query),true);
 assert.equal((await f.accept('learning.observe',query)).status,'CANCELLED');
 assert.equal(repeatedAutonomousAction(f.state,'learning.observe',{kind:'fetch',query:'座头鲸唱歌',url:'https://example.test/whales'}),false);
 const first=autonomousDecisionKey(f.state,'learning.observe',query,Date.parse('2026-11-19T15:59:59Z'));
 assert.notEqual(first,autonomousDecisionKey(f.state,'learning.observe',query,Date.parse('2026-11-19T16:00:00Z')));
});

test('entry waits for the helper and cancels its own unconfirmed request on abort',async t=>{
 for(const abort of [false,true]){
  const f=fixture(),controller=new AbortController();let timer,cancelled=0;
  t.after(()=>clearTimeout(timer));
  const executors=createAutonomousWorkExecutors(f.reader,{
   enter:async()=>{
    f.state.legacy.worksite.requested=true;
    f.state.life.events.push({...f.state.life.events[0],eventId:'entry-request',type:'interaction.worksite',payload:{action:'request-entry'}});
    timer=setTimeout(()=>{if(abort)controller.abort();else f.state.legacy.worksite={inside:true,forced:false,requested:false};},5);
   },begin:async()=>{},stop:async()=>{},leave:async()=>{},
   cancelEntry:async(_id,requestId)=>{assert.equal(requestId,'entry-request');if(!f.state.legacy.worksite.inside){f.state.legacy.worksite.requested=false;cancelled++;}},
  },200);
  const execute=executors.get('work.enter')('main',{id:'entry',type:'work.enter',payload:{}},controller.signal);
  if(abort){await assert.rejects(execute);assert.equal(cancelled,1);assert.equal(f.state.legacy.worksite.inside,false);}
  else{assert.equal((await execute).status,'completed');assert.equal(cancelled,0);}
 }
});

test('new owner replies allow reconsideration; old food polling state never owns a conversation',async()=>{
 const f=fixture();await f.accept('self.express',{text:'爸爸，我想借点饭钱。'});
 assert.equal(repeatedAutonomousAction(f.state,'self.express',{text:'爸爸，我想借点饭钱。'}),true);
 f.state.life.events.push({...f.state.life.events[0],eventId:'new-reply'});
 assert.equal(repeatedAutonomousAction(f.state,'self.express',{text:'爸爸，我想借点饭钱。'}),false);
 f.state.legacy.autonomousNeeds={status:'running',at:Date.now()};
 assert.equal(await f.coordinator.claimCognition('main',300,f.gate.signal),true);
 assert.equal(await f.coordinator.claimCognition('main',300,f.gate.signal),false);
});

test('sleep, active conversations and live physical actions block another model turn',async()=>{
 for(const block of [f=>{f.state.humanity.sleeping=true;},f=>{setSpiritRest(f.state.life,'sleep');},
  f=>{f.state.legacy.chatTurns={one:{status:'running',at:Date.now()}};},
  f=>{f.state.life.actions.push({actionType:'service.eat-rice',status:'DISPATCHED'});}]){
  const f=fixture();block(f);assert.equal(await f.coordinator.claimCognition('main',300,f.gate.signal),false);
 }
 const f=fixture();f.state.legacy.worksite={inside:true,forced:false};f.state.life.actions.push({actionType:'labor.step',status:'DISPATCHED'});
 assert.equal(await f.coordinator.claimCognition('main',300,f.gate.signal),true);
});

test('an older decision cannot consume a newer cooking reminder',async()=>{
 const f=fixture();f.state.legacy.riceCooker={cooked:[],pendingReplies:[],reminderId:'new'};
 await f.accept(null,{}, {observedCookerReminderId:'old'});assert.equal(f.state.legacy.riceCooker.reminderId,'new');
 await f.accept(null,{}, {observedCookerReminderId:'new'});assert.equal(f.state.legacy.riceCooker.reminderId,undefined);
 assert.equal(autonomousContext(f.state).activities.expression.available,true);
});

test('scheduler wakes comprehensive cognition without hunger or desktop idleness and shares reminder throttling',async t=>{
 let wake;const sends=[];
 for(const [name,method] of Object.entries({start:async()=>{},stop:async()=>{},createQueue:async()=>{},getQueue:async()=>({policy:'exclusive'}),work:async(_name,handler)=>{wake=handler;},send:async(...args)=>{sends.push(args);}}))t.mock.method(PgBoss.prototype,name,method);
 const f=fixture();f.state.humanity.stats.satiety=90;
 let calls=0,claims=0;
 const scheduler=new LifeScheduler({getState:()=>f.reader.load()},{propose:async()=>{calls++;return {status:'proposed',proposal:null,candidates:empty};}},
  {connectionString:'postgresql://localhost/unused',petId:'main',intervalSeconds:60,cognitiveIntervalSeconds:300,signal:f.gate.signal,
   idle:{snapshot:()=>({seconds:0,generation:1})},assertExclusive:async()=>{},
   wakeCoordinator:{claim:async()=>({cursor:'1',changed:false}),finish:async()=>{},release:async()=>{}},
   deterministic:{run:async(_id,_signal,options)=>assert.deepEqual(options,{allowAutonomous:true})},
   resultCoordinator:{resume:async()=>false,claimCognition:async(...args)=>{claims++;return f.coordinator.claimCognition(...args);},accept:async()=>{}}});
 try{
  await scheduler.start();await wake([{data:{petId:'main'}}]);assert.equal(calls,1);
  await Promise.all([scheduler.requestWake('main'),scheduler.requestWake('main')]);assert.equal(sends.length,2);
  await wake([{data:{petId:'main'}}]);assert.equal(claims,2);assert.equal(calls,1);
 }finally{await scheduler.stop();}
});

test('an interrupted idle walk still preserves thoughts and goal updates',async t=>{
 let wake;
 for(const [name,method] of Object.entries({start:async()=>{},stop:async()=>{},createQueue:async()=>{},getQueue:async()=>({policy:'exclusive'}),work:async(_name,handler)=>{wake=handler;},send:async()=>{}}))t.mock.method(PgBoss.prototype,name,method);
 const f=fixture(),accepted=[];let idle={seconds:130,generation:1};
 const candidates={...empty,thought:{text:'记起来了'},goals:[{title:'新念想'}],goalUpdates:[{goalId:'old',kind:'understood'}]};
 const scheduler=new LifeScheduler({getState:()=>f.reader.load()},{propose:async()=>{idle={seconds:0,generation:2};return {status:'proposed',proposal:{actionType:'body.activity'},candidates};}},
  {connectionString:'postgresql://localhost/unused',petId:'main',intervalSeconds:60,signal:f.gate.signal,idle:{snapshot:()=>idle},assertExclusive:async()=>{},
   wakeCoordinator:{claim:async()=>({cursor:'1',changed:false}),finish:async()=>{},release:async()=>{}},deterministic:{run:async()=>{}},
   resultCoordinator:{resume:async()=>false,claimCognition:async()=>true,accept:async(_id,result)=>accepted.push(result)}});
 try{await scheduler.start();await wake([{data:{petId:'main'}}]);assert.equal(accepted[0].proposal,null);assert.deepEqual(accepted[0].candidates,candidates);}finally{await scheduler.stop();}
});
