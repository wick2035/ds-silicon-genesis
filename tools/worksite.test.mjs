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
  let cancelled=0,woken=0;const service=createWorksite(store,gate,uow,()=>null,()=>cancelled++,()=>woken++);
  return {service,store,get:()=>state,set:value=>{state=value;},cancelled:()=>cancelled,woken:()=>woken};
}

test('forced entry survives a fresh service instance and only a manual release unlocks it',async()=>{
  const f=fixture();f.get().legacy.worksite={inside:false,forced:false,speech:{text:'上次的回应'}};f.get().legacy.labor.contracts.push({id:'c',status:'working',workPermit:true,batchRemaining:2});await f.service.act('main','enter-forced');
  assert.equal(f.woken(),1);
  const location=(await f.service.snapshot('main')).location;
  assert.equal(location.inside,true);assert.equal(location.forced,true);assert.equal(location.requested,false);
  assert.match(location.speech.text,/操作反馈.*拖进搬砖网页/);
  await assert.rejects(f.service.act('main','leave-voluntary'),/等爸爸/);
  await f.service.act('main','touch');assert.match(f.get().legacy.worksite.speech.text,/碰了碰/);
  await f.service.act('main','drag');assert.match(f.get().legacy.worksite.speech.text,/拖动/);
  assert.equal(f.get().life.events.filter(e=>e.type==='interaction.worksite').length,3);
  const recovered=createWorksite(f.store,{run:async(_id,fn)=>fn()},{apply:async()=>{throw Error('unexpected write');}},()=>null,()=>{});
  assert.equal((await recovered.snapshot('main')).location.forced,true);
  f.get().legacy.worksite.speech={text:'刚进来时的回应'};
  await f.service.act('main','release');assert.equal((await f.service.snapshot('main')).location.inside,false);assert.equal(f.get().legacy.worksite.speech,undefined);
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
  let drops=0;window.petBridge.dropInWorksite=async()=>{drops++;return {entered:false};};sprite.laborView=null;
  for(const event of [{type:'pointerup'},{type:'mousemove',buttons:0},{type:'lostpointercapture',buttons:0},{type:'pointercancel',buttons:0}]){sprite.dragState={dragging:true};sprite.onPointerUp(event);}
  assert.equal(drops,3,'normal and fallback releases enter the worksite, cancellation does not');
});


test('中断之后迟到的完成回执结算为取消，不留下永远派发中的步骤',async()=>{
  const world={id:'cmd',source:'labor',surface:'web',status:'queued',index:0,labor:{id:'job',trip:0,leg:'load',x:.22}};
  const channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{world:{command:structuredClone(world)}}})},{});
  const controller=new AbortController();let result;
  try{
    result=channel.bridge.execute('main',{id:'step',type:'labor.step',payload:{actionId:'step',petId:'main',parameters:{commandId:'cmd',contractId:'job'}}},controller.signal);
    for(let i=0;i<20&&!channel.view('main');i++)await new Promise(setImmediate);
    assert.ok(channel.view('main'));
    await channel.receipt({petId:'main',id:'cmd',surface:'web',index:0,status:'playing'});
    world.status='interrupted';
    await channel.receipt({petId:'main',id:'cmd',surface:'web',index:0,status:'completed',played:true,x:.22});
    const receipt=await result;assert.equal(receipt.status,'cancelled');assert.equal(receipt.evidence.confirmed,true);assert.equal(channel.view('main'),undefined);
  }finally{controller.abort();channel.close();if(result)await result;}
});

test('工地通知唤醒已订阅的窗口，中断只确认实际位移且不重播旧动作',async()=>{
  const world={id:'cmd',source:'labor',surface:'web',status:'queued',index:0,labor:{id:'job',trip:0,leg:'deliver',x:.78}};
  const channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{world:{command:structuredClone(world)}}})},{});
  const controller=new AbortController();let result;
  try{
    const initial=await channel.waitForWorksiteChange('main',-1,controller.signal);
    const dispatched=channel.waitForWorksiteChange('main',initial,controller.signal);
    const intent={id:'step',type:'labor.step',payload:{actionId:'step',petId:'main',parameters:{commandId:'cmd',contractId:'job'}}};
    result=channel.bridge.execute('main',intent,controller.signal);
    const revision=await dispatched;
    assert.equal(revision,initial+1);
    assert.equal(channel.view('main').status,'queued');
    assert.equal(await channel.waitForWorksiteChange('main',initial,controller.signal),revision);

    const base={petId:'main',id:'cmd',surface:'web',index:0};
    const playing={...base,status:'playing',worksiteX:.22};
    await channel.receipt(playing);
    assert.equal(channel.view('main').status,'running');
    await assert.rejects(channel.receipt(playing),/已经开始/);
    const cancelled=channel.waitForWorksiteChange('main',revision,controller.signal);
    channel.cancelPet('main');
    assert.equal(await cancelled,revision+1);
    assert.equal(channel.view('main'),undefined);
    world.status='interrupted';
    const partial={...base,status:'interrupted',worksiteX:.36,effortSeconds:.2};
    await assert.rejects(channel.receipt({...partial,worksiteX:.1}),/位移/);
    await channel.receipt(partial);
    const receipt=await result;
    assert.equal(receipt.status,'cancelled');
    assert.equal(receipt.evidence.effortSeconds,.2);
    assert.equal(receipt.evidence.intensity,1.5);
    assert.ok(Math.abs(receipt.evidence.travelDistance-.14)<1e-9);
    assert.ok(Math.abs(receipt.evidence.actionFraction-.25)<1e-9);
    await assert.rejects(channel.receipt(partial),/没有对应行动/);
  }finally{controller.abort();channel.close();if(result)await result;}
});
