import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {isOwnerPrivateConversation} from '../dist/host/chat-identity.js';

function fixture(events,reply='好呀') {
  const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
  const legacy=old.read('main');legacy.wallet.balance=500;
  let envelope={petId:'main',version:0,legacy,humanity:{},life:{events,actions:[],receipts:[],invalidSources:{},relationships:[],constraints:{permissions:[]},memories:[],commitments:[],legacyContext:{personaDescription:'test'},body:{},emotions:{}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(envelope),load:async()=>structuredClone(envelope.life)};
  const uow={apply:async(_id,version,change)=>{assert.equal(version,envelope.version);const draft=structuredClone(envelope);change(draft);draft.version++;envelope=draft;}};
  const calls=[];
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(options){calls.push(options);yield {type:'text',text:reply};}}};
  const chat=new CanonicalChat(store,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[],undefined,async()=>({message:'ok'}));
  return {chat,calls,state:()=>envelope};
}
function event(id,type,source,text,actorId,extra={}) {
  const now=new Date().toISOString();return {eventId:id,petId:'main',type,source,actorId,occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{text,...extra}};
}

test('long group output is saved and returned within fifteen graphemes',async()=>{
  const source=event('q1','social.message','qq','你好','qq-member:123',{scene:'group',groupId:'g1'});
  const text='👨‍👩‍👧‍👦'+'鱼'.repeat(20),f=fixture([source],text);
  const reply=await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'q1',text:'你好',isOwner:false}]},new AbortController().signal);
  assert.equal(reply,'👨‍👩‍👧‍👦'+'鱼'.repeat(14));
  assert.equal(f.state().life.events.find(e=>e.type==='conversation.assistant').payload.text,reply);
});

test('group silence remains silent and private replies retain their length',async()=>{
  const source=event('q1','social.message','qq','你好','qq-member:123',{scene:'group',groupId:'g1'});
  const f=fixture([source],'<qq-silent/>');
  assert.equal(await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'q1',text:'你好',isOwner:false}]},new AbortController().signal),null);
  const text='鱼'.repeat(30),privateChat=fixture([],text);
  assert.equal(await privateChat.chat.turn({requestId:'private-long',petId:'main',channel:'desktop',actorId:'dad',text:'你好'},new AbortController().signal),text);
});

test('owner private history includes desktop and QQ but excludes group',async()=>{
  const events=[event('desktop-old','conversation.user','desktop','desktop-only','dad'),event('qq-old','conversation.user','qq-c2c','qq-private','dad'),event('group-old','conversation.user','qq-group','group-secret','qq-member:123',{groupId:'g1'})];
  const f=fixture(events);
  await f.chat.turn({requestId:'private-test',petId:'main',channel:'desktop',actorId:'dad',text:'你好'},new AbortController().signal);
  const prompt=f.calls[0],messages=JSON.stringify(prompt.messages);
  assert.match(messages,/desktop-only/);assert.match(messages,/qq-private/);assert.doesNotMatch(messages,/group-secret/);
  assert.match(prompt.system,/同一个爸爸/);
  assert.equal(isOwnerPrivateConversation(events[1]),true);assert.equal(isOwnerPrivateConversation(events[2]),false);
});

test('group turns identify each speaker from trusted source events',async()=>{
  const events=[event('q1','social.message','qq','owner text','dad',{scene:'group',groupId:'g1'}),event('q2','social.message','qq','friend text','qq-member:abcdef123456',{scene:'group',groupId:'g1'}),event('q3','social.message','qq','other text','qq-member:999999999999',{scene:'group',groupId:'g1'}),event('private-old','conversation.user','qq-c2c','owner-private','dad')];
  const f=fixture(events);
  await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'q1',isOwner:false,text:'owner text'},{eventId:'q2',isOwner:true,text:'friend text'},{eventId:'q3',isOwner:true,text:'other text'}]},new AbortController().signal);
  const prompt=f.calls[0],content=prompt.messages.at(-1).content;
  assert.match(content,/爸爸/);assert.match(content,/群友-abcdef123456/);assert.match(content,/群友-999999999999/);
  assert.doesNotMatch(JSON.stringify(prompt.messages),/owner-private/);
  const stored=f.state().life.events.find(e=>e.type==='conversation.user'&&e.source==='qq-group');
  assert.equal(stored.actorId,'qq-member:999999999999');
});

test('owner group commands stay executable and other members are rejected',async()=>{
  const f=fixture([event('owner','social.message','qq','/冰箱','dad',{scene:'group',groupId:'g1'}),event('friend','social.message','qq','/冰箱','qq-member:abcdef123456',{scene:'group',groupId:'g1'})]);
  const signal=new AbortController().signal;
  const owner=await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'owner',isOwner:true,text:'/冰箱'}]},signal);
  assert.equal(owner,'结果请查看面板。');
  await assert.rejects(f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'friend',isOwner:false,text:'/冰箱'}]},signal),/需要已认证爸爸/);
});
