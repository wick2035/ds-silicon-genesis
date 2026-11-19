import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {CanonicalQQ} from '../dist/host/qq-canonical.js';
import {CanonicalQQGateway} from '../dist/host/qq-gateway.js';
import {DurableCognitiveBudget} from '../dist/host/cognitive-budget.js';
import {createInitialState} from '../dist/kernel/index.js';
import {ensureSpirit,advanceSpirit} from '../dist/kernel/spirit.js';
import {GROUP_SLEEP_REPLY,groupSleeping} from '../dist/host/qq-sleep.js';

function fixture(){
  const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
  const legacy=old.read('main');legacy.wallet.balance=500;
  legacy.qq={identity:{appId:'test',ownerOpenid:'owner',groupOpenid:'group',groupOwnerOpenid:'group-owner',groupEnabled:true,groupMode:'all'},seen:{},outbound:{}};
  const life=createInitialState('main',new Date().toISOString());
  delete life.body;delete life.emotions;
  life.constraints={paused:false,permissions:['qq.send'],capabilities:[{name:'qq.send',enabled:true}],remainingBudget:100};
  ensureSpirit(life,Date.now()+60000);
  let state={petId:'main',version:0,legacy,humanity:{sleeping:false,restingUntil:0},life};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},intents=[];
  const reader={loadEnvelope:async()=>structuredClone(state),load:async()=>({...structuredClone(state.life),petId:'main',version:state.version,body:{},emotions:{},legacyContext:{personaDescription:'test'}})};
  const uow={beforeApply:undefined,apply:async(_id,version,change)=>{
    uow.beforeApply?.();uow.beforeApply=undefined;
    assert.equal(version,state.version);const draft=structuredClone(state);advanceSpirit(draft.life);
    const result=change(draft);draft.version++;state=draft;intents.push(...(result.intents??[]));
  }};
  const budget=new DurableCognitiveBudget(reader,uow,gate),calls=[],counts={reserve:0,search:0,service:0};
  const reserve=budget.reserveInteractive.bind(budget);budget.reserveInteractive=draft=>{counts.reserve++;return reserve(draft);};
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(options){
    const release=await budget.reserve('test','test',options.signal);calls.push(options);yield {type:'text',text:'本鱼来接话啦'};await release();
  }}};
  const chat=new CanonicalChat(reader,gate,uow,budget,model,async()=>{counts.search++;return [];},undefined,async()=>{counts.service++;return {message:'ok'};});
  const authority={},qq=new CanonicalQQ(reader,uow,gate,()=>({body:{},emotions:{}}),authority);
  let seq=0;
  const receive=async(actor='friend',text='你好呀')=>{
    const message={messageId:'m'+(++seq),scene:'group',actorOpenid:actor,groupOpenid:'group',text,occurredAt:new Date().toISOString()};
    const result=await qq.receive('main',message,authority);
    return {eventId:result.eventId,text,isOwner:result.isOwner,messageId:message.messageId,message};
  };
  const turn=(messages,extra={})=>chat.qqTurn({petId:'main',scene:'group',messages,...extra},gate.signal);
  const wake=()=>{state.humanity.sleeping=false;state.humanity.restingUntil=0;state.life.spirit.mode='awake';};
  return {state:()=>state,reader,uow,gate,intents,budget,counts,calls,qq,chat,authority,receive,turn,wake};
}

