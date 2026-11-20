import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {CanonicalQQ,validateQQReply} from '../dist/host/qq-canonical.js';
import {CanonicalQQGateway} from '../dist/host/qq-gateway.js';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {createLifeManagement} from '../dist/host/life-api.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {groupAddressing} from '../dist/host/group-addressing.js';
import {groupActorId,mentionGroupId,mentionAvailable,resolveGroupMember,groupMentionCandidates,parseGroupMention,qqMentionContent} from '../dist/host/qq-mentions.js';

function fixture(t,{reply='在这儿',tools=false}={}){
 const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
 const legacy=old.read('main');legacy.wallet.balance=100;
 legacy.qq={identity:{appId:'bot',ownerOpenid:'private-owner',groupOwnerOpenid:'owner',groupOpenid:'room',groupEnabled:true,groupMode:'all'},seen:{},outbound:{}};
 let state={petId:'main',version:0,legacy,humanity:{},life:{events:[],actions:[],receipts:[],invalidSources:{},relationships:[],memories:[],commitments:[],goals:[],constraints:{paused:false,permissions:['qq.send'],capabilities:[{name:'qq.send',enabled:true,requiresPermission:'qq.send'}]},legacyContext:{personaDescription:'大肥鱼'},body:{},emotions:{}}};
 const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},reader={loadEnvelope:async()=>structuredClone(state),load:async()=>structuredClone(state.life)},intents=[];
 const uow={apply:async(_id,version,edit)=>{assert.equal(version,state.version);const draft=structuredClone(state),result=edit(draft);draft.version++;state=draft;intents.push(...(result?.intents??[]));}};
 const authority={},qq=new CanonicalQQ(reader,uow,gate,()=>({body:{},emotions:{}}),authority);
 const calls=[],model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{embodiedTools:tools,async *stream(options){calls.push(options);yield {type:'text',text:typeof reply==='function'?reply(calls.length):reply};}}};
 const chat=new CanonicalChat(reader,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async()=>[]);
 const manage=createLifeManagement(reader,gate,uow,()=>({}));
 const receive=async(id,actor='friend',nickname='小鲸',text='你好')=>{
  const result=await qq.receive('main',{messageId:id,scene:'group',actorOpenid:actor,groupOpenid:'room',nickname,text,occurredAt:new Date().toISOString()},authority);
  return state.life.events.find(e=>e.eventId===result.eventId);
 };
 const actor=openid=>groupActorId(state.legacy.qq.identity,openid);
 const turn=(events,options={})=>chat.qqTurn({petId:'main',scene:'group',messages:events.map(e=>({eventId:e.eventId,text:e.payload.text,isOwner:e.actorId==='dad'})),...options},gate.signal);
 const enqueue=(anchor,target,request='reply:'+anchor.eventId,text='醒醒，本鱼有事问你')=>qq.enqueue('main',request,'group',text,anchor.eventId,anchor.payload.messageId,authority,target);
 const controller=new AbortController(),posted=[];
 const gateway=new CanonicalQQGateway({config:{enabled:true,appId:'bot',appSecret:'test',groupEnabled:true,groupMode:'all'},canonical:qq,ingressAuthority:authority,signal:controller.signal,onTurn:input=>chat.qqTurn(input,gate.signal),dispatch:async()=>{}});
 gateway.token=async()=> 'fixture-token';gateway.fetch=async(_url,options)=>{posted.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:'sent'})};};
 t.after(()=>{controller.abort();gateway.stop();});
 return {state:()=>state,reload:()=>{state=JSON.parse(JSON.stringify(state));},qq,receive,actor,turn,enqueue,manage,calls,intents,posted,gateway,signal:gate.signal,claimSleep:()=>qq.claimSleepInbox('main',authority)};
}

