import test from 'node:test';
import assert from 'node:assert/strict';
import {developmentSources} from '../dist/host/development-sources.js';
import {developmentMaterial} from '../dist/host/development-material.js';
import {createDevelopment} from '../dist/host/development.js';

const date='2026-11-20';
const event=(id,type='care',payload={})=>({eventId:id,petId:'main',type,source:'test',occurredAt:date+'T01:00:00Z',evidenceLevel:'observed',payload});
function fixture(generate,events=[event('long-event:'+ 'a'.repeat(64))]){
  let state={petId:'main',version:0,legacy:{config:{diaryEnabled:true,costs:{diary:10}},wallet:{balance:100,frozen:false},diaries:{},deletedDays:[]},life:{events,memories:[],invalidSources:{},constraints:{paused:false}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},store={loadEnvelope:async()=>structuredClone(state)},uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const draft=structuredClone(state);fn(draft);draft.version++;state=draft;}};
  let calls=0;
  const model={agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:{stream:async function*(input){yield {type:'text',text:await generate(input,++calls,()=>state)};}}};
  const dev=createDevelopment(store,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model);
  return {dev,signal:gate.signal,get:()=>state,calls:()=>calls,run:()=>dev.task('main','diary',gate.signal,true,date)};
}

test('short citations restore exact IDs, include visible speakers and avoid collisions with real IDs',()=>{
  const events=[{id:'E1',type:'self.thought',text:'感受',speakers:[{id:'raw-speaker:'+ 'a'.repeat(64),actorId:'qq-member:123',speaker:'群友-123',text:'原话'}]},{id:'other',text:'经历'}],before=structuredClone(events);
  const citations=developmentSources(events),thought=citations.events[0],speaker=thought.speakers[0];
  assert.notEqual(thought.id,'E1');assert.match(speaker.id,/^E\d+$/);assert.equal(speaker.actorId,'qq-member:123');
  assert.deepEqual(citations.parse(JSON.stringify({text:'本鱼记得那句话。',sources:[thought.id,speaker.id,'E1']})).sources,['E1',events[0].speakers[0].id]);
  assert.deepEqual(events,before);
  for(const sources of [[],['invented'],['other','invented'],[null]])assert.throws(()=>citations.parse(JSON.stringify({text:'正文',sources})),/来源编号/);
});

test('diary accepts a shown attributed speaker outside the sampled top-level events',async()=>{
  const messages=Array.from({length:24},(_,i)=>({...event('message-'+i,'social.message',{text:'群友原话 '+i}),actorId:'qq-member:'+i}));
  const events=[...messages,event('batch','conversation.assistant',{text:'看到了群聊',groupBatch:true,sourceIds:['message-1']})];
  const f=fixture(async input=>{
    const shown=JSON.parse(input.messages[0].content).events;
    const batch=shown.find(e=>e.type==='conversation.assistant');assert.equal(batch.speakers[0].actorId,'qq-member:1');
    return JSON.stringify({text:'群友说过那句话，我当时看到了。',sources:[batch.speakers[0].id]});
  },events);
  assert.ok(!developmentMaterial(f.get(),date).some(e=>e.id==='message-1'));
  assert.equal(await f.run(),true);assert.deepEqual(f.get().legacy.diaries[date].sources,['message-1']);assert.equal(f.get().legacy.wallet.balance,90);
});

test('one invalid result gets one correction under the same claim and settles only once',async()=>{
  const f=fixture(async(input,call,state)=>{
    assert.equal(state().legacy.developmentClaims['diary:'+date].attempt,1);assert.equal(state().legacy.wallet.balance,100);assert.equal(state().legacy.diaries[date],undefined);
    if(call===1)return JSON.stringify({text:'本鱼记得今天。',sources:['made-up-hash']});
    assert.equal(input.messages.length,3);assert.equal(input.messages[1].role,'assistant');assert.match(input.messages[2].content,/纠正/);
    const id=JSON.parse(input.messages[0].content).events[0].id;return JSON.stringify({text:'本鱼记得今天。',sources:[id,id]});
  });
  assert.equal(await f.run(),true);assert.equal(f.calls(),2);assert.equal(f.get().legacy.wallet.balance,90);
  assert.deepEqual(f.get().legacy.diaries[date].sources,['long-event:'+ 'a'.repeat(64)]);
  assert.equal(f.get().life.events.filter(e=>e.eventId==='finance:diary:'+date).length,1);
  assert.equal(await f.run(),false);assert.equal(f.calls(),2);
});

test('malformed JSON can be corrected without saving a partial diary',async()=>{
  const f=fixture(async(input,call)=>call===1?'not JSON':JSON.stringify({text:'本鱼记下今天。',sources:[JSON.parse(input.messages[0].content).events[0].id]}));
  assert.equal(await f.run(),true);assert.equal(f.calls(),2);assert.equal(f.get().life.memories.length,1);
});

test('unknown sources fail after two calls, preserve the failure reason and never charge diary money',async()=>{
  const f=fixture(async()=>JSON.stringify({text:'不能采用的日记',sources:['invented']}));
  await assert.rejects(f.run(),/本次材料以外/);assert.equal(f.calls(),2);assert.equal(f.get().legacy.wallet.balance,100);
  assert.equal(f.get().legacy.diaries[date],undefined);assert.equal(f.get().life.memories.length,0);
  assert.match(f.get().legacy.developmentClaims['diary:'+date].reason,/来源编号/);
  assert.equal(await f.dev.task('main','diary',f.signal,false,date),false);assert.equal(f.calls(),2);
});

test('an invalidated canonical source is rejected again at commit after alias resolution',async()=>{
  const f=fixture(async(input,_call,state)=>{
    state().life.invalidSources['long-event:'+ 'a'.repeat(64)]='用户撤回';
    return JSON.stringify({text:'旧来源已撤回。',sources:[JSON.parse(input.messages[0].content).events[0].id]});
  });
  await assert.rejects(f.run(),/来源或状态已变化/);assert.equal(f.calls(),1);assert.equal(f.get().legacy.wallet.balance,100);assert.equal(f.get().legacy.diaries[date],undefined);
});
