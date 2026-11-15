import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {createWorksite} from '../dist/host/worksite.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';
import {ActionCoordinator} from '../dist/host/action-coordinator.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {projectBody} from '../dist/host/body-projection.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';
import {ensureSpirit,setSpiritRest} from '../dist/kernel/spirit.js';
import {hasForcedWork} from '../dist/host/forced-labor.js';
import {createFinanceManagement} from '../dist/host/finance-management.js';

function fixture(){
  const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
  let state={petId:'main',version:0,legacy:old.read('main'),humanity:createHumanity(),life:{events:[],memories:[],invalidSources:{},relationships:[],goals:[],constraints:{permissions:[],capabilities:[{name:'labor.step',enabled:true,physical:true}],paused:true},actions:[],receipts:[],commitments:[]}};
  state.legacy.labor={contracts:[]};state.humanity.helperReady=true;state.humanity.restrained=false;
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},store={loadEnvelope:async()=>structuredClone(state)};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const d=structuredClone(state);fn(d);d.version++;state=d;}};
  const site=createWorksite(store,gate,uow,()=>null,()=>{});
  return {get:()=>state,site,gate,store,uow};
}
test('空工地、无约定也能强制进场，未虚构答应或工钱',async()=>{
  const f=fixture(),before=structuredClone(f.get().humanity);await f.site.act('main','force-work');
  const s=f.get(),c=s.legacy.labor.contracts[0];assert.equal(s.legacy.worksite.inside,true);assert.equal(c.trips,1);assert.equal(c.wageUnspecified,true);assert.equal(c.accepted,undefined);assert.equal(c.done,0);
  assert.ok(s.humanity.emotions.fear>before.emotions.fear);assert.ok(s.humanity.stats.security<before.stats.security);assert.ok(s.humanity.stats.pain<=before.stats.pain);
  assert.ok(s.life.memories.some(m=>m.content.includes('尚未商量工钱')));assert.equal(hasForcedWork(s),true);
});
test('还在商量也可强制按已有条件搬，不改为自愿同意',async()=>{
  const f=fixture();f.get().legacy.labor.contracts.push({id:'offer',status:'offered',trips:4,done:0,wage:200,paid:0,accepted:false});await f.site.act('main','force-work');
  const c=f.get().legacy.labor.contracts[0];assert.equal(c.status,'working');assert.equal(c.trips,4);assert.equal(c.wage,200);assert.equal(c.accepted,false);
});
test('旧工钱未结也可强制新一趟，旧账仍可查看',async()=>{
  const f=fixture();f.get().legacy.labor.contracts.push({id:'old',status:'unpaid',trips:2,done:2,wage:80,paid:0});await f.site.act('main','force-work');
  const finance=createFinanceManagement(f.store,f.gate,{});const read=await finance.read('main');assert.equal(read.labor.current.wageUnspecified,true);assert.equal(read.labor.history[0].id,'old');assert.equal(read.labor.history[0].wage,80);
});
test('接她出去会撤销强制搬运，作废强迫来源也不能绕过暂停',async()=>{
  const f=fixture();await f.site.act('main','force-work');
  const source=f.get().legacy.labor.contracts[0].forcedSource;
  f.get().life.invalidSources[source]='removed';assert.equal(hasForcedWork(f.get()),false);
  delete f.get().life.invalidSources[source];await f.site.act('main','release');assert.equal(hasForcedWork(f.get()),false);assert.equal(f.get().legacy.labor.contracts[0].forced,false);
});
test('强制动作途中取消仍结算已经发生的痛苦，不把负体力补回零',async()=>{
  const f=fixture();await f.site.act('main','force-work');const s=f.get(),c=s.legacy.labor.contracts[0];
  c.status='cancelled';c.forced=false;s.humanity.stats.stamina=-10;
  s.legacy.world={command:{id:'partial',source:'labor',status:'interrupted',forcedLabor:true}};
  projectOutcome(s,{id:'partial-action',type:'labor.step',payload:{parameters:{contractId:c.id,commandId:'partial'}}},{status:'cancelled',evidence:{actionId:'partial-action',kind:'labor.step',confirmed:true,effortSeconds:3,intensity:1}},new Date().toISOString(),'partial-receipt');
  assert.ok(s.humanity.stats.stamina<-10);assert.ok(s.humanity.stats.pain>3);assert.equal(c.done,0);assert.ok(s.life.memories.some(m=>m.content.includes('实际用力 3 秒')));
});
test('休息、零精神、负体力和自主暂停均不拦强制工作，实际回执才增加进度并留下痛苦记忆',async()=>{
  const f=fixture(),s=f.get();s.humanity.sleeping=true;s.humanity.restingUntil=Date.now()+600000;s.humanity.stats.stamina=-10;s.humanity.stats.energy=-10;
  const spirit=ensureSpirit(s.life);spirit.value=0;setSpiritRest(s.life,'sleep');
  await f.site.act('main','force-work');
  const actions=new ActionCoordinator(f.uow,projectBody),lifecycle=new CanonicalActionLifecycle(projectBody);let count=0;
  const controller=new AbortController();
  const dispatcher={dispatch:async id=>{
    const state=f.get(),a=state.life.actions.find(a=>a.id===id),cmd=state.legacy.world.command;
    const intent={id,type:'labor.step',payload:{actionId:id,petId:'main',actionType:'labor.step',parameters:a.parameters}};
    const receipt={status:'completed',evidence:{actionId:id,kind:'labor.step',confirmed:true,commandId:cmd.id,index:cmd.index,surface:'web',played:true,x:cmd.labor.x,effortSeconds:2,intensity:1}};
    await f.uow.apply('main',state.version,d=>{const prepared=lifecycle.prepare(d,intent);assert.equal(prepared.allowed,true,prepared.reason);projectOutcome(d,intent,receipt,new Date().toISOString(),'test-receipt:'+id);d.life.actions.find(a=>a.id===id).status='COMPLETED';});
    count++;if(count===4)controller.abort();return receipt;
  }};
  const life=createDeterministicLife({get:async()=>structuredClone(f.get().humanity)},f.store,async()=>{throw Error('unexpected self care');},f.gate,f.uow,actions,dispatcher,async()=>{});
  await life.run('main',controller.signal,{allowAutonomous:false});
  for(let i=0;i<100&&count<4;i++)await new Promise(r=>setTimeout(r,5));controller.abort();
  assert.equal(count,4);assert.equal(f.get().legacy.labor.contracts[0].done,1);assert.ok(f.get().humanity.stats.pain>s.humanity.stats.pain);assert.ok(f.get().life.memories.some(m=>m.content.includes('我被强迫搬运')));assert.equal(f.get().life.spirit.value,0);
});
