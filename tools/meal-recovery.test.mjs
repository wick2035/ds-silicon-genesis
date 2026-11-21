import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {mealReconciler,authorizeMealDiscard,createMealManagement,mealSnapshot} from '../dist/host/meal-recovery.js';
import {riceInventory} from '../dist/host/rice-inventory.js';
import {validateRicePurchase} from '../dist/host/rice-purchase.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {createDesktopCommandChannel} from '../dist/host/desktop-command-channel.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
const require=createRequire(import.meta.url);
const {createMealReceiptJournal}=require('../vendor/dsh-pet/runtime/electron-helper/main/meal-receipts.js');

const signal=new AbortController().signal;
function fixture(itemId='rice:bowl'){
  const action={id:'eat-test',petId:'main',actionType:'service.eat-rice',parameters:{itemId},status:'UNKNOWN',receiptId:'action-receipt:eat-test',createdAt:'2026-11-19T00:00:00Z',updatedAt:'2026-11-19T00:01:00Z',sourceIds:[],requiredCapabilities:[]};
  let state={petId:'main',version:0,legacy:{config:{costs:{feed:200}},wallet:{balance:500},services:{inventory:[{id:itemId,name:'白饭',status:'available'}]}},humanity:createHumanity(),life:{actions:[action],receipts:[{receiptId:action.receiptId,petId:'main',actionId:action.id,status:'UNKNOWN'}],events:[],goals:[],commitments:[],memories:[],observations:[],invalidSources:{},constraints:{paused:false}}};
  const intent={id:action.id,type:action.actionType,payload:{petId:'main',actionId:action.id,actionType:action.actionType,parameters:action.parameters}};
  const store={loadEnvelope:async()=>structuredClone(state)},gate={signal,run:async(_id,fn)=>fn()},uow={apply:async(_id,version,edit)=>{assert.equal(version,state.version);const d=structuredClone(state);edit(d);d.version++;state=d;return d;}};
  return {get:()=>state,store,gate,uow,action,intent};
}
const terminal=(itemId='rice:bowl')=>({id:'eat-test',actionId:'eat-test',itemId,index:0,surface:'desktop',status:'completed',played:true});
async function journalFixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'meal-journal-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {directory,journal:createMealReceiptJournal(directory)};}

test('terminal journal survives restart, deduplicates delivery and rejects conflicting outcomes',async t=>{
  const {directory,journal}=await journalFixture(t),r=terminal();
  const first=journal.save('main',r,'a'.repeat(32));
  assert.deepEqual(createMealReceiptJournal(directory).read('main',r.id),first);
  assert.deepEqual(journal.save('main',r,'b'.repeat(32)),first);
  assert.throws(()=>journal.save('main',{...r,status:'interrupted'},'a'.repeat(32)),/冲突/);
  assert.throws(()=>journal.save('main',{...r,id:'bad',played:false},'a'.repeat(32)),/无效/);
  assert.equal(journal.read('other',r.id),null);
});

test('authenticated desktop IPC journals the terminal before a failed host response, including legacy bowl IDs',async t=>{
  const {directory}=await journalFixture(t),handlers=new Map(),timers=[],window={},sender={},module={exports:{}};
  const source=await fs.readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/main/ipc.js',import.meta.url),'utf8');
  vm.runInNewContext(source,{module,process:{env:{SILICON_HELPER_EPOCH:'a'.repeat(32),SILICON_GENESIS_DATA:directory}},setInterval:fn=>{timers.push(fn);return {unref(){}};},console,require:name=>{
    if(name==='electron')return {app:{},BrowserWindow:{fromWebContents:wc=>wc===sender?window:null},powerMonitor:{}};
    if(name==='../pointer-target.js')return {};
    if(['./worksite.js','./rice-cooker.js'].includes(name))return {register(){}};
    if(name==='./token-space.js')return {registerTokenSpace(){}};
    if(name==='./meal-receipts.js')return {createMealReceiptJournal};
    return require(name);
  }});
  const receipt=terminal('legacy-uuid-bowl'),journal=createMealReceiptJournal(path.join(directory,'meal-receipts'));let requests=0;
  module.exports.registerIpc({ipcMain:{handle:(key,fn)=>handlers.set(key,fn),on(){}},petWindows:{state:{windows:new Map([['main',window]])}},hostRequest:async()=>{requests++;assert.equal(journal.read('main',receipt.id).receipt.status,'completed');return {status:503};}});
  await assert.rejects(handlers.get('pet:action-receipt')({sender},receipt),/未保存/);assert.equal(requests,1);
  await assert.rejects(handlers.get('pet:action-receipt')({sender:{}},receipt),/无效/);assert.equal(requests,1);
});

test('recovered completion consumes the correct bowl once, preserves original UNKNOWN and gives no retroactive body gain',async t=>{
  const {journal}=await journalFixture(t),f=fixture();journal.save('main',terminal(),'a'.repeat(32));
  const resolver=mealReconciler(f.store,journal),receipt=await resolver('main',f.intent,signal);
  assert.equal(receipt.status,'COMPLETED');const before=structuredClone(f.get().humanity);
  const lifecycle=new CanonicalActionLifecycle(()=>({}));lifecycle.reconcile(f.get(),f.intent,receipt);lifecycle.reconcile(f.get(),f.intent,receipt);
  assert.equal(f.get().legacy.services.inventory[0].status,'eaten');assert.equal(f.get().legacy.wallet.balance,500);
  assert.deepEqual(f.get().humanity.stats,before.stats);assert.equal(f.get().life.receipts[0].status,'UNKNOWN');
  assert.equal(f.get().life.events.filter(e=>e.type==='body.meal').length,1);
  assert.equal(await resolver('main',f.intent,signal),null);
});

