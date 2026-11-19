import test from 'node:test';
import assert from 'node:assert/strict';
import {COOKING_MS,canConsiderCooking,cookerFacts,createRiceCooker,settleCooking,startCooking} from '../dist/host/rice-cooker.js';
import {availableRice,validateRiceMeal} from '../dist/host/rice-inventory.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';

function fixture() {
  let now=Date.now(), state={
    petId:'main',version:0,
    legacy:{farm:{rawBowls:8},services:{inventory:[]},config:{costs:{feed:20}},wallet:{balance:100}},
    humanity:{...createHumanity(),helperReady:true,restrained:false,sleeping:false},
    life:{actions:[],events:[],memories:[],commitments:[],invalidSources:{},constraints:{paused:false,capabilities:[{name:'service.buy-rice',enabled:true}]}}
  };
  const reader={loadEnvelope:async()=>structuredClone(state)};
  const gate={signal:new AbortController().signal,run:async(_id,operation)=>operation()};
  const uow={apply:async(_id,version,change)=>{
    assert.equal(state.version,version);
    const draft=structuredClone(state);
    change(draft);
    draft.version++;
    state=draft;
    return structuredClone(state);
  }};
  const newHost=()=>createRiceCooker(reader,gate,uow,()=>now);
  return {state:()=>state,reader,gate,uow,newHost,now:()=>now,advance:delta=>{now+=delta;}};
}

test('old save, bounds, exact deadline, and restart settle a batch once',async()=>{
  const f=fixture(), firstHost=f.newHost(), snapshot=()=>({action:'snapshot'});
  assert.deepEqual((await firstHost.helper('main',snapshot())).availableIds,[]);
  assert.throws(()=>startCooking(f.state(),'oversize',7,f.now()),/碗数/);
  assert.throws(()=>startCooking(f.state(),'fraction',1.5,f.now()),/碗数/);
  startCooking(f.state(),'batch-1',3,f.now());
  assert.equal(f.state().legacy.farm.rawBowls,5);
  assert.equal(f.state().legacy.wallet.balance,100);
  assert.throws(()=>startCooking(f.state(),'extra',2,f.now()),/碗数/);
  f.advance(COOKING_MS-1);
  assert.equal((await firstHost.helper('main',snapshot())).remaining,0);
  f.advance(1);
  const newHost=f.newHost();
  const ready=await newHost.helper('main',snapshot());
  assert.equal(ready.batch,null);
  assert.equal(ready.remaining,3);
  assert.deepEqual((await firstHost.helper('main',snapshot())).availableIds,ready.availableIds);
  assert.equal(f.state().life.events.filter(event=>event.type==='rice.ready').length,1);
});

test('reminder asks for a decision even with two fridge bowls and survives a restart',async()=>{
  const f=fixture(), host=f.newHost();
  f.state().legacy.services.inventory=[{id:'fridge-a',status:'available'},{id:'fridge-b',status:'available'}];
  assert.equal(canConsiderCooking(f.state()),false);
  const request={action:'remind',requestId:'reminder-1'};
  const waiting=await host.helper('main',request);
  assert.equal(canConsiderCooking(f.state()),true);
  assert.equal((await f.newHost().helper('main',request)).reminderId,waiting.reminderId);
  assert.equal(f.state().life.events.filter(event=>event.type==='rice.reminded').length,1);
  startCooking(f.state(),'batch-2',2,f.now());
  assert.equal(cookerFacts(f.state()).reminderId,null);
});

test('stale take cannot touch a reserved bowl; retry, memory and replies share the same event',async()=>{
  const f=fixture(), host=f.newHost();
  startCooking(f.state(),'batch-3',3,f.now());
  f.advance(COOKING_MS);
  const initial=await host.helper('main',{action:'snapshot'});
  const [eating,...others]=initial.availableIds;
  f.state().life.actions.push({actionType:'service.eat-rice',status:'PENDING',parameters:{itemId:eating}});
  assert.equal(cookerFacts(f.state()).reserved,1);
  await assert.rejects(host.helper('main',{action:'take',requestId:'editor-stale',bowls:2,expectedIds:initial.availableIds}),/确认碗数/);
  const request={action:'take',requestId:'taking-123',bowls:2,expectedIds:others};
  const taken=await host.helper('main',request);
  assert.equal(taken.remaining,1);
  assert.equal(taken.availableIds.length,0);
  assert.deepEqual(await host.helper('main',request),taken);
  assert.throws(()=>validateRiceMeal(f.state(),others[0]),/锅饭已不可用/);
  assert.doesNotThrow(()=>validateRiceMeal(f.state(),eating));
  const [reply]=taken.replies;
  assert.deepEqual(reply,{id:'rice-taken:taking-123',bowls:2,remaining:1});
  assert.equal(f.state().life.events.find(event=>event.eventId===reply.id).actorId,'dad');
  assert.equal(f.state().life.memories.filter(memory=>memory.sourceIds.includes(reply.id)).length,1);
  const reconnect=f.newHost();
  assert.deepEqual((await reconnect.helper('main',{action:'snapshot'})).replies,[reply]);
  assert.deepEqual((await reconnect.helper('main',{action:'ack',requestId:reply.id})).replies,[]);
});

test('only a real completed eating receipt consumes the cooked bowl and increases satiety',()=>{
  const f=fixture(), state=f.state();
  state.humanity.stats.satiety=20;
  state.legacy.services.inventory=[{id:'fridge-a',status:'available'}];
  startCooking(state,'batch-4',1,f.now()-COOKING_MS);
  settleCooking(state,f.now());
  const [bowl,fridge]=availableRice(state);
  assert.equal(bowl.source,'cooker');
  assert.equal(fridge.source,'fridge');
  const intent={id:'meal-4',type:'service.eat-rice',payload:{parameters:{itemId:bowl.id}}};
  const at=new Date(f.now()).toISOString();
  projectOutcome(state,intent,{status:'cancelled',evidence:{}},at,'source');
  assert.equal(state.humanity.stats.satiety,20);
  assert.equal(cookerFacts(state).remaining,1);
  assert.throws(()=>projectOutcome(state,intent,{status:'completed',evidence:{
    actionId:intent.id,kind:intent.type,confirmed:true,itemId:bowl.id,played:false}},at,'source'),/吃饭回执/);
  projectOutcome(state,intent,{status:'completed',evidence:{
    actionId:intent.id,kind:intent.type,confirmed:true,itemId:bowl.id,played:true}},at,'source');
  assert(state.humanity.stats.satiety>20);
  assert.equal(cookerFacts(state).remaining,0);
  assert.deepEqual(availableRice(state).map(item=>item.id),['fridge-a']);
});

test('an uncooked batch and hunger do not trigger a separate rule-driven purchase',async()=>{
  const f=fixture(), state=f.state(), orders=[];
  state.humanity.stats.satiety=15;
  startCooking(state,'batch-5',2,f.now());
  const life=createDeterministicLife({get:async()=>state.humanity},f.reader,async(_id,input)=>orders.push(input.command),
    f.gate,f.uow,{}, {},async()=>{});
  await life.run('main',f.gate.signal,{allowAutonomous:true});
  assert.deepEqual(orders,[]);
  assert.equal(cookerFacts(state).batch.id,'batch-5');
});
