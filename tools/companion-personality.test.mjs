import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,workspace} from '../dist/kernel/index.js';
import {createHumanity,advanceHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {companionContext,companionTime,conversationTimeFacts,riceMotivation} from '../dist/host/companion-personality.js';
import {legacyContext} from '../dist/host/legacy-context.js';
import {createCognitiveModel} from '../dist/host/cognitive-model.js';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {LegacyDomain} from '../dist/host/legacy-domain.js';
import {createFinanceManagement} from '../dist/host/finance-management.js';
import {createInteractionReactions} from '../dist/host/interaction-reactions.js';
import {createLegacyResponses} from '../dist/host/legacy-responses.js';
import {createSemanticGrounding,reviewedReply} from '../dist/host/semantic-grounding.js';
import {createLaborCompletionNotices} from '../dist/host/labor-completion-notices.js';
import {conversationContext} from '../dist/host/conversation-context.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';
import {createDeterministicLife} from '../dist/host/deterministic-life.js';

test('eating one bowl leaves hunger and a strong rice craving in the actual speech context',()=>{
 const now=Date.now(),s=fixture(now).get();s.humanity.stats.satiety=20;s.humanity.lastFedAt=now;s.legacy.config.riceAppeal=100;
 const food=conversationContext(s.life,s).food;
 assert.equal(food.satiety,20);assert.equal(food.hunger,80);assert.match(food.fullness,/仍然明显饥饿/);assert.ok(food.craving>=85);assert.equal(food.wantsRice,true);
 const full=riceMotivation({stats:{satiety:80},lastFedAt:now},{riceAppeal:100},now);
 const tempted=riceMotivation({stats:{satiety:80},lastFedAt:now},{riceAppeal:500},now);
 assert.match(full.fullness,/已经吃饱/);assert.ok(tempted.craving>full.craving);assert.equal(tempted.hunger,full.hunger);assert.equal(tempted.mealDue,false);
});

const hour=3600000;
test('autonomy model allowance accepts 80 daily calls and rejects values above 80',async()=>{
 const f=fixture(),domain=new LegacyDomain(f.reader,f.uow,f.gate,{});
 await domain.configure('main','allowance-20',{learning:{dailyModelCalls:20}});
 assert.equal(f.get().legacy.config.learning.dailyModelCalls,20);
 await domain.configure('main','allowance-80',{learning:{dailyModelCalls:80}});
 assert.equal(f.get().legacy.config.learning.dailyModelCalls,80);
 await assert.rejects(domain.configure('main','allowance-81',{learning:{dailyModelCalls:81}}));
});
function event(id,type,at,extra={}){return {eventId:id,petId:'main',type,source:'desktop',actorId:'dad',occurredAt:new Date(at).toISOString(),receivedAt:new Date(at).toISOString(),evidenceLevel:'observed',payload:{},...extra};}
function fixture(now=Date.now()){
  const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:()=>now,save(){},load(){}});
  const h=createHumanity(now);h.helperReady=true;h.restrained=false;
  let state={petId:'main',version:0,legacy:old.read('main'),humanity:h,life:createInitialState('main',new Date(now).toISOString())};
  state.life.constraints.paused=false;
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const reader={loadEnvelope:async()=>structuredClone(state),load:async()=>({...structuredClone(state.life),legacyContext:legacyContext('大肥鱼')(state)})};
  const uow={apply:async(_id,version,change)=>{assert.equal(version,state.version);const draft=structuredClone(state);change(draft);draft.version++;state=draft;}};
  const budget={runAs:async(_id,_category,fn)=>fn()};
  return {get:()=>state,reader,uow,gate,budget};
}