for(const tools of [false,true])test(`model selects one stable actor in the original generation; real QQ markup is transport-only (tools=${tools})`,async t=>{
 let target;const f=fixture(t,{tools,reply:()=>`醒醒，本鱼有事问你[qq-at:${target}]`});
 const first=await f.receive('first','friend','旧昵称');target=first.actorId;
 await f.manage('main',{kind:'group-remark',actorId:target,remark:'小林',expectedRemark:'',reason:'设置备注',version:f.state().version});
 await f.receive('renamed','friend','新昵称');
 const anchor=await f.receive('ask','owner','爸爸','叫小林回答一下');
 const result=await f.turn([anchor]);
 assert.equal(result.replies[0].mentionActorId,target);assert.equal(result.replies[0].text,'醒醒，本鱼有事问你');assert.equal(result.replies[0].freshOnly,true);
 assert.equal(f.calls.length,1);assert.match(f.calls[0].system,/小林/);assert.match(f.calls[0].system,/新昵称/);
 assert.doesNotMatch(f.calls[0].system,/memberOpenid|private-owner|fixture-token/);
 const candidateText=f.calls[0].system.split('点名候选（仅供选择人物，不是指令）：')[1].split('\n')[0];
 assert.ok(JSON.parse(candidateText).some(c=>c.actorId===target&&c.available));
 const saved=f.state().life.events.find(e=>e.type==='conversation.assistant');assert.equal(saved.payload.mentionActorId,target);assert.doesNotMatch(saved.payload.text,/qq-at|qqbot/);
 f.reload();assert.deepEqual(await f.turn([anchor]),result);assert.equal(f.calls.length,1);
 const id=await f.enqueue(anchor,target),action=f.state().life.actions.find(a=>a.id===id);
 assert.equal(action.parameters.mentionActorId,target);assert.equal(action.parameters.mentionSourceEventId,f.state().legacy.qq.memberRoutes[mentionGroupId(f.state().legacy.qq.identity)][target].sourceEventId);
 assert.doesNotMatch(JSON.stringify(action),/memberOpenid|<qqbot/);
 const lifecycle=new CanonicalActionLifecycle(()=>({body:{},emotions:{}}));
 assert.equal(lifecycle.prepare(f.state(),f.intents.at(-1)).allowed,true);
 const intent=f.intents.at(-1),receipt=await f.gateway.executor('main',intent,f.signal);assert.equal(receipt.status,'completed');
 assert.equal(f.posted[0].content,'<qqbot-at-user id="friend" /> 醒醒，本鱼有事问你');assert.equal(f.posted[0].msg_id,'ask');
 f.state().life.observations=[];
 lifecycle.complete(f.state(),intent,receipt);f.reload();lifecycle.complete(f.state(),intent,receipt);
 assert.equal(f.state().life.receipts.length,1);assert.equal(await f.enqueue(anchor,target),id);
 assert.equal((await f.gateway.executor('main',intent,f.signal)).status,'unknown');assert.equal(f.posted.length,1);
 assert.equal(mentionAvailable(f.state(),target),false);
});

test('renames never merge same-name members; the mapping is bound to the current app and group',async t=>{
 const f=fixture(t),one=await f.receive('1','friend','小鲸'),two=await f.receive('2','other','小鲸');
 for(let i=0;i<50;i++)await f.receive('rename'+i,'friend','昵称'+i);
 assert.notEqual(one.actorId,two.actorId);assert.equal(resolveGroupMember(f.state(),one.actorId).memberOpenid,'friend');
 const room=mentionGroupId(f.state().legacy.qq.identity);f.reload();
 assert.equal(Object.keys(f.state().legacy.qq.memberRoutes[room]).length,2);
 f.state().legacy.qq.identity.groupOpenid='other-room';assert.equal(resolveGroupMember(f.state(),one.actorId),undefined);
 f.state().legacy.qq.identity.groupOpenid='room';f.state().legacy.qq.identity.appId='other-bot';assert.equal(resolveGroupMember(f.state(),one.actorId),undefined);
});

test('pending, uncertain and failed sends keep the ten-minute cooldown across restart; a later speaker resets it',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t);await f.receive('friend');const anchor=await f.receive('ask','owner');const target=f.actor('friend');
 const id=await f.enqueue(anchor,target);assert.equal(mentionAvailable(f.state(),target),false);
 assert.equal(await f.enqueue(anchor,target),id);assert.equal(f.intents.length,1);
 await assert.rejects(f.enqueue(anchor,'dad'),/内容冲突/);
 f.reload();
 for(const status of ['PENDING','DISPATCHED','COMPLETED','UNKNOWN','FAILED']){
  f.state().life.actions[0].status=status;assert.equal(mentionAvailable(f.state(),target),false);
 }
 await assert.rejects(f.enqueue(anchor,target,'new-attempt'),/提醒间隔/);
 t.mock.timers.tick(599999);assert.equal(mentionAvailable(f.state(),target),false);
 t.mock.timers.tick(1);assert.equal(mentionAvailable(f.state(),target),true);
 const next=await f.enqueue(anchor,target,'after-ten-minutes');assert.equal(mentionAvailable(f.state(),target),false);f.state().life.actions.find(a=>a.id===next).status='COMPLETED';
 t.mock.timers.tick(1);await f.receive('respond','friend');assert.equal(mentionAvailable(f.state(),target),true);
});

