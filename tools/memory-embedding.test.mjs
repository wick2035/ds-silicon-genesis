import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryEmbedding,vectorBuckets,cosine,contentHash} from '../dist/host/memory-embedding.js';
import {CanonicalMemoryRetrieval} from '../dist/host/memory-retrieval.js';
import {createInitialState} from '../dist/kernel/index.js';

const v=(index)=>Array.from({length:1024},(_,i)=>i===index?1:0);
test('向量桶稳定，同一向量相似度为一',()=>{
  assert.deepEqual(vectorBuckets(v(1)),vectorBuckets(v(1)));assert.equal(vectorBuckets(v(1)).length,16);
  assert.equal(cosine(v(1),v(1)),1);assert.equal(cosine(v(1),v(2)),0);assert.equal(vectorBuckets([1]).length,0);
});
test('百炼调用使用正确模型、任务类型和响应序号，不输出密钥',async()=>{
  const controller=new AbortController(),lease={signal:controller.signal},store={};
  const embedding=new MemoryEmbedding(lease,store,{providers:{test:{baseURL:'https://work.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',apiKey:'test-key'}}});
  const saved=globalThis.fetch;let body;
  globalThis.fetch=async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({output:{embeddings:[{index:1,embedding:v(2)},{index:0,embedding:v(1)}]}}),{status:200});};
  try{const result=await embedding.embed(['第一句','第二句'],'query',1000);assert.equal(result[0][1],1);assert.equal(result[1][2],1);assert.equal(body.model,'qwen3.7-text-embedding-flash');assert.equal(body.parameters.text_type,'query');assert.equal(body.parameters.dimension,1024);}finally{globalThis.fetch=saved;controller.abort();}
});
test('语义召回会过滤已纠正或来源失效的旧向量',async()=>{
  const controller=new AbortController(),docs=[{id:'memory:1',content:'新的事情',sourceIds:['a'],terms:[]}];
  const lease={signal:controller.signal,query:async()=>({rows:[{document_id:'memory:1',content_hash:contentHash('旧的事情'),embedding:v(1)},{document_id:'deleted',content_hash:contentHash('已删除'),embedding:v(1)}]})};
  const embedding=new MemoryEmbedding(lease,{}, {providers:{test:{baseURL:'https://work.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',apiKey:'test-key'}}});
  embedding.embed=async()=>[v(1)];
  assert.deepEqual(await embedding.candidates('main','问题',docs),[]);controller.abort();
});
test('无关键词重合时语义候选仍可进入本地重排，失败时关键词回退',async()=>{
  const state=createInitialState('main','2026-01-01T00:00:00Z');
  state.memories.push({id:'a',kind:'semantic',content:'爸爸喜欢茉莉花茶',valid:true,sourceIds:[],evidenceLevel:'reported',createdAt:'2026-01-01T00:00:00Z'});
  const scored=[],reranker={score:async(_q,docs)=>{scored.push(...docs);return docs.map(()=>.9)}};
  const embedding={candidates:async(_p,_q,docs)=>docs},retrieval=new CanonicalMemoryRetrieval({},undefined,reranker,undefined,embedding);
  assert.equal((await retrieval.search('main','常喝的饮品',8,state))[0].id,'a');assert.match(scored[0],/茉莉/);
  const fallback=new CanonicalMemoryRetrieval({},undefined,{score:async()=>null},undefined,{candidates:async()=>[]});
  assert.equal((await fallback.search('main','茉莉花茶',8,state))[0].id,'a');
});
test('低相关重排结果不会被当成可用记忆',async()=>{
  const state=createInitialState('main','2026-01-01T00:00:00Z');
  state.memories.push({id:'a',kind:'semantic',content:'爸爸喜欢茉莉花茶',valid:true,sourceIds:[],evidenceLevel:'reported',createdAt:'2026-01-01T00:00:00Z'});
  const retrieval=new CanonicalMemoryRetrieval({},undefined,{score:async()=>[.0001]},undefined,{candidates:async(_p,_q,docs)=>docs});
  assert.deepEqual(await retrieval.search('main','火星火山',8,state),[]);
});

test('并行启动语义检索，并等待语义候选和重排结果',async()=>{
  const state=createInitialState('main','2026-01-01T00:00:00Z');
  state.memories.push({id:'a',kind:'semantic',content:'爸爸喜欢茉莉花茶',valid:true,sourceIds:[],evidenceLevel:'reported',createdAt:'2026-01-01T00:00:00Z'});
  let releaseIndex,releaseSemantic,releaseRank,semanticStarted=false,rankStarted=false,finished=false;
  const index={candidates:()=>new Promise(resolve=>{releaseIndex=()=>resolve(null);})};
  const embedding={candidates:async(_p,_q,docs)=>{semanticStarted=true;await new Promise(resolve=>{releaseSemantic=resolve;});return docs;}};
  const reranker={score:async(_q,docs)=>{rankStarted=true;await new Promise(resolve=>{releaseRank=resolve;});return docs.map(()=>.9);}};
  const retrieval=new CanonicalMemoryRetrieval({},undefined,reranker,index,embedding);
  const result=retrieval.search('main','常喝的饮品',8,state).then(value=>{finished=true;return value;});
  assert.equal(semanticStarted,true);releaseIndex();await new Promise(setImmediate);
  assert.equal(finished,false);releaseSemantic();await new Promise(setImmediate);
  assert.equal(rankStarted,true);assert.equal(finished,false);releaseRank();
  assert.equal((await result)[0].id,'a');
});
