import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {createWorksite} from '../dist/host/worksite.js';
import {createWorksiteReviews} from '../dist/host/worksite-reviews.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';
import {ActionCoordinator} from '../dist/host/action-coordinator.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {projectBody} from '../dist/host/body-projection.js';
import {blocksNewLabor} from '../dist/host/labor-pending.js';
import {ensureSpirit} from '../dist/kernel/spirit.js';

function fixture(){
 const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
 let state={petId:'main',version:0,legacy:old.read('main'),humanity:createHumanity(),life:{observations:[],beliefs:[],events:[],memories:[],invalidSources:{},relationships:[],goals:[],constraints:{permissions:[],capabilities:[{name:'labor.step',enabled:true,physical:true}],paused:false},actions:[],receipts:[],commitments:[]}};
 state.legacy.labor={contracts:[]};state.humanity.helperReady=true;state.humanity.restrained=false;
 const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},store={loadEnvelope:async()=>structuredClone(state)};
 const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const d=structuredClone(state);fn(d);d.version++;state=d;}};
 const site=createWorksite(store,gate,uow,()=>null,()=>{});
 return {get:()=>state,site,gate,store,uow};
}
const job=(id,trips,status='queued')=>({id,status,trips,done:0,wage:50,paid:0,workPermit:false,batchRemaining:0,carrying:false});
async function runTrips(f,steps){
 const controller=new AbortController(),actions=new ActionCoordinator(f.uow,projectBody),lifecycle=new CanonicalActionLifecycle(projectBody);let count=0;
 const dispatcher={dispatch:async id=>{
  const s=f.get(),a=s.life.actions.find(a=>a.id===id),cmd=s.legacy.world.command;
  const intent={id,type:'labor.step',payload:{actionId:id,petId:'main',actionType:'labor.step',parameters:a.parameters}};
  const receipt={status:'completed',evidence:{actionId:id,kind:'labor.step',confirmed:true,commandId:cmd.id,index:cmd.index,surface:'web',played:true,x:cmd.labor.x,effortSeconds:0,intensity:1}};
  await f.uow.apply('main',s.version,d=>{const decision=lifecycle.prepare(d,intent);assert.equal(decision.allowed,true,decision.reason);lifecycle.complete(d,intent,receipt);});
  if(++count===steps)controller.abort();return receipt;
 }};
 const life=createDeterministicLife({get:async()=>structuredClone(f.get().humanity)},f.store,async()=>{},f.gate,f.uow,actions,dispatcher,async()=>{});
 try{await life.run('main',controller.signal,{allowAutonomous:true});for(let i=0;i<500&&count<steps;i++)await new Promise(r=>setTimeout(r,2));assert.equal(count,steps);}finally{controller.abort();}
}
test('空工地自主进出，停工留在原地，再进场自动恢复',async()=>{
 const f=fixture();await f.site.act('main','request-entry');await f.site.act('main','enter-voluntary');
 await f.site.act('main','stop-work');assert.equal(f.get().legacy.worksite.inside,true);assert.equal(f.get().legacy.worksite.workState,'stopped');
 await f.site.act('main','leave-voluntary');await f.site.act('main','request-entry');await f.site.act('main','enter-voluntary');assert.equal(f.get().legacy.worksite.workState,'running');
 await f.site.act('main','release');await f.site.act('main','enter-forced');await assert.rejects(f.site.act('main','leave-voluntary'),/等爸爸/);await f.site.act('main','release');
});
test('每趟真实回执后连续执行，按顺序衔接任务，完成后留在工地',async()=>{
 const f=fixture();f.get().legacy.labor.contracts.push(job('one',2),job('two',2));await f.site.act('main','enter-forced');
 await runTrips(f,16);const s=f.get();assert.deepEqual(s.legacy.labor.contracts.map(c=>c.done),[2,2]);assert.equal(s.legacy.worksite.completedInSession,4);assert.equal(s.legacy.worksite.inside,true);assert.equal(s.legacy.worksite.forced,true);
});
test('停工不覆盖强制工作，恢复普通工作并使旧决定失效',async()=>{
 const f=fixture();f.get().legacy.labor.contracts.push(job('one',2));await f.site.act('main','enter-forced');const expected={sessionId:f.get().legacy.worksite.sessionId,contractId:'one'};
 await f.site.act('main','stop-work');await f.site.act('main','resume-work');await assert.rejects(f.site.act('main','stop-work',expected),/已变化/);
 await f.site.act('main','force-work');await assert.rejects(f.site.act('main','stop-work'),/强制干活/);await runTrips(f,8);assert.equal(f.get().legacy.labor.contracts[0].done,2);
});
test('全部资源耗尽后保留位置并明确停工',async()=>{
 const f=fixture();f.get().legacy.labor.contracts.push(job('one',2));await f.site.act('main','enter-forced');Object.assign(f.get().humanity.stats,{stamina:0,energy:0,satiety:0});f.get().humanity.helperReady=false;ensureSpirit(f.get().life).value=0;
 const life=createDeterministicLife({get:async()=>structuredClone(f.get().humanity)},f.store,async()=>{},f.gate,f.uow,{}, {},async()=>{});await life.run('main',new AbortController().signal,{allowAutonomous:true});
 assert.equal(f.get().legacy.worksite.workState,'stopped');assert.equal(f.get().legacy.worksite.stopReason,'exhausted');assert.equal(f.get().legacy.worksite.inside,true);
});
test('15 趟判断在后台执行，重复通知只请求一次，过期决定不影响新一轮',async()=>{
 const f=fixture();f.get().legacy.labor.contracts.push(job('one',100,'working'));await f.site.act('main','enter-forced');f.get().legacy.worksite.completedInSession=15;
 let release,requests=0;const ready=new Promise(r=>release=r);const budget={runAs:async(_id,_kind,fn)=>fn()};
 const model={agentDefaultModel:{currentSelection:()=>({provider:'x',model:'x'})},llm:{async *stream(){requests++;await ready;yield {type:'text',text:'{"decision":"stop"}'};}}};
 const review=createWorksiteReviews(f.store,f.gate,f.uow,budget,model,(id,expected)=>f.site.act(id,'stop-work',expected));review.observe(f.get());review.observe(f.get());
 for(let i=0;i<20&&requests===0;i++)await new Promise(setImmediate);assert.equal(requests,1);assert.equal(f.get().legacy.worksite.reviewedThrough,15);
 await f.site.act('main','stop-work');await f.site.act('main','resume-work');release();for(let i=0;i<10;i++)await new Promise(setImmediate);
 assert.equal(f.get().legacy.worksite.workState,'running');assert.equal(f.get().legacy.worksite.completedInSession,0);
});

