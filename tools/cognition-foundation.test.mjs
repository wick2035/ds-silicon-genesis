import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,workspace} from '../dist/kernel/index.js';
import {Cognition} from '../dist/cognition/index.js';
import {CognitiveError} from '../dist/cognition/diagnostics.js';
import {buildCognitiveContext} from '../dist/host/cognitive-context.js';
import {cognitiveSelfModel} from '../dist/host/self-model-context.js';
import {CanonicalMemoryRetrieval} from '../dist/host/memory-retrieval.js';
import {MemoryEmbedding} from '../dist/host/memory-embedding.js';
import {createModelFacade} from '../dist/host/model-facade.js';
import {createCognitionDiagnostics} from '../dist/host/cognition-diagnostics.js';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const at='2026-11-20T03:00:00.000Z',empty={action:null,goals:[],plan:[],interests:[],selfModel:[]};
const fixture=()=>{const state=createInitialState('main',at);state.constraints.paused=false;return state;};
const budget={reserve:async()=>({}),withReserved:async(_id,_ticket,fn)=>fn()};
const world=async()=>({space:{},inventory:[],capabilities:[],recentResults:[]});
const diagnostics=()=>({totalMs:0,stages:{},trimmed:{}});
const event=(id,type='conversation.user')=>({eventId:id,petId:'main',type,occurredAt:at,receivedAt:at,source:'desktop',actorId:'dad',evidenceLevel:'observed',payload:{text:'以前一起看海'}});

test('large archives preserve live facts, whole records and valid citation links',()=>{
  const s=fixture();s.events=[event('source')];
  const snap=workspace(s);snap.sourceEvents=s.events;
  snap.currentActions=[{id:'active',actionType:'body.activity',status:'DISPATCHED',parameters:{kind:'walk'},sourceIds:['source']}];
  snap.unconfirmedActions=Array.from({length:1000},(_,i)=>({id:'old:'+i,status:'UNKNOWN',sourceIds:['source']}));
  snap.recentEvents=[{...event('source'),momentSource:true}];
  snap.selfModel={preferences:Array.from({length:1000},(_,i)=>({id:'self:'+i,label:'偏好'+i,value:'喜欢看海',valid:true,sourceIds:['source'],version:i+1}))};
  snap.relevantMemories=[{id:'long',content:'完整但放不下的记忆'.repeat(2000),sourceIds:['source'],valid:true},
    {id:'fits',content:'以前一起看海',sourceIds:['source'],valid:true},
    {id:'gone',content:'来源不存在',sourceIds:['missing'],valid:true}];
  snap.activeGoals=[{id:'goal',title:'看海',sourceIds:['source'],status:'active'}];
  snap.goalReadings=[{goalId:'goal',memoryId:'long',evidenceId:'source'}];
  const d=diagnostics(),before=structuredClone(snap);
  const result=buildCognitiveContext(snap,{recall:['long','fits','gone'],rankedGoals:[{goalId:'goal',score:2},{goalId:'gone',score:1}]},{},d);
  const input=JSON.parse(result.input);
  assert.ok(result.input.length<=30000);
  assert.deepEqual(input.当前.currentActions,snap.currentActions);
  assert.deepEqual(input.当前.constraints,snap.constraints);
  assert.equal(input.当前.relevantMemories[0].content,'以前一起看海');
  assert.deepEqual(input.认知线索.recall,['fits']);assert.deepEqual(input.当前.goalReadings,[]);
  assert.equal(input.认知线索.rankedGoals.length,1);assert.equal(input.来源.source.eventId,'source');
  assert.ok(d.trimmed.memories>=2);assert.ok(d.trimmed.unconfirmedActions>0);
  assert.deepEqual(snap,before);
});