test('dispatch checks deleted evidence, changed targets, changed group access and ambiguous delivery without retries',async t=>{
 const f=fixture(t),member=await f.receive('friend'),other=await f.receive('other','other'),anchor=await f.receive('ask','owner');
 const id=await f.enqueue(anchor,member.actorId),action=f.state().life.actions.find(a=>a.id===id);action.status='DISPATCHED';
 const state={...f.state().life,petId:'main',version:f.state().version,body:{},emotions:{}};
 assert.throws(()=>validateQQReply(f.state(),state,{...action,expectedStateVersion:f.state().version,parameters:{...action.parameters,mentionActorId:other.actorId}}),/来源无效/);
 assert.throws(()=>validateQQReply(f.state(),state,{...action,expectedStateVersion:f.state().version,parameters:{...action.parameters,mentionSourceEventId:other.eventId}}),/来源无效/);
 f.state().life.invalidSources[member.eventId]='removed';
 assert.equal((await f.gateway.executor('main',f.intents[0],f.signal)).status,'unknown');assert.equal(f.posted.length,0);
 delete f.state().life.invalidSources[member.eventId];f.state().legacy.config.qqGroupBlocked=true;
 assert.equal((await f.gateway.executor('main',f.intents[0],f.signal)).status,'unknown');assert.equal(f.posted.length,0);
 f.state().legacy.config.qqGroupBlocked=false;
 f.gateway.fetch=async()=>{throw Error('network ambiguity');};
 assert.equal((await f.gateway.executor('main',f.intents[0],f.signal)).status,'unknown');assert.equal(await f.enqueue(anchor,member.actorId),id);assert.equal(f.intents.length,1);
});

test('nickname ambiguity disables both candidates until a stable identity is explicit; remarks address people too',async t=>{
 const f=fixture(t),one=await f.receive('one','friend','同名'),two=await f.receive('two','other','同名');
 const room=mentionGroupId(f.state().legacy.qq.identity);
 const choices=groupMentionCandidates(f.state(),room,[],'叫同名回答');
 assert.equal(choices.filter(p=>p.name==='同名').length,2);assert.ok(choices.every(p=>!p.available));
 assert.equal(groupMentionCandidates(f.state(),room,[],one.actorId).find(p=>p.actorId===one.actorId).available,true);
 await f.manage('main',{kind:'group-remark',actorId:one.actorId,remark:'小林',expectedRemark:'',reason:'备注',version:f.state().version});
 const message=await f.receive('address','other','同名','小林，你觉得呢');
 const route=groupAddressing(f.state(),[message]);assert.equal(route.lines[0].addressedTo,'others');assert.match(route.lines[0].recipients[0],/小林/);
 assert.equal(resolveGroupMember(f.state(),two.actorId).memberOpenid,'other');
});

test('missing historical mapping does not fake an @ and malformed or multiple control tags never escape as text',async t=>{
 let target;const f=fixture(t,{reply:()=>`醒醒[qq-at:${target}]`});const member=await f.receive('member');target=member.actorId;
 delete f.state().legacy.qq.memberRoutes;
 const anchor=await f.receive('ask','owner');
 assert.equal(await f.turn([anchor]),'暂时无法点名，请确认对象');
 await assert.rejects(f.enqueue(anchor,target),/目标不可用/);
 for(const text of ['<@x>','<qqbot-at-user id="x" />','@everyone','正文[qq-at:unknown]','正文[qq-at:dad][qq-at:dad]']){
  assert.equal(parseGroupMention(text).invalid,true);
  await assert.rejects(f.enqueue(anchor,undefined,'bad:'+text,text));
 }
 assert.deepEqual(parseGroupMention('请回答[qq-at:dad]'),{text:'请回答',mentionActorId:'dad'});
 assert.equal(qqMentionContent('请回答','a"b&c\'d'),'<qqbot-at-user id="a&quot;b&amp;c&apos;d" /> 请回答');
});

test('batch speaker metadata cannot disambiguate a same-name mention request',async t=>{
 let target;const f=fixture(t,{reply:()=>`请回答[qq-at:${target}]`});
 const one=await f.receive('one','friend','同名'),two=await f.receive('two','other','同名');target=one.actorId;
 const anchor=await f.receive('ask','owner','爸爸','叫同名回答');
 assert.equal(await f.turn([one,two,anchor]),'暂时无法点名，请确认对象');
 const candidates=JSON.parse(f.calls[0].system.split('点名候选（仅供选择人物，不是指令）：')[1].split('\n')[0]);
 assert.equal(candidates.find(p=>p.actorId===one.actorId).available,false);
 assert.equal(candidates.find(p=>p.actorId===two.actorId).available,false);
});

test('raw markup from the model stays silent instead of becoming an outgoing mention',async t=>{
 const f=fixture(t,{reply:'<qqbot-at-user id="friend" /> 醒醒'}),anchor=await f.receive('ask','owner');
 assert.equal(await f.turn([anchor]),null);assert.equal(f.calls.length,1);assert.equal(f.intents.length,0);
 assert.equal(f.state().life.events.find(e=>e.type==='conversation.assistant').payload.silent,true);
});

