import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createCommitObservers} from '../dist/host/commit-observers.js';
import {MemoryIndex} from '../dist/host/memory-index.js';
import {MemoryEmbedding} from '../dist/host/memory-embedding.js';

test('committed observers run in order on one snapshot and isolate failures',()=>{
  const observers=createCommitObservers(),state={petId:'main'},seen=[];
  observers.add(s=>{seen.push(s);throw Error('observer failure');});
  observers.add(s=>seen.push(s));
  observers.notify(state);
  assert.deepEqual(seen,[state,state]);
});

for(const [name,make] of [
  ['lexical',lease=>new MemoryIndex(lease,{})],
  ['embedding',lease=>new MemoryEmbedding(lease,{}, {})]
])test(`${name} indexing coalesces a burst and uses the latest commit`,async()=>{
  const controller=new AbortController(),lease={signal:controller.signal,detach:fn=>fn()};
  const index=make(lease),seen=[];
  index.run=async()=>{seen.push(index.pending.version);index.pending=undefined;};
  try{
    index.schedule({version:1},60);
    await sleep(30);
    index.schedule({version:2},60);
    await sleep(40);
    assert.deepEqual(seen,[]);
    await sleep(50);
    assert.deepEqual(seen,[2]);
  }finally{controller.abort();}
});
