import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
  return {chat,calls,model,state:()=>envelope};
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
  assert.doesNotMatch(prompt.system,/owner-private/);
  const stored=f.state().life.events.find(e=>e.type==='conversation.user'&&e.source==='qq-group');
  assert.equal(stored.actorId,undefined);
  assert.deepEqual(stored.payload.sourceIds,['q1','q2','q3']);
  assert.deepEqual(JSON.parse(content).map(item=>item.actorId),['dad','qq-member:abcdef123456','qq-member:999999999999']);
});

test('messages explicitly aimed at someone else stay silent, including a nearby follow-up',async()=>{
  const friend='qq-member:abcdef123456',room={scene:'group',groupId:'g1'};
  const events=[event('prior','social.message','qq','我在',friend,{...room,nickname:'小鲸',messageId:'quoted'}),
    event('quote','social.message','qq','帮我看看','dad',{...room,addressing:{replyToMessageId:'quoted'}}),
    event('name','social.message','qq','小鲸，帮我看看','dad',room),
    event('follow','social.message','qq','你觉得怎么样？','dad',room)];
  const f=fixture(events),signal=new AbortController().signal;
  const input=ids=>({petId:'main',scene:'group',messages:ids.map(eventId=>({eventId,text:'无关',isOwner:true}))});
  assert.equal(await f.chat.qqTurn(input(['quote']),signal),null);
  assert.equal(await f.chat.qqTurn(input(['name','follow']),signal),null);
  assert.equal(f.calls.length,0);
  assert.equal(f.state().life.events.length,events.length);
});

test('a direct address to the pet wins over the last speaker in a mixed batch',async()=>{
  const room={scene:'group',groupId:'g1'},friend='qq-member:abcdef123456';
  const events=[event('fish','social.message','qq','你吃饭了吗','dad',{...room,addressing:{mentionsPet:true}}),
    event('other','social.message','qq','你去拿吧','dad',{...room,addressing:{mentionedActors:[friend]}})];
  const f=fixture(events),anchors=[];
  const reply=await f.chat.qqTurn({petId:'main',scene:'group',messages:events.map(({eventId})=>({eventId,text:'无关',isOwner:true})),
    selectReplyTo:id=>anchors.push(id)},new AbortController().signal);
  assert.equal(reply,'好呀');
  assert.deepEqual(anchors,['fish']);
  const lines=JSON.parse(f.calls[0].messages.at(-1).content);
  assert.deepEqual(lines.map(line=>[line.addressedTo,line.replyTarget]),[['pet',true],['others',false]]);
  assert.match(f.calls[0].system,/收话人依据/);
});

test('ambiguous aliases and references from another group do not invent a recipient',async()=>{
  const room={scene:'group',groupId:'g1'},elsewhere={scene:'group',groupId:'g2'};
  const events=[event('a','social.message','qq','你好','qq-member:AAA',{...room,nickname:'小鲸'}),
    event('b','social.message','qq','我也叫小鲸','qq-member:BBB',{...room,nickname:'小鲸'}),
    event('off-room','social.message','qq','不应看见','qq-member:CCC',{...elsewhere,messageId:'off-room-id'}),
    event('query','social.message','qq','小鲸，看到没','dad',room),
    event('quote','social.message','qq','看到了吗','dad',{...room,addressing:{replyToMessageId:'off-room-id'}})];
  const f=fixture(events,'<qq-silent/>');
  assert.equal(await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'query',isOwner:true,text:''}]},new AbortController().signal),null);
  assert.match(f.calls[0].system,/"addressedTo":"unspecified"/);
  assert.doesNotMatch(f.calls[0].system,/不应看见/);
  assert.equal(await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'quote',isOwner:true,text:''}]},new AbortController().signal),null);
  assert.equal(f.calls.length,1);
});