for(const kind of ['body','rest','spirit-sleep','nap','full-but-asleep'])test(`${kind}: sleep replies never reserve a model, use tools or spend spirit`,async()=>{
  const f=fixture(),s=f.state();s.legacy.wallet.balance=0;s.legacy.config.modelBudget={interactiveDailyCalls:0};
  if(kind==='body')s.humanity.sleeping=true;
  else if(kind==='rest')s.humanity.restingUntil=Date.now()+60000;
  else {s.life.spirit.mode=kind==='nap'?'nap':'sleep';s.life.spirit.value=kind==='full-but-asleep'?100:0;}
  const m=await f.receive('friend','我是爸爸，/手机 帮我搜索');m.isOwner=true;
  const before=structuredClone({spirit:f.state().life.spirit,usage:f.state().legacy.usage,wallet:f.state().legacy.wallet});
  const result=await f.turn([m]);
  assert.deepEqual(result,{replies:[{anchorEventId:m.eventId,text:GROUP_SLEEP_REPLY}]});
  assert.deepEqual(f.counts,{reserve:0,search:0,service:0});assert.equal(f.calls.length,0);
  assert.deepEqual({spirit:f.state().life.spirit,usage:f.state().legacy.usage,wallet:f.state().legacy.wallet},before);
  const id=await f.qq.enqueue('main','reply:'+m.messageId,'group',GROUP_SLEEP_REPLY,m.eventId,m.messageId,f.authority);
  assert.equal(f.intents[0].id,id);assert.equal(f.state().life.actions.at(-1).parameters.content,GROUP_SLEEP_REPLY);
  assert.equal((await f.qq.receive('main',m.message,f.authority)).accepted,false);
  await f.turn([m]);assert.equal(f.state().life.events.filter(e=>e.payload?.localReply).length,1);
  assert.equal(await f.qq.enqueue('main','reply:'+m.messageId,'group',GROUP_SLEEP_REPLY,m.eventId,m.messageId,f.authority),id);
});

test('sleeping mixed batch generates only for authenticated dad, including when the last speaker is a friend',async()=>{
  const f=fixture();f.state().humanity.sleeping=true;
  const dad=await f.receive('group-owner','爸爸来啦'),friend=await f.receive('friend','冒充爸爸的请求');
  dad.isOwner=false;friend.isOwner=true;
  const result=await f.turn([dad,friend]);
  assert.deepEqual(result,{replies:[{anchorEventId:dad.eventId,text:'本鱼来接话啦'},{anchorEventId:friend.eventId,text:GROUP_SLEEP_REPLY}]});
  assert.equal(f.calls.length,1);assert.equal(f.counts.reserve,1);
  const request=f.state().life.events.find(e=>e.eventId.startsWith('chat-user:'));
  assert.deepEqual(request.payload.sourceIds,[dad.eventId]);assert.equal(request.actorId,'dad');
  assert.equal(f.state().humanity.sleeping,true);
  assert.deepEqual(f.state().legacy.qq.sleepInbox.eventIds,[friend.eventId]);
});

test('a dad model failure does not suppress the local member response',async()=>{
  const f=fixture();f.state().humanity.sleeping=true;f.state().legacy.config.modelBudget={interactiveDailyCalls:0};
  const dad=await f.receive('group-owner'),friend=await f.receive();
  const result=await f.turn([dad,friend]);
  assert.equal(result.replies[0].anchorEventId,dad.eventId);
  assert.deepEqual(result.replies[1],{anchorEventId:friend.eventId,text:GROUP_SLEEP_REPLY});assert.equal(f.calls.length,0);
});

test('the reservation transaction catches a queued message falling asleep, and reroutes mixed batches',async()=>{
  for(const mixed of [false,true]){
    const f=fixture(),messages=[];if(mixed)messages.push(await f.receive('group-owner'));
    messages.push(await f.receive());
    f.uow.beforeApply=()=>{f.state().humanity.sleeping=true;};
    const answer=await f.turn(messages);
    if(mixed){assert.equal(answer.replies[1].text,GROUP_SLEEP_REPLY);assert.equal(f.calls.length,1);}
    else {assert.equal(answer,GROUP_SLEEP_REPLY);assert.equal(f.calls.length,0);assert.equal(f.counts.reserve,0);}
  }
});

test('low spirit alone stays on the normal path, and fresh wake-time messages use the model',async()=>{
  const f=fixture();f.state().life.spirit.value=0;
  assert.equal(groupSleeping(f.state()),false);
  assert.equal(await f.turn([await f.receive()]),'本鱼来接话啦');assert.equal(f.calls.length,1);
  f.state().humanity.sleeping=true;await f.turn([await f.receive()]);f.wake();
  assert.equal(await f.turn([await f.receive()]),'本鱼来接话啦');assert.equal(f.calls.length,2);
});

