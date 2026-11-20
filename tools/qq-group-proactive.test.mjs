import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalQQ,createQQExecutor,QQPlatformRejection} from '../dist/host/qq-canonical.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {groupProactiveState,GROUP_QUIET_INTERVAL as interval} from '../dist/host/qq-group-proactive-policy.js';
import {generateGroupOpener,createGroupProactive} from '../dist/host/qq-group-proactive.js';
import {recentGroupActivity} from '../dist/host/group-conversation-context.js';

function fixture(){
  const authority={},signal=new AbortController().signal,intents=[];
  let state={petId:'main',version:0,legacy:{config:{},wallet:{balance:1,frozen:true},qq:{identity:{appId:'app',ownerOpenid:'owner',groupOpenid:'group',groupOwnerOpenid:'dad',groupEnabled:true,groupMode:'all'},seen:{},outbound:{}}},humanity:{},life:{events:[],actions:[],receipts:[],memories:[],goals:[],observations:[],development:[],beliefs:[],relationships:[],invalidSources:{},constraints:{paused:false,permissions:['qq.send'],capabilities:[{name:'qq.send',enabled:true,requiresPermission:'qq.send'}]}}};
  state.life.commitments=[];
  state.humanity={updatedAt:Date.now(),stats:{energy:70,stamina:70,satiety:50,hydration:80,comfort:70,pain:0,stress:20,security:80},emotions:{joy:50,sadness:10,anger:5,fear:5,love:60,aversion:5,longing:20}};
  let serial=Promise.resolve();const gate={signal,run:(_id,fn)=>{const next=serial.then(fn);serial=next.catch(()=>{});return next;}};
  const reader={loadEnvelope:async()=>structuredClone(state)},body=()=>({body:{},emotions:{}});
  const uow={apply:async(_id,v,fn)=>{assert.equal(v,state.version);const draft=structuredClone(state),result=fn(draft);draft.version++;state=draft;intents.push(...(result.intents??[]));}};
  const qq=new CanonicalQQ(reader,uow,gate,body,authority),lifecycle=new CanonicalActionLifecycle(body);
  const claim=()=>qq.claimGroupOpportunity('main',authority);
  const ready=async()=>{await claim();state.legacy.qq.groupProactive.enabledAt=Date.now()-interval-1000;};
  const enqueue=(snapshot,text='今天想聊点什么呀？')=>qq.enqueueGroupOpener('main',snapshot.legacy.qq.groupProactive.lastAttemptId,text,authority);
  return {state:()=>state,intents,qq,authority,ready,claim,enqueue,lifecycle};
}

test('four hours of silence grants one durable opportunity, no catch-up or restart burst',async()=>{
  const f=fixture();assert.equal(await f.claim(),null);
  f.state().legacy.qq.groupProactive.enabledAt=Date.now()-interval+60000;assert.equal(await f.claim(),null);
  f.state().legacy.qq.groupProactive.enabledAt=Date.now()-7*24*3600000;
  const claims=await Promise.all([f.claim(),f.claim()]);assert.equal(claims.filter(Boolean).length,1);
  assert.equal(await f.claim(),null);assert.equal(f.state().legacy.wallet.balance,1);
  const other=new CanonicalQQ({loadEnvelope:async()=>structuredClone(f.state())},{apply:()=>assert.fail('restart must not claim again')},{signal:new AbortController().signal,run:async(_id,fn)=>fn()},()=>({}),f.authority);
  assert.equal(await other.claimGroupOpportunity('main',f.authority),null);
});

test('new group ingress resets silence; ban, pause, sleep, limited visibility, and low balance prohibit an opener',async()=>{
  for(const change of [s=>s.legacy.config.qqGroupBlocked=true,s=>s.life.constraints.paused=true,s=>s.humanity.sleeping=true,s=>s.legacy.qq.identity.groupMode='mentions',s=>s.legacy.wallet.balance=.39]){
    const f=fixture();await f.ready();change(f.state());assert.equal(await f.claim(),null);assert.equal(f.intents.length,0);
  }
  const f=fixture();await f.ready();await f.qq.receive('main',{scene:'group',messageId:'new',actorOpenid:'friend',groupOpenid:'group',text:'醒醒',occurredAt:new Date().toISOString()},f.authority);
  assert.equal(await f.claim(),null);assert.equal(groupProactiveState(f.state()).ready,false);
});

test('one opener reserves exactly 0.4 atomically, remains idempotent, and does not use an old reply anchor',async()=>{
  const f=fixture();await f.ready();const snapshot=await f.claim(),id=await f.enqueue(snapshot);
  assert.equal(f.state().legacy.wallet.balance,.6);assert.equal(f.intents.length,1);
  assert.equal(await f.enqueue(snapshot),id);assert.equal(f.state().legacy.wallet.balance,.6);
  const p=f.intents[0].payload.parameters;assert.equal(p.scene,'group');assert.equal(p.replyTo,undefined);assert.equal(p.replySeq,undefined);
  assert.equal(f.state().life.events.filter(e=>e.type==='wallet.spend').length,1);
  assert.equal(await f.claim(),null);
  assert.equal(recentGroupActivity(f.state().life)[0].delivery,'发送尚未确认');
});

