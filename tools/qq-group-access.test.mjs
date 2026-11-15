import test from 'node:test';
import assert from 'node:assert/strict';
import {createLifeManagement,createLifeApi} from '../dist/host/life-api.js';
import {CanonicalQQ,validateQQReply} from '../dist/host/qq-canonical.js';
import {groupChatBlocked,assertGroupReplyAllowed} from '../dist/host/qq-group-access.js';
import {companionContext} from '../dist/host/companion-personality.js';
import {developmentMaterial,developmentDay} from '../dist/host/development-material.js';
import {interactionDescription,createInteractionReactions} from '../dist/host/interaction-reactions.js';

function fixture(){
  let state={petId:'main',version:0,legacy:{config:{},qq:{identity:{appId:'test',ownerOpenid:'owner',groupOpenid:'group',groupOwnerOpenid:'group-owner',groupEnabled:true,groupMode:'all'},seen:{},outbound:{}}},humanity:{},life:{events:[],memories:[],goals:[],relationships:[],actions:[],invalidSources:{},constraints:{paused:false,permissions:[]}}};
  const reader={loadEnvelope:async()=>structuredClone(state)},gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const draft=structuredClone(state);fn(draft);draft.version++;state=draft;}};
  const changed=[],manage=createLifeManagement(reader,gate,uow,()=>({}),undefined,blocked=>changed.push(blocked));
  const ingress={},canonical=new CanonicalQQ(reader,uow,gate,()=>({}),ingress);
  const set=blocked=>manage('main',{kind:'group-chat',blocked,reason:blocked?'爸爸暂时不让看群消息':'爸爸恢复群聊',version:state.version});
  const message=(id,scene='group')=>({messageId:id,scene,actorOpenid:scene==='group'?'friend':'owner',groupOpenid:'group',text:'看得到吗',occurredAt:new Date().toISOString()});
  return {state:()=>state,reader,changed,set,manage,canonical,ingress,message};
}

test('ban persists, rejects group ingress without recording it, and preserves private QQ',async()=>{
  const f=fixture();await f.set(true);
  assert.equal(groupChatBlocked(f.state()),true);
  assert.equal(await f.canonical.groupBlocked('main'),true);
  const count=f.state().life.events.length;
  assert.equal((await f.canonical.receive('main',f.message('hidden'),f.ingress)).accepted,false);
  assert.equal(f.state().life.events.length,count);
  assert.equal((await f.canonical.receive('main',f.message('private','c2c'),f.ingress)).accepted,true);
  await f.set(false);
  assert.equal((await f.canonical.receive('main',{...f.message('delayed'),occurredAt:new Date(Date.now()-60000).toISOString()},f.ingress)).accepted,false);
  assert.equal((await f.canonical.receive('main',f.message('new'),f.ingress)).accepted,true);
  assert.deepEqual(f.changed,[true,false]);
});

test('ban and restore are attributed experiences visible to current context and diary',async()=>{
  const f=fixture();await f.set(true);await f.set(true);
  assert.equal(f.state().life.events.length,1);
  const context=companionContext(f.state()).groupChat;
  assert.equal(context.blocked,true);assert.equal(context.canRead,false);
  assert.equal(context.lastChange.actorId,'dad');assert.match(context.lastChange.detail.text,/爸爸禁止/);
  const material=developmentMaterial(f.state(),developmentDay(new Date().toISOString()));
  assert.equal(material[0].actorId,'dad');assert.match(material[0].text,/爸爸禁止/);
  await f.set(false);assert.equal(companionContext(f.state()).groupChat.canRead,true);
  assert.match(companionContext(f.state()).groupChat.lastChange.detail.text,/爸爸恢复/);
});

test('restoring access never revalidates old queued reply anchors',async()=>{
  const f=fixture();const old=await f.canonical.receive('main',f.message('old'),f.ingress);
  await f.set(true);
  assert.throws(()=>validateQQReply(f.state(),{}, {parameters:{scene:'group'},sourceIds:[old.eventId]}),/禁止/);
  await f.set(false);
  assert.throws(()=>assertGroupReplyAllowed(f.state(),old.eventId),/过期/);
  const fresh=await f.canonical.receive('main',f.message('new'),f.ingress);
  assert.doesNotThrow(()=>assertGroupReplyAllowed(f.state(),fresh.eventId));
});

test('authenticated settings API validates and exposes the group control',async()=>{
  const f=fixture(),api=createLifeApi({authorize:()=>true,petId:()=> 'main',manage:f.manage,groupChatBlocked:async()=>groupChatBlocked(f.state()),getState:async()=>({...f.state().life,version:f.state().version})});
  const post=blocked=>api(new Request('http://localhost/api/life/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'group-chat',blocked,reason:'爸爸暂时禁止群聊',version:0})}));
  assert.equal((await post('true')).status,400);
  assert.equal((await post(true)).status,200);
  const settings=await api(new Request('http://localhost/api/life/settings'));
  assert.equal((await settings.json()).value.groupChatBlocked,true);
  const forbidden=createLifeApi({authorize:()=>false});
  assert.equal((await forbidden(new Request('http://localhost/api/life/settings'))).status,403);
});

test('the existing reaction channel lets her respond to a committed ban and restoration',async()=>{
  const f=fixture(),replies=[],sources=[];
  const observe=createInteractionReactions(structuredClone(f.state()),async(_pet,event)=>{sources.push(event);return '爸爸，本鱼想看群嘛';},text=>replies.push(text),new AbortController().signal);
  await f.set(true);observe(f.state());await new Promise(resolve=>setImmediate(resolve));
  assert.match(sources[0].description,/爸爸刚刚禁止/);assert.equal(replies.length,1);
  assert.equal(sources[0].sourceIds[0],f.state().life.events[0].eventId);
  observe(f.state());await new Promise(resolve=>setImmediate(resolve));assert.equal(replies.length,1);
  await f.set(false);observe(f.state());await new Promise(resolve=>setImmediate(resolve));
  assert.match(sources[1].description,/爸爸刚刚恢复/);
  assert.equal(interactionDescription({...f.state().life.events[0],actorId:'qq-member:fake'}),undefined);
});
