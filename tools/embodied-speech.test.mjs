import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbodiedSpeech} from '../dist/host/embodied-speech.js';
import {createHumanity,advanceHumanity,reactHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {actionFacts} from '../dist/host/semantic-grounding.js';
import {WriterLease} from '../dist/host/writer-lease.js';

function fixture(resultStatus='COMPLETED'){
  const now=Date.now(),human=createHumanity(now);human.helperReady=true;human.restrained=false;
  let state={petId:'main',version:0,humanity:human,legacy:{services:{inventory:[{id:'rice-1',name:'白饭',status:'available'}]},wallet:{balance:100},config:{costs:{feed:20}}},life:{events:[{eventId:'user-1',type:'conversation.user',payload:{text:'先吃饭吧'}}],invalidSources:{},actions:[],receipts:[],goals:[],constraints:{paused:false,permissions:[],capabilities:[{name:'service.eat-rice',enabled:true},{name:'care.feed',enabled:true}]}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},reader={loadEnvelope:async()=>structuredClone(state)};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);fn(state);state.version++;}};
  const actions={queue:async(_id,id)=>{state.life.actions.find(a=>a.id===id).status='PENDING';}};
  let dispatches=0;
  const dispatcher={dispatch:async id=>{dispatches++;const a=state.life.actions.find(a=>a.id===id);a.status=resultStatus;state.life.receipts.push({actionId:id,status:resultStatus});}};
  const speech=createEmbodiedSpeech(reader,gate,uow,actions,dispatcher,async()=>({status:'PENDING'}),async()=>({status:'done'}));
  const options={embodied:{petId:'main',requestId:'speech-test',sourceIds:['user-1'],allowActions:true},system:'角色',messages:[{role:'user',content:'先吃饭'}],signal:gate.signal};
  return {speech,options,dispatcher,get:()=>state,dispatches:()=>dispatches};
}
const call=(id,name,input)=>({type:'tool-call-delta',index:1,id,name,argumentsDelta:JSON.stringify(input)});
async function collect(stream){let text='';for await(const p of stream)if(p.type==='text')text+=p.text;return text;}

test('after eating, continuation replaces pre-action system facts with current inventory and body',async()=>{
  const f=fixture();f.get().humanity.stats.satiety=13;f.get().legacy.wallet.balance=30;
  f.dispatcher.dispatch=async id=>{
    const state=f.get(),action=state.life.actions.find(a=>a.id===id);action.status='COMPLETED';
    state.life.receipts.push({actionId:id,status:'COMPLETED'});
    state.legacy.services.inventory[0].status='eaten';state.humanity.stats.satiety=25;
    state.humanity.lastFedAt=Date.now();state.legacy.wallet.balance=29.8;
  };
  let rounds=0;
  const model={async *stream(o){
    const live=JSON.parse(o.system.split('当前身体与食物（优先于旧对话和历史摘要）：').at(-1));
    if(++rounds===1){assert.equal(live.身体.satiety,13);yield call('eat','act',{actionType:'service.eat-rice',parameters:{itemId:'rice-1'}});}
    else{assert.equal(live.身体.satiety,25);assert.equal(live.饭钱,29.8);assert.deepEqual(live.库存,[]);assert.equal(live.food.lastFedAt,f.get().humanity.lastFedAt);yield {type:'text',text:'刚吃完了。'};}
  }};
  assert.equal(await collect(f.speech.wrap(model).stream(f.options)),'刚吃完了。');assert.equal(rounds,2);
});

test('prepared chat snapshots retain personality and current hunger in model input',async()=>{
 const f=fixture();f.get().humanity.stats.satiety=20;
 f.get().life.legacyContext={};f.get().life.memories=Array.from({length:20},(_,i)=>({id:'m'+i,content:'历史'.repeat(1000),sourceIds:[],valid:true}));
 const model={async *stream(o){assert.match(o.system,/【你自己的心思和口吻】/);assert.match(o.system,/仍然明显饥饿/);assert.match(o.system,/"craving":89/);yield {type:'text',text:'还饿，想吃白饭。'};}};
 assert.equal(await collect(f.speech.wrap(model).stream({...f.options,embodiedSnapshot:structuredClone(f.get())})),'还饿，想吃白饭。');
});

test('工具之前的台词不发布，完成回执返回模型再说话；吃饭编号可见',async()=>{
  const f=fixture();let rounds=0;
  const model={async *stream(o){rounds++;assert.match(o.system,/rice-1/);if(rounds===1){assert.ok(o.tools.some(t=>t.name==='act'));yield {type:'text',text:'我已经吃完啦'};yield call('c1','act',{actionType:'service.eat-rice',parameters:{itemId:'rice-1'}});}else{const receipt=JSON.parse(o.messages.at(-1).content);assert.equal(receipt.result.status,'COMPLETED');yield {type:'text',text:'饭吃到了，热乎乎的。'};}}};
  assert.equal(await collect(f.speech.wrap(model).stream(f.options)),'饭吃到了，热乎乎的。');assert.equal(f.dispatches(),1);
});

