import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopIdle} from '../dist/host/desktop-idle.js';
import {createDesktopCommandChannel} from '../dist/host/desktop-command-channel.js';
import {validateActionParameters} from '../dist/host/action-parameters.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('空闲只采集时间；活动、断线和过期观察令旧决定失效',()=>{
  const idle=new DesktopIdle();idle.update(121,100000,100000);const first=idle.snapshot(100000);
  assert.equal(idle.eligible(100000),true);idle.update(3,110000,110000);
  assert.notEqual(idle.snapshot(110000).generation,first.generation);assert.equal(idle.eligible(110000),false);
  assert.equal(idle.snapshot(141000),undefined);idle.clear();assert.equal(idle.snapshot(110000),undefined);
  assert.throws(()=>idle.update(-1,110000,110000));assert.throws(()=>idle.update(2,1,110000));
});

test('模型方向经过白名单；真实位移和播放后才能提交走动回执',async()=>{
  assert.doesNotThrow(()=>validateActionParameters('body.activity',{activity:'walk',target:'left'}));
  assert.throws(()=>validateActionParameters('body.activity',{activity:'walk',target:'arbitrary'}));
  const channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{}})},{}),id='walk-action';
  const intent={id,type:'body.activity',payload:{petId:'main',actionId:id,parameters:{activity:'walk',target:'left'}}};
  const pending=channel.bridge.execute('main',intent,new AbortController().signal);await new Promise(setImmediate);
  assert.equal(channel.view('main').steps[0].target,'left');
  const receipt={petId:'main',id,actionId:id,index:0,surface:'desktop',status:'completed',played:true,activity:'walk'};
  await assert.rejects(channel.receipt({...receipt,distance:0}));
  await channel.receipt({...receipt,distance:90});const result=await pending;assert.equal(result.status,'completed');
  assert.equal(result.evidence.distance,90);
  const draft={legacy:{},humanity:{},life:{}};assert.doesNotThrow(()=>projectOutcome(draft,intent,result,new Date().toISOString(),'receipt'));
  assert.throws(()=>projectOutcome(draft,intent,{...result,evidence:{...result.evidence,distance:0}},new Date().toISOString(),'receipt'));
  channel.close();
});

test('用户抓住身体立即打断等待中的走动',async()=>{
  const channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{}})},{}),id='walk-2';
  const pending=channel.bridge.execute('main',{id,type:'body.activity',payload:{petId:'main',actionId:id,parameters:{activity:'walk',target:'right'}}},new AbortController().signal);
  await new Promise(setImmediate);channel.cancelPet('main');assert.equal((await pending).status,'cancelled');assert.equal(channel.view('main'),undefined);channel.close();
});

test('电脑恢复活动时桌宠不会开始过期的走动',async()=>{
  const source=await readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/sprite/desktop-body.js',import.meta.url),'utf8');
  const receipts=[];class Sprite{playIdle(){} switchTo(){} dispose(){} showWhisper(){}}
  vm.runInNewContext(source,{PetSprite:Sprite,window:{petBridge:{canStartIdleMotion:async()=>false,reportActionReceipt:async value=>receipts.push(value)}}});
  const sprite=new Sprite();await sprite.executeBody({id:'walk-3',actionId:'walk-3',index:0,source:'silicon-walk',steps:[{action:'walk',target:'left'}]},{walk:['walk']});
  assert.equal(receipts.length,1);assert.equal(receipts[0].status,'interrupted');
});

