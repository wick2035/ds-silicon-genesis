import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,invalidateDependents} from '../dist/kernel/index.js';
import {applyGoalProposal,mergeDuplicateGoals} from '../dist/kernel/goal-lifecycle.js';
import {Cognition} from '../dist/cognition/index.js';
import {CognitiveResultCoordinator} from '../dist/host/cognitive-result.js';
import {createCognitiveModel} from '../dist/host/cognitive-model.js';
import {CanonicalMemoryRetrieval} from '../dist/host/memory-retrieval.js';
import {createLifeApi} from '../dist/host/life-api.js';
const at='2026-11-15T08:00:00.000Z';
const answer='被遗弃是原本承担照顾责任的人不再照顾。被遗弃并不是受害者的错；他们可能得到救助，也可能仍需要稳定的照顾和陪伴。';
const update={goalId:'g',kind:'understood',evidenceId:'explanation',understanding:answer};
function fixture(){
 const s=createInitialState('main',at);s.constraints.paused=false;
 s.events.push({eventId:'question',petId:'main',type:'conversation.user',source:'desktop',actorId:'dad',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{text:'被遗弃是什么意思？'}},
 {eventId:'explanation',petId:'main',type:'conversation.user',source:'desktop',actorId:'dad',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{text:answer}});
 s.memories.push({id:'explanation-memory',kind:'semantic',content:answer,sourceIds:['explanation'],evidenceLevel:'reported',valid:true,createdAt:at});
 s.goals.push({id:'g',title:'弄明白被遗弃是什么意思',kind:'self-directed',priority:0,urgency:0,status:'active',sourceIds:['question']});return s;
}
test('写入解释本身不完成目标；理解后保存引用和主观记忆',()=>{
 const s=fixture();assert.equal(s.goals[0].status,'active');applyGoalProposal(s,update,at);
 assert.equal(s.goals[0].status,'completed');assert.equal(s.events.at(-1).type,'goal.understood');assert.equal(s.events.at(-1).evidenceLevel,'inferred');assert.equal(s.memories.at(-1).content.includes(answer),true);
 s.invalidSources.explanation='纠正';invalidateDependents(s);assert.equal(s.memories.at(-1).valid,false);
});
test('实际行动和指定网页阅读不能凭文字理解完成',()=>{
 for(const goal of [{kind:'service',title:'吃饭'},{kind:'self-directed',title:'去月球'},{kind:'explore',title:'阅读网页',completion:{type:'read-url',url:'https://example.org'}}]){
  const s=fixture();Object.assign(s.goals[0],goal);assert.throws(()=>applyGoalProposal(s,update,at));assert.equal(s.goals[0].status,'active');
 }
});
test('拒绝失效、未经阅读、陌生人和空泛的理解证据',()=>{
 for(const mutate of [s=>s.invalidSources.explanation='删除',s=>s.memories[0].valid=false,s=>s.events[1].actorId='stranger',s=>s.events[1].evidenceLevel='inferred']){
  const s=fixture();mutate(s);assert.throws(()=>applyGoalProposal(s,update,at));
 }
 assert.throws(()=>applyGoalProposal(fixture(),{...update,understanding:'我知道了'},at));
});
test('精确重复合并来源和引用，可从旧目标ID完成，重复提交幂等',()=>{
 const s=fixture();s.goals.push({...s.goals[0],id:'duplicate',title:'弄明白“被遗弃”是什么意思？',priority:30,sourceIds:['explanation']});
 s.actions.push({id:'pending',goalId:'duplicate'});s.cognitivePlans=[{steps:[{goalId:'duplicate'}]}];
 assert.equal(mergeDuplicateGoals(s,at),1);assert.equal(mergeDuplicateGoals(s,at),0);
 assert.equal(s.goals[1].mergedInto,'g');assert.equal(s.goals[1].status,'abandoned');assert.equal(s.actions[0].goalId,'g');assert.equal(s.cognitivePlans[0].steps[0].goalId,'g');assert.deepEqual(s.goals[0].sourceIds,['question','explanation']);
 applyGoalProposal(s,{...update,goalId:'duplicate'},at);applyGoalProposal(s,update,at);assert.equal(s.events.filter(e=>e.type==='goal.understood').length,1);
});
test('不同问题、暂停目标和不同阅读条件不误合并',()=>{
 const s=fixture();s.goals.push({...s.goals[0],id:'other',title:'被遗弃的人和动物后来会怎么样'}, {...s.goals[0],id:'paused',status:'paused'}, {...s.goals[0],id:'read',completion:{type:'read-url',url:'https://example.org'}});
 assert.equal(mergeDuplicateGoals(s,at),0);
});
const output={thought:null,action:null,goals:[],goalUpdates:[update],plan:[],interests:[],selfModel:[]};
test('认知必须实际收到解释记忆才可提出完成',async()=>{
 for(const read of [true,false]){
  const s=fixture(),c=new Cognition({generate:async()=>output},{reserve:async()=>({}),withReserved:async(_id,_ticket,fn)=>fn()},{forCognition:async()=>read?s.memories:[],world:async()=>({space:{},inventory:[],capabilities:[],recentResults:[]})});
  const result=await c.propose(s,new AbortController().signal,async()=>s);assert.equal(result.status,read?'proposed':'degraded');if(!read)assert.equal(result.reason,'unread_goal_explanation');
 }
});
test('接受认知时将理解记忆和完成状态一起写入存档',async()=>{
 let envelope={petId:'main',version:0,life:fixture(),legacy:{},humanity:{}};
 const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
 const uow={apply:async(_id,version,change)=>{assert.equal(version,envelope.version);const d=structuredClone(envelope);change(d);d.version++;envelope=d;}};
 const coordinator=new CognitiveResultCoordinator({loadEnvelope:async()=>structuredClone(envelope)},uow,gate,()=>({body:fixture().body,emotions:fixture().emotions}),{},{});
 await coordinator.accept('main',{status:'proposed',sourceVersion:0,proposal:null,candidates:output},gate.signal);
 assert.equal(envelope.life.goals[0].status,'completed');assert.ok(envelope.life.memories.some(m=>m.id.startsWith('memory:goal-understood:')));
});
test('模型上下文裁剪后不能引用已被移除的解释',async()=>{
 const s=fixture(),snapshot={...((await import('../dist/kernel/index.js')).workspace(s))};
 snapshot.relevantMemories=Array.from({length:20},(_,i)=>({...s.memories[0],id:'m'+i,content:'内容'.repeat(1500),sourceIds:[i===19?'explanation':'question']}));
 const model=createCognitiveModel({async *stream(){yield {type:'text',text:JSON.stringify(output)};}},()=>({provider:'test',model:'test'}));
 await assert.rejects(model.generate(snapshot,new AbortController().signal,{observation:[],recall:[],appraisal:[],motivations:[],rankedGoals:[]}),/理解依据/);
});
test('旧目标来源超过最近事件窗口后仍能显示，失效来源不会泄露',async()=>{
 const s=fixture();s.events.push(...Array.from({length:501},(_,i)=>({eventId:'recent:'+i,type:'tick',payload:{}})));
 const api=createLifeApi({authorize:()=>true,petId:()=>s.petId,getState:async()=>s});
 let body=await (await api(new Request('http://localhost/api/life/snapshot'))).json();
 assert.equal(body.value.sources.question.text,'被遗弃是什么意思？');
 s.invalidSources.question='deleted';body=await (await api(new Request('http://localhost/api/life/snapshot'))).json();assert.equal(body.value.sources.question,undefined);
});
test('目标单独检索，避免长对话挤掉旧问题的解释',async()=>{
 const s=fixture();s.events.push({eventId:'long',type:'conversation.user',payload:{text:'其他话题'.repeat(150)}});
 const calls=[],retrieval=new CanonicalMemoryRetrieval({query:async()=>({rows:[]})});
 retrieval.search=async(_id,query)=>{calls.push(query);return query===s.goals[0].title?[s.memories[0]]:[]};
 const memories=await retrieval.forCognition(s);assert.ok(calls.includes(s.goals[0].title));assert.equal(memories[0].id,'explanation-memory');
});