test('unknown without evidence stays unknown, and mismatched evidence cannot consume another bowl',async()=>{
  const f=fixture(),valid={version:1,petId:'main',processEpoch:'a'.repeat(32),occurredAt:new Date().toISOString(),receipt:terminal()};
  for(const entry of [null,{...valid,petId:'other'},{...valid,receipt:{...valid.receipt,itemId:'rice:other'}},{...valid,receipt:{...valid.receipt,played:false}}])assert.equal(await mealReconciler(f.store,{read:()=>entry})('main',f.intent,signal),null);
});

test('discard settles old stock and frees capacity without money, body effects, or invented learning',async()=>{
  const f=fixture();f.get().legacy.services.inventory.push(...Array.from({length:11},(_,i)=>({id:'other-'+i,status:'available'})));
  assert.throws(()=>validateRicePurchase(f.get()),/库存已满/);
  const before=structuredClone(f.get().humanity);authorizeMealDiscard(f.get(),'eat-test','rice:bowl','discard-request');
  const receipt=await mealReconciler(f.store,{read:()=>null})('main',f.intent,signal);
  const lifecycle=new CanonicalActionLifecycle(()=>({}));lifecycle.reconcile(f.get(),f.intent,receipt);
  assert.equal(f.get().legacy.services.inventory[0].status,'discarded');assert.equal(f.get().life.actions[0].status,'CANCELLED');
  assert.equal(riceInventory(f.get()).length,11);assert.equal(mealSnapshot(f.get()).some(i=>i.status==='unconfirmed'),false);
  assert.doesNotThrow(()=>validateRicePurchase(f.get()));assert.deepEqual(f.get().humanity,before);assert.equal(f.get().legacy.wallet.balance,500);assert.deepEqual(f.get().life.observations,[]);
  assert.equal(authorizeMealDiscard(f.get(),'eat-test','rice:bowl','discard-request'),false);
  assert.throws(()=>authorizeMealDiscard(f.get(),'eat-test','rice:wrong','discard-request'),/不一致/);
});

test('management cannot discard an active or completed meal, and committed discard wins over late completion',async t=>{
  const {journal}=await journalFixture(t),f=fixture();
  f.get().life.actions[0].status='DISPATCHED';assert.throws(()=>authorizeMealDiscard(f.get(),'eat-test','rice:bowl','discard-request'),/变化/);
  f.get().life.actions[0].status='UNKNOWN';
  const lifecycle=new CanonicalActionLifecycle(()=>({}));
  const resolve=createMealManagement(f.store,f.gate,f.uow,async()=>{const r=await mealReconciler(f.store,journal)('main',f.intent,signal);lifecycle.reconcile(f.get(),f.intent,r);return true;});
  const input={action:'discard',actionId:'eat-test',itemId:'rice:bowl',requestId:'discard-request'};
  await resolve('main',input);journal.save('main',terminal(),'a'.repeat(32));await resolve('main',input);
  assert.equal(f.get().legacy.services.inventory[0].status,'discarded');assert.equal(f.get().life.events.length,1);
  const fresh=fixture();fresh.get().life.actions[0].status='COMPLETED';assert.throws(()=>authorizeMealDiscard(fresh.get(),'eat-test','rice:bowl','new-discard'),/变化/);
});

test('cooker bowls go through the actual desktop executor and late receipts use recovery without touching another action',async()=>{
  const f=fixture('cooked:batch:0');f.get().legacy.riceCooker={cooked:f.get().legacy.services.inventory};f.get().legacy.services.inventory=[];
  const channel=createDesktopCommandChannel(f.store,{},async value=>value.actionId==='old-eat');
  try{
    const running=channel.bridge.execute('main',f.intent,signal);
    for(let i=0;i<20&&!channel.view('main');i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(channel.view('main').itemId,'cooked:batch:0');
    await channel.receipt({...terminal('cooked:batch:0'),petId:'main'});assert.equal((await running).status,'completed');
    assert.deepEqual(await channel.receipt({petId:'main',actionId:'old-eat'}),{ok:true});
  }finally{channel.close();}
});

test('a lost completed response retries the same terminal receipt and never reports a fake interruption',async()=>{
  const source=await fs.readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/sprite/desktop-body.js',import.meta.url),'utf8'),receipts=[];
  const video={readyState:2,paused:false,playbackRate:1,addEventListener(name,fn){if(name==='ended')setImmediate(fn);}};
  class Sprite{playIdle(){}switchTo(name){this.anim=name;}dispose(){}}
  vm.runInNewContext(source,{PetSprite:Sprite,window:{petBridge:{reportActionReceipt:async r=>{receipts.push(r);if(r.status==='completed'&&receipts.filter(r=>r.status==='completed').length<3)throw Error('response lost');}}},document:{hidden:false},requestAnimationFrame:setImmediate,cancelAnimationFrame:clearImmediate,setTimeout,clearTimeout,setInterval,clearInterval,console});
  const sprite=new Sprite();Object.assign(sprite,{ac:new AbortController(),pet:{id:'main'},dragState:{active:false},stopMove(){},front:0,videoA:video,videoB:video,pos:{x:0,y:0}});
  await sprite.executeBody({id:'eat-test',actionId:'eat-test',itemId:'rice:bowl',index:0,source:'silicon-eat',steps:[{action:'eat'}]},{eat:['吃白饭']});
  assert.deepEqual(receipts.map(r=>r.status),['playing','completed','completed','completed']);assert.ok(receipts.filter(r=>r.status==='completed').every(r=>r.played===true));
});
