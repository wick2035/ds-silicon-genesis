import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalQQGateway} from '../dist/host/qq-gateway.js';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,onTurn) {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const controller=new AbortController(),turns=[],sent=[];
  const gateway=new CanonicalQQGateway({config:{enabled:true,appId:'test',appSecret:'test',groupEnabled:true,groupMode:'all'},
    canonical:{pair:async()=>({paired:false}),receive:async(_pet,message)=>({accepted:true,isOwner:false,eventId:message.messageId}),
      enqueue:async(...args)=>{sent.push(args);return args[1];}},ingressAuthority:{},signal:controller.signal,
    onTurn:async(input,signal)=>{turns.push(input.messages);return onTurn?onTurn(input,signal):'本鱼也来聊聊';},dispatch:async()=>{}});
  t.after(()=>{controller.abort();gateway.stop();});
  let seq=0;
  const receive=()=>gateway.receive({id:'m'+(++seq),content:'消息'+seq,timestamp:new Date().toISOString(),group_openid:'group',author:{member_openid:'friend'}},'group','GROUP_MESSAGE_CREATE');
  const tick=async ms=>{t.mock.timers.tick(ms);await settle();};
  return {gateway,turns,sent,receive,tick};
}

test('busy group coalesces the whole waiting burst instead of replaying old batches',async t=>{
  const f=fixture(t);
  for(let i=0;i<12;i++)await f.receive();
  await f.tick(0);
  assert.deepEqual(f.turns.map(batch=>batch.length),[12]);
  await f.tick(20000);assert.equal(f.sent.length,1);assert.equal(f.turns.length,1);
  assert.deepEqual(f.turns.flat().map(m=>m.eventId),Array.from({length:12},(_,i)=>'m'+(i+1)));
  assert.equal(f.sent[0][5],'m12');
});

test('quiet group gets a turn after one second without filling a batch',async t=>{
  const f=fixture(t);await f.receive();
  await f.tick(999);assert.equal(f.turns.length,0);
  await f.tick(1);assert.equal(f.turns[0].length,1);
});

test('send uses the chosen eligible batch message as the QQ reply anchor',async t=>{
  const f=fixture(t,input=>{input.selectReplyTo('not-in-this-batch');input.selectReplyTo('m2');return '在这儿';});
  for(let i=0;i<4;i++)await f.receive();
  await f.tick(0);
  assert.equal(f.sent.length,1);
  assert.deepEqual(f.sent[0].slice(1,6),['reply:m2','group','在这儿','m2','m2']);
});

test('new messages supersede the unsent generation and are considered together next',async t=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,()=>pending);
  for(let i=0;i<4;i++)await f.receive();
  await f.tick(0);
  for(let i=0;i<4;i++)await f.receive();
  await f.tick(20000);assert.equal(f.turns.length,1);
  release('本鱼来啦');await settle();
  assert.equal(f.sent.length,0);
  await f.tick(0);assert.equal(f.turns.length,2);
  assert.deepEqual(f.turns[1].map(m=>m.eventId),['m5','m6','m7','m8']);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][5],'m8');
});

test('generation overlaps cooldown while actual group sends remain ten seconds apart',async t=>{
  const f=fixture(t);await f.receive();await f.tick(1000);
  await f.receive();await f.tick(1000);
  assert.equal(f.turns.length,2);assert.equal(f.sent.length,1);
  await f.tick(8999);assert.equal(f.sent.length,1);
  await f.tick(1);assert.equal(f.sent.length,2);
});

test('a newer message replaces an unsent cooldown draft without resending it',async t=>{
  const f=fixture(t);await f.receive();await f.tick(1000);
  await f.receive();await f.tick(1000);assert.equal(f.turns.length,2);
  await f.receive();await f.tick(1000);assert.equal(f.turns.length,3);
  await f.tick(8000);
  assert.deepEqual(f.sent.map(args=>args[5]),['m1','m3']);
});

