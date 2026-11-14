import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalQQ,validateQQReply,createQQExecutor} from '../dist/host/qq-canonical.js';

function fixture(){
  const authority={},signal=new AbortController().signal;
  const state={petId:'main',version:0,legacy:{wallet:{balance:100},qq:{identity:{appId:'app',ownerOpenid:'owner',groupEnabled:false,groupMode:'owner'},seen:{},outbound:{}}},humanity:{},life:{events:[],actions:[],invalidSources:{},constraints:{paused:false,permissions:['qq.send'],capabilities:[{name:'qq.send',enabled:true,requiresPermission:'qq.send'}]}}};
  const event=(id,type,source,text,extra={})=>{const now=new Date().toISOString();return {eventId:id,petId:'main',type,source,occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{text},...extra};};
  const reader={loadEnvelope:async()=>structuredClone(state)},gate={signal,run:async(_id,fn)=>fn()},intents=[];
  const uow={apply:async(_id,version,change)=>{assert.equal(version,state.version);const draft=structuredClone(state),result=change(draft);draft.version++;Object.assign(state,draft);intents.push(...(result.intents||[]));}};
  const qq=new CanonicalQQ(reader,uow,gate,()=>({body:{},emotions:{}}),authority);
  const expression=(id,kind='whisper',text='今天心情不错')=>{state.life.events.push(event('request-'+id,'interaction.requested','scheduler','',{payload:{kind}}),event(id,'conversation.assistant','desktop',text,{causationId:'request-'+id}));};
  return {state,event,intents,authority,qq,expression};
}

test('forwards only new proactive expression text without a QQ reply window',async()=>{
  const f=fixture();f.expression('old');f.state.life.events.forEach(e=>e.receivedAt=new Date(Date.now()-10000).toISOString());await f.qq.enableRelay('main');
  f.state.life.events.push(f.event('u','conversation.user','desktop','你好'),f.event('a','conversation.assistant','desktop','普通回复',{causationId:'u'}));
  f.expression('new','whisper','今天心情不错');const id=await f.qq.enqueueNextRelay('main',f.authority);assert.ok(id);
  const action=f.state.life.actions.find(a=>a.id===id);assert.equal(action.parameters.content,'今天心情不错');assert.equal(action.parameters.replyTo,undefined);assert.deepEqual(action.sourceIds,['new']);
  assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
  const life={...f.state.life,petId:'main',version:f.state.version,body:{},emotions:{}};
  assert.throws(()=>validateQQReply(f.state,life,{...action,expectedStateVersion:f.state.version,parameters:{...action.parameters,content:'tampered'}}),/来源无效/);
  const sent=[];const execute=createQQExecutor({send:async input=>{sent.push(input);return {messageId:'receipt'};}});
  assert.equal((await execute('main',f.intents[0],new AbortController().signal)).status,'completed');assert.equal(sent[0].replyTo,undefined);
});

test('ignores expired, deleted, unrelated and unfunded expressions',async()=>{
  const f=fixture();await f.qq.enableRelay('main');f.expression('expired');f.state.life.events.at(-1).receivedAt=new Date(Date.now()-121000).toISOString();f.expression('deleted');f.state.life.invalidSources['request-deleted']='removed';f.expression('other','help');
  assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);f.expression('unfunded','physical');f.state.legacy.wallet.balance=0;assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
});

test('attempts share a durable six-hour and two-per-day budget, including unknown results',async()=>{
  const f=fixture();await f.qq.enableRelay('main');f.expression('first');assert.ok(await f.qq.enqueueNextRelay('main',f.authority));const first=Object.values(f.state.legacy.qq.outbound)[0];first.state='unknown';f.expression('second','care');assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
  Object.values(f.state.legacy.qq.outbound)[0].at=Date.now()-6*60*60*1000-1000;assert.ok(await f.qq.enqueueNextRelay('main',f.authority));const second=Object.values(f.state.legacy.qq.outbound)[1];second.at=Date.now()-6*60*60*1000-1000;f.expression('third','worksite');assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
});

test('gateway posts proactive messages without a reply id or sequence',async()=>{
  const {CanonicalQQGateway}=await import('../dist/host/qq-gateway.js');
  const controller=new AbortController(),calls=[];
  const gateway=new CanonicalQQGateway({config:{enabled:true,appId:'app',appSecret:'secret'},canonical:{},ingressAuthority:{},signal:controller.signal,onTurn:async()=>null,dispatch:async()=>{}});
  gateway.token=async()=> 'token';gateway.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({id:'sent'})};};
  try {
    const intent={id:'send',type:'qq.send',payload:{petId:'main',actionId:'send',parameters:{scene:'c2c',destination:'owner',content:'早上好',proactive:true}}};
    assert.equal((await gateway.executor('main',intent,controller.signal)).status,'completed');
    assert.match(calls[0].url,/\/v2\/users\/owner\/messages$/);assert.deepEqual(calls[0].body,{content:'早上好',msg_type:0});
  } finally {controller.abort();gateway.stop();}
});