test('隔一小时的新一餐不会重用六小时内的旧请求，未确认的吃饭仍不重试',async()=>{
  const realNow=Date.now;let now=Math.floor(realNow()/(6*hour))*6*hour+hour;
  Date.now=()=>now;
  try{
    for(const hasRice of [true,false]){
      const f=fixture(now),s=f.get(),requests=[];
      s.humanity.stats.satiety=80;s.humanity.lastFedAt=now-hour;
      s.legacy.worksite={inside:false};s.legacy.wallet={balance:1000};s.legacy.config.costs={feed:10};
      s.legacy.services={inventory:hasRice?[{status:'available'}]:[]};
      s.life.constraints.capabilities.push({name:'service.buy-rice',enabled:true});
      const life=createDeterministicLife({get:async()=>f.get().humanity},f.reader,async(_id,input)=>{requests.push(input);},f.gate,f.uow,{}, {},async()=>{});
      await life.run('main',f.gate.signal,{allowAutonomous:true});now+=hour;
      await life.run('main',f.gate.signal,{allowAutonomous:true});
      assert.equal(requests.length,2);assert.notEqual(requests[0].key,requests[1].key);
      assert.equal(requests[0].command,hasRice?'/吃':'/冰箱 买一碗白饭');
      s.life.actions.push({actionType:hasRice?'service.eat-rice':'service.buy-rice',status:'UNKNOWN'});now+=hour;
      await life.run('main',f.gate.signal,{allowAutonomous:true});assert.equal(requests.length,2);
    }
  }finally{Date.now=realNow;}
});

test('相隔八小时的爸爸私聊不会被本轮、自动事件、群聊和其他人刷新',()=>{
  const now=Date.parse('2026-11-15T10:00:00Z'),f=fixture(now),s=f.get();
  s.life.events=[event('dad-old','conversation.user',now-8*hour),event('auto','conversation.assistant',now-30000),
    event('body','body.observed',now-20000),event('thought','self.thought',now-10000,{actorId:undefined,source:'model'}),
    event('group','conversation.user',now-5000,{source:'qq-group'}),event('other','conversation.user',now-2000,{source:'qq-c2c',actorId:'qq-member:other'}),event('current','conversation.user',now)];
  const time=companionTime(s,now,['current']);
  assert.equal(time.secondsSinceOwnerMessage,28800);assert.equal(time.reunion,true);assert.match(time.gapDescription,/8小时/);
  assert.match(time.localTime,/18:00/);assert.equal(companionTime(s,now+5000).secondsSinceOwnerMessage,5);
});

test('QQ 原始消息及其派生事件只算同一次接触；跨渠道私聊共享时间',()=>{
  const now=Date.now(),f=fixture(now),s=f.get();
  s.life.events=[event('desktop-old','conversation.user',now-8*hour),event('qq-in','social.message',now,{source:'qq',payload:{scene:'c2c'}}),
    event('qq-current','conversation.user',now,{source:'qq-c2c',causationId:'qq-in'}),event('chat-social','social.message',now,{causationId:'qq-current'})];
  const t=companionTime(s,now,['qq-current']);assert.equal(t.secondsSinceOwnerMessage,28800);assert.equal(t.secondsSinceOwnerContact,28800);
  s.life.events.push(event('care','social.care',now-2*hour));
  const cared=companionTime(s,now,['qq-current']);assert.equal(cared.secondsSinceOwnerMessage,28800);assert.equal(cared.secondsSinceOwnerContact,7200);
});

test('删除和未来时间不成为重逢依据，没有记录就明确未知',()=>{
  const now=Date.now(),s=fixture(now).get();s.life.events=[event('deleted','conversation.user',now-8*hour),event('future','conversation.user',now+hour)];
  s.life.invalidSources.deleted='removed';const t=companionTime(s,now);assert.equal(t.secondsSinceOwnerMessage,null);assert.equal(t.reunion,false);
  s.life.events.push(event('raw','social.message',now-6*hour,{source:'qq',payload:{scene:'c2c'}}),event('derived','conversation.user',now-6*hour,{source:'qq-c2c',causationId:'raw'}));
  s.life.invalidSources.raw='removed';assert.equal(companionTime(s,now).secondsSinceOwnerMessage,null);
});

test('白饭偏好、六种需求、智力和库存进入新版投影，偏好不篡改饥饿',()=>{
  const now=Date.now(),s=fixture(now).get();s.legacy.config.riceAppeal=400;s.legacy.config.intelligence=75;s.humanity.stats.satiety=80;s.humanity.lastFedAt=now-1000;
  s.legacy.services={inventory:[{id:'bowl',name:'大白饭',status:'available'}]};
  const before=structuredClone(s),context=companionContext(s,now);assert.deepEqual(s,before);
  assert.equal(context.food.appeal,400);assert.equal(context.food.satiety,80);assert.equal(context.food.wantsRice,false);assert.equal(context.food.inventory[0].id,'bowl');
  assert.equal(context.mind.intelligence,75);assert.deepEqual(Object.keys(context.needs).sort(),['food','rest','company','curiosity','play','comfort'].sort());
  assert.equal(legacyContext('原身份')(s).companion.food.appeal,400);
});

