import test from 'node:test';
import assert from 'node:assert/strict';
import {createFoodRequests,foodRequestPolicy} from '../dist/host/food-request.js';
import {DurableCognitiveBudget} from '../dist/host/cognitive-budget.js';
import {createEmbodiedSpeech} from '../dist/host/embodied-speech.js';
import {createInitialState} from '../dist/kernel/index.js';
import {ensureSpirit} from '../dist/kernel/spirit.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {projectBody} from '../dist/host/body-projection.js';
import {ActionCoordinator} from '../dist/host/action-coordinator.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {PgBoss} from 'pg-boss';
import {LifeScheduler} from '../dist/scheduler/index.js';

const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const tool=(name,input)=>({type:'tool-call-delta',index:0,id:'call',name,argumentsDelta:JSON.stringify(input)});
function fixture(script=async function*(){yield {type:'text',text:'爸，我肚子饿了，能给本鱼一碗饭吗？'};}) {
 let now=Date.now(),calls=0;
 const life=createInitialState('main',new Date(now).toISOString()),humanity=createHumanity(now);
 humanity.stats.satiety=20;humanity.helperReady=true;humanity.restrained=false;ensureSpirit(life);
 life.constraints={paused:false,remainingBudget:0,permissions:[],capabilities:['service.buy-rice','service.eat-rice','service.cook-rice','learning.observe'].map(name=>({name,enabled:true}))};
 let state={petId:'main',version:0,life,humanity,legacy:{usage:{},config:{learning:{dailyModelCalls:0},modelBudget:{interactiveDailyCalls:0},begging:{intervalMinutes:10,hourlyMax:4},costs:{feed:20}},wallet:{balance:0},services:{inventory:[]}}};
 let chain=Promise.resolve();const gate={signal:new AbortController().signal,run(_id,fn){const next=chain.then(fn);chain=next.catch(()=>{});return next;}};
 const intents=new Map(),reader={load:async()=>({...structuredClone(state.life),petId:'main',version:state.version,...projectBody(state)}),loadEnvelope:async()=>structuredClone(state)};
 const uow={apply:async(_id,v,fn)=>{assert.equal(v,state.version);const draft=structuredClone(state),result=fn(draft);draft.version++;state=draft;for(const intent of result?.intents??[])intents.set(intent.id,intent);return structuredClone(state);}};
 const budget=new DurableCognitiveBudget(reader,uow,gate),actions=new ActionCoordinator(uow,projectBody),lifecycle=new CanonicalActionLifecycle(projectBody),dispatched=[];
 const dispatcher={dispatch:async id=>{
  const intent=intents.get(id);let prepared;
  await uow.apply('main',state.version,draft=>{prepared=lifecycle.prepare(draft,intent);return {};});assert.equal(prepared.allowed,true,prepared.reason);
  dispatched.push(intent.type);
  await uow.apply('main',state.version,draft=>{lifecycle.complete(draft,intent,{status:'completed',evidence:{actionId:id,kind:intent.type,confirmed:true,...(intent.type==='service.eat-rice'?{itemId:intent.payload.parameters.itemId,played:true}:{})}});return {};});return {status:'completed'};
 }};
 const speech=createEmbodiedSpeech(reader,gate,uow,actions,dispatcher,async()=>assert.fail('work'),async()=>assert.fail('leave'));
 const llm=speech.wrap({async *stream(options){calls++;const release=await budget.reserve('test','test',options.signal);try{yield* script(options,calls,state);await release('completed');}catch(error){await release('failed');throw error;}}});
 const published=[],model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm};
 const create=()=>createFoodRequests(reader,gate,uow,budget,model,text=>published.push(text),()=>now),requests=create();
 return {get state(){return state;},get calls(){return calls;},get usage(){return state.legacy.usage[day()];},gate,reader,uow,budget,requests,create,published,dispatched,advance:ms=>{now+=ms;},run:signal=>requests.run('main',signal??gate.signal),policy:()=>foodRequestPolicy(state,now)};
}

