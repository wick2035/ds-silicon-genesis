import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorksiteChatWait} from '../dist/host/worksite-chat-coordination.js';

const settle=()=>new Promise(setImmediate);
function fixture(){
 const listeners=new Set(),state={petId:'main',life:{actions:[{actionType:'labor.step',status:'DISPATCHED'}]}};
 const source={onCommit(fn){listeners.add(fn);return ()=>listeners.delete(fn);}};
 const reader={loadEnvelope:async()=>structuredClone(state)};
 return {state,listeners,wait:createWorksiteChatWait(reader,[source]),notify(){for(const fn of listeners)fn(structuredClone(state));}};
}
test('waits for the current work receipt and cleans up the subscription',async()=>{
 const f=fixture(),controller=new AbortController();let finished=false;
 const wait=f.wait('main',controller.signal).then(()=>{finished=true;});await settle();
 assert.equal(finished,false);f.state.life.actions[0].status='COMPLETED';f.notify();await wait;
 assert.equal(finished,true);assert.equal(f.listeners.size,0);
});
test('pending work does not delay chat and cancellation cleans up a dispatched wait',async()=>{
 const f=fixture(),controller=new AbortController();f.state.life.actions[0].status='PENDING';
 await f.wait('main',controller.signal);assert.equal(f.listeners.size,0);
 f.state.life.actions[0].status='DISPATCHED';const wait=f.wait('main',controller.signal);await settle();controller.abort();
 await assert.rejects(wait,/取消/);assert.equal(f.listeners.size,0);
});
test('a receipt arriving while the snapshot is loading is not missed',async()=>{
 let notify,release;const barrier=new Promise(resolve=>{release=resolve;});
 const source={onCommit(fn){notify=fn;return ()=>{};}};
 let calls=0;const reader={loadEnvelope:async()=>{calls++;if(calls===1){await barrier;return {petId:'main',life:{actions:[{actionType:'labor.step',status:'DISPATCHED'}]}};}return {petId:'main',life:{actions:[]}};}};
 const wait=createWorksiteChatWait(reader,[source])('main',new AbortController().signal);
 notify({petId:'main'});release();await wait;assert.equal(calls,2);
});
