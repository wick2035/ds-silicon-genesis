import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalQQ,validateQQReply} from '../dist/host/qq-canonical.js';

function fixture(){
  const authority={},signal=new AbortController().signal;
  const state={petId:'main',version:0,legacy:{qq:{identity:{appId:'app',ownerOpenid:'owner',groupEnabled:false,groupMode:'owner'},seen:{},outbound:{}}},humanity:{},life:{events:[],actions:[],invalidSources:{},constraints:{paused:false,permissions:['qq.send'],capabilities:[{name:'qq.send',enabled:true,requiresPermission:'qq.send'}]}}};
  const event=(id,type,source,text,extra={})=>{const now=new Date().toISOString();return {eventId:id,petId:'main',type,source,occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{text},...extra};};
  const reader={loadEnvelope:async()=>structuredClone(state)},gate={signal,run:async(_id,fn)=>fn()},intents=[];
  const uow={apply:async(_id,version,change)=>{assert.equal(version,state.version);const draft=structuredClone(state),result=change(draft);draft.version++;Object.assign(state,draft);intents.push(...(result.intents||[]));}};
  return {state,event,intents,authority,qq:new CanonicalQQ(reader,uow,gate,()=>({body:{},emotions:{}}),authority)};
}
async function anchor(f,id='qq'){
  f.state.life.events.push(f.event(id,'social.message','qq','你好',{actorId:'dad',payload:{scene:'c2c',messageId:id}}));
  const action=await f.qq.enqueue('main','reply:'+id,'c2c','你好',''+id,id,f.authority);
  return f.state.life.actions.find(a=>a.id===action);
}
test('only new complete desktop turns relay as one message, after the normal QQ reply',async()=>{
  const f=fixture(),{state,event,qq,authority}=f;
  const old=new Date(Date.now()-10000).toISOString();state.life.events.push(event('old-u','conversation.user','desktop','旧问题',{receivedAt:old}),event('old-a','conversation.assistant','desktop','旧回答',{receivedAt:old,causationId:'old-u'}));
  await qq.enableRelay('main');const normal=await anchor(f);
  state.life.events.push(event('u','conversation.user','desktop','快搬'),event('a','conversation.assistant','desktop','我愿意试试',{causationId:'u'}));
  assert.equal(await qq.enqueueNextRelay('main',authority),null,'normal QQ reply must be delivered first');
  state.life.actions.find(a=>a.id===normal.id).status='COMPLETED';const id=await qq.enqueueNextRelay('main',authority);assert.ok(id);assert.equal(await qq.enqueueNextRelay('main',authority),null);
  const relay=state.life.actions.find(a=>a.id===id);assert.equal(relay.parameters.content,'【生命空间】\n我：快搬\n大肥鱼：我愿意试试');assert.equal(relay.parameters.replySeq,2);
  assert.deepEqual(relay.sourceIds,['a','u','qq']);
  state.life.events.push(event('u2','conversation.user','desktop','再搬'),event('a2','conversation.assistant','desktop','我看看',{causationId:'u2'}));
  assert.equal(await qq.enqueueNextRelay('main',authority),null,'wait for first send receipt');
  Object.values(state.legacy.qq.outbound).find(x=>x.actionId===id).state='sent';
  assert.ok(await qq.enqueueNextRelay('main',authority),'next turn follows a definite receipt');
  const life={...state.life,petId:'main',version:state.version,body:{},emotions:{}};
  assert.throws(()=>validateQQReply(state,life,{...relay,expectedStateVersion:state.version,parameters:{...relay.parameters,content:'tampered'}}),/来源无效/);
});
test('a partial, deleted, expired, or historical turn is never forwarded',async()=>{
  const f=fixture(),{state,event,qq,authority}=f;await qq.enableRelay('main');(await anchor(f)).status='COMPLETED';
  const stale=new Date(Date.now()-121000).toISOString();
  state.life.events.push(event('partial','conversation.user','desktop','等待'),event('deleted','conversation.user','desktop','删除'),event('answer','conversation.assistant','desktop','回答',{causationId:'deleted'}),event('late-u','conversation.user','desktop','过期',{receivedAt:stale}),event('late-a','conversation.assistant','desktop','过期',{receivedAt:stale,causationId:'late-u'}));state.life.invalidSources.deleted='removed';
  assert.equal(await qq.enqueueNextRelay('main',authority),null);
});
test('unknown delivery is not replayed against a later QQ message',async()=>{
  const f=fixture(),{state,event,qq,authority}=f;await qq.enableRelay('main');(await anchor(f,'q1')).status='COMPLETED';
  state.life.events.push(event('u','conversation.user','desktop','你好'),event('a','conversation.assistant','desktop','你好',{causationId:'u'}));assert.ok(await qq.enqueueNextRelay('main',authority));
  Object.values(state.legacy.qq.outbound).find(x=>x.relayKey).state='unknown';(await anchor(f,'q2')).status='COMPLETED';
  assert.equal(await qq.enqueueNextRelay('main',authority),null);
});
