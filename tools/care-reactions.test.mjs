import test from 'node:test';
import assert from 'node:assert/strict';
import {createHumanity,describeHumanity,advanceHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {createCareReactions,careReactionLeaf} from '../dist/host/care-reactions.js';
import {createLegacyRequestAdapter} from '../dist/host/legacy-request-adapter.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';
import {createDesktopCommandChannel} from '../dist/host/desktop-command-channel.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';
import {validateManualService} from '../dist/host/manual-service-validation.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createInitialState} from '../dist/kernel/index.js';
import {projectBody} from '../dist/host/body-projection.js';
import {ActionCoordinator} from '../dist/host/action-coordinator.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {createLegacyServiceActions} from '../dist/host/legacy-service-actions.js';
import {CanonicalHumanityAdapter} from '../dist/host/humanity-adapter.js';

test('身体快照按当前时间恢复姿态，且不改写已保存状态',async()=>{
  const then=Date.parse('2026-11-14T06:05:41Z'),now=then+180000,human=createHumanity(then);
  human.injury={at:then,curlUntil:then+47000,guardUntil:then+108000};
  const original=structuredClone(human);
  const adapter=new CanonicalHumanityAdapter({loadEnvelope:async()=>({humanity:human})},{}, {},{},{},()=>now);
  assert.equal((await adapter.snapshot('main')).body.phase,'well');
  assert.deepEqual(human,original);
});

test('受伤保护姿态中喝水仍播放对应动作，完成后恢复原保护状态',async()=>{
  const source=await readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/sprite/desktop-body.js',import.meta.url),'utf8');
  const crying=await readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/sprite/crying.js',import.meta.url),'utf8');
  const receipts=[],classes=new Set(['is-crying']);
  const video={readyState:2,paused:false,playbackRate:1,addEventListener(name,cb){if(name==='ended')setImmediate(cb);}};
  class Sprite {playIdle(){} switchTo(name){this.anim=name;} dispose(){} showWhisper(){}}
  const context={PetSprite:Sprite,window:{petBridge:{reportActionReceipt:async r=>{receipts.push(r);}}},document:{hidden:false},
    requestAnimationFrame:fn=>setImmediate(fn),cancelAnimationFrame:clearImmediate,setTimeout,clearTimeout,performance};
  vm.runInNewContext(crying+'\n'+source,context);
  const sprite=new Sprite();Object.assign(sprite,{ac:new AbortController(),pet:{id:'main'},bodyProtected:true,dragState:{active:false},
    humanity:{body:{phase:'guarded'},crying:false},painStage:{dataset:{bodyPhase:'guarded'},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}},
    stopMove(){},front:0,videoA:video,videoB:video,pos:{x:0,y:0}});
  await sprite.executeBody({id:'drink',actionId:'drink',itemId:'water',index:0,source:'silicon-eat',steps:[{action:'drink'}]},{drink:['喝水']});
  assert.deepEqual(receipts.map(r=>r.status),['playing','completed']);
  assert.equal(receipts[1].played,true);assert.equal(sprite.bodyProtected,true);assert.ok(classes.has('is-crying'));
});

test('时段会影响困意，但不自动休息或按睡眠恢复体力',()=>{
  const now=Date.parse('2026-11-14T05:00:00Z'),state=createHumanity(now);
  state.stats.energy=60;state.stats.stamina=60;
  assert.equal(describeHumanity(state,now).resting,false);
  assert.ok(describeHumanity(state,now).desires.rest>40);
  const later=advanceHumanity(state,now+3600000);
  assert.ok(later.stats.energy<60);
  assert.ok(later.stats.stamina<60);
});

test('体力很低不会自动入睡，真正睡着也不会自动唤醒',async()=>{
  const now=Date.now(),human=createHumanity(now);
  human.stats.energy=1;human.stats.stamina=1;human.stats.satiety=80;human.helperReady=true;human.restrained=false;
  const state={humanity:human,legacy:{services:{inventory:[]},wallet:{},config:{},labor:{contracts:[]}},life:{events:[],actions:[],commitments:[],constraints:{paused:false,capabilities:[]},invalidSources:{}}};
  let writes=0;
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const life=createDeterministicLife({get:async()=>human},{loadEnvelope:async()=>state},async()=>{throw Error('不应触发服务');},gate,{apply:async()=>{writes++;}},{queue:async()=>{throw Error('不应排队');}},{dispatch:async()=>{throw Error('不应派发');}},async()=>{});
  await life.run('main',gate.signal,{allowAutonomous:true});
  human.sleeping=true;human.stats.energy=100;human.stats.stamina=100;
  await life.run('main',gate.signal,{allowAutonomous:true});
  assert.equal(writes,0);
});