test('重复失败不重放',async()=>{
  const f=fixture();let rounds=0;
  const model={async *stream(o){rounds++;if(rounds<3)yield call('c'+rounds,'act',{actionType:'service.eat-rice',parameters:{}});else{assert.match(JSON.parse(o.messages.at(-1).content).result.reason,/已尝试/);yield {type:'text',text:'这口还没吃上。'};}}};
  assert.equal(await collect(f.speech.wrap(model).stream(f.options)),'这口还没吃上。');assert.equal(f.dispatches(),0);
});

test('未知执行结果返回模型且阻止再次驱动身体',async()=>{
  const f=fixture('UNKNOWN');let rounds=0;
  const model={async *stream(o){
    rounds++;assert.ok(o.signal instanceof AbortSignal);
    if(rounds===1)yield call('c1','act',{actionType:'service.eat-rice',parameters:{itemId:'rice-1'}});
    else if(rounds===2){assert.equal(JSON.parse(o.messages.at(-1).content).result.status,'UNKNOWN');yield call('c2','act',{actionType:'care.water',parameters:{}});}
    else{assert.match(JSON.parse(o.messages.at(-1).content).result.reason,/未确认/);yield {type:'text',text:'还不知道刚才有没有吃到，先确认一下。'};}
  }};
  assert.match(await collect(f.speech.wrap(model).stream(f.options)),/还不知道/);assert.equal(f.dispatches(),1);
});

test('只说话只调用一次模型；取消后不执行工具',async()=>{
  const f=fixture();let rounds=0;
  const model={async *stream(){rounds++;yield {type:'text',text:'爸爸，陪我坐一会儿。'};}};
  assert.equal(await collect(f.speech.wrap(model).stream(f.options)),'爸爸，陪我坐一会儿。');assert.equal(rounds,1);assert.equal(f.dispatches(),0);
  const controller=new AbortController();controller.abort();
  await assert.rejects(collect(f.speech.wrap(model).stream({...f.options,signal:controller.signal})),/取消/);
});

test('真实敲打和扣钱进入事实依据，未知碰撞不自动认定是爸爸',()=>{
  const f=fixture(),s=f.get(),at=new Date().toISOString();
  s.life.events.push({eventId:'hit',type:'body.observed',actorId:'dad',occurredAt:at,payload:{event:'knock',detail:{count:3}}},{eventId:'wallet',type:'wallet',actorId:'dad',occurredAt:at,payload:{text:'爸爸扣了20'}},{eventId:'collision',type:'body.observed',occurredAt:at,payload:{event:'collision'}});
  const events=actionFacts(s).experiences;assert.equal(events.length,3);assert.equal(events[0].actorId,'dad');assert.equal(events[2].actorId,null);
});

test('新版恢复无需数小时，吃喝不足仍影响恢复，挨打有哭泣窗口',()=>{
  const now=Date.parse('2026-11-15T01:00:00Z'),h=createHumanity(now);h.stats.pain=60;h.stats.stamina=20;h.stats.energy=20;h.restingUntil=now+20*60000;
  const rested=advanceHumanity(h,now+15*60000);assert.ok(rested.stats.pain<16);assert.ok(rested.stats.stamina>=49);assert.ok(rested.stats.energy>40);
  const awake=structuredClone(h);awake.restingUntil=0;assert.ok(advanceHumanity(awake,now+15*60000).stats.pain>rested.stats.pain);
  const poor=structuredClone(awake);poor.stats.satiety=0;assert.ok(advanceHumanity(poor,now+15*60000).stats.stamina<advanceHumanity(awake,now+15*60000).stats.stamina);
  const hit=reactHumanity(createHumanity(now),'knock',now,{count:3});assert.ok(hit.cryingUntil>now+3000);assert.equal(hit.collision.origin,'user-knock');
});

test('等待动作回执期间触碰可取得状态锁，失败后续写仍串行',async()=>{
  const client={on(){return this;},removeListener(){return this;},release(){},async query(){return {rows:[{acquired:true}],rowCount:1};}};
  const lease=new WriterLease({connect:async()=>client});await lease.acquire();
  let unblock;const pending=new Promise(resolve=>unblock=resolve),sequence=[];
  try{
    const animation=lease.run('main',async()=>{sequence.push('start');await assert.rejects(lease.waitOutside(async()=>{await pending;throw Error('interrupted');}),/interrupted/);sequence.push('resume');});
    await new Promise(setImmediate);
    await lease.run('main',async()=>{sequence.push('touch');unblock();});await animation;
    assert.deepEqual(sequence,['start','touch','resume']);
  }finally{await lease.close();}
});


