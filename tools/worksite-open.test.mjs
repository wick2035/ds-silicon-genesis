import test from 'node:test';
import assert from 'node:assert/strict';
import {createHelperChannel} from '../dist/host/helper-channel.js';
import {createLifeApi} from '../dist/host/life-api.js';

test('life page waits for the matching live desktop window acknowledgment',async()=>{
  const channel=createHelperChannel({observeRestraint:async()=>{}},{},['main'],{},{},{cancelPet(){}},undefined,undefined,undefined,undefined,async()=>({location:{inside:false}}));
  await assert.rejects(channel.requestWorksiteOpen('main'),/尚未连接/);
  const epoch='a'.repeat(32);channel.opened(epoch);
  const api=createLifeApi({authorize:()=>true,petId:()=> 'main',getState:async()=>{throw Error('unexpected');},openWorksite:id=>channel.requestWorksiteOpen(id)});
  const response=api(new Request('http://localhost/api/life/worksite',{method:'POST'}));
  await new Promise(setImmediate);
  const poll=await channel.worksite(epoch,{petId:'main',action:'snapshot'});
  assert.equal(typeof poll.openRequestId,'string');
  await channel.worksite(epoch,{petId:'main',action:'open-ack',requestId:'obsolete'});
  assert.equal((await channel.worksite(epoch,{petId:'main',action:'snapshot'})).openRequestId,poll.openRequestId);
  await channel.worksite(epoch,{petId:'main',action:'open-ack',requestId:poll.openRequestId});
  const reply=await response;assert.equal(reply.status,200);assert.deepEqual((await reply.json()).value,{opened:true});
  assert.equal((await channel.worksite(epoch,{petId:'main',action:'snapshot'})).openRequestId,undefined);
  assert.equal((await api(new Request('http://localhost/api/life/worksite'))).status,405);
  channel.closed(epoch);
});
