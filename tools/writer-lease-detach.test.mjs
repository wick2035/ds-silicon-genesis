import test from 'node:test';
import assert from 'node:assert/strict';
import {WriterLease} from '../dist/host/writer-lease.js';

test('commit-triggered background work waits for its own pet gate turn',async()=>{
  const client={on(){return this;},removeListener(){return this;},release(){},async query(){return {rows:[{acquired:true}],rowCount:1};}};
  const lease=new WriterLease({connect:async()=>client});await lease.acquire();let entered=false,done;
  const child=new Promise(resolve=>done=resolve);
  await lease.run('main',async()=>{
    lease.detach(()=>setTimeout(()=>{void lease.run('main',async()=>{entered=true;}).then(done);},0));
    await new Promise(resolve=>setTimeout(resolve,15));assert.equal(entered,false);
  });
  await child;assert.equal(entered,true);await lease.close();
});
