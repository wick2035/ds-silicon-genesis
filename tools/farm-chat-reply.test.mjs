import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../dist/kernel/index.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {CanonicalChat,createChatHttp} from '../dist/host/chat-service.js';
import {createEmbodiedSpeech} from '../dist/host/embodied-speech.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {projectBody} from '../dist/host/body-projection.js';
import {changeFarmWeather,farmFacts} from '../dist/host/farm.js';

function fixture(weather='light-rain') {
  const now=Date.now(),at=new Date(now).toISOString();
  let state={petId:'main',version:0,legacy:{wallet:{balance:663.6},config:{costs:{riceSeed:9.9}}},humanity:createHumanity(now),
    life:createInitialState('main',at)};
  state.life.legacyContext={personaDescription:'大肥鱼'};
  state.life.constraints.capabilities.push({name:'farm.tend',enabled:true,physical:true});
  changeFarmWeather(state,weather,now);
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const reader={loadEnvelope:async()=>structuredClone(state),load:async()=>structuredClone(state.life)};
  const applyCurrent=async(_id,change)=>{
    const draft=structuredClone(state);
    change(draft);
    draft.version++;
    state=draft;
  };
  const uow={applyCurrent,apply:async(id,version,change)=>{
    assert.equal(state.version,version);
    await applyCurrent(id,change);
  }};
  const lifecycle=new CanonicalActionLifecycle(projectBody);
  function finishFarm(draft,id,sourceIds,status='completed'){
    const action=draft.life.actions.find(action=>action.id===id)??{
      id,petId:'main',actionType:'farm.tend',status:'DISPATCHED',sourceIds,requiredCapabilities:['farm.tend'],
      parameters:{operation:'plant',seedPurchase:farmFacts(draft).seedPurchase}
    };
    if(!draft.life.actions.includes(action))draft.life.actions.push(action);
    action.status='DISPATCHED';
    const intent={id,type:'farm.tend',payload:{actionId:id,petId:'main',actionType:'farm.tend',parameters:action.parameters}};
    lifecycle.complete(draft,intent,{status,evidence:{actionId:id,kind:'farm.tend',confirmed:true,settledAt:Date.now()}});
  }
  const speech=createEmbodiedSpeech(reader,gate,uow,
    {queue:async(id,actionId)=>applyCurrent(id,draft=>{draft.life.actions.find(a=>a.id===actionId).status='PENDING';})},
    {dispatch:async id=>applyCurrent('main',draft=>finishFarm(draft,id))},
    async()=>{},async()=>{});
  const chat=llm=>new CanonicalChat(reader,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},
    {agentDefaultModel:{currentSelection:()=>({provider:'fixture',model:'fixture'})},llm},async()=>[]);
  return {get:()=>state,gate,chat,speech,finishFarm};
}

const input=(id,text)=>({requestId:id,petId:'main',channel:'desktop',actorId:'dad',text});

