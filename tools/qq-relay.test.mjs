import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalQQ,createQQExecutor,validateQQReply} from '../dist/host/qq-canonical.js';

function fixture() {
  const now=new Date().toISOString(), authority={},signal=new AbortController().signal;
  const state={petId:'main',version:0,legacy:{qq:{identity:{appId:'app',ownerOpenid:'owner',groupEnabled:false,groupMode:'owner'},seen:{},outbound:{}}},humanity:{},life:{events:[],actions:[],invalidSources:{},constraints:{paused:false,permissions:['qq.send'],capabilities:[{name:'qq.send',enabled:true,requiresPermission:'qq.send'}]}}};
  const event=(id,type,source,text,extra={})=>({eventId:id,petId:'main',type,source,occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{text},...extra});
  const reader={loadEnvelope:async()=>structuredClone(state)},gate={signal,run:async(_id,fn)=>fn()};
  const intents=[];const uow={apply:async(_id,version,change)=>{assert.equal(version,state.version);const draft=structuredClone(state),result=change(draft);draft.version++;Object.assign(state,draft);intents.push(...(result.intents||[]));}};
  return {state,event,intents,authority,signal,qq:new CanonicalQQ(reader,uow,gate,()=>({body:{},emotions:{}}),authority)};
}

test('desktop conversations relay in order with separate QQ reply sequence numbers',async()=>{
  const f=fixture(),{state,event,qq,authority}=f;
  state.life.events.push(event('qq','social.message','qq','你好',{actorId:'dad',payload:{scene:'c2c',messageId:'m'}}));
  await qq.enableRelay('main');
  state.life.events.push(event('u','conversation.user','desktop','干活吧'),event('a','conversation.assistant','desktop','我会的',{causationId:'u'}),event('noise','conversation.assistant','desktop','摸摸'),event('private-group','conversation.user','qq-group','群消息'));
  const first=await qq.enqueueNextRelay('main',authority),second=await qq.enqueueNextRelay('main',authority);
  assert.ok(first&&second);assert.equal(await qq.enqueueNextRelay('main',authority),null);
  assert.match(f.intents[0].payload.parameters.content,/生命空间·我.*干活吧/);assert.match(f.intents[1].payload.parameters.content,/生命空间·大肥鱼.*我会的/);
  assert.deepEqual(f.intents.map(i=>i.payload.parameters.replySeq),[1,2]);
  const normal=await qq.enqueue('main','reply:m','c2c','好的','qq','m',authority);
  assert.ok(normal);assert.equal(f.intents[2].payload.parameters.replySeq,3);
  const sent=[];const exec=createQQExecutor({send:async(input)=>{sent.push(input);return {messageId:'result'};}});
  assert.equal((await exec('main',f.intents[1],f.signal)).status,'completed');assert.equal(sent[0].replySeq,2);
  const action=state.life.actions[0],life={...state.life,petId:'main',version:state.version,body:{},emotions:{}};
  assert.throws(()=>validateQQReply(state,life,{...action,expectedStateVersion:state.version,parameters:{...action.parameters,content:'tampered'}}),/来源无效/);
});

test('expired or exhausted QQ windows retain messages for the next private message',async()=>{
  const f=fixture(),{state,event,qq,authority}=f;
  const stale=new Date(Date.now()-61*60*1000).toISOString();
  state.life.events.push(event('old','social.message','qq','你好',{actorId:'dad',occurredAt:stale,receivedAt:stale,payload:{scene:'c2c',messageId:'old'}}));
  await qq.enableRelay('main');state.life.events.push(event('u','conversation.user','desktop','未同步'));
  assert.equal(await qq.enqueueNextRelay('main',authority),null);
  state.life.events.push(event('new','social.message','qq','回来啦',{actorId:'dad',payload:{scene:'c2c',messageId:'new'}}));
  assert.ok(await qq.enqueueNextRelay('main',authority));assert.equal(f.intents[0].payload.parameters.replyTo,'new');
});

test('deleted and unrelated conversation sources are not forwarded',async()=>{
  const f=fixture(),{state,event,qq,authority}=f;
  state.life.events.push(event('qq','social.message','qq','你好',{actorId:'dad',payload:{scene:'c2c',messageId:'m'}}));await qq.enableRelay('main');
  state.life.events.push(event('deleted','conversation.user','desktop','deleted'),event('answer','conversation.assistant','desktop','answer',{causationId:'deleted'}));state.life.invalidSources.deleted='removed';
  assert.equal(await qq.enqueueNextRelay('main',authority),null);
});

test('reply quota reserves the normal answer and continues after a new message',async()=>{
  const f=fixture(),{state,event,qq,authority}=f;
  state.life.events.push(event('q1','social.message','qq','你好',{actorId:'dad',payload:{scene:'c2c',messageId:'m1'}}));await qq.enableRelay('main');
  for(let i=0;i<6;i++)state.life.events.push(event('u'+i,'conversation.user','desktop','消息'+i));
  for(let i=0;i<4;i++)assert.ok(await qq.enqueueNextRelay('main',authority));
  assert.equal(await qq.enqueueNextRelay('main',authority),null);
  await qq.enqueue('main','reply:m1','c2c','好','q1','m1',authority);assert.equal(f.intents.at(-1).payload.parameters.replySeq,5);
  assert.equal(await qq.enqueueNextRelay('main',authority),null);
  state.life.events.push(event('q2','social.message','qq','继续',{actorId:'dad',payload:{scene:'c2c',messageId:'m2'}}));
  assert.ok(await qq.enqueueNextRelay('main',authority));assert.equal(f.intents.at(-1).payload.parameters.replySeq,1);
});

test('known cancellations wait for another QQ message but unknown deliveries never repeat',async()=>{
  const f=fixture(),{state,event,qq,authority}=f;
  state.life.events.push(event('q1','social.message','qq','你好',{actorId:'dad',payload:{scene:'c2c',messageId:'m1'}}));await qq.enableRelay('main');
  state.life.events.push(event('u','conversation.user','desktop','内容'));
  await qq.enqueueNextRelay('main',authority);const old=Object.values(state.legacy.qq.outbound)[0];old.state='cancelled';
  assert.equal(await qq.enqueueNextRelay('main',authority),null);
  state.life.events.push(event('q2','social.message','qq','再来',{actorId:'dad',payload:{scene:'c2c',messageId:'m2'}}));
  assert.ok(await qq.enqueueNextRelay('main',authority));Object.values(state.legacy.qq.outbound).at(-1).state='unknown';
  state.life.events.push(event('q3','social.message','qq','再次',{actorId:'dad',payload:{scene:'c2c',messageId:'m3'}}));
  assert.equal(await qq.enqueueNextRelay('main',authority),null);
});
