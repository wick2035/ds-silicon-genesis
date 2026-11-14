import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalQQGateway} from '../dist/host/qq-gateway.js';

function fixture(t,onTurn,dispatchImpl=async()=>{}) {
  const calls=[],statuses=[],controller=new AbortController();
  let resolveDispatch;
  const dispatched=new Promise(resolve=>{resolveDispatch=resolve;});
  const canonical={
    pair:async()=>({paired:false}),
    receive:async()=>({accepted:true,isOwner:true,eventId:'source-event'}),
    enqueue:async(...args)=>{calls.push(args);return 'action-id';}
  };
  const gateway=new CanonicalQQGateway({config:{enabled:true,appId:'123',appSecret:'test',petId:'main'},canonical,ingressAuthority:{},signal:controller.signal,onTurn,
    dispatch:async id=>{try{return await dispatchImpl(id);}finally{resolveDispatch();}},onStatus:status=>statuses.push(status)});
  t.after(()=>{controller.abort();gateway.stop();});
  return {gateway,calls,statuses,dispatched};
}
const message=()=>({id:'message-id',content:'hello',timestamp:new Date().toISOString(),author:{user_openid:'owner'}});

test('a zero wallet produces an actionable private reply',async t=>{
  const f=fixture(t,async()=>{throw Error('模拟饭钱已用完，请先添加饭钱');});
  await f.gateway.receive(message());await f.dispatched;
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0][2],'c2c');
  assert.match(f.calls[0][3],/饭钱用完/);
  assert.equal(f.calls[0][4],'source-event');
  assert.ok(f.statuses.includes('message-failed'));
});

test('unexpected errors get a safe reply without exposing error text',async t=>{
  const f=fixture(t,async()=>{throw Error('private-provider-error');});
  await f.gateway.receive(message());await f.dispatched;
  assert.equal(f.calls.length,1);
  assert.match(f.calls[0][3],/稍后再试/);
  assert.doesNotMatch(f.calls[0][3],/private-provider-error/);
});

test('failed delivery does not trigger another reply',async t=>{
  const f=fixture(t,async()=>{throw Error('模拟饭钱已用完，请先添加饭钱');},async()=>{throw Error('unknown delivery');});
  await f.gateway.receive(message());await f.dispatched;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.length,1);
});