test('移动与动画都结束后才报告走动完成',async()=>{
  const source=await readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/sprite/desktop-body.js',import.meta.url),'utf8');
  const receipts=[];let ended,frames=0;
  const video={readyState:2,paused:false,duration:3,playbackRate:1,addEventListener(name,cb){if(name==='ended')ended=cb;}};
  class Sprite {playIdle(){} switchTo(name){this.anim=name;} dispose(){} showWhisper(){}}
  const ctx={PetSprite:Sprite,window:{petBridge:{canStartIdleMotion:async()=>true,reportActionReceipt:async r=>receipts.push(r)}},S:{screenOfBox:()=>0},AREAS:[{x:0,width:1000}],VIEW:{w:1000,h:1000},
    requestAnimationFrame(fn){return setImmediate(()=>{frames++;if(frames===2)ended?.();if(frames===4){sprite.pos.x=200;sprite.posFollow=null;}fn();});},cancelAnimationFrame:clearImmediate,setTimeout,clearTimeout};
  vm.runInNewContext(source,ctx);const sprite=new Sprite();Object.assign(sprite,{ac:new AbortController(),pet:{id:'main'},dragState:{active:false},front:0,videoA:video,videoB:video,pos:{x:0,y:0},halfW:10,halfH:10,posFollow:null,stopMove(){},throwSpaceOf(){return {};},moveToCenter(){this.posFollow=1;}});
  await sprite.executeBody({id:'walk-4',actionId:'walk-4',index:0,source:'silicon-walk',steps:[{action:'walk',target:'right'}]},{walk:['walk']});
  assert.ok(frames>=4);assert.deepEqual(receipts.map(r=>r.status),['playing','completed']);assert.equal(receipts[1].distance,200);
});

test('原地玩车可独立完成；被爸爸按住时记录正在玩什么和中断方式',async()=>{
  const {createInitialState}=await import('../dist/kernel/index.js');
  const {CanonicalActionLifecycle}=await import('../dist/host/action-lifecycle.js');
  const at=new Date().toISOString(),life=createInitialState('main',at);
  const activity={id:'play-1',petId:'main',actionType:'body.activity',parameters:{activity:'play'},priority:50,interruptPolicy:'interruptible',requiredCapabilities:['body.activity'],expectedStateVersion:0,sourceIds:[],status:'DISPATCHED',createdAt:at,updatedAt:at};
  life.actions.push(activity);const draft={petId:'main',version:0,legacy:{},humanity:{},life};
  const channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{}})},{});
  const intent={id:'play-1',type:'body.activity',payload:{petId:'main',actionId:'play-1',actionType:'body.activity',parameters:{activity:'play'}}};
  assert.doesNotThrow(()=>validateActionParameters('body.activity',intent.payload.parameters));
  const pending=channel.bridge.execute('main',intent,new AbortController().signal);await new Promise(setImmediate);
  assert.equal(channel.view('main').steps[0].action,'play');
  channel.cancelPet('main','爸爸按住了我的身体，暂时还不知道是轻点还是拖拽');const result=await pending;
  new CanonicalActionLifecycle(()=>({body:life.body,emotions:life.emotions}),()=>new Date(at)).complete(draft,intent,result);
  const event=draft.life.events.find(e=>e.type==='action.receipt');assert.equal(event.payload.activity,'play');
  assert.match(event.payload.interruption,/爸爸按住/);assert.equal(event.payload.status,'CANCELLED');channel.close();
});

test('原地玩耍无需伪造位移，完成的动画才有回执',async()=>{
  const channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{}})},{}),id='play-2';
  const intent={id,type:'body.activity',payload:{petId:'main',actionId:id,parameters:{activity:'cube'}}};
  const pending=channel.bridge.execute('main',intent,new AbortController().signal);await new Promise(setImmediate);
  await assert.rejects(channel.receipt({petId:'main',id,actionId:id,index:0,surface:'desktop',status:'completed',activity:'cube',played:false}));
  await channel.receipt({petId:'main',id,actionId:id,index:0,surface:'desktop',status:'completed',activity:'cube',played:true,distance:0});
  const result=await pending;assert.equal(result.status,'completed');
  assert.doesNotThrow(()=>projectOutcome({legacy:{},humanity:{},life:{}},intent,result,new Date().toISOString(),'receipt'));channel.close();
});