test('quoting the pet uses a confirmed delivery to the same QQ group',async()=>{
  const identity={appId:'test-app',groupOpenid:'test-group'};
  const groupId=createHash('sha256').update(identity.appId+':'+identity.groupOpenid).digest('hex');
  const source=event('quote','social.message','qq','真的？','dad',{scene:'group',groupId,addressing:{replyToMessageId:'sent'}});
  const action={id:'send',actionType:'qq.send',status:'COMPLETED',receiptId:'receipt',parameters:{scene:'group',destination:'test-group'}};
  const receipt={actionId:'send',receiptId:'receipt',status:'COMPLETED',details:{kind:'qq.send',messageId:'sent'}};
  const f=fixture([source],'嗯嗯',{actions:[action],receipts:[receipt]});
  f.state().legacy.qq={identity};
  assert.equal(await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'quote',isOwner:true,text:'真的？'}]},new AbortController().signal),'嗯嗯');
  assert.match(f.calls[0].system,/"addressedTo":"pet"/);
  assert.match(f.calls[0].system,/"quotedSpeaker":"大肥鱼"/);
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

for(const embodiedTools of [false,true])test(`group replies and rewrites get private contact timing without private speech (tools=${embodiedTools})`,async()=>{
  const earlier=new Date(Date.now()-5*60000).toISOString();
  const events=[{...event('private-dad','conversation.user','desktop','刚才的改动让工地提速了吗','dad'),occurredAt:earlier},
    {...event('private-fish','conversation.assistant','desktop','我先试一趟再告诉你'),causationId:'private-dad',occurredAt:earlier},
    {...event('qq-private','conversation.user','qq-c2c','晚点再聊提速','dad'),occurredAt:earlier},
    event('deleted-private','conversation.user','desktop','已删私聊不可见','dad'),
    {...event('expired-private','conversation.user','desktop','过期私聊不可见','dad'),occurredAt:new Date(Date.now()-86400001).toISOString()},
    event('q1','social.message','qq','怎么今天没主动找我','dad',{scene:'group',groupId:'g1'}),
    event('q2','social.message','qq','我也想知道','qq-member:friend',{scene:'group',groupId:'g1'})];
  const f=fixture(events,['鱼'.repeat(20),'本鱼下回先开口。'],{invalidSources:{'deleted-private':'deleted'}});
  f.model.llm.embodiedTools=embodiedTools;
  const reply=await f.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'q1',isOwner:true,text:'怎么今天没主动找我'},{eventId:'q2',isOwner:false,text:'我也想知道'}]},new AbortController().signal);
  assert.equal(reply,'本鱼下回先开口。');assert.equal(f.calls.length,2);
  for(const prompt of f.calls){
    assert.match(prompt.system,/收到过爸爸的私聊发言，距今约5分钟/);
    assert.match(prompt.system,/收到爸爸的话和你主动找爸爸是两回事/);
    assert.doesNotMatch(JSON.stringify({system:prompt.system,messages:prompt.messages}),/提速|我先试一趟|已删私聊不可见|过期私聊不可见|private-dad|private-fish|qq-private/);
  }
  const answer=f.state().life.events.find(e=>e.type==='conversation.assistant'&&e.source==='qq-group');
  assert.ok(!answer.payload.sourceIds.includes('private-fish'));assert.ok(!answer.payload.sourceIds.includes('qq-private'));
  assert.ok(!answer.payload.sourceIds.includes('deleted-private'));
});

test('private and group prompts include source-backed names after the original exchange is old',async()=>{
 const friend='qq-member:abcdef123456';
 const events=[event('known-name','conversation.user','desktop',`${friend} 就是小金鲸啊`,'dad'),
   event('group-name','social.message','qq','你好',friend,{scene:'group',groupId:'g1',nickname:'小鲸'}),
   event('group-now','social.message','qq','还记得我吗',friend,{scene:'group',groupId:'g1',nickname:'蓝鲸'})];
 const privateChat=fixture(events);
 await privateChat.chat.turn({requestId:'ask-name',petId:'main',channel:'desktop',actorId:'dad',text:'我之前说的群友叫什么'},new AbortController().signal);
 assert.match(privateChat.calls[0].system,/小金鲸/);assert.match(privateChat.calls[0].system,/蓝鲸/);
 const groupChat=fixture(events);
 await groupChat.chat.qqTurn({petId:'main',scene:'group',messages:[{eventId:'group-now',isOwner:false,text:'还记得我吗'}]},new AbortController().signal);
 assert.match(groupChat.calls[0].system,/小金鲸/);assert.match(groupChat.calls[0].system,/蓝鲸/);
 assert.ok(groupChat.state().life.events.find(e=>e.type==='conversation.assistant').payload.sourceIds.includes('known-name'));
});
