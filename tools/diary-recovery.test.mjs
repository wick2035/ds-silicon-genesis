import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevelopment} from '../dist/host/development.js';
import {createModelFacade} from '../dist/host/model-facade.js';

test('失败的日记可手动重试，成功后只结算一次',async()=>{
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  let state={petId:'main',version:0,legacy:{config:{diaryEnabled:true,costs:{diary:10}},wallet:{balance:100,frozen:false},diaries:{},deletedDays:[]},life:{events:[{eventId:'e1',type:'care',occurredAt:date+'T00:00:00.000Z',evidenceLevel:'observed',payload:{}}],memories:[],invalidSources:{},constraints:{paused:false}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},store={loadEnvelope:async()=>structuredClone(state)},uow={apply:async(_id,version,edit)=>{assert.equal(state.version,version);const draft=structuredClone(state);edit(draft);draft.version++;state=draft;}},budget={runAs:async(_id,_kind,fn)=>fn()};
  let attempts=0;const model={agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},llm:{stream:async function*(input){assert.equal(input.maxTokens,4096);assert.equal(input.reasoningEffort,'low');attempts++;if(attempts===1)throw Error('模型连接失败');yield {type:'text',text:'```json\n'+JSON.stringify({text:'今天一起度过了平静的一天。',sources:['e1']})+'\n```'};}}};
  const dev=createDevelopment(store,gate,uow,budget,model);
  await assert.rejects(dev.task('main','diary',gate.signal,true,date),/模型连接失败/);
  assert.equal(state.legacy.developmentClaims['diary:'+date].status,'failed');assert.equal(state.legacy.wallet.balance,100);
  assert.equal(await dev.task('main','diary',gate.signal,false,date),false);
  assert.equal(await dev.task('main','diary',gate.signal,true,date),true);
  assert.equal(state.legacy.diaries[date].text,'今天一起度过了平静的一天。');assert.equal(state.legacy.wallet.balance,90);
  assert.equal(await dev.task('main','diary',gate.signal,true,date),false);assert.equal(attempts,2);
});

test('独占宿主启动恢复中断的整理领取，仍须手动重试且不扣费',async()=>{
  let state={petId:'main',version:0,legacy:{wallet:{balance:100},developmentClaims:{'diary:2026-11-20':{status:'running'},'reflection:2026-11-19':{status:'completed'}}},life:{}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},store={loadEnvelope:async()=>structuredClone(state)},uow={apply:async(_id,version,edit)=>{assert.equal(version,state.version);const draft=structuredClone(state);edit(draft);draft.version++;state=draft;}};
  const dev=createDevelopment(store,gate,uow,{},{});await dev.recoverInterrupted('main');
  assert.equal(state.legacy.developmentClaims['diary:2026-11-20'].status,'failed');assert.equal(state.legacy.developmentClaims['reflection:2026-11-19'].status,'completed');assert.equal(state.legacy.wallet.balance,100);
  await dev.recoverInterrupted('main');assert.equal(state.version,1);
});

test('百炼 DeepSeek 低延迟模式同时关闭隐式思考',async()=>{
  const original=globalThis.fetch;let body;
  try{
    globalThis.fetch=async(_url,init)=>{body=JSON.parse(init.body);return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'完成'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}})};
    const model=createModelFacade({version:1,defaultSelection:{provider:'p',model:'deepseek-v4.1-flash-1017'},providers:{p:{api:'openai-completions',baseURL:'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',apiKey:'test-key',models:['deepseek-v4.1-flash-1017']}}},{leaseSignal:new AbortController().signal,budget:{reserve:async()=>()=>{}}});
    for await(const _part of model.llm.stream({provider:'p',model:'deepseek-v4.1-flash-1017',messages:[{role:'user',content:'test'}],reasoningEffort:'low'})){}
    assert.equal(body.reasoning_effort,'low');assert.equal(body.enable_thinking,false);model.dispose();
  }finally{globalThis.fetch=original;}
});

test('模型认证失败与输出截断给出可操作的错误，不泄露服务响应',async()=>{
  const original=globalThis.fetch,config={version:1,defaultSelection:{provider:'p',model:'reasoner'},providers:{p:{api:'openai-completions',baseURL:'https://example.invalid/v1',apiKey:'private-key',models:['reasoner']}}},options={leaseSignal:new AbortController().signal,budget:{reserve:async()=>()=>{}}};
  try{
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'private-key',type:'auth'}}),{status:401,headers:{'content-type':'application/json'}});
    let model=createModelFacade(config,options);const auth=await model.testConnection();assert.equal(auth.ok,false);assert.match(auth.message,/认证失败/);assert.ok(!auth.message.includes('private-key'));model.dispose();
    globalThis.fetch=async()=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'部分'},finish_reason:'length'}]})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
    model=createModelFacade(config,options);const truncated=await model.testConnection();assert.equal(truncated.ok,false);assert.match(truncated.message,/截断/);model.dispose();
    globalThis.fetch=async()=>new Response(JSON.stringify({data:[{id:'reasoner'},{id:'available-model'}]}),{status:200,headers:{'content-type':'application/json'}});
    model=createModelFacade(config,options);const models=await model.discoverModels();assert.equal(models.ok,true);assert.deepEqual(models.models.map(x=>x.id),['reasoner','available-model']);model.dispose();
  }finally{globalThis.fetch=original;}
});
