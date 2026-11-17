import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DurableCognitiveBudget} from '../dist/host/cognitive-budget.js';
import {createModelFacade} from '../dist/host/model-facade.js';
import {createInitialState} from '../dist/kernel/index.js';
import {ensureSpirit} from '../dist/kernel/spirit.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {projectLegacySnapshot} from '../dist/host/legacy-snapshot.js';
function fixture(){
 const state=createInitialState('main',new Date().toISOString());state.constraints.paused=false;
 const {petId,version,body,emotions,...life}=state;
 const d={petId,version,life,humanity:{stats:{satiety:50},sleeping:false},legacy:{config:{learning:{dailyModelCalls:5}},usage:{}}};ensureSpirit(d.life);
 let chain=Promise.resolve();const gate={signal:new AbortController().signal,run(_id,fn){const next=chain.then(fn);chain=next.catch(()=>{});return next;}};
 const store={load:async()=>({...structuredClone(d.life),petId,version:d.version,body,emotions}),loadEnvelope:async()=>structuredClone(d)};
 const uow={apply:async(_id,v,fn)=>{assert.equal(v,d.version);const next=structuredClone(d);fn(next);next.version++;Object.assign(d,next);}};
 return {d,gate,budget:new DurableCognitiveBudget(store,uow,gate)};
}
const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function facade(f,baseURL){return createModelFacade({version:1,providers:{test:{api:'openai-completions',baseURL,apiKey:'test',models:['test']}},defaultSelection:{provider:'test',model:'test'}},{leaseSignal:f.gate.signal,budget:f.budget});}
const consume=async(stream)=>{for await(const _ of stream){}};
async function server(t,status=200){let requests=0;const s=http.createServer((req,res)=>{requests++;req.resume();if(status!==200){res.writeHead(status);res.end('{}');return;}res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n');});await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));return {url:`http://127.0.0.1:${s.address().port}`,requests:()=>requests};}
test('预检和无效请求不会扣额度，真实请求只扣一次并记录用途',async t=>{
 const f=fixture(),s=await server(t),m=facade(f,s.url),ticket=await f.budget.reserve('main');assert.ok(ticket);assert.equal(f.d.legacy.usage[day()],undefined);
 await assert.rejects(f.budget.withReserved('main',ticket,()=>consume(m.llm.stream({provider:'test',model:'test',messages:[]}))));
 assert.equal(s.requests(),0);assert.equal(f.d.legacy.usage[day()],undefined);
 const second=await f.budget.reserve('main');await f.budget.withReserved('main',second,()=>consume(m.llm.stream({provider:'test',model:'test',messages:[{role:'user',content:'hi'}]})));
 const u=f.d.legacy.usage[day()];assert.equal(s.requests(),1);assert.equal(u.totalCalls,1);assert.equal(u.modelCalls,1);assert.equal(u.callDetails.length,1);assert.equal(u.callDetails[0].purpose,'自主思考');assert.equal(u.callDetails[0].status,'completed');
});
test('已发出的失败请求计入并标记失败，未发出时取消不扣次数',async t=>{
 const f=fixture(),s=await server(t,500),m=facade(f,s.url),args={provider:'test',model:'test',messages:[{role:'user',content:'hi'}]};
 await assert.rejects(f.budget.runAs('main','needs',()=>consume(m.llm.stream(args))));assert.equal(s.requests(),1);assert.equal(f.d.legacy.usage[day()].callDetails[0].status,'failed');
 const c=new AbortController();c.abort();await assert.rejects(f.budget.runAs('main','needs',()=>consume(m.llm.stream({...args,signal:c.signal}))));assert.equal(f.d.legacy.usage[day()].totalCalls,1);
});
test('网络派发前取消可补偿已预留次数，恢复精神并且保留其他调用',async()=>{
 const f=fixture(),before=f.d.life.spirit.value;const release=await f.budget.runAs('main','autonomous',()=>f.budget.reserve('test','test',f.gate.signal));assert.equal(f.d.legacy.usage[day()].totalCalls,1);await release('not-sent');await release('not-sent');assert.equal(f.d.legacy.usage[day()].totalCalls,0);assert.equal(f.d.legacy.usage[day()].callDetails.length,0);assert.ok(Math.abs(f.d.life.spirit.value-before)<.01);
});
test('旧版累计和新增明细分开投影',()=>{
 const f=fixture(),d=day();f.d.humanity=createHumanity();f.d.legacy.usage[d]={totalCalls:4,callDetails:[{at:new Date().toISOString(),purpose:'自主思考',status:'completed'}]};
 const learning=projectLegacySnapshot(f.d).state.learning;assert.equal(learning.used,4);assert.equal(learning.days[0].unattributed,3);assert.equal(learning.days[0].details.length,1);
});

test('连接被拒绝时未发出 HTTP 请求，不扣额度',async t=>{
 const f=fixture(),s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${s.address().port}`;await new Promise(r=>s.close(r));
 const m=facade(f,url);await assert.rejects(f.budget.runAs('main','needs',()=>consume(m.llm.stream({provider:'test',model:'test',messages:[{role:'user',content:'hi'}]}))));
 assert.equal(f.d.legacy.usage[day()].totalCalls,0);assert.equal(f.d.legacy.usage[day()].callDetails.length,0);
});
test('并发请求原子扣减，不超过主动额度',async t=>{
 const f=fixture(),s=await server(t),m=facade(f,s.url),args={provider:'test',model:'test',messages:[{role:'user',content:'hi'}]};f.d.legacy.config.learning.dailyModelCalls=3;
 const outcomes=await Promise.allSettled([1,2].map(()=>f.budget.runAs('main','needs',()=>consume(m.llm.stream(args)))));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(s.requests(),1);assert.equal(f.d.legacy.usage[day()].totalCalls,1);
});

test('精神耗尽时取消必要需求请求，不会凭空增加精神',async()=>{
 const f=fixture();f.d.life.spirit.value=0;const release=await f.budget.runAs('main','needs',()=>f.budget.reserve('test','test',f.gate.signal));await release('not-sent');assert.equal(f.d.life.spirit.value,0);
});
test('有进行中目标时，食物需要不能耗尽自主思考额度',async()=>{
 const f=fixture();f.d.legacy.config.learning.dailyModelCalls=12;f.d.life.goals.push({id:'g',status:'active',sourceIds:['q']});
 for(let i=0;i<8;i++){const release=await f.budget.runAs('main','needs',()=>f.budget.reserve('test','test',f.gate.signal));await release('completed');}
 await assert.rejects(f.budget.runAs('main','needs',()=>f.budget.reserve('test','test',f.gate.signal)),/额度不足/);
 const release=await f.budget.runAs('main','autonomous',()=>f.budget.reserve('test','test',f.gate.signal));await release('completed');
 assert.equal(f.d.legacy.usage[day()].totalCalls,9);
 await assert.rejects(f.budget.runAs('main','needs',()=>f.budget.reserve('test','test',f.gate.signal)),/额度不足/);
 const second=await f.budget.runAs('main','autonomous',()=>f.budget.reserve('test','test',f.gate.signal));await second('completed');
 assert.equal(f.d.legacy.usage[day()].totalCalls,10);
});
