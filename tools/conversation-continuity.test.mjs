import test from 'node:test';
import assert from 'node:assert/strict';
import {privateConversationHistory,recentPrivateActivity,privateConversationThread,groupPrivateContinuity,historicalMemory} from '../dist/host/conversation-history.js';
import {createLegacyResponses} from '../dist/host/legacy-responses.js';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';

const event=(id,type,text,seconds,extra={})=>({eventId:id,type,source:'desktop',occurredAt:new Date(Date.UTC(2026,10,15,9,7,seconds)).toISOString(),payload:{text},...extra});

test('group contact timing uses the Hong Kong day and skips future, pending, and invalid speech',()=>{
  const now=Date.UTC(2026,10,16,16,2),at=(minutes)=>new Date(now+minutes*60000).toISOString();
  const contact=event('chat-user:private','conversation.user','私人内容',0,{source:'qq-c2c',actorId:'dad',occurredAt:at(-4)});
  const state={events:[
    contact,event('chat-assistant:private','conversation.assistant','私聊答复',0,{source:'qq-c2c',causationId:contact.eventId,occurredAt:at(-3)}),
    event('chat-user:pending','conversation.user','待回复',0,{occurredAt:at(-1)}),
    event('deleted','conversation.user','已删除',0,{occurredAt:at(-1)}),
    event('future','conversation.user','未来',0,{occurredAt:at(1)})],invalidSources:{deleted:'deleted'}};
  assert.match(groupPrivateContinuity(state,now),/昨天收到过爸爸的私聊发言，距今约4分钟/);
  assert.equal(groupPrivateContinuity(state,now-5*60000),'');
  state.invalidSources[contact.eventId]='deleted';
  assert.equal(groupPrivateContinuity(state,now),'');
});

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

test('removing an incorrect answer preserves the user message but excludes unfinished requests',()=>{
  const events=[event('chat-user:question','conversation.user','饭钱到了吗',0),event('chat-assistant:wrong','conversation.assistant','没有收到',1,{causationId:'chat-user:question'}),event('chat-user:pending','conversation.user','还在处理',2)];
  assert.deepEqual(privateConversationHistory({events,invalidSources:{'chat-assistant:wrong':'removed'}}).map(e=>e.eventId),['chat-user:question']);
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

test('group context keeps speech attribution and delivery while source IDs remain in the stored turn',async()=>{
  const f=fixture(),at=new Date().toISOString();
  f.state.life.events.push(
    {eventId:'group-internal-q',type:'social.message',source:'qq',actorId:'qq-member:friend',occurredAt:at,payload:{scene:'group',groupId:'g',text:'喜欢面条'}},
    {eventId:'group-internal-u',type:'conversation.user',source:'qq-group',actorId:'qq-member:friend',occurredAt:at,causationId:'group-internal-q',payload:{groupId:'g',text:'喜欢面条',sourceIds:['group-internal-q']}},
    {eventId:'group-internal-a',type:'conversation.assistant',source:'qq-group',occurredAt:at,causationId:'group-internal-u',payload:{groupId:'g',text:'本鱼爱白饭'}},
    {eventId:'group-internal-receipt',type:'action.receipt',source:'outbox',occurredAt:at,causationId:'receipt',payload:{actionId:'send'}});
  f.state.life.actions.push({id:'send',actionType:'qq.send',sourceIds:['group-internal-q'],parameters:{scene:'group',content:'本鱼爱白饭'},status:'COMPLETED',receiptId:'receipt'});
  f.state.life.receipts.push({receiptId:'receipt',actionId:'send',status:'COMPLETED',details:{kind:'qq.send',messageId:'delivered'}});
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{embodiedTools:true,async *stream(o){
    const context=JSON.parse(o.system.split('自己最近的群聊经历：')[1].split('\n')[0]);
    assert.equal(context[0].delivery,'已确认发送');assert.equal(context[0].heard[0].actorId,'qq-member:friend');assert.equal(context[0].heard[0].text,'喜欢面条');
    assert.equal(context[0].text,'本鱼爱白饭');assert.equal(context[0].sourceIds,undefined);
    yield {type:'text',text:'嗯，爸爸。'};
  }}};
  const chat=new CanonicalChat(f.reader,f.gate,f.uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[]);
  await chat.turn({petId:'main',requestId:'group-evidence',channel:'desktop',actorId:'dad',text:'你好'},f.gate.signal);
  const saved=f.state.life.events.find(e=>e.type==='conversation.assistant'&&e.payload?.text==='嗯，爸爸。');
  assert.ok(saved.payload.sourceIds.includes('group-internal-q'));assert.ok(saved.payload.sourceIds.includes('group-internal-receipt'));
});

test('historical memories retain source event time rather than summary creation time',()=>{
  const {state}=fixture();const memory={content:'我吃过饭',sourceIds:['meal'],evidenceLevel:'observed'};
  assert.equal(historicalMemory(memory,state.life).sources[0].at,'2026-11-15T09:07:31.000Z');
});
