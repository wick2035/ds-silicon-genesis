import test from 'node:test';
import assert from 'node:assert/strict';
import {createCareReactions} from '../dist/host/care-reactions.js';
import {createWorksiteReactions} from '../dist/host/worksite-reactions.js';
import {runReaction,REACTION_TIMEOUT_MS} from '../dist/host/reaction-response.js';
import {CognitiveError} from '../dist/cognition/diagnostics.js';
import {createModelFacade} from '../dist/host/model-facade.js';
import {convertMessages} from '../dist/host/model-messages.js';
import {createLegacyResponses} from '../dist/host/legacy-responses.js';
import {createEmbodiedSpeech} from '../dist/host/embodied-speech.js';
import {conversationContext} from '../dist/host/conversation-context.js';
import {createInitialState} from '../dist/kernel/index.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';

const flush=()=>new Promise(setImmediate);
const state=events=>({petId:'main',life:{events,invalidSources:{}}});
const care={eventId:'water',type:'social.care',payload:{action:'water'}};
const site={eventId:'site',type:'interaction.worksite',payload:{action:'touch'}};

test('care and worksite responses may finish after 30 seconds and publish only once',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const [create,event] of [[createCareReactions,care],[createWorksiteReactions,site]]){
    let finish,signal,calls=0;const shown=[];
    const observe=create(state([]),async(_id,_event,s)=>{signal=s;calls++;return new Promise(r=>finish=r);},(...args)=>shown.push(args));
    observe(state([event]));await flush();t.mock.timers.tick(31000);await flush();
    assert.equal(signal.aborted,false);assert.equal(shown.length,0);
    finish('收到啦');await flush();observe(state([event]));await flush();
    assert.equal(calls,1);assert.equal(shown.length,1);assert.ok(shown[0].includes('收到啦'));
  }
});

test('deadline cancels a stalled response without retries or late publication',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let finish,signal,calls=0;const shown=[];
  const observe=createCareReactions(state([]),async(_id,_event,s)=>{signal=s;calls++;return new Promise(r=>finish=r);},text=>shown.push(text));
  observe(state([care]));await flush();t.mock.timers.tick(REACTION_TIMEOUT_MS);await flush();
  assert.equal(signal.aborted,true);assert.equal(shown.length,1);assert.match(shown[0],/照料已完成。回应生成超时/);
  finish('迟到的回应');await flush();assert.equal(shown.length,1);assert.equal(calls,1);
});

test('shutdown cancels care and worksite without showing an error or stale reply',async()=>{
  for(const [create,event] of [[createCareReactions,care],[createWorksiteReactions,site]]){
    const controller=new AbortController(),shown=[];let finish,signal;
    const observe=create(state([]),async(_id,_event,s)=>{signal=s;return new Promise(r=>finish=r);},(...args)=>shown.push(args),controller.signal);
    observe(state([event]));await flush();controller.abort();await flush();
    assert.equal(signal.aborted,true);assert.deepEqual(shown,[]);
    finish('late');await flush();observe(state([event]));assert.deepEqual(shown,[]);
  }
});

test('feedback distinguishes local context, budget, authentication, timeout and invalid output',async t=>{
  const logged=[];t.mock.method(console,'warn',(...args)=>logged.push(JSON.stringify(args)));
  for(const [code,pattern] of [['context_overflow',/资料过长/],['budget_exhausted',/额度或精神不足/],['authentication_error',/认证失败/],['model_timeout',/生成超时/],['invalid_model_output',/未返回完整回应/]]){
    const result=await runReaction(async()=>{throw new CognitiveError(code,'private prompt and secret-key');},'care');
    assert.equal(result.fallback,true);assert.match(result.text,pattern);assert.match(result.text,/照料已完成/);
    assert.doesNotMatch(result.text,/private|secret|检查模型连接/);
  }
  assert.equal(logged.length,5);assert.ok(logged.every(line=>!line.includes('private')&&!line.includes('secret')));
});

test('oversized model inputs are classified before charging or making network requests',async()=>{
  let charges=0;
  const model=createModelFacade({version:1,defaultSelection:{provider:'p',model:'m'},providers:{p:{api:'openai-completions',baseURL:'https://example.invalid',apiKey:'test-key',models:['m']}}},{leaseSignal:new AbortController().signal,budget:{reserve:async()=>{charges++;throw Error('must not charge');}}});
  try {
    for(const input of [{system:'x'.repeat(32769),messages:[{role:'user',content:'hi'}]},{messages:[{role:'user',content:'x'.repeat(32769)}]}]){
      await assert.rejects(async()=>{for await(const _ of model.llm.stream({provider:'p',model:'m',...input})){}},e=>e.code==='context_overflow');
    }
    assert.equal(charges,0);
  } finally {model.dispose();}
});

