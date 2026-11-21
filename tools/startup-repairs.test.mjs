import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mealReconciler} from '../dist/host/meal-recovery.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';

const signal=new AbortController().signal;
function fixture(itemId='rice:bowl'){
  const action={id:'eat-test',petId:'main',actionType:'service.eat-rice',parameters:{itemId},status:'UNKNOWN',receiptId:'action-receipt:eat-test',createdAt:'2026-11-19T00:00:00Z',updatedAt:'2026-11-19T00:01:00Z',sourceIds:[],requiredCapabilities:[]};
  let state={petId:'main',version:0,legacy:{config:{costs:{feed:200}},wallet:{balance:500},services:{inventory:[{id:itemId,name:'白饭',status:'available'}]}},humanity:createHumanity(),life:{actions:[action],receipts:[{receiptId:action.receiptId,petId:'main',actionId:action.id,status:'UNKNOWN'}],events:[],goals:[],commitments:[],memories:[],observations:[],invalidSources:{},constraints:{paused:false}}};
  const intent={id:action.id,type:action.actionType,payload:{petId:'main',actionId:action.id,actionType:action.actionType,parameters:action.parameters}};
  const store={loadEnvelope:async()=>structuredClone(state)},gate={signal,run:async(_id,fn)=>fn()},uow={apply:async(_id,version,edit)=>{assert.equal(version,state.version);const d=structuredClone(state);edit(d);d.version++;state=d;return d;}};
  return {get:()=>state,store,gate,uow,action,intent};
}
import {prepareStartupRepairs} from '../dist/host/startup-repairs.js';

test('authorized startup work backs up before mutation and generates the requested diary once',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'meal-startup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'data'));
  const f=fixture(),file=path.join(root,'data/authorized-repairs.json');let calls=0;
  await fs.writeFile(file,JSON.stringify({version:1,petId:'main',tasks:[{kind:'discard-meal',status:'pending',actionId:'eat-test',itemId:'rice:bowl',requestId:'discard-request'},{kind:'diary',status:'pending',date:'2026-11-20'}]}));
  const reconcile=async()=>{const plan=JSON.parse(await fs.readFile(file));assert.ok(plan.backup);const backup=JSON.parse(await fs.readFile(plan.backup));assert.equal(backup.state.legacy.services.inventory[0].status,'available');const receipt=await mealReconciler(f.store,{read:()=>null})('main',f.intent,signal);new CanonicalActionLifecycle(()=>({})).reconcile(f.get(),f.intent,receipt);return true;};
  let work=await prepareStartupRepairs(root,'main',f.store,f.gate,f.uow,{query:async()=>({rows:[]})},reconcile);
  await work.finishDiaries(async date=>{calls++;f.get().legacy.diaries={[date]:{text:'日记',sources:['source']}};return true;});
  work=await prepareStartupRepairs(root,'main',f.store,f.gate,f.uow,{query:async()=>({rows:[]})},reconcile);await work.finishDiaries(()=>{throw Error('must not retry');});assert.equal(calls,1);
});

test('startup interrupted or failed diary jobs are not repeatedly charged by automatic retries',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'meal-startup-interrupted-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'data'));
  const file=path.join(root,'data/authorized-repairs.json'),f=fixture();
  await fs.writeFile(file,JSON.stringify({version:1,petId:'main',tasks:[{kind:'diary',status:'running',date:'2026-11-20'}]}));
  const work=await prepareStartupRepairs(root,'main',f.store,f.gate,f.uow,{query:async()=>{throw Error('no backup needed');}},()=>{throw Error('no meal');});
  await work.finishDiaries(()=>{throw Error('must not repeat interrupted call');});
  assert.equal(JSON.parse(await fs.readFile(file)).tasks[0].status,'failed');assert.equal(f.get().legacy.wallet.balance,500);
});