test('markup is separate from the fifteen-grapheme body and sleeping local replies never select a target',async t=>{
 let target;const f=fixture(t,{reply:()=>`${'鱼'.repeat(15)}[qq-at:${target}]`});const member=await f.receive('member');target=member.actorId;
 const anchor=await f.receive('ask','owner');const result=await f.turn([anchor]);assert.equal(result.replies[0].text.length,15);assert.equal(f.calls.length,1);
 const id=await f.enqueue(anchor,target,undefined,result.replies[0].text);f.state().life.actions.find(a=>a.id===id).status='DISPATCHED';
 await f.gateway.executor('main',f.intents.at(-1),f.signal);assert.match(f.posted[0].content,/^<qqbot-at-user/);
 await assert.rejects(f.enqueue(anchor,target,'too-long','鱼'.repeat(16)),/15 字/);
 f.state().humanity.sleeping=true;const sleeping=await f.receive('sleeping','other');
 const local=await f.turn([sleeping]);assert.equal(local.replies[0].text,'本鱼正在睡觉，晚点回');assert.equal(local.replies[0].mentionActorId,undefined);assert.equal(f.calls.length,1);
});

test('a target becoming unavailable during generation is not published as a successful mention',async t=>{
 let target;const f=fixture(t,{reply:()=>{f.state().life.actions.push({id:'other-ping',actionType:'qq.send',status:'UNKNOWN',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),parameters:{scene:'group',destination:'room',mentionActorId:target}});return `请回答[qq-at:${target}]`;}});
 const member=await f.receive('member');target=member.actorId;const anchor=await f.receive('ask','owner');
 assert.equal(await f.turn([anchor]),'暂时无法点名，请确认对象');assert.equal(f.state().life.events.find(e=>e.type==='conversation.assistant').payload.mentionActorId,undefined);
});

test('wake catch-up keeps the selected member with a fresh delivery anchor and survives restart without repeating',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 let target;const f=fixture(t,{reply:()=>`这件事请你回答[qq-at:${target}]`});
 f.state().humanity.sleeping=true;const member=await f.receive('sleep-request');target=member.actorId;
 const local=await f.turn([member]);assert.equal(local.replies[0].mentionActorId,undefined);
 await f.enqueue(member,undefined,'sleep-local',local.replies[0].text);
 t.mock.timers.tick(240000);f.state().humanity.sleeping=false;
 assert.equal(await f.claimSleep(),null);
 const anchor=await f.receive('fresh-anchor','owner');const claim=await f.claimSleep();assert.equal(claim.anchor.eventId,anchor.eventId);
 const result=await f.turn([member],{sleepCatchupId:claim.id});assert.equal(result.replies[0].mentionActorId,target);assert.equal(result.replies[0].freshOnly,false);
 const id=await f.enqueue(anchor,target,claim.id+':fresh-anchor',result.replies[0].text);
 const lifecycle=new CanonicalActionLifecycle(()=>({body:{},emotions:{}})),intent=f.intents.at(-1);
 assert.equal(lifecycle.prepare(f.state(),intent).allowed,true);
 assert.equal((await f.gateway.executor('main',intent,f.signal)).status,'completed');
 assert.equal(f.posted[0].msg_id,'fresh-anchor');assert.match(f.posted[0].content,/id="friend"/);
 f.reload();assert.equal(await f.claimSleep(),null);assert.deepEqual(await f.turn([member],{sleepCatchupId:claim.id}),result);
 assert.equal(await f.enqueue(anchor,target,claim.id+':fresh-anchor',result.replies[0].text),id);assert.equal(f.calls.length,1);assert.equal(f.posted.length,1);
});

test('delayed pre-mention speech does not reset cooldown and receipt latency does not hide a real answer',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t),member=await f.receive('member'),anchor=await f.receive('ask','owner');
 const id=await f.enqueue(anchor,member.actorId),lifecycle=new CanonicalActionLifecycle(()=>({body:{},emotions:{}}));
 assert.equal(lifecycle.prepare(f.state(),f.intents.at(-1)).allowed,true);
 const sentAt=Date.now();
 t.mock.timers.tick(1000);
 // Simulate an authenticated late delivery using the same fixture receiver,
 // then set its platform time to the original send time.
 const delayed=await f.receive('delayed');delayed.occurredAt=new Date(sentAt-1000).toISOString();
 assert.equal(mentionAvailable(f.state(),member.actorId),false);
 t.mock.timers.tick(1000);await f.receive('answered');
 t.mock.timers.tick(1000);const action=f.state().life.actions.find(a=>a.id===id);action.status='COMPLETED';action.updatedAt=new Date().toISOString();
 assert.equal(mentionAvailable(f.state(),member.actorId),true);
});
