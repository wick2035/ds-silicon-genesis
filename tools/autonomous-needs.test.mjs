import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutonomousNeeds} from '../dist/host/autonomous-needs.js';
import {createEmbodiedSpeech} from '../dist/host/embodied-speech.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';

function fixture(){
 const humanity=createHumanity();humanity.stats.satiety=20;humanity.helperReady=true;
 const s={petId:'main',version:0,humanity,legacy:{config:{costs:{feed:20}},wallet:{balance:100},services:{inventory:[{id:'old',name:'大白饭',status:'available'}]}},life:{events:[],invalidSources:{},actions:[{id:'unknown',actionType:'service.eat-rice',parameters:{itemId:'old'},status:'UNKNOWN'}],receipts:[],memories:[],goals:[],commitments:[],relationships:[],constraints:{paused:false,permissions:[],capabilities:[{name:'service.buy-rice',enabled:true},{name:'service.eat-rice',enabled:true,physical:true}]}}};
 s.life.actions[0].sourceIds=[];
 const reader={loadEnvelope:async()=>structuredClone(s)},gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},uow={apply:async(_id,v,fn)=>{assert.equal(v,s.version);fn(s);s.version++;}};
 const actions={queue:async(_id,id)=>{s.life.actions.find(a=>a.id===id).status='PENDING';}},dispatched=[],published=[];
 const dispatcher={dispatch:async id=>{const a=s.life.actions.find(a=>a.id===id);dispatched.push(a.actionType);a.status='COMPLETED';if(a.actionType==='service.buy-rice'){s.legacy.wallet.balance-=20;s.legacy.services.inventory.push({id:'new',name:'大白饭',status:'available'});}else{assert.equal(a.parameters.itemId,'new');s.legacy.services.inventory.find(i=>i.id==='new').status='eaten';s.humanity.stats.satiety+=12;}s.life.receipts.push({actionId:id,status:'COMPLETED'});}};
 const speech=createEmbodiedSpeech(reader,gate,uow,actions,dispatcher,async()=>{},async()=>{});
 const budget={runAs:async(_id,category,fn)=>{assert.equal(category,'needs');return fn();}};
 const create=model=>createAutonomousNeeds(reader,gate,uow,budget,{agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:speech.wrap(model)},text=>published.push(text));
 return {s,gate,create,dispatched,published};
}
const call=(id,actionType,parameters)=>({type:'tool-call-delta',index:0,id,name:'act',argumentsDelta:JSON.stringify({actionType,parameters})});
test('hunger starts its own decision and buys then eats from receipts without a user message',async()=>{
 const f=fixture();let rounds=0;
 const needs=f.create({async *stream(o){rounds++;assert.match(o.system,/不是爸爸的新消息/);if(rounds===1)yield call('buy','service.buy-rice',{});else if(rounds===2){const t=JSON.parse(o.messages.at(-1).content);assert.equal(t.库存.find(i=>i.id==='old').status,'unconfirmed');yield call('eat','service.eat-rice',{itemId:t.库存.find(i=>i.status==='available').id});}else{const t=JSON.parse(o.messages.at(-1).content);assert.equal(t.food.satiety,32);yield {type:'text',text:'我自己买来吃了，还想再留一碗。'};}}});
 assert.equal(await needs.run('main',f.gate.signal),true);assert.deepEqual(f.dispatched,['service.buy-rice','service.eat-rice']);assert.equal(f.published.length,1);assert.equal(f.s.life.events.some(e=>e.type==='conversation.user'),false);assert.equal(f.s.legacy.autonomousNeeds.status,'completed');
 await needs.run('main',f.gate.signal);assert.equal(rounds,3);assert.equal(f.published.length,1);
});
test('autonomous need can ask the owner or choose silence without a prescribed purchase',async()=>{
 for(const text of ['爸爸，我还饿，想再要一碗饭。','<needs-silent/>']){
  const f=fixture();f.s.legacy.wallet.balance=0;const needs=f.create({async *stream(){yield {type:'text',text};}});
  await needs.run('main',f.gate.signal);assert.deepEqual(f.dispatched,[]);assert.deepEqual(f.published,text==='<needs-silent/>'?[]:[text]);
 }
});
test('satisfied, paused and active private conversations do not trigger another autonomous decision',async()=>{
 for(const patch of [f=>{f.s.humanity.stats.satiety=80;f.s.humanity.lastFedAt=Date.now();},f=>{f.s.life.constraints.paused=true;},f=>{f.s.legacy.chatTurns={x:{status:'running',wakeRequested:true,at:Date.now()}};}]){
  const f=fixture();patch(f);const needs=f.create({async *stream(){assert.fail('unexpected model call');}});assert.equal(await needs.run('main',f.gate.signal),false);
 }
});

test('new money restarts a blocked need before the unchanged-state cooldown expires',async()=>{
 const f=fixture();f.s.legacy.wallet.balance=0;let decisions=0;
 const needs=f.create({async *stream(){decisions++;yield {type:'text',text:'想吃饭。'};}});
 await needs.run('main',f.gate.signal);await needs.run('main',f.gate.signal);assert.equal(decisions,1);
 f.s.legacy.wallet.balance=100;
 await needs.run('main',f.gate.signal);assert.equal(decisions,2);
});
