import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,invalidateDependents} from '../dist/kernel/index.js';
import {Cognition} from '../dist/cognition/index.js';
import {createExplorationExecutor} from '../dist/host/network-services.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {CanonicalMemoryRetrieval} from '../dist/host/memory-retrieval.js';
import {conversationContext} from '../dist/host/conversation-context.js';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {createCognitiveModel} from '../dist/host/cognitive-model.js';
import {workspace} from '../dist/kernel/index.js';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';

test('长期记忆增长时认知输入仍可发送，并保留近期问题',async()=>{
  const state=createInitialState('main','2026-11-14T05:16:28.000Z'),snapshot=workspace(state);
  snapshot.recentEvents=[{eventId:'question',type:'conversation.user',occurredAt:'2026-11-14T05:16:28.000Z',evidenceLevel:'observed',payload:'什么是被遗弃'}];
  snapshot.relevantMemories=Array.from({length:20},(_,i)=>({id:'m'+i,kind:'semantic',content:'记忆'.repeat(1500),sourceIds:['question'],evidenceLevel:'reported',valid:true,createdAt:'2026-11-14T05:16:28.000Z'}));
  let sent;const llm={stream:async function*(request){sent=request.messages[0].content;yield {type:'text',text:'{"action":null,"goals":[],"plan":[],"interests":[],"selfModel":[]}'};}};
  await createCognitiveModel(llm,()=>({provider:'test',model:'test'})).generate(snapshot,new AbortController().signal,{observation:[],recall:[],appraisal:[],motivations:[],rankedGoals:[]});
  assert.ok(sent.length<=30000);assert.equal(JSON.parse(sent).当前.recentEvents[0].eventId,'question');assert.equal(snapshot.relevantMemories.length,20);
});

test('探索跳过空壳和失效页面，只把实际可阅读的内容作为结果',async()=>{
  const intent={id:'exploration-test',type:'learning.observe',payload:{parameters:{kind:'search',query:'被遗弃是什么意思'}}};
  const seen=[];
  const web={search:async()=>({sources:['shell','missing','article'].map(id=>({url:'https://example.org/'+id}))}),fetch:async({url})=>{seen.push(url);if(url.endsWith('shell'))return {url,content:'搜索助手'};if(url.endsWith('missing'))return {url,content:'404 页面不存在 '+ '广告'.repeat(100)};return {url,content:'遗弃是指原本有照顾责任的人放弃照顾。'.repeat(12)};}};
  const result=await createExplorationExecutor(web,{} )('main',intent,new AbortController().signal);
  assert.equal(result.status,'completed');assert.equal(result.evidence.documentUrl,'https://example.org/article');assert.equal(seen.length,3);
  const failure=await createExplorationExecutor({...web,search:async()=>({sources:[{url:'https://example.org/shell'}]})},{} )('main',intent,new AbortController().signal);
  assert.equal(failure.status,'failed');
});

const at='2026-11-14T05:16:28.000Z';
const event=(id,type,text)=>({eventId:id,petId:'main',type,source:'desktop',actorId:'dad',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{text}});

test('对话问题不会被账本挤掉，真实阅读回执可召回并随来源删除失效',async()=>{
  const state=createInitialState('main',at);
  state.constraints={paused:false,permissions:['network'],remainingBudget:2,capabilities:[{name:'learning.observe',enabled:true,requiresPermission:'network'}]};
  state.events.push(event('question','conversation.user','你可以看看什么是被遗弃了'));
  for(let i=0;i<16;i++)state.events.push(event('bookkeeping:'+i,'wallet.spend',''));
  const budget={reserve:async()=>({}),withReserved:async(_id,_ticket,fn)=>fn()};
  const retrieval={forCognition:async()=>[],world:async()=>({space:{},inventory:[],capabilities:state.constraints.capabilities,recentResults:[]})};
  let prompt;
  const model={generate:async snapshot=>{prompt=snapshot;return {action:{actionType:'learning.observe',parameters:{kind:'search',query:'什么是被遗弃'},priority:50,interruptPolicy:'interruptible',requiredCapabilities:['learning.observe'],sourceIds:['question']},goals:[],plan:[],interests:[],selfModel:[]};}};
  const result=await new Cognition(model,budget,retrieval).propose(state,new AbortController().signal,async()=>structuredClone(state));
  assert.equal(result.status,'proposed');assert.ok(prompt.recentEvents.some(e=>e.eventId==='question'));
  const proposal=result.proposal;
  const intent={id:proposal.id,type:proposal.actionType,payload:{actionId:proposal.id,petId:'main',actionType:proposal.actionType,parameters:proposal.parameters}};
  const draft={petId:'main',version:0,legacy:{wallet:{balance:0},explorationCharges:{[proposal.id]:{amount:0,status:'reserved'}}},humanity:{},life:state};
  state.actions.push({...proposal,status:'DISPATCHED',createdAt:at,updatedAt:at});
  const executor=createExplorationExecutor({search:async()=>({sources:[{url:'https://example.org/page'}]}),fetch:async()=>({url:'https://example.org/page',content:'离开后不再照料。'.repeat(15)})},{});
  const receipt=await executor('main',intent,new AbortController().signal);
  new CanonicalActionLifecycle(()=>({body:state.body,emotions:state.emotions}),()=>new Date(at)).complete(draft,intent,receipt);
  assert.equal(state.actions[0].status,'COMPLETED');
  assert.match(state.memories[0].content,/探索问题：什么是被遗弃/);
  assert.deepEqual(state.memories[0].sourceIds,[`action-result:${proposal.id}`,'question']);
  let terms;
  const search=new CanonicalMemoryRetrieval({query:async(_sql,args)=>{terms=args[1];return {rows:state.memories.filter(m=>terms.some(t=>m.content.includes(t))).map(m=>({m}))};}});
  const memories=await search.search('main','被遗弃');
  assert.equal(memories.length,1);assert.ok(terms.includes('遗弃'));
  state.invalidSources.question='删除聊天';invalidateDependents(state);
  assert.equal(state.memories[0].valid,false);
});

