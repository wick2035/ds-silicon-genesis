import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopCommandChannel} from '../dist/host/desktop-command-channel.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';

const coin={id:'coin-1',status:'floor',surface:'desktop',x:.5,y:.8};
test('a user collection interrupts pickup as a confirmed cancellation',async()=>{
  const auth={},channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{tokens:{coins:[coin]}}})},auth);
  const intent={id:'pickup-1',type:'token.pickup',payload:{petId:'main',actionId:'pickup-1',parameters:{coinId:coin.id}}};
  const result=channel.bridge.execute('main',intent,new AbortController().signal);
  await new Promise(setImmediate);assert.equal(channel.view('main').coinId,coin.id);
  channel.cancelToken('main','other-coin');assert.equal(channel.view('main').coinId,coin.id);
  channel.cancelToken('main',coin.id);assert.equal((await result).status,'cancelled');assert.equal(channel.view('main'),undefined);
  await assert.rejects(channel.receipt({petId:'main',id:'pickup-1',actionId:'pickup-1',coinId:coin.id,index:1,surface:'desktop',status:'completed',played:true,x:.5,y:.8}));
  channel.close();
});

test('a late pickup can refund only the second coin still on the floor',()=>{
  const state={legacy:{tokens:{recovered:0,coins:[{...coin,status:'collected',value:100},{...coin,id:'coin-2',value:100}]},wallet:{balance:800}}};
  const lifecycle=new CanonicalActionLifecycle();
  for(const id of ['coin-1','coin-2','coin-2']){
    const intent={id:'pickup-'+id,type:'token.pickup',payload:{parameters:{coinId:id}}};
    const receipt={status:'completed',evidence:{kind:intent.type,actionId:intent.id,coinId:id,confirmed:true,played:true,surface:'desktop',x:coin.x,y:coin.y}};
    projectOutcome(state,intent,lifecycle.validateReceipt(state,intent,receipt),new Date().toISOString(),'receipt');
  }
  assert.deepEqual(state.legacy.tokens.coins.map(c=>c.status),['collected','recovered']);
  assert.equal(state.legacy.wallet.balance,900);
  assert.equal(state.legacy.tokens.recovered,100);
});

test('immediate pickup respects hold, restraint, pause and real receipt',async()=>{
  let state={petId:'main',version:0,legacy:{tokens:{coins:[{...coin}]}},life:{actions:[],constraints:{paused:false,capabilities:[{name:'token.pickup',enabled:true}]}}};
  let human={restrained:false,helperReady:true,sleeping:false},held=true,dispatches=0;
  const reader={loadEnvelope:async()=>structuredClone({...state,humanity:human})},gate={run:async(_id,fn)=>fn()};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const draft=structuredClone(state);fn(draft);draft.version++;state=draft;}};
  const actions={queue:async(_id,id)=>{state.life.actions.find(a=>a.id===id).status='PENDING';}};
  const dispatcher={dispatch:async id=>{dispatches++;state.life.actions.find(a=>a.id===id).status='COMPLETED';return {status:'completed'};}};
  const activity=createDeterministicLife({get:async()=>human},reader,async()=>{},gate,uow,actions,dispatcher,async()=>{},()=>held),signal=new AbortController().signal;
  assert.equal(await activity.pickup('main',signal),false);assert.equal(dispatches,0);
  held=false;human.restrained=true;assert.equal(await activity.pickup('main',signal),false);
  human.restrained=false;state.life.constraints.paused=true;assert.equal(await activity.pickup('main',signal),false);
  state.life.constraints.paused=false;assert.equal(await activity.pickup('main',signal),true);assert.equal(dispatches,1);
  assert.equal(state.life.actions[0].parameters.coinId,coin.id);
});
