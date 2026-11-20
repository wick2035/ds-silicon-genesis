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
  return {state,event,intents,authority,qq,expression,reader,uow,gate};
}

test('ordinary chat and cooldown checks never rewrite the archive or advance its version',async()=>{
  const f=fixture();await f.qq.enableRelay('main');
  f.state.life.events.push(f.event('group','social.message','qq','你好'),f.event('answer','conversation.assistant','qq-group','本鱼来啦'));
  const before=JSON.stringify(f.state);
  assert.equal(f.qq.hasPendingRelay(f.state),false);
  for(let i=0;i<5;i++)assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
  assert.equal(JSON.stringify(f.state),before);
  f.expression('new');assert.equal(f.qq.hasPendingRelay(f.state),true);
  await f.qq.enqueueNextRelay('main',f.authority);
  const version=f.state.version;
  f.expression('later');assert.equal(f.qq.hasPendingRelay(f.state),false);
  assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
  assert.equal(f.state.version,version);assert.equal(f.intents.length,1);
});

test('relay rechecks the latest locked balance after a successful preflight',async()=>{
  const f=fixture();await f.qq.enableRelay('main');f.expression('new');
  f.uow.applyCurrent=async(_id,change)=>{f.state.legacy.wallet.balance=0;change(f.state);};
  assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
  assert.equal(f.intents.length,0);
});

test('QQ ingress uses the locked current state without a redundant archive read',async()=>{
  const f=fixture();f.state.life.relationships=[];
  f.reader.loadEnvelope=async()=>{throw Error('redundant archive read');};
  f.uow.applyCurrent=async(_id,change)=>{const draft=structuredClone(f.state);change(draft);draft.version++;Object.assign(f.state,draft);};
  const result=await f.qq.receive('main',{messageId:'m1',scene:'c2c',actorOpenid:'owner',text:'你好',occurredAt:new Date().toISOString()},f.authority);
  assert.equal(result.accepted,true);assert.equal(f.state.life.events.length,1);
});

test('group access reads only settings and fails closed on read errors',async()=>{
  const f=fixture();f.reader.loadEnvelope=async()=>{throw Error('redundant archive read');};
  f.reader.loadLifeSettings=async()=>({groupChatBlocked:true});assert.equal(await f.qq.groupBlocked('main'),true);
  f.reader.loadLifeSettings=async()=>({groupChatBlocked:false});assert.equal(await f.qq.groupBlocked('main'),false);
  f.reader.loadLifeSettings=async()=>{throw Error('settings unavailable');};await assert.rejects(f.qq.groupBlocked('main'),/settings unavailable/);
});

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

test('真实完工后的主动通知走已启用的 QQ 转发，仍受原发送条件约束',async()=>{
  const f=fixture();await f.qq.enableRelay('main');f.expression('completion-notice','completion','爸爸，本鱼搬完啦。');
  assert.equal(typeof await f.qq.enqueueNextRelay('main',f.authority),'string');
  assert.equal(f.state.life.actions.at(-1).parameters.content,'爸爸，本鱼搬完啦。');
});

test('ignores expired, deleted and unrelated expressions; zero rice money prevents proactive contact',async()=>{
  const f=fixture();await f.qq.enableRelay('main');f.expression('expired');f.state.life.events.at(-1).receivedAt=new Date(Date.now()-121000).toISOString();f.expression('deleted');f.state.life.invalidSources['request-deleted']='removed';f.expression('other','help');
  assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);f.expression('unfunded','physical');f.state.legacy.wallet.balance=0;assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
});

test('attempts share a durable two-hour interval including unknown results, without the old daily cap',async()=>{
  const f=fixture();await f.qq.enableRelay('main');f.expression('first');assert.ok(await f.qq.enqueueNextRelay('main',f.authority));const first=Object.values(f.state.legacy.qq.outbound)[0];first.state='unknown';f.expression('second','care');assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
  Object.values(f.state.legacy.qq.outbound)[0].at=Date.now()-2*60*60*1000-1000;assert.ok(await f.qq.enqueueNextRelay('main',f.authority));const second=Object.values(f.state.legacy.qq.outbound)[1];second.at=Date.now()-2*60*60*1000-1000;f.expression('third','worksite');assert.ok(await f.qq.enqueueNextRelay('main',f.authority));
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


test('charges 0.2 per sentence once, caps at three, and ignores daily freeze',async()=>{
  const f=fixture();await f.qq.enableRelay('main');f.state.legacy.wallet={balance:0.6,frozen:true};
  f.expression('priced','whisper','想爸爸了。今天很开心！想聊聊天？第四句。');
  const id=await f.qq.enqueueNextRelay('main',f.authority);assert.ok(id);
  assert.equal(f.state.life.actions.find(a=>a.id===id).parameters.content,'想爸爸了。今天很开心！想聊聊天？');
  assert.equal(f.state.legacy.wallet.balance,0);
  assert.equal(f.state.life.events.filter(e=>e.type==='wallet.spend').length,1);
  assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
  assert.equal(f.state.legacy.wallet.balance,0);
});

test('insufficient balance never queues or charges a multi-sentence contact',async()=>{
  const f=fixture();await f.qq.enableRelay('main');f.state.legacy.wallet.balance=0.39;
  f.expression('too-expensive','whisper','第一句。第二句。');
  assert.equal(await f.qq.enqueueNextRelay('main',f.authority),null);
  assert.equal(f.state.legacy.wallet.balance,0.39);assert.equal(f.intents.length,0);
});

test('one QQ incoming message permits at most three replies, with idempotent replay',async()=>{
  const f=fixture(),source=f.event('incoming','social.message','qq','你好',{payload:{messageId:'message',scene:'c2c'}});
  f.state.life.events.push(source);
  for(let i=1;i<=3;i++)await f.qq.enqueue('main','reply-'+i,'c2c','回复'+i,'incoming','message',f.authority);
  assert.deepEqual(f.state.life.actions.map(a=>a.parameters.replySeq),[1,2,3]);
  await f.qq.enqueue('main','reply-3','c2c','回复3','incoming','message',f.authority);
  await assert.rejects(()=>f.qq.enqueue('main','reply-4','c2c','第四条','incoming','message',f.authority),/最多三条/);
  assert.equal(f.intents.length,3);assert.equal(f.state.legacy.wallet.balance,100);
});
