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

test('busy group batches four messages per reply and respects delivery cooldown',async t=>{
  const f=fixture(t);
  for(let i=0;i<12;i++)await f.receive();
  await f.tick(0);
  assert.deepEqual(f.turns.map(batch=>batch.length),[4]);
  await f.tick(9999);assert.equal(f.sent.length,1);
  await f.tick(1);assert.deepEqual(f.turns.map(batch=>batch.length),[4,4]);
  await f.tick(10000);assert.deepEqual(f.turns.map(batch=>batch.length),[4,4,4]);
  assert.deepEqual(f.turns.flat().map(m=>m.eventId),Array.from({length:12},(_,i)=>'m'+(i+1)));
});

test('quiet group gets a turn after four seconds without filling a batch',async t=>{
  const f=fixture(t);await f.receive();
  await f.tick(3999);assert.equal(f.turns.length,0);
  await f.tick(1);assert.equal(f.turns[0].length,1);
});

test('new messages wait for the current generation and its send cooldown',async t=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,()=>pending);
  for(let i=0;i<4;i++)await f.receive();
  await f.tick(0);
  for(let i=0;i<4;i++)await f.receive();
  await f.tick(20000);assert.equal(f.turns.length,1);
  release('本鱼来啦');await settle();
  await f.tick(9999);assert.equal(f.turns.length,1);
  await f.tick(1);assert.equal(f.turns.length,2);
});

test('stop cancels pending group timers',async t=>{
  const f=fixture(t);await f.receive();f.gateway.stop();
  await f.tick(30000);assert.equal(f.turns.length,0);assert.equal(f.sent.length,0);
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