test('同一趟未知回执在中断或重启后不能自动重放，其他任务不被旧记录锁死',()=>{
 const f=fixture(),s=f.get();s.legacy.labor.contracts.push(job('one',3,'working'));s.legacy.world={command:{id:'old',status:'interrupted',labor:{id:'one',trip:0}}};
 s.life.actions.push({actionType:'labor.step',status:'UNKNOWN',parameters:{commandId:'old',contractId:'one'}});assert.equal(blocksNewLabor(s),true);
 s.legacy.labor.contracts[0].done=1;assert.equal(blocksNewLabor(s),false);
});
test('有效的第 15 趟停工决定生效，且不离开工地',async()=>{
 const f=fixture();f.get().legacy.labor.contracts.push(job('one',100,'working'));await f.site.act('main','enter-forced');f.get().legacy.worksite.completedInSession=15;
 const budget={runAs:async(_id,_kind,fn)=>fn()},model={agentDefaultModel:{currentSelection:()=>({provider:'x',model:'x'})},llm:{async *stream(){yield {type:'text',text:'{\"decision\":\"stop\"}'};}}};
 const review=createWorksiteReviews(f.store,f.gate,f.uow,budget,model,(id,expected)=>f.site.act(id,'stop-work',expected));review.observe(f.get());
 for(let i=0;i<30&&f.get().legacy.worksite.workState!=='stopped';i++)await new Promise(setImmediate);
 assert.equal(f.get().legacy.worksite.workState,'stopped');assert.equal(f.get().legacy.worksite.inside,true);assert.equal(f.get().legacy.worksite.forced,true);
});

test('爸爸明确选择重新搬，未知回执不变且不会虚构进度',async()=>{
 const f=fixture();f.get().legacy.labor.contracts.push(job('one',3,'working'));await f.site.act('main','enter-forced');const s=f.get();
 s.legacy.world={command:{id:'old',status:'interrupted',labor:{id:'one',trip:0}}};s.life.actions.push({id:'unknown-step',actionType:'labor.step',status:'UNKNOWN',parameters:{commandId:'old',contractId:'one'}});
 assert.equal((await f.site.snapshot('main')).waitingForReceipt,true);await f.site.act('main','retry-unconfirmed');
 assert.equal(f.get().life.actions.at(-1).status,'UNKNOWN');assert.equal(f.get().legacy.labor.contracts[0].done,0);assert.equal(blocksNewLabor(f.get()),false);assert.equal((await f.site.snapshot('main')).waitingForReceipt,false);
});

test('已经在持续工作时重复恢复不会重新计算 15 趟',async()=>{
 const f=fixture();await f.site.act('main','enter-forced');const s=f.get().legacy.worksite;s.completedInSession=7;const session=s.sessionId;
 await f.site.act('main','resume-work');assert.equal(f.get().legacy.worksite.completedInSession,7);assert.equal(f.get().legacy.worksite.sessionId,session);
});
