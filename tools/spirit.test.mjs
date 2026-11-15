import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureSpirit,advanceSpirit,setSpiritRest,spendSpirit,sleepRecovery,fatigueMultiplier} from '../dist/kernel/spirit.js';
import {extractThought} from '../dist/host/thought-expression.js';
import {checkSimulatedSpending,settleSimulatedSpending} from '../dist/host/simulated-spending.js';
import {initializeSpirit} from '../dist/host/spirit-initialization.js';
const hour=3600000,at=1700000000000;
const life=()=>{const l={};ensureSpirit(l,at);return l;};
test('指数恢复严格在连续八小时回满，重启、频繁结算与单次结算一致',()=>{
  const a=life();a.spirit.value=0;setSpiritRest(a,'sleep',at);const b=structuredClone(a);
  for(let t=1;t<=479;t++)advanceSpirit(a,at+t*60000);
  assert.ok(a.spirit.value<100);advanceSpirit(b,at+479*60000);assert.equal(a.spirit.value,b.spirit.value);
  advanceSpirit(a,at+8*hour);assert.equal(a.spirit.value,100);
  assert.ok(sleepRecovery(2,8)>sleepRecovery(4,8)-sleepRecovery(2,8));
});
test('中途叫醒不补足睡眠，小憩不会清除睡眠债或补满',()=>{
  const l=life();l.spirit.value=0;setSpiritRest(l,'sleep',at);setSpiritRest(l,'awake',at+4*hour);
  const v=l.spirit.value;assert.ok(v>0&&v<100);assert.equal(l.spirit.lastSleepHours,4);
  setSpiritRest(l,'sleep',at+4*hour);advanceSpirit(l,at+8*hour);assert.ok(l.spirit.value<100);
  const n=life();n.spirit.value=10;setSpiritRest(n,'nap',at);advanceSpirit(n,at+hour/3);assert.equal(n.spirit.value,12);assert.equal(n.spirit.awakeSince,at);
});
test('清醒过久的自然损耗按指数积分，不受更新频率影响',()=>{
  const a=life(),b=life();a.spirit.value=b.spirit.value=100;
  for(let t=1;t<=15*60;t++)advanceSpirit(a,at+t*60000);
  advanceSpirit(b,at+15*hour);assert.ok(Math.abs(a.spirit.value-b.spirit.value)<1e-9);
  assert.ok(fatigueMultiplier(a.spirit,at+15*hour)>1);
});
test('精神为零或睡着时不调用行动，睡眠和唤醒仍可用',()=>{
  const l=life();l.spirit.value=0;assert.throws(()=>spendSpirit(l,'learning.observe',at),/精神/);
  spendSpirit(l,'body.sleep',at);setSpiritRest(l,'sleep',at);assert.throws(()=>spendSpirit(l,'thought',at),/精神/);spendSpirit(l,'body.wake',at);
});
test('零饭钱仍能聊天，聊天不扣饭钱，日记仍按原价结算',()=>{
  const d={life:life(),legacy:{wallet:{balance:0,frozen:false},config:{costs:{diary:100}},events:[]}};
  // Real-time preflight starts from a fresh checkpoint.
  d.life.spirit.updatedAt=Date.now();d.life.spirit.awakeSince=Date.now();
  checkSimulatedSpending(d,'chat');settleSimulatedSpending(d,'chat','one');assert.equal(d.legacy.wallet.balance,0);
  assert.throws(()=>checkSimulatedSpending(d,'diary'),/不足/);
  d.legacy.wallet.balance=100;d.life.events=[];settleSimulatedSpending(d,'diary','one');assert.equal(d.legacy.wallet.balance,0);
});
test('主观念头被提取，发言不泄露内部标记',()=>{
  assert.deepEqual(extractThought('<念头>有点累，想轻声说。</念头>爸爸，陪我坐会儿。'),{feeling:'有点累，想轻声说。',reply:'爸爸，陪我坐会儿。'});
});
test('存档升级保留暂停、已有禁用能力、余额和身体',()=>{
  const d={life:{constraints:{paused:true,permissions:[],capabilities:[{name:'self.express',enabled:false}]}},humanity:{sleeping:false},legacy:{wallet:{balance:123}}};
  initializeSpirit(d,at);initializeSpirit(d,at+1000);assert.equal(d.life.constraints.paused,true);assert.equal(d.life.constraints.capabilities.find(c=>c.name==='self.express').enabled,false);assert.equal(d.legacy.wallet.balance,123);assert.equal(d.life.spirit.value,80);
});
import {DurableCognitiveBudget} from '../dist/host/cognitive-budget.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {createInitialState} from '../dist/kernel/index.js';
import {sweetPrice} from '../dist/host/spirit-activity.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';
function fixture(){
 const state=createInitialState('main',new Date().toISOString());state.constraints.paused=false;
 const {petId,version,body,emotions,...l}=state;
 const d={petId,version,life:l,humanity:{stats:{satiety:50},sleeping:false},legacy:{wallet:{balance:0,frozen:false},config:{learning:{dailyModelCalls:100},costs:{feed:20}},usage:{}}};ensureSpirit(d.life);
 const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
 const store={load:async()=>({...d.life,petId,version:d.version,body,emotions}),loadEnvelope:async()=>structuredClone(d)};
 const uow={apply:async(_id,v,fn)=>{assert.equal(v,d.version);const n=structuredClone(d);fn(n);n.version++;Object.assign(d,n);return structuredClone(d);}};
 return {d,gate,store,uow,projection:()=>({body,emotions})};
}
test('真实模型预算预扣精神，失败不退款，复用认知票据不会双扣',async()=>{
 const f=fixture(),budget=new DurableCognitiveBudget(f.store,f.uow,f.gate),before=f.d.life.spirit.value;
 const ticket=await budget.reserve('main');assert.ok(ticket);
 const after=f.d.life.spirit.value;assert.ok(before-after>=.5);
 await budget.withReserved('main',ticket,()=>budget.reserve('provider','model',f.gate.signal));assert.equal(f.d.life.spirit.value,after);
 await assert.rejects(budget.runAs('main','interactive',async()=>{await budget.reserve('provider','model',f.gate.signal);throw Error('model unavailable');}));
 assert.ok(f.d.life.spirit.value<after);const used=f.d.life.spirit.value;
 f.d.life.spirit.value=0;assert.equal(await budget.reserve('main'),null);assert.equal(f.d.life.spirit.value,0);
 assert.equal(f.d.legacy.wallet.balance,0);assert.ok(used>0);
});
test('行动派发扣一次精神，重复完成回执不重复收费或发言',()=>{
 const f=fixture(),d=f.d,now=new Date(),action={id:'expression-one',petId:'main',actionType:'self.express',parameters:{text:'想听听窗外的声音。'},priority:10,interruptPolicy:'interruptible',requiredCapabilities:['self.express'],expectedStateVersion:0,sourceIds:[],status:'PENDING',createdAt:now.toISOString(),updatedAt:now.toISOString()};
 d.life.constraints.capabilities=[{name:'self.express',enabled:true}];d.life.actions.push(action);
 const intent={id:action.id,type:action.actionType,payload:{actionId:action.id,petId:'main',actionType:action.actionType,parameters:action.parameters}};
 const lifecycle=new CanonicalActionLifecycle(f.projection,()=>now),before=d.life.spirit.value;
 assert.equal(lifecycle.prepare(d,intent).allowed,true);assert.ok(d.life.spirit.value<=before-.5);
 const receipt={status:'completed',evidence:{actionId:action.id,kind:action.actionType,confirmed:true}};
 lifecycle.complete(d,intent,receipt);const after=d.life.spirit.value;lifecycle.complete(d,intent,receipt);
 assert.equal(d.life.spirit.value,after);assert.equal(d.life.events.filter(e=>e.eventId.startsWith('self-expression:')).length,1);
});
test('甜食快速恢复但不会回满，扣饭钱、增加饥饿并受冷却限制',()=>{
 const f=fixture(),d=f.d;d.legacy.wallet.balance=10;d.life.spirit.value=98;
 const now=Date.now(),intent={id:'sweet-one',type:'service.sweet',payload:{parameters:{}}};
 assert.equal(sweetPrice(d,now),5);projectOutcome(d,intent,{status:'completed',evidence:{actionId:intent.id,kind:intent.type,confirmed:true}},new Date(now).toISOString(),'receipt');
 assert.equal(d.life.spirit.value,99);assert.equal(d.legacy.wallet.balance,5);assert.equal(d.humanity.stats.satiety,42);assert.throws(()=>sweetPrice(d,now+3600000),/暂时/);
});
import {CanonicalChat} from '../dist/host/chat-service.js';
test('精神耗尽时的睡眠、打盹、叫醒与甜食命令绕过模型预检',async()=>{
 const f=fixture();f.d.life.spirit.value=0;let calls=0;
 const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(){throw Error('must not call model');}}};
 const chat=new CanonicalChat(f.store,f.gate,f.uow,{runAs:async()=>{throw Error('must not call budget');}},model,async()=>[],undefined,async(_id,input)=>{calls++;return {message:input.command+'已处理'};});
 for(const text of ['/休息','/打盹','/醒来','/甜食'])assert.equal(await chat.turn({requestId:'recovery-'+calls,petId:'main',channel:'desktop',actorId:'dad',text},f.gate.signal),text+'已处理');
 assert.equal(calls,4);assert.equal(f.d.legacy.wallet.balance,0);
});