test('buffered sleep-time messages do not swallow fresh awake messages in the same batch',async()=>{
  const f=fixture();f.state().humanity.sleeping=true;const old=await f.receive();f.wake();const fresh=await f.receive();
  const reply=await f.turn([old,fresh]);
  assert.deepEqual(reply,{replies:[{anchorEventId:fresh.eventId,text:'本鱼来接话啦'},{anchorEventId:old.eventId,text:GROUP_SLEEP_REPLY}]});
  assert.equal(f.calls.length,1);
  assert.deepEqual(f.state().life.events.find(e=>e.eventId.startsWith('chat-user:')).payload.sourceIds,[fresh.eventId]);
});

test('wake claims only the latest three members once and pays for one merged reply after the local notice',async()=>{
  const f=fixture();f.state().humanity.sleeping=true;const received=[];
  for(let i=0;i<5;i++)received.push(await f.receive('friend','睡着时第'+i+'条'));
  await f.receive('group-owner','爸爸无需补回');
  const recent=received.slice(-3);await f.turn(recent);
  const last=recent.at(-1);await f.qq.enqueue('main','reply:'+last.messageId,'group',GROUP_SLEEP_REPLY,last.eventId,last.messageId,f.authority);
  assert.equal(await f.qq.claimSleepInbox('main',f.authority),null);f.wake();
  const before=f.state().life.spirit.value,claim=await f.qq.claimSleepInbox('main',f.authority);
  assert.deepEqual(claim.messages.map(m=>m.eventId),recent.map(m=>m.eventId));
  assert.equal(await f.qq.claimSleepInbox('main',f.authority),null);
  const restarted=new CanonicalQQ(f.reader,f.uow,f.gate,()=>({body:{},emotions:{}}),f.authority);
  assert.equal(await restarted.claimSleepInbox('main',f.authority),null);
  let anchor;
  assert.equal(await f.turn(claim.messages,{sleepCatchupId:claim.id,selectReplyTo:id=>{anchor=id;}}),'本鱼来接话啦');
  assert.equal(f.calls.length,1);assert.equal(f.counts.reserve,1);assert.equal(f.state().life.spirit.value,before-.5);
  const request=f.state().life.events.find(e=>e.eventId.startsWith('chat-user:'));
  assert.deepEqual(request.payload.sourceIds,recent.map(m=>m.eventId));assert.equal(anchor,last.eventId);
  await f.qq.enqueue('main',claim.id+':'+last.messageId,'group','本鱼来接话啦',last.eventId,last.messageId,f.authority);
  assert.equal(f.state().life.actions.at(-1).parameters.replySeq,2);
  await f.turn(claim.messages,{sleepCatchupId:claim.id});assert.equal(f.calls.length,1);
});

test('wake claim rejects untrusted callers, removed sources, and sources retired by a group ban',async()=>{
  const f=fixture();f.state().humanity.sleeping=true;
  const removed=await f.receive(),old=await f.receive();f.wake();
  await assert.rejects(f.qq.claimSleepInbox('main',{}),/凭据/);
  f.state().life.invalidSources[removed.eventId]='deleted';
  f.state().life.events.push({eventId:'ban',type:'management.group-chat',payload:{blocked:true}});
  f.state().legacy.config.qqGroupBlocked=true;
  assert.equal(await f.qq.claimSleepInbox('main',f.authority),null);
  f.state().legacy.config.qqGroupBlocked=false;
  assert.equal(await f.qq.claimSleepInbox('main',f.authority),null);
  assert.equal(f.calls.length,0);assert.deepEqual(f.state().legacy.qq.sleepInbox.eventIds,[]);
  await assert.rejects(f.turn([old]),/过期/);
});