test('想吃和实际自动投喂分开：高诱惑力不强迫饱腹时吃，真实一小时间隔保留',()=>{
  const now=Date.now(),h={stats:{satiety:60},lastFedAt:now-1000};
  const craves=riceMotivation(h,{riceAppeal:500},now);assert.equal(craves.wantsRice,true);assert.equal(craves.mealDue,false);
  assert.equal(riceMotivation({...h,lastFedAt:now-hour},{},now).mealDue,true);
  assert.equal(riceMotivation({stats:{satiety:95},lastFedAt:now-8*hour},{riceAppeal:500},now).mealDue,false);
  assert.equal(riceMotivation({stats:{satiety:40}},{},now).mealDue,true);assert.equal(riceMotivation({},{}).mealDue,false);
});

test('主观心绪只取有来源且未作废的新念头，过期小剧场不当真实经历',()=>{
  const now=Date.now(),s=fixture(now).get();s.life.events=[event('user','conversation.user',now-1000),event('feeling','self.thought',now-500,{source:'model',payload:{text:'还惦记一口饭',feeling:'嘴硬',desire:'白饭',sourceIds:['user']}})];
  s.legacy.world={soft:{current:{scene:'bowl',status:'waiting',expires:now+1000}}};
  assert.equal(companionContext(s,now).subjectiveContinuity[0].desire,'白饭');assert.equal(companionContext(s,now).soft.roleplay,true);
  s.life.invalidSources.user='removed';assert.equal(companionContext(s,now).subjectiveContinuity.length,0);assert.equal(companionContext(s,now+2000).soft,null);
});

test('真实八小时重逢进入聊天最终模型请求，下一句恢复短间隔而不是反复重逢',async()=>{
  const now=Date.now(),f=fixture(now);f.get().life.events.push(event('last','conversation.user',now-8*hour));
  const captured=[];const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(o){captured.push(o);yield {type:'text',text:'<念头>想爸爸了，也惦记饭</念头>爸爸，你回来啦。'};}}};
  const chat=new CanonicalChat(f.reader,f.gate,f.uow,f.budget,model,async()=>[]);
  await chat.turn({requestId:'return-eight-hours',petId:'main',channel:'desktop',actorId:'dad',text:'本鱼，在干嘛'},f.gate.signal);
  assert.match(captured[0].system,/约8小时/);assert.match(captured[0].system,/不编造自己这段时间/);
  assert.match(captured[0].system,/疼也能馋/);assert.ok(f.get().life.events.some(e=>e.type==='self.thought'));
  await chat.turn({requestId:'next-short-message',petId:'main',channel:'desktop',actorId:'dad',text:'想吃什么'},f.gate.signal);
  const facts=JSON.parse(captured.at(-1).system.split('生活事实与近期行动（派发或等待不等于完成；仅完成回执证明实际结果）：')[1].split('\n')[0]);
  assert.equal(facts.companion.time.reunion,false);assert.ok(facts.companion.time.secondsSinceOwnerMessage<5);
});

test('自主思考拿到同一份白饭偏好、智力、钱包与真实时间，输出仍走新版 JSON',async()=>{
  const now=Date.now(),s=fixture(now).get();s.legacy.config.riceAppeal=160;s.legacy.config.intelligence=75;s.life.events.push(event('old','conversation.user',now-8*hour));
  s.life.legacyContext=legacyContext('原身份')(s);let captured;
  const m=createCognitiveModel({async *stream(o){captured=o;yield {type:'text',text:JSON.stringify({action:null,thought:null,goals:[],goalUpdates:[],plan:[],interests:[],selfModel:[]})};}},()=>({provider:'test',model:'test'}));
  await m.generate(workspace(s.life),new AbortController().signal,{});
  const c=JSON.parse(captured.messages[0].content).当前.legacyContext.companion;
  assert.equal(c.food.appeal,160);assert.equal(c.mind.intelligence,75);assert.equal(c.food.balance,10000);assert.equal(c.time.secondsSinceOwnerMessage,28800);assert.match(captured.system,/只返回一个 JSON/);
});