test('self projection deduplicates, expires, versions and exposes unresolved contradictions',()=>{
  const record=(id,value,extra={})=>({id,label:'喜欢的饮料',value,sourceIds:['source'],valid:true,...extra});
  const model={preferences:[record('old','喜欢白水',{version:1}),record('new','喜欢茶',{version:2,supersedes:['old']}),record('duplicate','喜欢茶',{version:3}),
    record('expired','喜欢汽水',{validUntil:'2026-01-01'}),record('future','喜欢咖啡',{validFrom:'2030-01-01'})],
    interests:[record('conflict1','想去看海'),record('conflict2','不想去看海')],
    autobiography:[record('older-evidence','和爸爸一起煮白饭',{createdAt:'2020-01-01'}),record('recent-evidence','玩耍',{createdAt:'2026-01-01'})]};
  const before=structuredClone(model),p=cognitiveSelfModel(model,[event('source')],'煮白饭',Date.parse(at));
  assert.equal(p.tendencies.find(t=>t.category==='preferences').id,'duplicate');
  assert.equal(p.tendencies.find(t=>t.category==='preferences').status,'current');
  assert.equal(p.conflicts.length,1);assert.equal(p.conflicts[0].status,'unresolved');
  assert.equal(p.evidence[0].id,'older-evidence');assert.deepEqual(model,before);
  assert.ok(!JSON.stringify(p).includes('expired'));assert.ok(!JSON.stringify(p).includes('future'));
});

test('autonomous recall uses current documents, merges queries and reaches semantics, associations and reranking',async()=>{
  const s=fixture();s.events=[event('source')];s.events[0].payload.text='常喝的饮品';
  s.goals=[{id:'g',title:'常喝的饮品',status:'active'}];
  s.memories=[{id:'tea',kind:'semantic',content:'爸爸喜欢茉莉花茶',sourceIds:['source'],valid:true,createdAt:at},
    {id:'invalid',kind:'semantic',content:'不应召回',sourceIds:['deleted'],valid:true,createdAt:at}];s.invalidSources.deleted='撤销';
  let embeds=0,ranks=0;const index={candidates:async(_v,_id,_q,signal)=>{assert.ok(signal);return null;}};
  const embedding={candidates:async(id,q,docs,signal)=>{embeds++;assert.equal(id,s.petId);assert.match(q,/饮品/);assert.ok(signal);assert.equal(docs.some(d=>d.memory?.id==='invalid'),false);return docs;}};
  const ranker={score:async(q,docs,signal)=>{ranks++;assert.ok(signal);assert.match(docs[0],/茉莉/);return docs.map(()=>.9);}};
  const d=diagnostics(),retrieval=new CanonicalMemoryRetrieval({},undefined,ranker,index,embedding);
  const found=await retrieval.forCognition(s,new AbortController().signal,d);
  assert.equal(embeds,1);assert.equal(ranks,1);assert.equal(found[0].id,'tea');assert.equal(d.recall.mode,'hybrid');
  assert.equal(retrieval.search,undefined);await assert.rejects(retrieval.searchSnapshot(undefined,'茶'),/当前状态/);
});

test('recall deadline cancels remote work and returns local evidence without waiting',async()=>{
  const s=fixture();s.events=[event('source')];s.memories=[{id:'sea',content:'以前一起看海',kind:'episodic',valid:true,sourceIds:['source'],createdAt:at}];
  let signal;const retrieval=new CanonicalMemoryRetrieval({},undefined,{score:async()=>[]},undefined,{candidates:async(_p,_q,_d,s)=>{signal=s;return new Promise(()=>{});}},20);
  const d=diagnostics(),start=performance.now();const result=await retrieval.searchSnapshot(s,'看海',8,{diagnostics:d});
  assert.ok(performance.now()-start<500);assert.equal(signal.aborted,true);assert.equal(result[0].id,'sea');
  assert.deepEqual(d.recall,{mode:'lexical',reason:'recall_timeout',queries:1});
});