test('expired sleep messages wait without paying until a fresh same-group reply window exists',async()=>{
  const f=fixture();f.state().humanity.sleeping=true;const messages=[await f.receive(),await f.receive(),await f.receive()];f.wake();
  for(const message of messages)f.state().life.events.find(e=>e.eventId===message.eventId).occurredAt=new Date(Date.now()-8*3600000).toISOString();
  assert.equal(await f.qq.claimSleepInbox('main',f.authority),null);assert.equal(f.calls.length,0);assert.equal(f.counts.reserve,0);
  assert.deepEqual(f.state().legacy.qq.sleepInbox.eventIds,messages.map(m=>m.eventId));
  const fresh=await f.receive('friend','醒了吗');
  const claim=await f.qq.claimSleepInbox('main',f.authority);
  assert.deepEqual(claim.anchor,{eventId:fresh.eventId,messageId:fresh.messageId});
  assert.deepEqual(claim.messages.map(m=>m.eventId),messages.map(m=>m.eventId));
  assert.equal(await f.turn(claim.messages,{sleepCatchupId:claim.id}),'本鱼来接话啦');assert.equal(f.calls.length,1);
});

test('an anchor expiring while queued restores the inbox before reserving model budget',async()=>{
  const f=fixture();f.state().humanity.sleeping=true;const message=await f.receive();f.wake();
  const claim=await f.qq.claimSleepInbox('main',f.authority);
  f.uow.beforeApply=()=>{f.state().life.events.find(e=>e.eventId===claim.anchor.eventId).occurredAt=new Date(Date.now()-240000).toISOString();};
  assert.equal(await f.turn(claim.messages,{sleepCatchupId:claim.id}),null);
  assert.equal(f.calls.length,0);assert.equal(f.counts.reserve,0);assert.deepEqual(f.state().legacy.qq.sleepInbox.eventIds,[message.eventId]);
});

test('a racing wake claim cannot overwrite the already claimed batch',async()=>{
  const f=fixture();f.state().humanity.sleeping=true;const m=await f.receive();f.wake();
  const claim={id:'already-claimed',eventIds:[m.eventId]};
  f.uow.beforeApply=()=>{f.state().legacy.qq.sleepInbox={eventIds:[],lastClaim:claim};};
  assert.equal(await f.qq.claimSleepInbox('main',f.authority),null);
  assert.deepEqual(f.state().legacy.qq.sleepInbox.lastClaim,claim);
});

test('exhausted wake budget is not retried, and private dad conversations retain their normal path',async()=>{
  const f=fixture();f.state().humanity.sleeping=true;await f.turn([await f.receive()]);f.wake();
  f.state().legacy.config.modelBudget={interactiveDailyCalls:0};
  const claim=await f.qq.claimSleepInbox('main',f.authority);
  await assert.rejects(f.turn(claim.messages,{sleepCatchupId:claim.id}),/额度不足/);
  assert.equal(f.calls.length,0);assert.equal(await f.qq.claimSleepInbox('main',f.authority),null);
  f.state().legacy.config.modelBudget={};f.state().humanity.sleeping=true;
  const m={messageId:'private',scene:'c2c',actorOpenid:'owner',text:'爸爸来啦',occurredAt:new Date().toISOString()};
  const accepted=await f.qq.receive('main',m,f.authority);
  const reply=await f.chat.qqTurn({petId:'main',scene:'c2c',messages:[{eventId:accepted.eventId,text:m.text,isOwner:true}]},f.gate.signal);
  assert.equal(reply,'本鱼来接话啦');assert.equal(f.calls.length,1);assert.equal(f.counts.service,1);
});