test('未完成的饭和探索只作为未确认状态，失败不生成学习记忆',async()=>{
  const state=createInitialState('main',at);
  state.actions=[{id:'eat',actionType:'service.eat-rice',status:'DISPATCHED',parameters:{},sourceIds:[],updatedAt:at},
    {id:'search',actionType:'learning.observe',status:'FAILED',parameters:{query:'鲸鱼'},sourceIds:[],updatedAt:at,receiptId:'r'}];
  state.receipts=[{receiptId:'r',actionId:'search',status:'FAILED',occurredAt:at,details:{reason:'资料获取失败'}}];
  state.events.push({...event('result','action.receipt',''),causationId:'r'});
  const envelope={legacy:{wallet:{balance:3,frozen:false},config:{networkLearning:true,costs:{feed:200},exploration:{dailyRuns:1}},abilities:{search:{status:'granted'},fetch:{status:'granted'}},services:{inventory:[{name:'大白饭',status:'available'}]}}};
  const context=conversationContext(state,envelope);
  assert.equal(context.actions[0].status,'DISPATCHED');assert.equal(context.actions[1].status,'FAILED');
  assert.equal(context.actions[1].reason,'资料获取失败');assert.equal(context.food.inventory[0].name,'大白饭');
  assert.equal(context.phone.open,true);assert.equal(state.memories.length,0);
  state.invalidSources.result='删除回执';
  assert.equal(conversationContext(state,envelope).actions[1].status,'UNCONFIRMED');
});

test('后续聊天同时检索前一个问题并向模型提供已提交的生活状态',async()=>{
  const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
  const life=createInitialState('main',at);life.legacyContext={personaDescription:'大肥鱼',skills:[],strategies:[],attempts:[]};
  life.events.push(event('question','conversation.user','什么是被遗弃'));life.memories.push({id:'knowledge',kind:'semantic',content:'探索问题：什么是被遗弃',sourceIds:['question'],evidenceLevel:'observed',valid:true,createdAt:at});
  let envelope={petId:'main',version:0,legacy:old.read('main'),humanity:{},life};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(envelope),load:async()=>({...structuredClone(envelope.life),version:envelope.version})};
  const uow={apply:async(_id,version,change)=>{assert.equal(version,envelope.version);const draft=structuredClone(envelope);change(draft);draft.version++;envelope=draft;}};
  let system,query;
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(options){system=options.system;yield {type:'text',text:'我还在想那件事。'};}}};
  const chat=new CanonicalChat(store,gate,uow,{runAs:async(_id,_kind,fn)=>fn()},model,async(_id,q)=>{query=q;return life.memories;});
  await chat.turn({requestId:'follow-up',petId:'main',channel:'desktop',actorId:'dad',text:'你后来知道了吗'},new AbortController().signal);
  assert.match(query,/什么是被遗弃/);assert.match(system,/探索问题：什么是被遗弃/);
  assert.match(system,/生活事实与近期行动/);assert.match(system,/派发或等待不等于完成/);
  assert.match(system,/账户的管理权限和你生活中的人物关系是两回事/);
});
