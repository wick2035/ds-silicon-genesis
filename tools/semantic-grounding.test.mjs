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
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(options){if(options.system.startsWith('审核角色回复')){const input=JSON.parse(options.messages[0].content);const decision=makeReview({...input,segments:input.reply.match(/[^，,。！？!?；;\n]+[，,。！？!?；;\n]*|[，,。！？!?；;\n]+/gu)});yield {type:'text',text:JSON.stringify({safe:true,workIntent:decision.workIntent,evidence:[]})};}else if(options.system.startsWith('你是独立事实审核器')){const input=JSON.parse(options.messages[0].content);yield {type:'text',text:JSON.stringify(makeReview(input))};}else yield {type:'text',text:'搬着呢，别催啦，这一块我这就动。'};}}};
  const budget={runAs:async(_id,_kind,fn)=>fn()},grounding=createSemanticGrounding(reader,budget,model),chat=new CanonicalChat(reader,gate,uow,budget,model,async()=>[],undefined,undefined,()=>{},grounding);
  return {reader,grounding,chat,get:()=>state};
}
test('semantic audit rejects paraphrased motion without playing evidence and can identify a work decision',async()=>{
  const f=fixture(input=>({workIntent:true,segments:input.segments.map((text,i)=>({text,kind:i===0?'fact':i===2?'intent':'other',supported:i===1,evidence:[]}))}));
  const reply=await f.chat.turn({requestId:'audit-work',petId:'main',channel:'desktop',actorId:'dad',text:'快搬！'},new AbortController().signal);
  assert.doesNotMatch(reply,/搬着呢/);assert.match(reply,/试着搬/);assert.equal(f.get().legacy.labor.contracts[0].workPermit,true);
  assert.equal(f.get().life.events.find(e=>e.type==='conversation.assistant').payload.text,reply);
});
test('missing, altered, or unsupported evidence fails closed',async()=>{
  for(const build of [input=>({workIntent:true,segments:[]}),input=>({workIntent:true,segments:input.segments.map(text=>({text:text+'x',kind:'other',supported:true,evidence:[]}))}),input=>({workIntent:true,segments:input.segments.map(text=>({text,kind:'fact',supported:true,evidence:['invented']}))})]){
    const f=fixture(build);const reply=await f.chat.turn({requestId:'bad-review',petId:'main',channel:'desktop',actorId:'dad',text:'快搬！'},new AbortController().signal);
    assert.match(reply,/没法确认/);assert.equal(f.get().legacy.labor.contracts[0].status,'paused');
  }
});
test('a state change between review and commit invalidates the result',async()=>{
  const f=fixture(input=>({workIntent:false,segments:input.segments.map(text=>({text,kind:'other',supported:true,evidence:[]}))}));
  const review=await f.grounding.review('main','你好。','你好',new AbortController().signal);assert.ok(review);
  const s=await f.reader.loadEnvelope('main');s.legacy.worksite.inside=false;
  assert.notEqual(f.grounding.signature(s),review.signature);assert.match(reviewedReply(review,false,false),/没法确认/);
});
test('playing is only presented when it matches a dispatched action',async()=>{
  const f=fixture(()=>({}));const s=await f.reader.loadEnvelope('main');s.life.actions.push({id:'step',actionType:'labor.step',status:'DISPATCHED',parameters:{contractId:'c'},sourceIds:[]});
  assert.equal(actionFacts(s,{actionId:'different',kind:'labor.step',startedAt:1}).playing,null);
  assert.equal(actionFacts(s,{actionId:'step',kind:'labor.step',startedAt:1}).playing.id,'playing');
});