test('45-second total deadline starts before retrieval; external cancellation never reaches generation',async()=>{
  for(const external of [false,true]){
    const s=fixture(),controller=new AbortController();let received,generated=false;
    const c=new Cognition({generate:async()=>{generated=true;return empty;}},budget,{world,forCognition:async(_s,signal)=>{received=signal;return new Promise(()=>{});}},30);
    const pending=c.propose(s,controller.signal,async()=>s);
    if(external)setTimeout(()=>controller.abort(),10);
    const result=await pending;assert.equal(result.reason,external?'stopped':'cognition_timeout');
    assert.equal(received.aborted,true);assert.equal(generated,false);assert.ok(result.diagnostics.totalMs<500);
  }
});

test('failure codes distinguish context, budget, auth, model timeout and invalid output',async()=>{
  for(const code of ['context_overflow','authentication_error','invalid_model_output']){
    const s=fixture(),c=new Cognition({generate:async()=>{throw new CognitiveError(code,code);}},budget,{world,forCognition:async()=>[]});
    const r=await c.propose(s,new AbortController().signal,async()=>s);assert.equal(r.reason,code);assert.ok(r.diagnostics.stages.generation>=0);
  }
  const s=fixture();
  const c=new Cognition({generate:async()=>new Promise(()=>{})},budget,{world,forCognition:async()=>[]},20);
  assert.equal((await c.propose(s,new AbortController().signal,async()=>s)).reason,'model_timeout');
  const exhausted=new Cognition({generate:async()=>empty},{...budget,reserve:async()=>null},{world,forCognition:async()=>[]});
  assert.equal((await exhausted.propose(s,new AbortController().signal,async()=>s)).reason,'budget_exhausted');
});

test('embedding cache uses model/task/text fingerprints and never caches an aborted request',async()=>{
  const controller=new AbortController(),embedding=new MemoryEmbedding({signal:controller.signal},{},{providers:{}});
  let calls=0;embedding.requestEmbeddings=async texts=>{calls++;return texts.map(()=>Array(1024).fill(.5));};
  await embedding.embed(['same','same'],'query',1000);await embedding.embed(['same'],'query',1000);
  assert.equal(calls,1);await embedding.embed(['changed'],'query',1000);await embedding.embed(['same'],'document',1000);assert.equal(calls,3);
  const stopped=new AbortController();stopped.abort();await assert.rejects(embedding.embed(['cancelled'],'query',1000,stopped.signal));assert.equal(calls,3);
});

test('transport authentication stays distinguishable and diagnostics omit model content',async t=>{
  const original=globalThis.fetch;
  const facade=createModelFacade({version:1,defaultSelection:{provider:'p',model:'m'},providers:{p:{api:'openai-completions',baseURL:'https://example.invalid/v1',apiKey:'test-secret',models:['m']}}},
    {leaseSignal:new AbortController().signal,budget:{reserve:async()=>()=>{}}});
  try{
    globalThis.fetch=async()=>new Response('{"error":{"message":"unauthorized"}}',{status:401,headers:{'content-type':'application/json'}});
    await assert.rejects(async()=>{for await(const _ of facade.llm.stream({provider:'p',model:'m',messages:[{role:'user',content:'hello'}]})){}},e=>e.code==='authentication_error');
  }finally{globalThis.fetch=original;facade.dispose();}
  const dir=await mkdtemp(join(tmpdir(),'cognition-diagnostics-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const writer=createCognitionDiagnostics(dir);
  await writer.record({status:'proposed',sourceVersion:1,proposal:null,candidates:{...empty,thought:{text:'private-memory'}},diagnostics:{...diagnostics(),inputChars:29988}});
  await writer.flush();const files=await readdir(dir);assert.equal(files.length,1);
  const text=await readFile(join(dir,files[0]),'utf8');assert.doesNotMatch(text,/private-memory|test-secret/);
  assert.equal(JSON.parse(text).diagnostics.inputChars,29988);
});
