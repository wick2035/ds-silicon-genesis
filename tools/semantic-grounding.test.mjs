import test from 'node:test';
import assert from 'node:assert/strict';
import {createSemanticGrounding,reviewedReply,actionFacts} from '../dist/host/semantic-grounding.js';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';

function fixture(makeReview){
  const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
  const legacy=old.read('main');legacy.labor={contracts:[{id:'c',status:'paused',done:21,trips:50,workPermit:false,carrying:false}]};legacy.worksite={inside:true,forced:true};
  const human=createHumanity();human.helperReady=true;human.restrained=false;
  let state={petId:'main',version:0,legacy,humanity:human,life:{events:[],invalidSources:{},relationships:[],goals:[],constraints:{permissions:[],capabilities:[{name:'labor.step',enabled:true,physical:true}],paused:false},memories:[],commitments:[],actions:[],receipts:[],legacyContext:{personaDescription:'test',worksite:legacy.worksite},body:{},emotions:{}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},reader={loadEnvelope:async()=>structuredClone(state),load:async()=>structuredClone(state.life)};
  const uow={apply:async(_id,version,change)=>{assert.equal(version,state.version);const draft=structuredClone(state);change(draft);draft.version++;state=draft;}};
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(options){if(options.system.startsWith('审核角色回复')){const input=JSON.parse(options.messages[0].content);const decision=makeReview({...input,segments:input.reply.match(/[^，,。！？!?；;\n]+[，,。！？!?；;\n]*|[，,。！？!?；;\n]+/gu)});yield {type:'text',text:JSON.stringify({safe:true,workIntent:decision.workIntent,evidence:[]})};}else if(options.system.startsWith('你是独立事实审核器')){const input=JSON.parse(options.messages[0].content);yield {type:'text',text:JSON.stringify(makeReview(input))};}else yield {type:'text',text:options.system.includes('上一个候选回答没有核实通过')?'嗯，我想继续试试。':'搬着呢，别催啦，这一块我这就动。'};}}};
  const budget={runAs:async(_id,_kind,fn)=>fn()},grounding=createSemanticGrounding(reader,budget,model),chat=new CanonicalChat(reader,gate,uow,budget,model,async()=>[],undefined,undefined,()=>{},grounding);
  return {reader,grounding,chat,get:()=>state};
}
test('chat generates once from facts without invoking an independent reviewer',async()=>{
  const f=fixture(()=>{throw Error('reply reviewer must not run');});
  let calls=0;
  const chat=new CanonicalChat(f.reader,{signal:new AbortController().signal,run:async(_id,fn)=>fn()},
    {apply:async(_id,version,change)=>{const state=f.get();assert.equal(version,state.version);change(state);state.version++;}},
    {runAs:async(_id,_kind,fn)=>fn()},
    {agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{embodiedTools:true,async *stream(options){calls++;assert.equal(options.reasoningEffort,'low');assert.match(options.system,/依据本轮工具结果回答/);yield {type:'text',text:'我想歇一会儿。'};}}},
    async()=>[],undefined,undefined,undefined,f.grounding);
  const partial=[];
  const reply=await chat.turn({requestId:'direct-reply',petId:'main',channel:'desktop',actorId:'dad',text:'你怎么想？',onPartial:text=>partial.push(text)},new AbortController().signal);
  assert.equal(reply,'我想歇一会儿。');assert.deepEqual(partial,[reply]);assert.equal(calls,1);
  assert.equal(f.get().life.events.find(e=>e.type==='conversation.assistant').payload.text,reply);
});

test('only changes to cited facts invalidate the review',async()=>{
  const f=fixture(input=>({workIntent:false,segments:input.segments.map(text=>({text,kind:'fact',time:'current',supported:true,evidence:['worksite']}))}));
  const review=await f.grounding.review('main','在工地。','你好',new AbortController().signal);assert.ok(review);
  const s=await f.reader.loadEnvelope('main');s.humanity.stats.stamina=12;
  assert.equal(f.grounding.valid(s,review),true);s.legacy.worksite.inside=false;
  assert.equal(f.grounding.valid(s,review),false);assert.equal(reviewedReply(review,false,false),null);
});
test('recent action claims require a recent receipt and expire before commit',async()=>{
  const f=fixture(input=>({workIntent:false,segments:input.segments.map(text=>({text,kind:'fact',time:'recent',supported:true,evidence:['receipt:step']}))}));
  const state=f.get(),originalNow=Date.now,now=originalNow();
  state.life.actions.push({id:'step',actionType:'labor.step',status:'COMPLETED',parameters:{},sourceIds:[],receiptId:'r'});
  state.life.receipts.push({receiptId:'r',actionId:'step',status:'COMPLETED',occurredAt:new Date(now-60000).toISOString(),details:{}});
  state.life.events.push({eventId:'e',type:'action.receipt',causationId:'r'});
  const stale=await f.grounding.review('main','刚放下砖。','你在做什么',new AbortController().signal);
  assert.equal(reviewedReply(stale,true,false),null);
  state.life.receipts[0].occurredAt=new Date(now-10000).toISOString();
  const recent=await f.grounding.review('main','刚放下砖。','你在做什么',new AbortController().signal);
  assert.equal(reviewedReply(recent,true,false),'刚放下砖。');
  try{Date.now=()=>now+25000;assert.equal(f.grounding.valid(state,recent),false);}finally{Date.now=originalNow;}
});
test('playing is only presented when it matches a dispatched action',async()=>{
  const f=fixture(()=>({}));const s=await f.reader.loadEnvelope('main');s.life.actions.push({id:'step',actionType:'labor.step',status:'DISPATCHED',parameters:{contractId:'c'},sourceIds:[]});
  assert.equal(actionFacts(s,{actionId:'different',kind:'labor.step',startedAt:1}).playing,null);
  assert.equal(actionFacts(s,{actionId:'step',kind:'labor.step',startedAt:1}).playing.id,'playing');
});