test('generation racing new messages or a ban cannot queue or charge',async()=>{
  for(const banned of [false,true]){
    const f=fixture();await f.ready();const snapshot=await f.claim();
    if(banned)f.state().legacy.config.qqGroupBlocked=true;
    else await f.qq.receive('main',{scene:'group',messageId:'race',actorOpenid:'friend',groupOpenid:'group',text:'刚来',occurredAt:new Date().toISOString()},f.authority);
    await assert.rejects(()=>f.enqueue(snapshot),/失效/);assert.equal(f.state().legacy.wallet.balance,1);assert.equal(f.intents.length,0);
  }
});

test('dispatch rechecks new activity, known failures refund once, unknown delivery holds the reservation',async()=>{
  for(const outcome of ['completed','failed','unknown','cancelled']){
    const f=fixture();await f.ready();await f.enqueue(await f.claim());const intent=f.intents[0];
    if(outcome==='cancelled'){
      f.state().legacy.config.qqGroupBlocked=true;assert.equal(f.lifecycle.prepare(f.state(),intent).allowed,false);
    }else assert.equal(f.lifecycle.prepare(f.state(),intent).allowed,true);
    const receipt={status:outcome,evidence:outcome==='completed'?{actionId:intent.id,kind:'qq.send',messageId:'sent'}:{reason:'test'}};
    f.lifecycle.complete(f.state(),intent,receipt);f.lifecycle.complete(f.state(),intent,receipt);
    assert.equal(f.state().legacy.wallet.balance,['failed','cancelled'].includes(outcome)?1:.6);
    if(outcome==='completed')assert.equal(recentGroupActivity(f.state().life)[0].delivery,'已确认发送');
    assert.equal(await f.claim(),null);
  }
});

test('platform rejection is distinct from ambiguous network delivery',async()=>{
  const f=fixture();await f.ready();await f.enqueue(await f.claim());
  for(const [error,status] of [[new QQPlatformRejection('not allowed'),'failed'],[new Error('connection reset'),'unknown']]){
    const run=createQQExecutor({send:async()=>{throw error;}});assert.equal((await run('main',f.intents[0],new AbortController().signal)).status,status);
  }
});

test('openers can use private contact timing without private content, rewrite, and stay silent without paying',async()=>{
  const f=fixture();await f.ready();const snapshot=await f.claim();
  snapshot.life.events.push({eventId:'private',type:'conversation.user',source:'desktop',actorId:'dad',payload:{text:'不能公开的私聊'},occurredAt:new Date().toISOString()});
  const calls=[],model={async *stream(o){calls.push(o);yield {type:'text',text:calls.length===1?'鱼'.repeat(20):'群里好安静呀。'};}};
  assert.equal(await generateGroupOpener(snapshot,model,{provider:'test',model:'test'},new AbortController().signal),'群里好安静呀。');
  assert.equal(calls.length,2);assert.doesNotMatch(JSON.stringify(calls),/不能公开的私聊/);
  for(const call of calls){assert.match(call.system,/收到过爸爸的私聊发言/);assert.match(call.system,/不使用 @ 或点名控制标记/);}
  assert.equal(calls[0].tools,undefined);assert.equal(calls[0].embodied,undefined);
  const quiet=fixture();await quiet.ready();let dispatched=0,decisions=0;
  const service=createGroupProactive({canonical:quiet.qq,authority:quiet.authority,generate:async()=>{decisions++;return null;},dispatch:async()=>dispatched++});
  await service.run('main',new AbortController().signal);await service.run('main',new AbortController().signal);
  assert.equal(decisions,1);assert.equal(dispatched,0);assert.equal(quiet.state().legacy.wallet.balance,1);
});

test('a selected opener passes through the durable outbox, and private QQ sends do not consume the group opportunity',async()=>{
  const f=fixture();await f.ready();
  f.state().life.actions.push({id:'private',actionType:'qq.send',parameters:{scene:'c2c',destination:'owner'},createdAt:new Date().toISOString()});
  const dispatched=[],service=createGroupProactive({canonical:f.qq,authority:f.authority,generate:async()=> '群里好安静呀。',dispatch:async id=>dispatched.push(id)});
  await service.run('main',new AbortController().signal);
  assert.deepEqual(dispatched,[f.intents[0].id]);assert.equal(f.state().legacy.wallet.balance,.6);
});

test('quiet-group openers cannot smuggle a mention marker or QQ tag into delivery',async()=>{
  const f=fixture();await f.ready();const snapshot=await f.claim();
  for(const text of ['醒醒[qq-at:dad]','<qqbot-at-user id="x" />','@everyone'])await assert.rejects(f.enqueue(snapshot,text));
  assert.equal(f.intents.length,0);assert.equal(f.state().legacy.wallet.balance,1);
});