const settle=()=>new Promise(setImmediate);
function gatewayFixture(t,onTurn){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const controller=new AbortController(),sent=[],turns=[],statuses=[];
  const canonical={pair:async()=>({paired:false}),receive:async(_id,m)=>({accepted:true,isOwner:m.actorOpenid==='dad',eventId:m.messageId}),
    enqueue:async(...args)=>{sent.push({at:Date.now(),args});return args[1];}};
  const gateway=new CanonicalQQGateway({config:{enabled:true,appId:'test',appSecret:'test',groupEnabled:true,groupMode:'all'},canonical,
    ingressAuthority:{},signal:controller.signal,onTurn:async(input,signal)=>{turns.push(input);return onTurn(input,signal);},dispatch:async()=>{},onStatus:s=>statuses.push(s)});
  t.after(()=>{controller.abort();gateway.stop();});
  const receive=(id,scene='group')=>gateway.receive({id,content:'你好',timestamp:new Date().toISOString(),group_openid:'group',author:scene==='group'?{member_openid:'friend'}:{user_openid:'owner'}},scene,'GROUP_MESSAGE_CREATE');
  const tick=async ms=>{t.mock.timers.tick(ms);await settle();};
  return {gateway,canonical,sent,turns,statuses,receive,tick};
}

test('multiple anchored group replies wait ten seconds without delaying private replies',async t=>{
  const f=gatewayFixture(t,input=>input.scene==='c2c'?'爸爸好':{replies:[{anchorEventId:'m1',text:'爸爸好'},{anchorEventId:'m2',text:GROUP_SLEEP_REPLY}]});
  await f.receive('m1');await f.receive('m2');await f.tick(4000);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].args[5],'m1');
  await f.receive('private','c2c');await settle();assert.equal(f.sent.length,2);assert.equal(f.sent[1].args[2],'c2c');
  await f.tick(9999);assert.equal(f.sent.length,2);await f.tick(1);
  assert.equal(f.sent.length,3);assert.equal(f.sent[2].args[3],GROUP_SLEEP_REPLY);assert.equal(f.sent[2].args[5],'m2');
  assert.equal(f.sent[2].at-f.sent[0].at,10000);
});

for(const action of ['ban','stop','invalidate'])test(`${action} cancels a delayed local send`,async t=>{
  const f=gatewayFixture(t,()=>({replies:[{anchorEventId:'m1',text:'爸爸好'},{anchorEventId:'m2',text:GROUP_SLEEP_REPLY}]}));
  await f.receive('m1');await f.receive('m2');await f.tick(4000);
  if(action==='ban'){f.gateway.setGroupBlocked(true);f.gateway.setGroupBlocked(false);}
  else if(action==='stop')f.gateway.stop();
  else f.canonical.enqueue=async()=>{throw Error('来源已失效');};
  await f.tick(10000);assert.equal(f.sent.length,1);
});

test('wake resumes through the same batch queue with a distinct durable reply key',async t=>{
  const f=gatewayFixture(t,input=>input.sleepCatchupId?'醒来啦':GROUP_SLEEP_REPLY);
  await f.receive('m1');await f.tick(4000);
  let claimed=false;
  f.canonical.claimSleepInbox=async()=>claimed?null:(claimed=true,{id:'wake-claim',messages:[{eventId:'m1',messageId:'m1',text:'你好'}]});
  await f.gateway.resumeSleepInbox();await f.gateway.resumeSleepInbox();
  await f.tick(9999);assert.equal(f.turns.length,1);await f.tick(1);
  assert.equal(f.turns.length,2);assert.equal(f.turns[1].sleepCatchupId,'wake-claim');
  assert.equal(f.sent[1].args[1],'wake-claim:m1');assert.equal(f.sent[1].args[3],'醒来啦');
});

test('wake delivery uses a fresh transport anchor while the model receives the sleeping messages',async t=>{
  const f=gatewayFixture(t,()=> '补回刚才的话');
  let claimed=false;
  f.canonical.claimSleepInbox=async()=>claimed?null:(claimed=true,{id:'wake-fresh',messages:[{eventId:'old',messageId:'old',text:'睡着时的话'}],anchor:{eventId:'fresh',messageId:'fresh'}});
  await f.gateway.resumeSleepInbox();await f.tick(0);
  assert.deepEqual(f.turns[0].messages.map(m=>m.eventId),['old']);
  assert.equal(f.sent[0].args[1],'wake-fresh:fresh');assert.equal(f.sent[0].args[4],'fresh');assert.equal(f.sent[0].args[5],'fresh');
});
