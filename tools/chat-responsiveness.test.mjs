import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {CanonicalChat} from '../dist/host/chat-service.js';

test('工作意图提取与回复生成并行，回复和确认提案一起提交',async()=>{
  const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
  let envelope={petId:'main',version:0,legacy:old.read('main'),humanity:{},life:{events:[],invalidSources:{},relationships:[],constraints:{permissions:[]},memories:[],commitments:[],legacyContext:{personaDescription:'test'},body:{},emotions:{}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(envelope),load:async()=>structuredClone(envelope.life)};
  const uow={apply:async(_id,version,change)=>{assert.equal(version,envelope.version);const draft=structuredClone(envelope);change(draft);draft.version++;envelope=draft;}};
  const started=[];let release;const barrier=new Promise(resolve=>{release=resolve});
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(options){const extractor=options.system.startsWith('仅将用户的工作');started.push(extractor?'extract':'reply');await barrier;yield {type:'text',text:extractor?'{"action":"offer","trips":2,"wage":80}':'好呀'};}}};
  const chat=new CanonicalChat(store,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[],async()=>{});
  const turn=chat.turn({requestId:'work-test',petId:'main',channel:'desktop',actorId:'dad',text:'搬砖两趟，工资80'},new AbortController().signal);
  for(let i=0;i<50&&started.length<2;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started.sort(),['extract','reply']);release();
  const reply=await turn;assert.match(reply,/好呀/);assert.match(reply,/搬 2 趟，工钱 80 token/);
  assert.equal(Object.keys(envelope.legacy.chatLaborProposals).length,1);
  assert.equal(envelope.life.events.filter(e=>e.type==='conversation.assistant').length,1);
});
