import test from 'node:test';
import assert from 'node:assert/strict';
import {privateConversationHistory,recentPrivateActivity,privateConversationThread,historicalMemory} from '../dist/host/conversation-history.js';
import {createLegacyResponses} from '../dist/host/legacy-responses.js';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';

const event=(id,type,text,seconds,extra={})=>({eventId:id,type,source:'desktop',occurredAt:new Date(Date.UTC(2026,10,15,9,7,seconds)).toISOString(),payload:{text},...extra});

test('ambient interaction speech cannot displace recent private dialogue or break its question and answer',()=>{
  const events=[event('chat-user:topic','conversation.user','你自己问小金鲸答应你的大白饭',0,{actorId:'dad'}),
    event('chat-assistant:topic','conversation.assistant','我自己去问',1,{causationId:'chat-user:topic'})];
  for(let i=0;i<30;i++)events.push(event('touch:'+i,'interaction.requested','',i+2),event('reaction:'+i,'conversation.assistant','摸头后的回应'+i,i+2,{causationId:'touch:'+i}));
  const state={events,invalidSources:{}},activity=recentPrivateActivity(state,Date.UTC(2026,10,15,9,8));
  assert.deepEqual(activity.map(e=>e.eventId),['chat-user:topic','chat-assistant:topic','reaction:28','reaction:29']);
  assert.deepEqual(privateConversationThread(state,activity).map(e=>e.eventId),['chat-user:topic','chat-assistant:topic']);
  state.invalidSources['chat-user:topic']='deleted';
  assert.deepEqual(privateConversationThread(state,recentPrivateActivity(state,Date.UTC(2026,10,15,9,8))),[]);
});
function fixture(){
  const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
  const state={petId:'main',version:0,legacy:old.read('main'),humanity:{stats:{satiety:25},emotions:{},desires:{}},life:{events:[],memories:[],actions:[],receipts:[],goals:[],commitments:[],relationships:[],invalidSources:{},constraints:{paused:false,permissions:[]},legacyContext:{personaDescription:'test'},body:{},emotions:{}}};
  state.legacy.wallet.balance=29.8;
  state.life.events.push(event('chat-user:meal','conversation.user','自己买饭吃',0,{actorId:'dad'}),
    event('meal','body.meal','',31,{source:'executor',payload:{action:'feed'}}),
    event('chat-assistant:meal','conversation.assistant','买了，也吃完了，剩30',41,{causationId:'chat-user:meal'}),
    event('reaction-request','interaction.requested','',42),
    event('reaction','conversation.assistant','吃完了还想再来一碗',43,{causationId:'reaction-request'}),
    event('prop','interaction','爸爸拿起我的饭碗',50,{source:'canonical-legacy'}));
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const reader={loadEnvelope:async()=>structuredClone(state),load:async()=>structuredClone(state.life)};
  const uow={apply:async(_id,v,fn)=>{assert.equal(v,state.version);fn(state);state.version++;}};
  return {state,gate,reader,uow};
}

test('shared private history preserves chat and interaction speech in time order, excludes group/invalid/pending speech',()=>{
  const {state}=fixture();
  state.life.events.push(event('group','conversation.assistant','群里秘密',44,{source:'qq-group'}),
    event('chat-user:pending','conversation.user','没完成的旧请求',45),
    event('deleted','conversation.assistant','已删除',46),
    event('bad-source','conversation.assistant','引用删除来源',47,{payload:{text:'引用删除来源',sourceIds:['deleted']}}));
  state.life.invalidSources.deleted='deleted';
  state.life.events.reverse();
  const history=privateConversationHistory(state.life);
  assert.deepEqual(history.map(e=>e.eventId),['chat-user:meal','chat-assistant:meal','reaction']);
  assert.deepEqual(history.map(e=>e.role),['user','assistant','assistant']);
});

test('interaction response sees earlier chat and its own last reaction, timestamps old money memory and reads fresh balance after waiting',async()=>{
  const f=fixture();
  f.state.life.events.push(event('topup','wallet','充值到230',-300));
  f.state.life.memories.push({id:'money',valid:true,content:'余额从10变为230',sourceIds:['topup'],evidenceLevel:'observed',createdAt:new Date().toISOString()});
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(o){
    const input=JSON.parse(o.messages.at(-1).content);
    assert.deepEqual(input.recentConversation.map(e=>e.eventId),['chat-user:meal','chat-assistant:meal','reaction','new-reaction']);
    assert.equal(input.currentLife.food.balance,29.6);
    assert.equal(input.materials[0].sources[0].at,f.state.life.events.find(e=>e.eventId==='topup').occurredAt);
    assert.match(o.system,/历史余额.*不是此刻状态/);
    yield {type:'text',text:'刚吃完呢，碗还给我。'};
  }}};
  const budget={runAs:async(_id,_kind,fn)=>{
    f.state.legacy.wallet.balance=29.6;
    f.state.life.events.push(event('new-reaction','conversation.assistant','已经吃过啦',49,{causationId:'reaction-request'}));
    return fn();
  }};
  const respond=createLegacyResponses(f.reader,f.gate,f.uow,budget,model,'test');
  assert.equal(await respond('main','physical',f.gate.signal,{eventId:'prop',description:'爸爸拿起我的饭碗'}),'刚吃完呢，碗还给我。');
  assert.ok(f.state.life.events.at(-1).payload.sourceIds.includes('new-reaction'));
});

test('ordinary chat includes interaction reactions as its own prior speech',async()=>{
  const f=fixture();let calls=0;
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{embodiedTools:true,async *stream(o){
    calls++;const own=o.messages.filter(m=>m.role==='assistant');
    assert.equal(own.length,2);assert.match(own[1].content,/吃完了还想再来一碗/);
    assert.match(own[1].content,/2026-11-15T09:07:43/);
    assert.equal(o.messages.at(-1).content,'你到底吃没吃？');
    yield {type:'text',text:'吃完啦，还想吃而已。'};
  }}};
  const chat=new CanonicalChat(f.reader,f.gate,f.uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[]);
  assert.equal(await chat.turn({petId:'main',requestId:'continuity',channel:'desktop',actorId:'dad',text:'你到底吃没吃？'},f.gate.signal),'吃完啦，还想吃而已。');
  assert.equal(calls,1);
});

test('historical memories retain source event time rather than summary creation time',()=>{
  const {state}=fixture();const memory={content:'我吃过饭',sourceIds:['meal'],evidenceLevel:'observed'};
  assert.equal(historicalMemory(memory,state.life).sources[0].at,'2026-11-15T09:07:31.000Z');
});
