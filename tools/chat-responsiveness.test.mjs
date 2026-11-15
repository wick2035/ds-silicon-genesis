import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {CanonicalChat} from '../dist/host/chat-service.js';

test('工作意图提取与回复生成并行，回复和确认提案一起提交',async()=>{
  const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
  let envelope={petId:'main',version:0,legacy:old.read('main'),humanity:{},life:{actions:[],events:[],invalidSources:{},relationships:[],constraints:{permissions:[]},memories:[],commitments:[],legacyContext:{personaDescription:'test'},body:{},emotions:{}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(envelope),load:async()=>structuredClone(envelope.life)};
  const uow={apply:async(_id,version,change)=>{assert.equal(version,envelope.version);const draft=structuredClone(envelope);change(draft);draft.version++;envelope=draft;}};
  const started=[];let release;const barrier=new Promise(resolve=>{release=resolve});
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(options){const extractor=options.system.startsWith('仅将用户的工作');started.push(extractor?'extract':'reply');await barrier;yield {type:'text',text:extractor?'{"action":"offer","trips":2,"wage":80}':options.system.includes('尚未执行的工作条件')?'好呀，两趟八十，对吗？':'好呀'};}}};
  const chat=new CanonicalChat(store,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[],async()=>{});
  const turn=chat.turn({requestId:'work-test',petId:'main',channel:'desktop',actorId:'dad',text:'搬砖两趟，工资80'},new AbortController().signal);
  for(let i=0;i<50&&started.length<2;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started.sort(),['extract','reply']);release();
  const reply=await turn;assert.equal(reply,'好呀，两趟八十，对吗？');
  assert.equal(Object.keys(envelope.legacy.chatLaborProposals).length,1);
  assert.equal(envelope.life.events.filter(e=>e.type==='conversation.assistant').length,1);
});


test('dad private message wakes a sleeping companion before generating a reply at zero spirit',async()=>{
 const {createHumanity}=await import('../vendor/dsh-pet/src/host/humanity.mjs');const {ensureSpirit,setSpiritRest}=await import('../dist/kernel/spirit.js');const {hasActiveConversation}=await import('../dist/host/active-conversation.js');
 const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
 let state={petId:'main',version:0,legacy:old.read('main'),humanity:createHumanity(),life:{events:[],invalidSources:{},relationships:[],constraints:{permissions:[],capabilities:[]},memories:[],commitments:[],goals:[],actions:[],receipts:[],legacyContext:{personaDescription:'test'},body:{},emotions:{}}};
 state.humanity.sleeping=true;ensureSpirit(state.life).value=0;setSpiritRest(state.life,'sleep');
 const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},reader={loadEnvelope:async()=>structuredClone(state),load:async()=>structuredClone(state.life)};
 const uow={apply:async(_id,v,fn)=>{assert.equal(v,state.version);fn(state);state.version++;}};
 const calls=[];const service=async(_id,input)=>{calls.push(input.command);assert.equal(hasActiveConversation(state),true);state.humanity.sleeping=false;setSpiritRest(state.life,'awake');return {status:'done'};};
 const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(){assert.equal(state.humanity.sleeping,false);assert.equal(state.life.spirit.mode,'awake');yield {type:'text',text:'嗯，爸爸，我醒啦。'};}}};
 const chat=new CanonicalChat(reader,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[],undefined,service);
 assert.equal(await chat.turn({requestId:'wake-test',petId:'main',channel:'desktop',actorId:'dad',text:'吃到了吗'},gate.signal),'嗯，爸爸，我醒啦。');
 assert.deepEqual(calls,['/醒来']);assert.equal(hasActiveConversation(state),false);assert.ok(state.life.spirit.value<1);
});