test('a confirmed plant receipt produces a persisted SSE reply without a second generation',async()=>{
  const f=fixture();
  let calls=0;
  const chat=f.chat({...f.speech.wrap({async *stream(){
    assert.equal(++calls,1);
    yield {type:'tool-call-delta',index:1,id:'plant-call',name:'act',argumentsDelta:JSON.stringify({
      actionType:'farm.tend',parameters:{operation:'plant',seedPurchase:farmFacts(f.get()).seedPurchase}
    })};
  }}),embodiedTools:true});
  const serve=createChatHttp(chat,()=>true,()=>'main');
  const message=input('plant-live-reply','先去买点种子');
  const response=await serve(new Request('http://localhost/api/life/chat',{method:'POST',
    headers:{'content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify({...message,stream:true})}));
  assert.equal(response.status,200);
  const wire=await response.text();
  assert.match(wire,/event: done/);
  assert.doesNotMatch(wire,/event: error/);
  const [reply]=f.get().life.events.filter(e=>e.type==='conversation.assistant');
  assert.match(reply.payload.text,/用 24 束种子种下了一季水稻/);
  assert.match(reply.payload.text,/237\.6 token/);
  assert.match(reply.payload.text,/库存还剩 0 束/);
  assert.match(reply.payload.text,/雨水已补 1 次。人工照料 0 次。今天还差 1 次照料，现在可以施肥/);
  assert.match(wire,/用 24 束种子种下了一季水稻/);
  assert.ok(reply.payload.sourceIds.some(id=>id.startsWith('action-result:')));
  assert.equal(await chat.turn(message,f.gate.signal),reply.payload.text);
  assert.equal(calls,1);
  assert.equal(f.get().legacy.wallet.balance,426);
});

test('failure after accounting still saves and returns the confirmed result exactly once',async()=>{
  for(const cancelled of [false,true]){
    const f=fixture(),request=new AbortController();
    let generated=0;
    const chat=f.chat({async *stream(o){
      generated++;
      f.finishFarm(f.get(),'already-planted',o.embodied.sourceIds);
      if(cancelled)request.abort();
      throw Error('模型请求已取消或超时');
    }});
    const message=input('plant-recovery','先去买点种子');
    const reply=await chat.turn(message,request.signal);
    assert.match(reply,/种下了一季水稻/);
    assert.match(reply,/今天还差 1 次照料，现在可以施肥/);
    const [turn]=Object.values(f.get().legacy.chatTurns);
    assert.deepEqual(turn.failure,{phase:'generate',reason:cancelled?'cancelled':'timeout'});
    assert.equal(turn.status,'completed');
    assert.equal(await chat.turn(message,f.gate.signal),reply);
    assert.equal(generated,1);
    assert.equal(f.get().life.events.filter(e=>e.type==='conversation.assistant').length,1);
    assert.equal(f.get().life.events.filter(e=>e.type==='wallet.spend').length,1);
  }
});

test('the reported draft cannot deny an earlier successful planting or count light rain as enough',async()=>{
  const f=fixture();
  f.finishFarm(f.get(),'old-plant',[]);
  const partials=[];
  const chat=f.chat({async *stream(){
    yield {type:'text',text:'本鱼进稻田了，可要播种时它说这会儿不能种。眼下还下着小雨，水是够的。'};
  }});
  const reply=await chat.turn({...input('farm-followup','自己进去稻田里，我教你种地\n先去买点种子'),onPartial:text=>partials.push(text)},f.gate.signal);
  assert.match(reply,/种下了一季水稻.*幼苗期.*库存还剩 0 束.*今天还差 1 次照料，现在可以施肥/);
  assert.doesNotMatch(reply,/不能种|水是够的|买了 24/);
  assert.deepEqual(partials,[]);
  assert.equal(f.get().life.events.filter(e=>e.type==='wallet.spend').length,1);
});

test('current field distinguishes full watering from missing receipts and an empty field',async()=>{
  const watered=fixture('heavy-rain');
  watered.finishFarm(watered.get(),'old-plant',[]);
  const chat=watered.chat({async *stream(){throw Error('模型请求已取消或超时');}});
  assert.match(await chat.turn(input('rain-status','稻田的水够了吗？'),watered.gate.signal),/雨水已补 2 次，今天的水够了。人工照料 0 次。今天的照料已达标/);

  const empty=fixture();
  const failed=empty.chat({async *stream(o){
    empty.finishFarm(empty.get(),'cancelled-plant',o.embodied.sourceIds,'cancelled');
    throw Error('没拿到确认');
  }});
  await assert.rejects(failed.turn(input('plant-unconfirmed','先去买点种子'),empty.gate.signal),/没拿到确认/);
  assert.equal(empty.get().life.events.filter(e=>e.type==='conversation.assistant').length,0);
  assert.equal(empty.get().legacy.wallet.balance,663.6);
  const wrong=empty.chat({async *stream(){yield {type:'text',text:'我已经成功播种了。'};}});
  assert.equal(await wrong.turn(input('ask-empty','稻田播种成功了吗？'),empty.gate.signal),'田里现在是空的。');
});

test('chat can request fertilizer and only reports completion from a confirmed action',async()=>{
  const f=fixture('light-rain');
  f.finishFarm(f.get(),'old-plant',[]);
  const invented=f.chat({async *stream(){yield {type:'text',text:'本鱼已经施了一次肥，农活达标了。'};}});
  const status=await invented.turn(input('invented-fertilizer','稻田农活做了几次？'),f.gate.signal);
  assert.match(status,/还差 1 次照料，现在可以施肥/);
  assert.doesNotMatch(status,/施了一次肥|农活已达标/);

  const chat=f.chat({...f.speech.wrap({async *stream(){
    yield {type:'tool-call-delta',index:1,id:'fertilizer',name:'act',argumentsDelta:JSON.stringify({
      actionType:'farm.tend',parameters:{operation:'fertilize'}
    })};
  }}),embodiedTools:true});
  const reply=await chat.turn(input('fertilizer-request','去给水稻施肥吧'),f.gate.signal);
  assert.match(reply,/给水稻施了一次肥/);
  assert.match(reply,/今天的照料已达标/);
  assert.equal(farmFacts(f.get()).careCompleted,1);
});
