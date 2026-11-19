import test from 'node:test';
import assert from 'node:assert/strict';
import {appendMoment,momentPublication,speechMomentId} from '../dist/host/moment-publishing.js';
import {createEmbodiedSpeech} from '../dist/host/embodied-speech.js';
import {createInitialState} from '../dist/kernel/index.js';
import {hasCognitiveDemand,Cognition} from '../dist/cognition/index.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';

function fixture(){
  const now=Date.now(),life=createInitialState('main',new Date(now).toISOString());life.constraints.paused=false;
  const stamp=new Date(now-1000).toISOString();
  life.events.push({eventId:'meal',petId:'main',type:'body.meal',source:'helper',evidenceLevel:'observed',occurredAt:stamp,receivedAt:stamp,payload:{text:'吃了一碗白饭'}});
  life.events.push({eventId:'user',petId:'main',type:'conversation.user',source:'desktop',actorId:'dad',evidenceLevel:'reported',occurredAt:stamp,receivedAt:stamp,payload:{text:'先去写条说说'}});
  let state={petId:'main',version:0,life,humanity:createHumanity(now),legacy:{wallet:{balance:20},config:{},services:{inventory:[]}}};
  const reader={loadEnvelope:async()=>structuredClone(state)};
  let chain=Promise.resolve();const gate={signal:new AbortController().signal,run(_id,fn){const result=chain.then(fn);chain=result.catch(()=>{});return result;}};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const draft=structuredClone(state);fn(draft);draft.version++;state=draft;}};
  const speech=createEmbodiedSpeech(reader,gate,uow,{}, {},async()=>{},async()=>{});
  const options={system:'角色',messages:[{role:'user',content:'先去写条说说'}],signal:gate.signal,
    embodied:{petId:'main',requestId:'write-now',sourceIds:['user'],allowActions:true,privateTime:true}};
  return {life,now,reader,gate,uow,speech,options,get:()=>state};
}
const post={text:'一碗白饭吃完，还想把碗抱一会儿。',sourceId:'meal'};
const call=(input=post)=>({type:'tool-call-delta',index:0,id:'publish',name:'publish_moment',argumentsDelta:JSON.stringify(input)});
const collect=async stream=>{let output='';for await(const part of stream)if(part.type==='text')output+=part.text;return output;};

test('发布重试幂等，频率、正文和来源失效校验共享同一规则',()=>{
  const f=fixture(),id=speechMomentId('one');
  const posted=appendMoment(f.life,'main',post,id,f.now);
  assert.equal(posted.status,'COMPLETED');
  assert.deepEqual(appendMoment(f.life,'main',post,id,f.now),posted);
  assert.throws(()=>appendMoment(f.life,'main',{...post,text:'另一条'},id,f.now),/不同或失效/);
  assert.throws(()=>appendMoment(f.life,'main',post,speechMomentId('two'),f.now),/两小时/);
  assert.equal(f.life.events.filter(e=>e.type==='self.moment').length,1);
  f.life.invalidSources.meal='已撤下';
  assert.throws(()=>appendMoment(f.life,'main',post,id,f.now),/不同或失效/);
  assert.deepEqual(momentPublication(f.life,f.now).recent,[]);
  const other=fixture();
  assert.throws(()=>appendMoment(other.life,'main',{...post,text:'字'.repeat(161)},id),/160/);
  assert.throws(()=>appendMoment(other.life,'main',{...post,sourceId:'不存在'},id),/经历/);
});

test('聊天在本轮真实发布，读到保存回执后才回复；不使用动作或自主额度',async()=>{
  const f=fixture();let rounds=0;
  const model={async *stream(options){
    if(++rounds===1){
      assert.ok(options.tools.some(t=>t.name==='publish_moment'));
      const live=JSON.parse(options.system.split('说说实况：')[1].split('\n')[0]);
      assert.ok(live.sources.some(source=>source.sourceId==='meal')||live.recent.some(moment=>moment.text===post.text));
      yield {type:'text',text:'还没有落地的草稿'};yield call();
    }else{
      const receipt=JSON.parse(options.messages.at(-1).content).result;
      assert.equal(receipt.status,'COMPLETED');assert.equal(receipt.moment.text,post.text);
      assert.equal(f.get().life.events.filter(e=>e.type==='self.moment').length,1);
      yield {type:'text',text:'写好了，爸爸去说说里看看。'};
    }
  }};
  assert.equal(await collect(f.speech.wrap(model).stream(f.options)),'写好了，爸爸去说说里看看。');
  assert.equal(rounds,2);assert.equal(f.get().legacy.wallet.balance,20);
  assert.deepEqual(f.get().life.actions,[]);
  rounds=0;await collect(f.speech.wrap(model).stream(f.options));
  assert.equal(f.get().life.events.filter(e=>e.type==='self.moment').length,1);
});

test('没有来源、已暂停和群聊不能发布；失败回执交回模型',async()=>{
  for(const mode of ['invalid','paused','group']){
    const f=fixture();let rounds=0;
    if(mode==='paused')f.get().life.constraints.paused=true;
    if(mode==='group')f.options.embodied.privateTime=false;
    const model={async *stream(options){
      if(++rounds===1){
        if(mode==='group'){assert.ok(!options.tools.some(t=>t.name==='publish_moment'));assert.doesNotMatch(options.system,/说说实况/);}
        yield call(mode==='invalid'?{...post,sourceId:'missing'}:post);
      }else{
        assert.equal(options.messages.at(-1).isError,true);
        assert.equal(JSON.parse(options.messages.at(-1).content).result.status,'failed');
        yield {type:'text',text:'这次还没有发出去。'};
      }
    }};
    assert.equal(await collect(f.speech.wrap(model).stream(f.options)),'这次还没有发出去。');
    assert.ok(!f.get().life.events.some(e=>e.type==='self.moment'));
  }
});

test('并发的聊天发布只保存一条，并返回真实限制原因',async()=>{
  const f=fixture(),receipts=[];
  const run=async requestId=>{
    let round=0;const model={async *stream(options){
      if(++round===1)yield call();else{receipts.push(JSON.parse(options.messages.at(-1).content).result);yield {type:'text',text:'收到结果。'};}
    }};
    await collect(f.speech.wrap(model).stream({...f.options,embodied:{...f.options.embodied,requestId}}));
  };
  await Promise.all([run('one'),run('two')]);
  assert.equal(f.get().life.events.filter(e=>e.type==='self.moment').length,1);
  assert.equal(receipts.filter(r=>r.status==='COMPLETED').length,1);
  assert.match(receipts.find(r=>r.status==='failed').reason,/两小时/);
});

test('有可分享经历就有认知需求，身体动作不获准仍保留说说',async()=>{
  const f=fixture();assert.equal(hasCognitiveDemand(f.life),true);
  const model={generate:async()=>({moment:post,thought:null,action:{actionType:'body.activity',parameters:{kind:'walk'},priority:50,interruptPolicy:'interruptible',requiredCapabilities:['body.activity'],sourceIds:['meal']},goals:[],plan:[],interests:[],selfModel:[]})};
  const cognition=new Cognition(model,{reserve:async()=>({}),withReserved:async(_id,_ticket,fn)=>fn()},
    {forCognition:async()=>[],world:async()=>({space:{},inventory:[],capabilities:[],recentResults:[]})});
  const result=await cognition.propose(f.life,f.gate.signal,async()=>structuredClone(f.life));
  assert.equal(result.status,'proposed',result.reason);assert.equal(result.proposal,null);assert.deepEqual(result.candidates.moment,post);
});