test('streaming speech delivers first words before model completion and returns tool results in the same turn',async()=>{
  const f=fixture();let finish;const barrier=new Promise(resolve=>{finish=resolve});let rounds=0;
  const model={async *stream(o){rounds++;if(rounds===1){yield call('c1','act',{actionType:'service.eat-rice',parameters:{itemId:'rice-1'}});}else{assert.equal(JSON.parse(o.messages.at(-1).content).result.status,'COMPLETED');yield {type:'text',text:'饭吃到了'};await barrier;yield {type:'text',text:'，热乎乎的。'};}}};
  const stream=f.speech.wrap(model).stream({...f.options,streamText:true})[Symbol.asyncIterator]();
  assert.deepEqual((await stream.next()).value,{type:'text',text:'饭吃到了'});assert.equal(f.dispatches(),1);
  finish();assert.equal((await stream.next()).value.text,'，热乎乎的。');assert.equal((await stream.next()).done,true);assert.equal(rounds,2);
});


test('historical unknown actions do not block buying new rice, and the model can eat its new inventory in the same turn',async()=>{
  const f=fixture(),s=f.get();s.legacy.services.inventory=[];
  s.life.constraints.capabilities.push({name:'service.buy-rice',enabled:true},{name:'care.water',physical:true,enabled:true});
  s.life.constraints.capabilities.find(c=>c.name==='service.eat-rice').physical=true;
  s.life.actions.push({id:'old-eat',actionType:'service.eat-rice',status:'UNKNOWN',sourceIds:[],parameters:{itemId:'old-rice'}},{id:'old-feed',actionType:'care.feed',status:'UNKNOWN',sourceIds:[],parameters:{}},{id:'old-labor',actionType:'labor.step',status:'UNKNOWN',sourceIds:[],parameters:{commandId:'old-command'}});
  let rounds=0;const dispatched=[];
  f.dispatcher.dispatch=async id=>{const action=s.life.actions.find(a=>a.id===id);dispatched.push(action.actionType);action.status='COMPLETED';if(action.actionType==='service.buy-rice'){s.legacy.wallet.balance-=20;s.legacy.services.inventory.push({id:'rice:new-purchase',name:'大白饭',status:'available'});}else{assert.equal(action.parameters.itemId,'rice:new-purchase');s.legacy.services.inventory[0].status='eaten';}s.life.receipts.push({actionId:id,status:'COMPLETED'});};
  const model={async *stream(o){rounds++;if(rounds===1)yield call('buy','act',{actionType:'service.buy-rice',parameters:{}});else if(rounds===2){const data=JSON.parse(o.messages.at(-1).content);assert.equal(data.result.status,'COMPLETED');assert.equal(data.饭钱,80);assert.equal(data.库存[0].id,'rice:new-purchase');yield call('eat','act',{actionType:'service.eat-rice',parameters:{itemId:data.库存[0].id}});}else{assert.equal(JSON.parse(o.messages.at(-1).content).result.status,'COMPLETED');yield {type:'text',text:'饭买来吃到了。'};}}};
  assert.equal(await collect(f.speech.wrap(model).stream(f.options)),'饭买来吃到了。');
  assert.deepEqual(dispatched,['service.buy-rice','service.eat-rice']);assert.equal(rounds,3);assert.equal(s.legacy.wallet.balance,80);assert.equal(s.legacy.services.inventory[0].status,'eaten');assert.equal(s.life.actions.find(a=>a.id==='old-eat').status,'UNKNOWN');
});

test('an uncertain meal still blocks consuming that same bowl, without blocking unrelated later resources',async()=>{
  const f=fixture(),s=f.get();s.life.actions.push({id:'uncertain-eat',actionType:'service.eat-rice',status:'UNKNOWN',sourceIds:[],parameters:{itemId:'rice-1'}});let rounds=0;
  const model={async *stream(o){if(++rounds===1)yield call('eat','act',{actionType:'service.eat-rice',parameters:{itemId:'rice-1'}});else{assert.match(JSON.parse(o.messages.at(-1).content).result.reason,/未确认/);yield {type:'text',text:'这碗还没确认，先不重复吃。'};}}};
  await collect(f.speech.wrap(model).stream(f.options));assert.equal(f.dispatches(),0);
});

test('malformed tool arguments return an error to the same model instead of ending its turn',async()=>{
  const f=fixture();let rounds=0;const model={async *stream(o){if(++rounds===1)yield {type:'tool-call-delta',index:1,id:'bad',name:'act',argumentsDelta:'{'};else{assert.equal(o.messages.at(-1).isError,true);yield {type:'text',text:'我再想想。'};}}};
  assert.equal(await collect(f.speech.wrap(model).stream(f.options)),'我再想想。');assert.equal(f.dispatches(),0);
});