test('时间事实经过原审核，作废对应消息会使已审核的时间证据失效',async()=>{
  const now=Date.now(),f=fixture(now);f.get().life.events=[event('old','conversation.user',now-8*hour),event('new','conversation.user',now)];
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(o){const input=JSON.parse(o.messages[0].content);assert.equal(input.facts.time.messageGapSeconds,28800);yield {type:'text',text:JSON.stringify({segments:input.segments.map(text=>({text,kind:'fact',time:'none',supported:true,evidence:['time']})),workIntent:false})};}}};
  const grounding=createSemanticGrounding(f.reader,f.budget,model);const r=await grounding.review('main','八小时没聊啦。','回来啦',f.gate.signal);
  assert.ok(r);assert.equal(grounding.valid(f.get(),r),true);assert.equal(reviewedReply(r,true,false),'八小时没聊啦。');
  f.get().life.invalidSources.old='removed';assert.equal(grounding.valid(f.get(),r),false);
});

test('手动加钱、扣钱、冻结和解冻有准确即时回应，同一操作不会重复；聊天提工钱不自动加钱',async()=>{
  const f=fixture(),domain=new LegacyDomain(f.reader,f.uow,f.gate,{}),finance=createFinanceManagement(f.reader,f.gate,domain);
  f.get().life.events.push(event('wage-talk','conversation.user',Date.now()-1000,{payload:{text:'这次工钱给你五百，我这就给你加饭钱'}}));
  const requests=[],published=[];
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(o){requests.push(o);yield {type:'text',text:'本鱼收到啦，这笔饭钱我可记着呢。'};}}};
  const respond=createLegacyResponses(f.reader,f.gate,f.uow,f.budget,model,'大肥鱼');
  const pending=[];
  const react=createInteractionReactions(structuredClone(f.get()),(id,e,signal)=>{const p=respond(id,'interaction',signal,e);pending.push(p);return p;},t=>published.push(t),f.gate.signal);
  const write=async(id,action,extra)=>{
    const w=f.get().legacy.wallet;await finance.write('main',{kind:'wallet',requestId:id,action,expectedBalance:w.balance,expectedFrozen:w.frozen,...extra});
    react(structuredClone(f.get()));await new Promise(setImmediate);await Promise.all(pending);await new Promise(setImmediate);
  };
  await write('wallet-add-wage','add',{amount:500});assert.equal(f.get().legacy.wallet.balance,10500);assert.equal(published.length,1);
  assert.match(requests[0].messages[0].content,/10000.*10500/);assert.match(requests[0].messages[0].content,/这次工钱/);assert.match(requests[0].system,/普通添钱不能擅自算工资/);
  await domain.wallet('main','wallet-add-wage',{action:'add',amount:500,expectedBalance:10000,expectedFrozen:false});react(structuredClone(f.get()));await new Promise(setImmediate);assert.equal(published.length,1);assert.equal(f.get().legacy.wallet.balance,10500);
  await write('wallet-subtract','subtract',{amount:100});assert.match(requests.at(-1).messages[0].content,/减少了 100 token/);
  await write('wallet-freeze','freeze',{frozen:true});assert.match(requests.at(-1).messages[0].content,/冻结了饭钱消耗/);
  await write('wallet-unfreeze','freeze',{frozen:false});assert.match(requests.at(-1).messages[0].content,/恢复了饭钱消耗/);
  assert.equal(f.get().legacy.wallet.balance,10400);assert.equal(published.length,4);
});

test('负体力只能随真实经过的时间恢复，不会在感知或毫秒级结算时跳回零',()=>{
  const now=Date.now(),h=createHumanity(now);h.stats.stamina=-10;h.stats.energy=-10;
  const after=advanceHumanity(h,now+1);assert.ok(after.stats.stamina<-9.9);assert.ok(after.stats.energy<-9.9);
  const s=fixture(now).get();s.humanity=h;companionContext(s,now+1);assert.equal(s.humanity.stats.stamina,-10);
});

test('群聊允许安静旁听，内部标记不会成为发给群友的消息',async()=>{
  const f=fixture(),now=Date.now();
  f.get().life.events.push(event('group-in','social.message',now,{source:'qq',actorId:'qq-member:other',payload:{scene:'group',groupId:'group',text:'小白，咱们聊一下'}}));
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(o){assert.match(o.system,/先分清谁在说/);yield {type:'text',text:'<qq-silent/>'};}}};
  const chat=new CanonicalChat(f.reader,f.gate,f.uow,f.budget,model,async()=>[]);
  assert.equal(await chat.qqTurn({petId:'main',scene:'group',messages:[{text:'小白，咱们聊一下',isOwner:false,eventId:'group-in'}]},f.gate.signal),null);
  assert.equal(f.get().life.events.at(-1).payload.silent,true);
});