test('hungry appeals use their own allowance even with zero daily/interactive quota and no money',async()=>{
 const f=fixture();await f.run();assert.equal(f.calls,1);assert.equal(f.published.length,1);
 assert.equal(f.usage.totalCalls,0);assert.equal(f.usage.modelCalls,0);assert.equal(f.usage.interactiveCalls,0);
 assert.equal(f.usage.foodRequestCalls,1);assert.equal(f.usage.foodRequestDetails[0].status,'completed');
 assert.equal(f.usage.callDetails,undefined);assert.equal(f.state.life.constraints.remainingBudget,0);
 assert.ok(f.state.life.events.some(e=>e.type==='conversation.assistant'&&e.payload.foodRequest));assert.deepEqual(f.dispatched,[]);
});

test('configured appeal interval and hourly maximum survive unanswered requests and restart',async()=>{
 const f=fixture();f.state.legacy.config.begging={intervalMinutes:20,hourlyMax:2};
 await f.run();f.advance(19*60000);await f.run();assert.equal(f.calls,1);
 f.advance(60000);await f.create().run('main',f.gate.signal);assert.equal(f.calls,2);
 f.advance(20*60000);await f.run();assert.equal(f.calls,2);
 f.advance(20*60000);await f.run();assert.equal(f.calls,3);
});

test('concurrent minute wakes produce one appeal, silence and failure also respect cooldown',async()=>{
 const f=fixture(async function*(){yield {type:'text',text:'<food-silent/>'};});
 await Promise.all([f.run(),f.run(),f.create().run('main',f.gate.signal)]);
 assert.equal(f.calls,1);assert.deepEqual(f.published,[]);assert.equal(f.usage.totalCalls,0);
 const g=fixture(async function*(){throw Error('model unavailable');});
 await assert.rejects(g.run(),/model unavailable/);await g.run();assert.equal(g.calls,1);
 assert.equal(g.usage.foodRequestDetails[0].status,'failed');assert.equal(g.usage.totalCalls,0);
});

test('pause, sleep, quiet requests, disabled limits and active chat suppress the food model',async()=>{
 for(const change of [s=>{s.life.constraints.paused=true;},s=>{s.humanity.sleeping=true;},s=>{s.legacy.growth={stopAt:1};},
  s=>{s.legacy.config.begging.hourlyMax=0;},s=>{s.legacy.config.autonomousPaused=true;},s=>{s.humanity.helperReady=false;},
  s=>{s.legacy.chatTurns={current:{status:'running',at:Date.now()}};}]){
  const f=fixture();change(f.state);await f.run();assert.equal(f.calls,0);assert.equal(f.usage,undefined);
 }
 const f=fixture(),signal=new AbortController();signal.abort();await f.run(signal.signal);assert.equal(f.calls,0);
});

test('food entry can purchase then eat the actual new bowl in one turn without daily quota',async()=>{
 const f=fixture(async function*(options,round,state){
  assert.deepEqual(options.tools?.find(t=>t.name==='act')?.inputSchema.properties.actionType.enum,['service.buy-rice','service.eat-rice','service.cook-rice']);
  assert.equal(options.tools?.some(t=>t.name==='begin_work'),false);
  if(round===1)yield tool('act',{actionType:'service.buy-rice',parameters:{}});
  else if(round===2){const result=JSON.parse(options.messages.at(-1).content).result;assert.equal(result.status,'COMPLETED');yield tool('act',{actionType:'service.eat-rice',parameters:{itemId:state.legacy.services.inventory[0].id}});}
  else yield {type:'text',text:'饭吃进去了，还没完全饱。'};
 });
 f.state.legacy.wallet.balance=40;await f.run();
 assert.deepEqual(f.dispatched,['service.buy-rice','service.eat-rice']);assert.equal(f.state.legacy.wallet.balance,20);
 assert.equal(f.state.legacy.services.inventory[0].status,'eaten');assert.ok(f.state.humanity.stats.satiety>20);
 assert.equal(f.usage.totalCalls,0);assert.equal(f.usage.foodRequestCalls,3);assert.equal(f.published.length,1);
});