test('chat reservation charges its first model call in the same transaction and credits it once',async()=>{
 const f=fixture(),budget=new DurableCognitiveBudget(f.store,f.uow,f.gate);f.d.legacy.config.modelBudget={interactiveDailyCalls:1};
 let ticket;await f.uow.apply('main',f.d.version,draft=>{ticket=budget.reserveInteractive(draft);});
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const spirit=f.d.life.spirit.value;assert.equal(f.d.legacy.usage[day].interactiveCalls,1);
 await budget.runInteractiveReserved('main',ticket,async()=>{await budget.reserve('provider','model',f.gate.signal);assert.equal(f.d.life.spirit.value,spirit);await assert.rejects(budget.reserve('provider','model',f.gate.signal),/额度不足/);});
 assert.equal(f.d.legacy.usage[day].interactiveCalls,1);assert.throws(()=>budget.runInteractiveReserved('main',ticket,async()=>{}),/票据无效/);
});


test('exhaustion and sleep never reject interactive model calls or essential food actions',async()=>{
 const f=fixture(),budget=new DurableCognitiveBudget(f.store,f.uow,f.gate);f.d.life.spirit.value=0;setSpiritRest(f.d.life,'sleep');
 checkSimulatedSpending(f.d,'chat');
 await budget.runAs('main','interactive',()=>budget.reserve('provider','model',f.gate.signal));assert.equal(f.d.life.spirit.value,0);
 assert.equal(f.d.life.spirit.mode,'sleep');assert.equal(await budget.reserve('main'),null);
 setSpiritRest(f.d.life,'awake');f.d.life.spirit.value=0;assert.doesNotThrow(()=>spendSpirit(f.d.life,'service.buy-rice'));assert.doesNotThrow(()=>spendSpirit(f.d.life,'service.eat-rice'));assert.equal(f.d.life.spirit.value,0);
});
