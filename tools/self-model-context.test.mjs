import test from 'node:test';
import assert from 'node:assert/strict';
import {selfModelContext,STABLE_PERSONALITY} from '../dist/host/self-model-context.js';
import {promptData} from '../dist/host/prompt-data.js';
import {createEmbodiedSpeech} from '../dist/host/embodied-speech.js';
import {createModelFacade} from '../dist/host/model-facade.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';

const categories=['personality','preferences','abilities','limitations','values','interests','habits','autobiography'];
function archive(){return Object.fromEntries(categories.map(category=>[category,Array.from({length:500},(_,i)=>({id:category+i,label:category,value:'成长经历'.repeat(100),valid:true,sourceIds:['source']}))]));}

test('自我认识按类别读取近期有效摘要，完整历史保持原样',()=>{
  const state={selfModel:archive(),invalidSources:{sourceBad:'撤销'}};
  state.selfModel.preferences.push({id:'invalid',label:'失效',value:'不应出现',valid:false,sourceIds:['source']},{id:'revoked',label:'撤销',value:'不应出现',valid:true,sourceIds:['sourceBad']});
  const original=structuredClone(state),context=selfModelContext(state);
  assert.ok(JSON.stringify(context).length<6000);
  for(const category of categories){assert.ok(context[category].length>0);assert.ok(context[category].length<=2);assert.equal(context[category].at(-1).id,category+'499');}
  assert.deepEqual(state,original);
});

test('本地话题匹配能找回很久以前的经历，核心性格始终保留',()=>{
  const selfModel=archive();
  selfModel.autobiography.unshift({id:'old-rice',label:'共同经历',value:'爸爸以前带本鱼煮白饭。',valid:true,sourceIds:['old-source']});
  const context=selfModelContext({selfModel,invalidSources:{}},'以前煮白饭');
  assert.ok(context.autobiography.some(r=>r.id==='old-rice'));
  for(const trait of ['本鱼','贪吃','白饭','傲娇','撒娇','撒泼','嘴硬心软'])assert.ok(STABLE_PERSONALITY.includes(trait));
});

test('动态资料预算产生完整 JSON，长记录不会把输入撑破',()=>{
  const value={traits:Array.from({length:100},()=>({text:'经历'.repeat(2000)})),wallet:{balance:30,frozen:false}};
  const result=promptData(value,1600);assert.ok(result.length<=1600);assert.deepEqual(JSON.parse(result).wallet,value.wallet);
});

test('大型成长存档能通过真实模型输入校验，sense_self 续轮也可完成',async()=>{
  const life={selfModel:archive(),events:[],invalidSources:{},actions:[],receipts:[],goals:[],constraints:{capabilities:[],permissions:[]}};
  const envelope={petId:'main',version:0,life,legacy:{},humanity:createHumanity(Date.now())};
  assert.ok(JSON.stringify(life.selfModel).length>32768);
  const original=globalThis.fetch;let requests=0;
  const gate={signal:new AbortController().signal};
  const facade=createModelFacade({version:1,defaultSelection:{provider:'p',model:'m'},providers:{p:{api:'openai-completions',baseURL:'https://example.invalid/v1',apiKey:'test',models:['m']}}},{leaseSignal:gate.signal,budget:{reserve:async()=>()=>{}}});
  try{
    globalThis.fetch=async(_url,init)=>{
      const body=JSON.parse(init.body);assert.ok(body.messages[0].content.length<=32768);assert.ok(body.messages[0].content.includes(STABLE_PERSONALITY));requests++;
      const delta=requests===1?{tool_calls:[{index:0,id:'sense-1',type:'function',function:{name:'sense_self',arguments:'{}'}}]}:{content:'爸爸，我在呢。'};
      return new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:requests===1?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    };
    const speech=createEmbodiedSpeech({loadEnvelope:async()=>structuredClone(envelope)},gate,{}, {}, {},async()=>{},async()=>{}).wrap(facade.llm);
    let text='';
    for await(const part of speech.stream({provider:'p',model:'m',system:'角色设定。'.repeat(2000),messages:[{role:'user',content:'你好'}],embodied:{petId:'main',requestId:'large-archive',sourceIds:[],allowActions:false}}))if(part.type==='text')text+=part.text;
    assert.equal(text,'爸爸，我在呢。');assert.equal(requests,2);
  }finally{facade.dispose();globalThis.fetch=original;}
});


test('dynamic prompt compression preserves complete resource ids and source ids',()=>{
 const id='rice:speech-action:'+ 'f'.repeat(64),source='chat-user:'+'a'.repeat(64);
 const data=JSON.parse(promptData({inventory:[{id,name:'饭'.repeat(1000),status:'available'}],itemId:id,sourceIds:[source],description:'历史'.repeat(2000)},700));
 assert.equal(data.inventory[0].id,id);assert.equal(data.itemId,id);assert.equal(data.sourceIds[0],source);
});