test('group batch is captured after the private lane clears, including later messages',async t=>{
  let release;
  const privateTurn=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,input=>input.scene==='c2c'?privateTurn:'跟上啦');
  await f.gateway.receive({id:'private',content:'你好',timestamp:new Date().toISOString(),author:{user_openid:'owner'}});
  await settle();
  for(let i=0;i<4;i++)await f.receive();await f.tick(0);
  for(let i=0;i<4;i++)await f.receive();
  release('爸爸好');await settle();
  assert.deepEqual(f.turns.map(batch=>batch.length),[1,8]);
  assert.equal(f.sent.at(-1)[5],'m8');
});

test('an overflowing burst keeps the newest 24 messages in one bounded turn',async t=>{
  const f=fixture(t);for(let i=0;i<40;i++)await f.receive();await f.tick(0);
  assert.equal(f.turns.length,1);assert.equal(f.turns[0].length,24);
  assert.equal(f.turns[0][0].eventId,'m17');assert.equal(f.sent[0][5],'m40');
});

test('stop cancels pending group timers',async t=>{
  const f=fixture(t);await f.receive();f.gateway.stop();
  await f.tick(30000);assert.equal(f.turns.length,0);assert.equal(f.sent.length,0);
});

test('structured mentions yield to new input during generation',async t=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,()=>pending);for(let i=0;i<4;i++)await f.receive();await f.tick(0);
 await f.receive();release({replies:[{anchorEventId:'m2',text:'请回答',mentionActorId:'qq-member:friend',freshOnly:true}]});await settle();
 assert.equal(f.sent.length,0);
});

test('structured mentions retain their selected reply anchor',async t=>{
 const g=fixture(t,()=>({replies:[{anchorEventId:'m2',text:'请回答',mentionActorId:'qq-member:friend',freshOnly:true}]}));
 for(let i=0;i<4;i++)await g.receive();await g.tick(0);
 assert.equal(g.sent[0][5],'m2');assert.equal(g.sent[0][7],'qq-member:friend');
});

test('structured mention drafts waiting for cooldown are discarded',async t=>{
 const f=fixture(t,input=>({replies:[{anchorEventId:input.messages.at(-1).eventId,text:'请回答',mentionActorId:'qq-member:friend',freshOnly:true}]}));
 for(let i=0;i<4;i++)await f.receive();await f.tick(0);assert.equal(f.sent.length,1);
 for(let i=0;i<4;i++)await f.receive();await f.tick(0);assert.equal(f.sent.length,1);
 await f.receive();await f.tick(1000);await f.tick(9000);
 assert.equal(f.sent.length,2);assert.equal(f.sent[1][5],'m9');
});

test('group ban discards buffered and prohibited messages while private QQ stays available',async t=>{
  const f=fixture(t);await f.receive();f.gateway.setGroupBlocked(true);
  await f.receive();await f.tick(20000);assert.equal(f.turns.length,0);
  await f.gateway.receive({id:'private',content:'爸爸来了',timestamp:new Date().toISOString(),author:{user_openid:'owner'}});
  await settle();assert.equal(f.sent.length,1);assert.equal(f.sent[0][2],'c2c');
  f.gateway.setGroupBlocked(false);await f.tick(20000);assert.equal(f.turns.length,1);
  await f.receive();await f.tick(4000);assert.equal(f.turns.length,2);
  assert.deepEqual(f.turns[1].map(m=>m.eventId),['m3']);
});

test('group ban aborts generation and prevents old output even after restoring access',async t=>{
  let release,groupSignal;
  const pending=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,(input,signal)=>{if(input.scene==='group'){groupSignal=signal;return pending;}return '爸爸好';});
  for(let i=0;i<4;i++)await f.receive();await f.tick(0);
  f.gateway.setGroupBlocked(true);assert.equal(groupSignal.aborted,true);
  f.gateway.setGroupBlocked(false);release('不该发出去');await settle();
  assert.equal(f.sent.length,0);
});
