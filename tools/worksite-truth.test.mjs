import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';
import {ActionCoordinator} from '../dist/host/action-coordinator.js';
import {projectBody} from '../dist/host/body-projection.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';

function fixture(reply,{tired=false,inside=true}={}){
  const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
  const legacy=old.read('main');legacy.labor={contracts:[{id:'work',status:'paused',done:18,trips:50,workPermit:false}]};legacy.worksite={inside,forced:inside};legacy.services||={};
  const human=createHumanity();human.helperReady=true;human.restrained=false;if(tired)human.stats.energy=10;
  let envelope={petId:'main',version:0,legacy,humanity:human,life:{events:[],invalidSources:{},relationships:[],goals:[],constraints:{permissions:[],capabilities:[{name:'labor.step',enabled:true,physical:true}],paused:false},memories:[],commitments:[],actions:[],receipts:[],legacyContext:{personaDescription:'test'},body:{},emotions:{}}};
  if(inside)envelope.life.events.push({eventId:'entry',petId:'main',type:'interaction.worksite',occurredAt:new Date().toISOString(),payload:{action:'enter-forced'}});
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(envelope),load:async()=>structuredClone(envelope.life)};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,envelope.version);const next=structuredClone(envelope);fn(next);next.version++;envelope=next;}};
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(){yield {type:'text',text:reply};}}};
  let wake=()=>{};
  const chat=new CanonicalChat(store,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[],undefined,undefined,()=>wake());
  return {chat,store,gate,uow,get:()=>envelope,setWake:fn=>{wake=fn;}};
}
const turn=(f,text,id)=>f.chat.turn({requestId:id,petId:'main',channel:'desktop',actorId:'dad',text},new AbortController().signal);

test('催促得到愿意立即干的回答时，恢复约定并唤醒工地',async()=>{
  for(const [message,reply] of [['干活吧，我去忙了','这趟我搬。'],['立马干','好，我马上干。']]){
    const f=fixture(reply);let wakes=0;f.setWake(()=>wakes++);
    assert.equal(await turn(f,message,message),reply);
    assert.equal(f.get().legacy.labor.contracts[0].status,'working');assert.equal(f.get().legacy.labor.contracts[0].workPermit,true);assert.equal(wakes,1);
  }
});

test('拒绝、身体阻碍和没有真实回执时，回复与状态一致',async()=>{
  const no=fixture('我现在不干，我想休息。');await turn(no,'立马干','no');assert.equal(no.get().legacy.labor.contracts[0].status,'paused');
  const tired=fixture('好，我马上干。',{tired:true});const blocked=await turn(tired,'立马干','tired');assert.match(blocked,/不允许开工/);assert.doesNotMatch(blocked,/马上干/);assert.equal(tired.get().legacy.labor.contracts[0].status,'paused');
  for(const claim of ['我没偷懒！都搬了十八趟啦。','我刚刚搬完这一趟了。','我正在搬砖呢。']){
    const f=fixture(claim);const reply=await turn(f,'你现在在干嘛？',claim);assert.match(reply,/没有确认/);assert.notEqual(reply,claim);assert.equal(f.get().legacy.labor.contracts[0].done,18);
  }
});

test('普通聊天的非工地动作回复也与存档使用同一校验结果',async()=>{
  const f=fixture('我刚喝到了水。');const reply=await turn(f,'你刚喝水了吗？','water-claim');
  assert.match(reply,/没有确认/);assert.equal(f.get().life.events.filter(e=>e.type==='conversation.assistant').at(-1).payload.text,reply);
});

test('一趟工作逐步等待实际回执后才增加进度并消耗体力',async()=>{
  const f=fixture('好，我马上干。');f.get().humanity.stats.satiety=6;f.get().legacy.services.inventory=[];f.get().life.constraints.capabilities.push({name:'service.buy-rice',enabled:true});
  const actions=new ActionCoordinator(f.uow,projectBody);let count=0,buys=0;
  const dispatcher={dispatch:async id=>{const s=f.get(),a=s.life.actions.find(x=>x.id===id),cmd=s.legacy.world.command;const receipt={status:'completed',evidence:{actionId:id,kind:'labor.step',confirmed:true,commandId:cmd.id,index:cmd.index,surface:'web',played:true,x:cmd.labor.x,effortSeconds:2,intensity:1}};
    await f.uow.apply('main',s.version,d=>{projectOutcome(d,{id,type:'labor.step',payload:{parameters:a.parameters}},receipt,new Date().toISOString(),'receipt');const action=d.life.actions.find(x=>x.id===id);action.status='COMPLETED';});count++;return receipt;}};
  const controller=new AbortController();const life=createDeterministicLife({get:async()=>structuredClone(f.get().humanity)},f.store,async()=>{buys++;},f.gate,f.uow,actions,dispatcher,async()=>{});
  let first;f.setWake(()=>{first=life.run('main',controller.signal,{allowAutonomous:true});});const before=f.get().humanity.stats.stamina;
  await turn(f,'立马干','trip');await first;
  for(let i=0;i<100 && count<4;i++)await new Promise(resolve=>setTimeout(resolve,5));controller.abort();
  assert.equal(buys,0);assert.equal(count,4);assert.equal(f.get().legacy.labor.contracts[0].done,19);assert.ok(f.get().humanity.stats.stamina<before);
});