function finishedFixture(){
  const now=Date.now(),f=fixture(now),s=f.get();
  const c={id:'job',status:'working',trips:1,done:0,carrying:true,wage:500,paid:0,payments:[],workPermit:true};
  s.legacy.labor={contracts:[c]};s.legacy.world={command:{id:'deliver',source:'labor',status:'running',index:1,surface:'desktop',approached:true,labor:{id:'job',trip:0,leg:'deliver',x:.78}}};
  const intent={id:'last-trip',type:'labor.step',payload:{parameters:{contractId:'job',commandId:'deliver'}}};
  const receipt={status:'completed',evidence:{actionId:'last-trip',kind:'labor.step',commandId:'deliver',index:1,surface:'desktop',played:true,x:.78,confirmed:true}};
  return {f,intent,receipt,finish:()=>projectOutcome(s,intent,receipt,new Date(now).toISOString(),'last-receipt')};
}
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};

test('最后一趟真实回执后主动来报告，工钱由爸爸手动加；窗口重开也不重复通知',async()=>{
  const {f,finish}=finishedFixture(),published=[],calls=[];
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(o){calls.push(o);yield {type:'text',text:'爸爸，本鱼搬完啦！工钱可不能忘了。'};}}};
  const responses=createLegacyResponses(f.reader,f.gate,f.uow,f.budget,model,'大肥鱼');
  const make=()=>createLaborCompletionNotices(f.reader,'main',(id,e,signal)=>responses(id,'completion',signal,e,{autonomous:true}),text=>published.push(text),f.gate.signal);
  const observe=make();observe(f.get());await flush();assert.equal(published.length,0);
  finish();observe(f.get());observe(f.get());await flush();assert.equal(published.length,1);assert.equal(calls.length,1);
  assert.match(calls[0].messages[0].content,/手动加饭钱/);assert.equal(f.get().legacy.wallet.balance,10000);
  make()(f.get());await flush();assert.equal(published.length,1);
});

test('未完成、中断、来源作废不报完工；暂停或停止打扰时保留通知，恢复再来',async()=>{
  const {f,intent,receipt,finish}=finishedFixture();projectOutcome(f.get(),intent,{status:'cancelled',evidence:{confirmed:false}},new Date().toISOString(),'cancelled');
  assert.equal(f.get().life.events.some(e=>e.type==='labor.completed'),false);
  f.get().legacy.world.command.status='running';finish();const completed=f.get().life.events.find(e=>e.type==='labor.completed');
  const calls=[],publish=[];
  const respond=async(_id,e)=>{calls.push(e);f.get().life.events.push(event('notice-request','interaction.requested',Date.now(),{payload:{kind:'completion'}}),event('notified','conversation.assistant',Date.now(),{causationId:'notice-request',payload:{sourceIds:[e.eventId],text:'搬完啦'}}));return '搬完啦';};
  const notify=createLaborCompletionNotices(f.reader,'main',respond,t=>publish.push(t),f.gate.signal);
  f.get().life.constraints.paused=true;notify(f.get());await flush();assert.equal(calls.length,0);
  f.get().life.constraints.paused=false;f.get().legacy.growth.stopAt=Date.now();notify(f.get());await flush();assert.equal(calls.length,0);
  delete f.get().legacy.growth.stopAt;f.get().life.invalidSources[completed.causationId]='removed';notify(f.get());await flush();assert.equal(calls.length,0);
  delete f.get().life.invalidSources[completed.causationId];notify(f.get());await flush();assert.equal(publish.length,1);
});

test('完工通知模型失败不伪造台词，重启后仍能找回未发送通知',async()=>{
  const {f,finish}=finishedFixture();finish();const published=[];
  createLaborCompletionNotices(f.reader,'main',async()=>{throw Error('model unavailable');},t=>published.push(t),f.gate.signal)(f.get());await flush();assert.equal(published.length,0);
  createLaborCompletionNotices(f.reader,'main',async(_id,e)=>{f.get().life.events.push(event('retry-request','interaction.requested',Date.now(),{payload:{kind:'completion'}}),event('retry-notice','conversation.assistant',Date.now(),{causationId:'retry-request',payload:{sourceIds:[e.eventId]}}));return '爸爸，本鱼搬完啦';},t=>published.push(t),f.gate.signal)(f.get());
  await flush();assert.equal(published.length,1);
});