test('只有真实提交的吃喝触发一次自然回应，模型失败有可见回退',async()=>{
  const base={petId:'main',humanity:{lastThought:'咕噜，谢谢爸爸'},life:{events:[{eventId:'old'}],invalidSources:{}}};
  const calls=[],shown=[];
  const observe=createCareReactions(base,async(_id,event)=>{calls.push(event);if(event.eventId==='water')throw Error('模型不可用');return '好香呀，爸爸';},text=>shown.push(text));
  const state=structuredClone(base);
  state.life.events.push({eventId:'water',type:'social.care',payload:{action:'water'}},{eventId:'feed',type:'social.care',payload:{action:'feed'}},{eventId:'pending',type:'action.pending',payload:{action:'feed'}});
  observe(state);observe(state);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(x=>x.eventId),['water','feed']);
  assert.match(calls[0].description,/喝了水/);
  assert.match(calls[1].description,/喂了你一口饭/);
  assert.deepEqual(new Set(shown),new Set(['咕噜，谢谢爸爸','好香呀，爸爸']));
});

test('喝水必须播放对应动作，完成回执后才增加水分',async()=>{
  const now=Date.now(),human=createHumanity(now);human.stats.hydration=20;
  const draft={petId:'main',legacy:{},humanity:human,life:{events:[],relationships:[],invalidSources:{}}};
  const channel=createDesktopCommandChannel({loadEnvelope:async()=>structuredClone(draft)},{});
  const intent={id:'drink-action',type:'care.water',payload:{petId:'main',actionId:'drink-action',parameters:{}}};
  const pending=channel.bridge.execute('main',intent,new AbortController().signal);await new Promise(setImmediate);
  const visual=channel.view('main');assert.equal(visual.steps[0].action,'drink');assert.equal(visual.itemId,'water');
  assert.equal(draft.humanity.stats.hydration,20);
  await assert.rejects(channel.receipt({petId:'main',id:intent.id,actionId:intent.id,itemId:'parent',index:0,surface:'desktop',status:'completed',played:true}));
  await channel.receipt({petId:'main',id:intent.id,actionId:intent.id,itemId:'water',index:0,surface:'desktop',status:'completed',played:true});
  const receipt=await pending;assert.equal(receipt.status,'completed');
  projectOutcome(draft,intent,receipt,new Date(now).toISOString(),'receipt');
  assert.ok(describeHumanity(draft.humanity,now+25000).stats.hydration>20);
  assert.equal(draft.life.events[0].payload.action,'water');channel.close();
});

test('喝水中断不会改变水分，手动来源才能使用已有照料权限',async()=>{
  const now=Date.now(),human=createHumanity(now);human.stats.hydration=20;
  const state={petId:'main',version:1,body:{sleeping:false,restrained:false,injured:false,pain:0,stamina:80},goals:[],events:[{eventId:'manual',type:'service.requested',source:'user',actorId:'dad',payload:{kind:'care.water',actionId:'drink'}}],invalidSources:{},constraints:{paused:false,permissions:[],capabilities:[{name:'care.feed',enabled:true,physical:true,bodyLimits:{allowInjured:true,minStamina:-1,maxPain:101}}]}};
  const draft={petId:'main',legacy:{manualServiceRequests:{drink:{kind:'care.water',sourceId:'manual'}}},humanity:human,life:{events:state.events,relationships:[],invalidSources:{}}};
  const proposal={id:'drink',petId:'main',actionType:'care.water',expectedStateVersion:1,priority:60,interruptPolicy:'safe-point',parameters:{},requiredCapabilities:['care.water'],sourceIds:['manual']};
  assert.doesNotThrow(()=>validateManualService(draft,state,proposal));
  assert.throws(()=>validateManualService({...draft,legacy:{}},state,proposal),/来源无效/);
  projectOutcome(draft,{id:'drink',type:'care.water',payload:{parameters:{}}},{status:'cancelled',evidence:{}},new Date(now).toISOString(),'receipt');
  assert.equal(draft.humanity.stats.hydration,20);
});

test('手动照料动作各自使用对应的桌面动作',async()=>{
  const channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{}})},{});
  for(const [care,expected] of [['feed','eat'],['water','drink'],['pet','pet'],['play','play'],['soothe','soothe'],['accompany','accompany']]){
    const id='care-'+care,intent={id,type:'care.'+care,payload:{petId:'main',actionId:id,parameters:{}}};
    const pending=channel.bridge.execute('main',intent,new AbortController().signal);await new Promise(setImmediate);
    const visual=channel.view('main');assert.equal(visual.steps[0].action,expected);
    await channel.receipt({petId:'main',id,actionId:id,itemId:care==='feed'?'parent':care,index:0,surface:'desktop',status:'interrupted'});
    assert.equal((await pending).status,'cancelled');
  }
  channel.close();
});

test('被打断的照料保留桌面回执中的可解释原因',async()=>{
  const channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{}})},{});
  const id='interrupted-drink',intent={id,type:'care.water',payload:{petId:'main',actionId:id,parameters:{}}};
  const pending=channel.bridge.execute('main',intent,new AbortController().signal);await new Promise(setImmediate);
  await channel.receipt({petId:'main',id,actionId:id,itemId:'water',index:0,surface:'desktop',status:'interrupted',reason:'动作被其他互动打断'});
  const result=await pending;assert.equal(result.status,'cancelled');assert.equal(result.evidence.reason,'动作被其他互动打断');channel.close();
});

