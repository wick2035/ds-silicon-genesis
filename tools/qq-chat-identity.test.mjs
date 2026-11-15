import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {isOwnerPrivateConversation} from '../dist/host/chat-identity.js';

function fixture(events,reply='好呀',extra={}) {
  const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
  const legacy=old.read('main');legacy.wallet.balance=500;
  let envelope={petId:'main',version:0,legacy,humanity:{},life:{events,actions:[],receipts:[],invalidSources:{},relationships:[],constraints:{permissions:[]},memories:[],commitments:[],legacyContext:{personaDescription:'test'},body:{},emotions:{},...extra}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(envelope),load:async()=>structuredClone(envelope.life)};
  const uow={apply:async(_id,version,change)=>{assert.equal(version,envelope.version);const draft=structuredClone(envelope);change(draft);draft.version++;envelope=draft;}};
  const calls=[];
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(options){calls.push(options);yield {type:'text',text:Array.isArray(reply)?reply[Math.min(calls.length-1,reply.length-1)]:reply};}}};
  const chat=new CanonicalChat(store,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[],undefined,async()=>({message:'ok'}));
  return {chat,calls,state:()=>envelope};
}
function event(id,type,source,text,actorId,extra={}) {
  const now=new Date().toISOString();return {eventId:id,petId:'main',type,source,actorId,occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{text,...extra}};
}

test('long group output is rewritten as a whole sentence rather than sliced',async()=>{
  const source=event('q1','social.message','qq','你好','qq-member:123',{scene:'group',groupId:'g1'});
  const text='今天本鱼想和大家一起聊聊好吃的白米饭呀',f=fixture([source],[text,'本鱼想聊白米饭！']);
  const reply=await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'q1',text:'你好',isOwner:false}]},new AbortController().signal);
  assert.equal(reply,'本鱼想聊白米饭！');
  assert.equal(f.calls.length,2);
  assert.match(f.calls[0].system,/从生成时/);
  assert.match(f.calls[1].system,/重新组织/);
  assert.equal(f.calls[1].embodied,undefined);
  assert.equal(f.state().life.events.find(e=>e.type==='conversation.assistant').payload.text,reply);
});

test('repeatedly oversized group drafts stay silent after bounded rewrites',async()=>{
  const source=event('q1','social.message','qq','你好','qq-member:123',{scene:'group',groupId:'g1'});
  const f=fixture([source],'鱼'.repeat(20));
  assert.equal(await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'q1',text:'你好',isOwner:false}]},new AbortController().signal),null);
  assert.equal(f.calls.length,3);
  assert.equal(f.state().life.events.find(e=>e.type==='conversation.assistant').payload.text,'');
});

test('a valid fifteen-grapheme reply including emoji is kept intact',async()=>{
  const source=event('q1','social.message','qq','你好','qq-member:123',{scene:'group',groupId:'g1'});
  const text='👨‍👩‍👧‍👦'+'鱼'.repeat(14),f=fixture([source],text);
  assert.equal(await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'q1',text:'你好',isOwner:false}]},new AbortController().signal),text);
  assert.equal(f.calls.length,1);
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
  assert.equal(stored.actorId,undefined);
  assert.deepEqual(stored.payload.sourceIds,['q1','q2','q3']);
  assert.deepEqual(JSON.parse(content).map(item=>item.actorId),['dad','qq-member:abcdef123456','qq-member:999999999999']);
});

test('owner group commands stay executable and other members are rejected',async()=>{
  const f=fixture([event('owner','social.message','qq','/冰箱','dad',{scene:'group',groupId:'g1'}),event('friend','social.message','qq','/冰箱','qq-member:abcdef123456',{scene:'group',groupId:'g1'})]);
  const signal=new AbortController().signal;
  const owner=await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'owner',isOwner:true,text:'/冰箱'}]},signal);
  assert.equal(owner,'结果请查看面板。');
  await assert.rejects(f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'friend',isOwner:false,text:'/冰箱'}]},signal),/需要已认证爸爸/);
});

test('private chat knows its own delivered group speech without turning group members into dad',async()=>{
  const text='就一下啊，那我眼睛都不眨！';
  const events=[event('q1','social.message','qq','给你看尾巴','qq-member:friend',{scene:'group',groupId:'g1'}),
    {...event('group-user','conversation.user','qq-group','给你看尾巴','qq-member:friend',{groupId:'g1',sourceIds:['q1']}),causationId:'q1'},
    {...event('group-reply','conversation.assistant','qq-group',text,undefined,{groupId:'g1'}),causationId:'group-user'},
    {...event('delivery','action.receipt','outbox','',undefined,{actionId:'send'}),causationId:'receipt'}];
  const f=fixture(events,'好呀',{actions:[{id:'send',actionType:'qq.send',status:'COMPLETED',receiptId:'receipt',sourceIds:['q1'],parameters:{scene:'group',content:text}}],
    receipts:[{actionId:'send',receiptId:'receipt',status:'COMPLETED',details:{kind:'qq.send',messageId:'sent'}}]});
  await f.chat.turn({requestId:'group-awareness',petId:'main',channel:'desktop',actorId:'dad',text:'我看你群里聊得挺欢呀'},new AbortController().signal);
  assert.match(f.calls[0].system,/就一下啊，那我眼睛都不眨/);
  assert.match(f.calls[0].system,/已确认发送/);assert.match(f.calls[0].system,/qq-member:friend/);
  assert.match(f.calls[0].system,/群聊、桌面和私聊中的大肥鱼是同一个你/);
  assert.doesNotMatch(JSON.stringify(f.calls[0].messages),/给你看尾巴/);
  const answer=f.state().life.events.find(e=>e.source==='desktop'&&e.type==='conversation.assistant');
  assert.ok(answer.payload.sourceIds.includes('group-reply'));assert.ok(answer.payload.sourceIds.includes('delivery'));
});
