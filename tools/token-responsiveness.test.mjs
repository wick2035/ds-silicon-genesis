import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopCommandChannel} from '../dist/host/desktop-command-channel.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';

const coin={id:'coin-1',status:'floor',surface:'desktop',x:.5,y:.8};
test('a user collection interrupts pickup as a confirmed cancellation',async()=>{
  const auth={},channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{tokens:{coins:[coin]}}})},auth);
  const intent={id:'pickup-1',type:'token.pickup',payload:{petId:'main',actionId:'pickup-1',parameters:{coinId:coin.id}}};
  const result=channel.bridge.execute('main',intent,new AbortController().signal);
  await new Promise(setImmediate);assert.equal(channel.view('main').coinId,coin.id);
  channel.cancelToken('main');assert.equal((await result).status,'cancelled');assert.equal(channel.view('main'),undefined);
  await assert.rejects(channel.receipt({petId:'main',id:'pickup-1',actionId:'pickup-1',coinId:coin.id,index:1,surface:'desktop',status:'completed',played:true,x:.5,y:.8}));
  channel.close();
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