function fixture(){
  const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
  const {petId,version,body,emotions,...life}=createInitialState('main',new Date().toISOString());
  const current={petId,version,life,humanity:createHumanity(),legacy:old.read('main')};
  current.legacy.wallet.balance=29.8;current.life.constraints.paused=false;
  current.life.events.push({...care,petId,occurredAt:new Date().toISOString()});
  const controller=new AbortController(),gate={signal:controller.signal,run:async(_id,fn)=>fn()};
  const reader={loadEnvelope:async()=>structuredClone(current)};
  const uow={apply:async(_id,v,fn)=>{assert.equal(v,current.version);fn(current);current.version++;}};
  return {current,reader,gate,uow,controller};
}

test('long group history still reaches the model with valid JSON, live facts and source attribution',async()=>{
  const f=fixture(),now=Date.now();
  for(let i=0;i<12;i++){
    const at=new Date(now-20000+i*1000).toISOString(),ids=[];
    for(let n=0;n<24;n++){
      const id=`group-${i}-${n}-`+'id'.repeat(50);ids.push(id);
      f.current.life.events.push({eventId:id,type:'social.message',source:'qq',actorId:'friend',occurredAt:at,payload:{scene:'group',groupId:'g',text:'群友讨论天气'.repeat(30)}});
    }
    f.current.life.events.push({eventId:'request-'+i,type:'conversation.user',source:'qq-group',occurredAt:at,payload:{groupId:'g',sourceIds:ids}},
      {eventId:'reply-'+i,type:'conversation.assistant',source:'qq-group',occurredAt:at,causationId:'request-'+i,payload:{groupId:'g',text:'今天天气不错'.repeat(40)}});
  }
  assert.ok(JSON.stringify(conversationContext(f.current.life,f.current)).length>32768);
  const before=structuredClone(f.current.life.events);let calls=0;
  const raw={async *stream(o){
    calls++;const input=JSON.parse(o.messages[0].content);
    await convertMessages(o.messages,'openai-completions',o.signal);
    assert.ok(o.messages[0].content.length<=24000);assert.ok(o.system.length<=32768);
    assert.equal(input.currentLife.food.balance,29.8);assert.deepEqual(input.body,f.current.humanity.stats);
    assert.equal(input.task,'爸爸刚刚给你喝水');assert.equal(input.recentPhysical.at(-1).payload.action,'water');
    const group=input.currentLife.companion.groupActivity.at(-1);
    assert.equal(group.channel,'qq-group');assert.equal(group.heard.at(-1).actorId,'friend');
    assert.equal(group.delivery,'发送尚未确认');assert.equal(group.sourceIds,undefined);
    yield {type:'text',text:'喝到啦，谢谢爸爸。'};
  }};
  const forbidden=async()=>{throw Error('unexpected action');};
  const wrapped=createEmbodiedSpeech(f.reader,f.gate,f.uow,{}, {},forbidden,forbidden).wrap(raw);
  const model={agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:wrapped};
  const respond=createLegacyResponses(f.reader,f.gate,f.uow,{runAs:async(_id,_kind,fn)=>fn()},model,'大肥鱼');
  assert.equal(await respond('main','care',f.gate.signal,{eventId:care.eventId,description:'爸爸刚刚给你喝水'}),'喝到啦，谢谢爸爸。');
  assert.equal(calls,1);assert.deepEqual(f.current.life.events.slice(0,before.length),before);
  assert.equal(f.current.life.events.at(-1).type,'conversation.assistant');
  assert.ok(f.current.life.events.at(-1).payload.sourceIds.includes(care.eventId));
});

test('cancellation while waiting for the final commit never stores late speech',async()=>{
  const f=fixture();let gates=0;
  f.gate.run=async(_id,fn)=>{if(++gates===2)f.controller.abort();return fn();};
  const model={agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:{async *stream(){yield {type:'text',text:'late'};}}};
  const respond=createLegacyResponses(f.reader,f.gate,f.uow,{runAs:async(_id,_kind,fn)=>fn()},model,'大肥鱼');
  await assert.rejects(respond('main','care',f.gate.signal,{eventId:care.eventId,description:'喝水'}));
  assert.ok(!f.current.life.events.some(e=>e.type==='conversation.assistant'));
});