test('照料回应走桌面可见气泡，并按语音设置决定是否朗读',async()=>{
  const source=await readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/events.js',import.meta.url),'utf8');
  const start=source.indexOf('function applySayLeaf('),end=source.indexOf('\n/** 工作状态叶子',start);
  assert.ok(start>=0&&end>start);
  const shown=[],sprite={pet:{id:'main'},showCareReaction:(text,duration)=>shown.push(['care',text,duration]),showWhisper:()=>shown.push(['random'])};
  const data=careReactionLeaf('喝到了',true),context={sprites:[sprite],S:{readSay:leaf=>({kind:'say',...leaf.data}),playSayVoice:said=>shown.push(['voice',said.voiceTo])}};
  context.leaf={data};vm.runInNewContext(source.slice(start,end)+'\napplySayLeaf("main",leaf);',context);
  assert.deepEqual(shown,[['care','喝到了',12000],['voice','desktop']]);
  assert.equal(careReactionLeaf('喝到了',false).voiceTo,undefined);
});

test('照料完成后面板显示她的回应，而不是只显示完成状态',async()=>{
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const waits=[];
  const adapter=createLegacyRequestAdapter({store:{loadEnvelope:async()=>null},gate,domain:{},humanity:{snapshot:async()=>({lastThought:'备用回应'})},
    resolvePet:()=>({petId:'main',name:'大肥鱼'}),service:async()=>({ok:true,status:'done',actionId:'drink-id',message:'照料已完成'}),
    waitCareResponse:async id=>{waits.push(id);return '咕噜，谢谢爸爸。';}});
  const result=await adapter('http://localhost/humanity/care?pet=main','POST',JSON.stringify({action:'water'}));
  assert.equal(result.obj.text,'咕噜，谢谢爸爸。');assert.deepEqual(waits,['care-water:drink-id']);
});

test('模型返回空内容时照料回应仍可见，且等待者拿到同一句',async()=>{
  const base={petId:'main',humanity:{lastThought:'喝到啦'},life:{events:[],invalidSources:{}}},shown=[];
  const observe=createCareReactions(base,async()=>'',text=>shown.push(text));
  observe({...base,life:{...base.life,events:[{eventId:'care-water:test',type:'social.care',payload:{action:'water'}}]}});
  assert.equal(await observe.wait('care-water:test'),'喝到啦');assert.deepEqual(shown,['喝到啦']);
});

test('照料回应显示期间不会被普通心情气泡盖掉',async()=>{
  const source=await readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/sprite/desktop-body.js',import.meta.url),'utf8');
  const shown=[];class Sprite{showWhisper(text){shown.push(text);}playIdle(){}switchTo(){}dispose(){}}
  vm.runInNewContext(source,{PetSprite:Sprite});const sprite=new Sprite();
  sprite.showCareReaction('喝到啦，谢谢爸爸。',12000);sprite.showInnerThought('其他心情');
  assert.deepEqual(shown,['喝到啦，谢谢爸爸。']);
});

test('喝水请求经过排队、桌面播放和可信回执后才落账',async()=>{
  const now=Date.now(),human=createHumanity(now);human.stats.hydration=20;human.helperReady=true;human.restrained=false;
  const life=createInitialState('main',new Date(now).toISOString());
  life.constraints.paused=false;life.constraints.capabilities=[{name:'care.feed',enabled:true,physical:true,bodyLimits:{allowInjured:true,minStamina:-1,maxPain:101}}];
  let state={petId:'main',version:0,humanity:human,legacy:{},life};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(state)};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const draft=structuredClone(state);fn(draft);draft.version++;state=draft;return draft;}};
  const actions=new ActionCoordinator(uow,projectBody),lifecycle=new CanonicalActionLifecycle(projectBody);
  const channel=createDesktopCommandChannel(store,{});
  const dispatcher={dispatch:async id=>{
    const action=state.life.actions.find(a=>a.id===id),intent={id,type:action.actionType,payload:{petId:'main',actionId:id,actionType:action.actionType,parameters:action.parameters}};
    assert.equal(lifecycle.prepare(state,intent).allowed,true);
    const pending=channel.bridge.execute('main',intent,gate.signal);await new Promise(setImmediate);
    const command=channel.view('main');assert.equal(command.steps[0].action,'drink');assert.equal(state.humanity.stats.hydration,20);
    await channel.receipt({petId:'main',id,actionId:id,itemId:'water',index:0,surface:'desktop',status:'completed',played:true});
    const receipt=await pending;lifecycle.complete(state,intent,receipt);return receipt;
  }};
  const service=createLegacyServiceActions(store,gate,uow,actions,dispatcher);
  const result=await service('main',{key:'drink-request-123',command:'/喝水'});
  assert.equal(result.status,'done');assert.equal(state.life.events.find(e=>e.type==='social.care').payload.action,'water');
  assert.ok(describeHumanity(state.humanity,Date.now()+25000).stats.hydration>20);
  channel.close();
});
