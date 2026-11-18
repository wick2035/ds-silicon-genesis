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
import {hasForcedWork,canChooseLabor,laborBlockReason} from '../dist/host/forced-labor.js';
import {createFinanceManagement} from '../dist/host/finance-management.js';

function fixture(){
  const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
  let state={petId:'main',version:0,legacy:old.read('main'),humanity:createHumanity(),life:{observations:[],beliefs:[],events:[],memories:[],invalidSources:{},relationships:[],goals:[],constraints:{permissions:[],capabilities:[{name:'labor.step',enabled:true,physical:true}],paused:true},actions:[],receipts:[],commitments:[]}};
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
test('提速前后完整往返消耗相同，用力时间分别按实际回执保存',async()=>{
  const f=fixture();await f.site.act('main','force-work');
  const at=new Date().toISOString();
  function completeTrip(forced,measured){
    const s=structuredClone(f.get()),c=s.legacy.labor.contracts[0];c.forced=forced;
    for(const [leg,x,intensity] of [['load',.22,1],['deliver',.78,1.5]]){
      s.legacy.world={command:{id:leg,source:'labor',status:'queued',surface:'web',index:0,labor:{id:c.id,trip:0,leg,x}}};
      for(const index of [0,1]){
        const id=`${leg}:${index}`,effortSeconds=index===0?(measured?1.4:2.24):.9;
        const evidence={actionId:id,kind:'labor.step',confirmed:true,commandId:leg,index,surface:'web',played:true,x,effortSeconds,intensity,
          ...(measured?{actionFraction:1,...(index===0?{travelDistance:.56}:{})}:{})};
        projectOutcome(s,{id,type:'labor.step',payload:{parameters:{contractId:c.id,commandId:leg}}},{status:'completed',evidence},at,`receipt:${id}`);
      }
    }
    assert.equal(c.done,1);assert.equal(c.status,'unpaid');assert.equal(c.paid,0);
    return s;
  }
  for(const forced of [false,true]){
    const old=completeTrip(forced,false),measured=completeTrip(forced,true);
    assert.deepEqual(measured.humanity.stats,old.humanity.stats);
    assert.deepEqual(measured.humanity.emotions,old.humanity.emotions);
    assert.equal(measured.humanity.serviceActions['labor-effort:deliver:0'].seconds,1.4);
    const memories=measured.life.memories.filter(m=>m.id.startsWith('forced-labor-memory:'));
    assert.equal(memories.length,forced?4:0);
    if(forced)assert.match(memories[2].content,/实际用力 1\.4 秒/);
  }
});
test('放砖回执入库前若任务已暂停，只记录已经确认的用力',async()=>{
  const f=fixture();await f.site.act('main','force-work');
  const s=f.get(),contract=s.legacy.labor.contracts[0];contract.status='paused';contract.carrying=true;
  s.legacy.world={command:{id:'delivery',source:'labor',status:'interrupted',forcedLabor:true,surface:'web',index:1,labor:{id:contract.id,trip:0,leg:'deliver',x:.78}}};
  const id='putdown',intent={id,type:'labor.step',payload:{parameters:{contractId:contract.id,commandId:'delivery'}}};
  const evidence={actionId:id,kind:'labor.step',confirmed:true,commandId:'delivery',index:1,surface:'web',played:true,x:.78,effortSeconds:.9,intensity:1.5,actionFraction:1};
  const receipt=new CanonicalActionLifecycle(projectBody).validateReceipt(s,intent,{status:'completed',evidence});
  assert.equal(receipt.status,'cancelled');
  projectOutcome(s,intent,receipt,new Date().toISOString(),'putdown-receipt');
  assert.equal(contract.done,0);assert.equal(contract.paid,0);assert.equal(contract.status,'paused');
  assert.match(s.life.memories.find(m=>m.id==='forced-labor-memory:putdown').content,/实际用力 0\.9 秒/);
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


test('重复强制按钮保留正在派发的身体步骤，许可覆盖全部剩余工作',async()=>{
  const f=fixture();f.get().legacy.labor.contracts.push({id:'job',status:'working',trips:5,done:2,wage:50,paid:0});
  await f.site.act('main','force-work');
  f.get().legacy.world={command:{id:'live',source:'labor',status:'queued',index:0,labor:{id:'job',trip:2}}};
  f.get().life.actions.push({id:'live-step',actionType:'labor.step',status:'DISPATCHED',parameters:{commandId:'live'}});
  await f.site.act('main','force-work');await f.site.act('main','force-work');
  assert.equal(f.get().legacy.world.command.id,'live');assert.equal(f.get().legacy.world.command.status,'queued');
  assert.equal(f.get().legacy.labor.contracts[0].batchRemaining,3);assert.equal(f.get().legacy.labor.contracts[0].done,2);
});

async function executeTrips(f,trips,forced){
  const controller=new AbortController(),actions=new ActionCoordinator(f.uow,projectBody),lifecycle=new CanonicalActionLifecycle(projectBody);let count=0;
  const dispatcher={dispatch:async id=>{
    const s=f.get(),a=s.life.actions.find(a=>a.id===id),cmd=s.legacy.world.command;
    const intent={id,type:'labor.step',payload:{actionId:id,petId:'main',actionType:'labor.step',parameters:a.parameters}};
    const receipt={status:'completed',evidence:{actionId:id,kind:'labor.step',confirmed:true,commandId:cmd.id,index:cmd.index,surface:'web',played:true,x:cmd.labor.x,effortSeconds:2,intensity:1}};
    await f.uow.apply('main',s.version,d=>{const decision=lifecycle.prepare(d,intent);assert.equal(decision.allowed,true,decision.reason);lifecycle.complete(d,intent,receipt);});
    if(++count===trips*4)controller.abort();return receipt;
  }};
  const life=createDeterministicLife({get:async()=>structuredClone(f.get().humanity)},f.store,async()=>{throw Error('unexpected care');},f.gate,f.uow,actions,dispatcher,async()=>{});
  try{await life.run('main',controller.signal,{allowAutonomous:!forced});for(let i=0;i<200&&count<trips*4;i++)await new Promise(r=>setTimeout(r,5));assert.equal(count,trips*4);}
  finally{controller.abort();}
}

test('旧的一趟强制许可自动续上，零精神和负体力仍连续完成三趟',async()=>{
  const f=fixture();f.get().legacy.labor.contracts.push({id:'job',status:'working',trips:3,done:0,wage:50,paid:0});
  await f.site.act('main','force-work');const s=f.get();s.legacy.labor.contracts[0].batchRemaining=1;
  s.humanity.stats.stamina=-10;s.humanity.stats.energy=-10;ensureSpirit(s.life).value=0;
  await executeTrips(f,3,true);assert.equal(f.get().legacy.labor.contracts[0].done,3);assert.equal(f.get().legacy.labor.contracts[0].status,'unpaid');
});

test('自愿决定搬砖时低体力、伤痛、短休息及零精神不撤销工作许可',async()=>{
  const f=fixture(),s=f.get();s.life.constraints.paused=false;s.legacy.worksite={inside:true,forced:false};
  s.legacy.labor.contracts.push({id:'job',status:'working',trips:1,done:0,wage:50,paid:0,workPermit:true,batchRemaining:1});
  Object.assign(s.humanity.stats,{stamina:1,energy:0,pain:100,satiety:1});s.humanity.restingUntil=Date.now()+600000;ensureSpirit(s.life).value=0;
  await executeTrips(f,1,false);assert.equal(f.get().legacy.labor.contracts[0].done,1);assert.equal(f.get().life.spirit.value,0);
});

test('自主搬砖只在四项资源全部耗尽时受资源门槛拦截，暂停和权限仍有效',()=>{
  const f=fixture(),s=f.get();s.life.constraints.paused=false;
  Object.assign(s.humanity.stats,{stamina:0,energy:0,satiety:0,pain:100});ensureSpirit(s.life).value=0;
  assert.equal(canChooseLabor(s),false);
  for(const key of ['stamina','energy','satiety']){s.humanity.stats[key]=.1;assert.equal(canChooseLabor(s),true);s.humanity.stats[key]=0;}
  s.life.spirit.value=.1;assert.equal(canChooseLabor(s),true);s.life.constraints.paused=true;assert.equal(canChooseLabor(s),false);
  s.life.constraints.paused=false;s.life.constraints.capabilities[0].enabled=false;assert.equal(canChooseLabor(s),false);
});


test('工作受阻时准确说明原因，不把连接、抓取和权限混为一谈',()=>{
  const f=fixture(),s=f.get();s.life.constraints.paused=false;
  s.humanity.helperReady=false;assert.match(laborBlockReason(s),/连接/);
  s.humanity.helperReady=true;s.humanity.restrained=true;assert.match(laborBlockReason(s),/抓住/);
  s.humanity.restrained=false;s.life.constraints.capabilities[0].enabled=false;assert.match(laborBlockReason(s),/能力/);
});


test('排队期间工作命令改变或超时，派发前取消旧步骤',()=>{
  const f=fixture(),s=f.get();s.legacy.worksite={inside:true,forced:false};
  s.legacy.labor.contracts.push({id:'job',status:'working',done:0,trips:2,workPermit:true});
  const action={id:'step',petId:'main',actionType:'labor.step',status:'PENDING',parameters:{contractId:'job',commandId:'old'},sourceIds:[],requiredCapabilities:['labor.step']};
  s.life.actions.push(action);s.legacy.world={command:{id:'new',surface:'web',status:'queued',expires:Date.now()+60000,labor:{id:'job'}}};
  const intent={id:'step',type:'labor.step',payload:{petId:'main',actionId:'step',actionType:'labor.step',parameters:action.parameters}};
  const lifecycle=new CanonicalActionLifecycle(projectBody);assert.match(lifecycle.prepare(s,intent).reason,/步骤已变化/);
  s.legacy.world.command.id='old';s.legacy.world.command.expires=Date.now()-1;assert.match(lifecycle.prepare(s,intent).reason,/步骤已变化/);
});