test('food entry can proactively cook and settles only after its real twenty-minute batch',async()=>{
 const f=fixture(async function*(options,round){if(round===1)yield tool('act',{actionType:'service.cook-rice',parameters:{bowls:3}});else yield {type:'text',text:'我放了三碗生米，等饭煮熟。'};});
 f.state.humanity.stats.satiety=80;f.state.legacy.farm={rawBowls:5,day:{date:'2026-11-20',weather:'sunny'},crop:null};
 assert.equal(f.policy().eligible,true);await f.run();
 assert.deepEqual(f.dispatched,['service.cook-rice']);assert.equal(f.state.legacy.farm.rawBowls,2);
 assert.equal(f.state.legacy.riceCooker.batch.bowls,3);assert.deepEqual(f.state.legacy.riceCooker.cooked,[]);
 assert.equal(f.state.humanity.stats.satiety,80);assert.equal(f.usage.totalCalls,0);
});

test('food tools cannot execute unrelated learning or work even if the model invents a call',async()=>{
 for(const malicious of [tool('act',{actionType:'learning.observe',parameters:{kind:'search',query:'test'}}),tool('begin_work',{})]){
  const f=fixture(async function*(options,round){if(round===1)yield malicious;else {assert.match(options.messages.at(-1).content,/当前入口不允许/);yield {type:'text',text:'<food-silent/>'};}});
  await f.run();assert.deepEqual(f.dispatched,[]);assert.deepEqual(f.published,[]);
 }
});

test('a pause arriving during generation prevents publishing the late appeal',async()=>{
 const f=fixture(async function*(_options,_round,state){state.life.constraints.paused=true;yield {type:'text',text:'爸爸，给我一碗饭吗？'};});
 await f.run();assert.deepEqual(f.published,[]);assert.equal(f.usage.totalCalls,0);
});

test('unchanged failed purchases cannot retry through another food opportunity',async()=>{
 const f=fixture(async function*(options,round){if(round%2===1)yield tool('act',{actionType:'service.buy-rice',parameters:{}});else yield {type:'text',text:'爸，饭钱还不够。'};});
 await f.run();assert.equal(f.state.life.actions.length,1);assert.equal(f.state.life.actions[0].status,'CANCELLED');
 f.advance(10*60000);await f.run();assert.equal(f.state.life.actions.length,1);assert.deepEqual(f.dispatched,[]);
});

test('minute wake still runs independent food decisions after exhausted cognition; food failure does not stop the wake',async t=>{
 let wake;const order=[];
 for(const [name,method] of Object.entries({start:async()=>{},stop:async()=>{},createQueue:async()=>{},getQueue:async()=>({policy:'exclusive'}),work:async(_name,handler)=>{wake=handler;},send:async()=>{}}))t.mock.method(PgBoss.prototype,name,method);
 const f=fixture();let failFood=false;
 const scheduler=new LifeScheduler({getState:()=>f.reader.load()},{propose:async()=>assert.fail('daily quota exhausted')},
  {connectionString:'postgresql://localhost/unused',petId:'main',intervalSeconds:60,signal:f.gate.signal,assertExclusive:async()=>{},
   wakeCoordinator:{claim:async()=>({cursor:'1',changed:false}),finish:async()=>{order.push('finish');},release:async()=>assert.fail('food failure must not abort wake')},
   deterministic:{run:async()=>{}},resultCoordinator:{resume:async()=>false,claimCognition:async()=>{order.push('cognition');return false;}},
   foodRequests:{run:async(...args)=>{order.push('food');if(failFood)throw Error('food model down');await f.requests.run(...args);}}});
 try{
  await scheduler.start();await wake([{data:{petId:'main'}}]);assert.equal(f.published.length,1);assert.equal(f.usage.totalCalls,0);
  failFood=true;await wake([{data:{petId:'main'}}]);assert.deepEqual(order,['cognition','food','finish','cognition','food','finish']);
 }finally{await scheduler.stop();}
});
