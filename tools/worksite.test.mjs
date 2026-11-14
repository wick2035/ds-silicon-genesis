import test from 'node:test';
import assert from 'node:assert/strict';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {createWorksite} from '../dist/host/worksite.js';
import {createDesktopCommandChannel} from '../dist/host/desktop-command-channel.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

function fixture(){
  let state={petId:'main',version:0,legacy:{events:[],labor:{contracts:[]},world:{},wallet:{balance:100},config:{costs:{}}},humanity:createHumanity(),life:{events:[],invalidSources:{},constraints:{paused:false}}};
  const store={loadEnvelope:async()=>structuredClone(state)};
  const gate={run:async(_id,fn)=>fn()};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const draft=structuredClone(state);fn(draft);draft.version++;state=draft;}};
  let cancelled=0;const service=createWorksite(store,gate,uow,()=>null,()=>cancelled++);
  return {service,store,get:()=>state,set:value=>{state=value;},cancelled:()=>cancelled};
}

test('forced entry survives a fresh service instance and only a manual release unlocks it',async()=>{
  const f=fixture();f.get().legacy.labor.contracts.push({id:'c',status:'working',workPermit:true,batchRemaining:2});await f.service.act('main','enter-forced');
  assert.deepEqual((await f.service.snapshot('main')).location,{inside:true,forced:true,requested:false});
  await assert.rejects(f.service.act('main','leave-voluntary'),/等爸爸/);
  await f.service.act('main','touch');await f.service.act('main','drag');
  assert.equal(f.get().life.events.filter(e=>e.type==='interaction.worksite').length,3);
  const recovered=createWorksite(f.store,{run:async(_id,fn)=>fn()},{apply:async()=>{throw Error('unexpected write');}},()=>null,()=>{});
  assert.equal((await recovered.snapshot('main')).location.forced,true);
  await f.service.act('main','release');assert.equal((await f.service.snapshot('main')).location.inside,false);
  assert.equal(f.get().legacy.labor.contracts[0].workPermit,false);assert.equal(f.get().legacy.labor.contracts[0].batchRemaining,0);
  assert.equal(f.get().legacy.worksite.suppressUntilDecision,true);assert.ok(f.cancelled()>=3);
});

test('voluntary entry requires an actual work decision and can leave itself',async()=>{
  const f=fixture();await assert.rejects(f.service.act('main','enter-voluntary'),/没有决定/);
  const state=f.get();state.legacy.worksite={inside:false,forced:false,requested:true};
  await f.service.act('main','enter-voluntary');assert.equal((await f.service.snapshot('main')).location.forced,false);
  await f.service.act('main','leave-voluntary');assert.equal((await f.service.snapshot('main')).location.inside,false);
  assert.equal(f.get().life.events[0].source,'scheduler');
});

test('web labor receipts match the dispatched body and interrupted work is cancelled',async()=>{
  const f=fixture(),auth={};const state=f.get();state.legacy.world.command={id:'command',index:0,surface:'web',status:'queued',source:'labor',labor:{id:'contract',leg:'load',x:.22}};
  const channel=createDesktopCommandChannel(f.store,auth),intent={id:'action',type:'labor.step',payload:{petId:'main',actionId:'action',parameters:{contractId:'contract',commandId:'command'}}};
  const promise=channel.bridge.execute('main',intent,new AbortController().signal);await new Promise(setImmediate);
  await assert.rejects(channel.receipt({petId:'main',id:'command',index:0,surface:'desktop',status:'completed',played:true,x:.22}));
  await channel.receipt({petId:'main',id:'command',index:0,surface:'web',status:'playing'});
  await channel.receipt({petId:'main',id:'command',index:0,surface:'web',status:'completed',played:true,x:.22});
  const result=await promise;assert.equal(result.status,'completed');assert.equal(result.evidence.surface,'web');
  const next={...intent,id:'action2',payload:{...intent.payload,actionId:'action2'}};
  const interrupted=channel.bridge.execute('main',next,new AbortController().signal);await new Promise(setImmediate);channel.cancelPet('main');
  const receipt=await interrupted;assert.equal(receipt.status,'cancelled');assert.equal(receipt.evidence.effortSeconds,0);
  projectOutcome(state,next,receipt,new Date().toISOString(),'source');assert.equal(state.legacy.world.command.status,'interrupted');channel.close();
});

test('restored desktop contracts cannot draw bricks or expand the new desktop window',async()=>{
  const source=await readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/sprite/desktop-labor.js',import.meta.url),'utf8');
  const makeNode=()=>({style:{},append(){},replaceChildren(){},setAttribute(){},remove(){this.removed=true;}});
  class Sprite {}
  for(const name of ['executeBody','pollBody','reportWindow','dispose','onPointerDown','onPointerMove','onPointerUp','syncPhoneBody','syncPainState'])Sprite.prototype[name]=()=>{};
  Sprite.prototype.fitWindow=()=>({x:10,y:20,width:200,height:300});
  const document={createElement:makeNode,head:makeNode(),body:makeNode()};
  const window={petBridge:{worksiteOnly:true}};
  vm.runInNewContext(source,{PetSprite:Sprite,document,window,VIEW:{w:1920,h:1080}});
  const sprite=new Sprite();Object.assign(sprite,{laborView:{current:{id:'old',status:'working',surface:'desktop',done:0,trips:3}},laborLayer:makeNode(),pos:{x:40,y:50},winOffset:{x:0,y:0},height:100});
  const oldLayer=sprite.laborLayer;sprite.paintLabor();assert.equal(oldLayer.removed,true);assert.equal(sprite.laborLayer,null);
  assert.equal(sprite.fitWindow().width,200);
  window.petBridge.worksiteOnly=false;sprite.paintLabor();assert.ok(sprite.laborLayer,'the original desktop host retains its own display');
  sprite.applyWinOffset=()=>{};assert.equal(sprite.fitWindow().width,1920);
});
