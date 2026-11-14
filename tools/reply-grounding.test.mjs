import test from 'node:test';
import assert from 'node:assert/strict';
import {groundActionReply} from '../dist/host/reply-grounding.js';
import {createLegacyResponses} from '../dist/host/legacy-responses.js';

const now=Date.parse('2026-11-14T12:00:00Z');
function state(type,status='COMPLETED',params={}){
  const receiptId='receipt';
  return {legacy:{},life:{invalidSources:{},actions:type?[{id:'a',actionType:type,status,parameters:params,sourceIds:[],receiptId}]:[],receipts:type?[{receiptId,actionId:'a',status,occurredAt:new Date(now-1000).toISOString()}]:[],events:type?[{eventId:'result',type:'action.receipt',causationId:receiptId}]:[]}};
}
test('吃喝、睡醒、移动、拾取和联网都需要对应完成回执',()=>{
  for(const text of ['我刚吃了饭。','我刚喝了水。','我已经睡着了。','我刚醒了。','我刚走了几步。','我刚捡到了钱。','我刚查到了资料。','我刚看了图片。'])assert.match(groundActionReply(text,state(),now),/没有确认/,text);
  assert.equal(groundActionReply('我刚喝了水。',state('care.water'),now),'我刚喝了水。');
  assert.match(groundActionReply('我刚吃了饭。',state('care.water'),now),/没有确认/);
  assert.match(groundActionReply('我刚跑了几步。',state('body.activity','COMPLETED',{activity:'dance'}),now),/没有确认/);
});
test('待执行、失败、未知、失效和过期回执不能冒充完成',()=>{
  for(const status of ['PENDING','DISPATCHED','FAILED','CANCELLED','UNKNOWN'])assert.match(groundActionReply('我刚喝了水。',state('care.water',status),now),/没有确认/);
  const invalid=state('care.water');invalid.life.invalidSources.result='已删除';assert.match(groundActionReply('我刚喝了水。',invalid,now),/没有确认/);
  const old=state('care.water');old.life.receipts[0].occurredAt=new Date(now-20*60000).toISOString();assert.match(groundActionReply('我刚喝了水。',old,now),/没有确认/);
});
test('照料和结薪按各自的真实记录核对',()=>{
  assert.match(groundActionReply('爸爸刚刚摸了我。',state(),now),/没有确认/);
  assert.equal(groundActionReply('爸爸刚刚摸了我。',state('care.pet'),now),'爸爸刚刚摸了我。');
  assert.match(groundActionReply('我刚收到工资了。',state(),now),/没有确认/);
  const paid=state();paid.life.events.push({eventId:'pay',type:'social.labor.payment',source:'user',occurredAt:new Date(now-1000).toISOString(),payload:{amount:50}});
  assert.equal(groundActionReply('我刚收到工资了。',paid,now),'我刚收到工资了。');
  paid.life.invalidSources.pay='删除';assert.match(groundActionReply('我刚收到工资了。',paid,now),/没有确认/);
});
test('意愿与执行分开，正在执行不能由旧完成回执证明',()=>{
  assert.match(groundActionReply('我马上去喝水。',state(),now),/没有安排/);
  assert.equal(groundActionReply('我马上去喝水。',state('care.water','PENDING'),now),'我马上去喝水。');
  assert.match(groundActionReply('我正在喝水。',state('care.water'),now),/是否正在执行/);
  assert.equal(groundActionReply('我想喝水。',state(),now),'我想喝水。');
  assert.equal(groundActionReply('我还没喝水。',state(),now),'我还没喝水。');
  assert.match(groundActionReply('我没吃饭，但我刚喝了水。',state(),now),/没有确认/);
});

test('互动回应提交和对外返回同一条经核对的文本',async()=>{
  const base=state();base.petId='main';base.version=0;base.humanity={stats:{},emotions:{},desires:{}};base.life.memories=[];base.life.constraints={paused:false};
  base.life.events.push({eventId:'pet',type:'social.care',source:'executor',payload:{action:'pet'}});
  let current=base;const store={loadEnvelope:async()=>structuredClone(current)},gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const uow={apply:async(_id,version,fn)=>{assert.equal(current.version,version);const draft=structuredClone(current);fn(draft);draft.version++;current=draft;}};
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(){yield {type:'text',text:'我刚喝到了水。'};}}};
  const respond=createLegacyResponses(store,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,'test');
  const reply=await respond('main','care',gate.signal,{eventId:'pet',description:'摸摸'});
  assert.match(reply,/没有确认/);assert.equal(current.life.events.at(-1).payload.text,reply);
});
