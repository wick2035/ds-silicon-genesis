import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {LegacyDomain} from '../dist/host/legacy-domain.js';
import {CanonicalHumanityAdapter} from '../dist/host/humanity-adapter.js';
import {createLegacyRequestAdapter} from '../dist/host/legacy-request-adapter.js';
import {createCompanionManagement} from '../dist/host/companion-management.js';
import {createLifeApi,createLifeManagement} from '../dist/host/life-api.js';

function fixture(){
  const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
  let state={petId:'main',version:0,legacy:old.read('main'),humanity:createHumanity(),life:{events:[],invalidSources:{},memories:[],beliefs:[],observations:[],relationships:[],constraints:{permissions:[]}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(state)},uow={apply:async(_id,version,change)=>{assert.equal(version,state.version);const draft=structuredClone(state);change(draft);draft.version++;state=draft;return draft;}};
  const domain=new LegacyDomain(store,uow,gate,{}),humanity=new CanonicalHumanityAdapter(store,uow,gate,{},{});
  const adapter=createLegacyRequestAdapter({store,gate,domain,humanity,resolvePet:()=>({petId:'main',name:'测试'})});
  const companion=createCompanionManagement(adapter,domain,()=>{},store.loadEnvelope);
  const api=createLifeApi({authorize:()=>true,petId:()=> 'main',getState:async()=>{throw Error('unexpected');},companion});
  const post=async input=>{const response=await api(new Request('http://localhost/api/life/companion',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:randomUUID(),...input})}));return {status:response.status,...await response.json()}};
  return {post,companion,state:()=>state,store,gate,uow};
}

test('联网开关与分项能力同时控制权威联网权限',async()=>{
  const f=fixture();assert.equal((await f.post({operation:'network',enabled:true})).status,200);
  assert.equal((await f.post({operation:'ability',ability:'search',action:'grant'})).status,200);
  assert.ok(f.state().life.constraints.permissions.includes('network'));
  assert.equal((await f.post({operation:'network',enabled:false})).status,200);
  assert.ok(!f.state().life.constraints.permissions.includes('network'));
  assert.equal((await f.post({operation:'config',intelligence:75})).status,200);
  assert.ok(!f.state().life.constraints.permissions.includes('network'));
});
test('探索和搜索设置接受新上限并拒绝超限值',async()=>{
  const f=fixture();
  assert.equal((await f.post({operation:'config',exploration:{dailyRuns:10,dailySearches:20}})).status,200);
  assert.equal(f.state().legacy.config.exploration.dailyRuns,10);
  assert.equal(f.state().legacy.config.exploration.dailySearches,20);
  assert.equal((await f.post({operation:'config',exploration:{dailyRuns:11}})).status,409);
  assert.equal((await f.post({operation:'config',exploration:{dailySearches:21}})).status,409);
  assert.equal(f.state().legacy.config.exploration.dailySearches,20);
});
test('身体调整的冲突和照料拒绝会返回失败，不伪装成成功',async()=>{
  const f=fixture(),revision=f.state().humanity.adjustmentRevision||0;
  assert.equal((await f.post({operation:'adjust',stats:{pain:25},expectedRevision:revision})).status,200);
  assert.equal((await f.post({operation:'adjust',stats:{pain:30},expectedRevision:revision})).status,409);
  assert.equal((await f.post({operation:'care',action:'not-real'})).status,409);
  assert.equal((await f.post({operation:'job',kind:'help'})).status,409);
});
test('照料从一次已提交读取生成页面，无需调用写入接口',async()=>{
  const f=fixture();
  let reads=0;
  const manager=createCompanionManagement(()=>assert.fail('unexpected adapter call'),undefined,()=>{},async id=>{
    reads++;
    return f.store.loadEnvelope(id);
  });
  const page=await manager.read('main',f.gate.signal);
  assert.equal(reads,1);
  assert.equal(page.body.stats.pain,f.state().humanity.stats.pain);
  assert.equal(page.config.intelligence,f.state().legacy.config.intelligence);
  assert.equal(page.diaryRevisionGuard,true);
});
test('日记编辑有并发检查，未知接口与无效请求被拒绝',async()=>{
  const f=fixture();f.state().legacy.diaries['2026-01-01']={text:'原文'};
  assert.equal((await f.post({operation:'diary',action:'edit',date:'2026-01-01',text:'新内容',expectedText:'原文'})).status,200);
  const stale=await f.post({operation:'diary',action:'delete',date:'2026-01-01',expectedText:'原文'});assert.equal(stale.status,409);assert.match(stale.error,/已变化/);
  const long=await f.post({operation:'diary',action:'edit',date:'2026-01-01',text:'很长的日记'.repeat(900),expectedRevision:1});assert.equal(long.status,200,long.error);
  assert.equal((await f.post({operation:'diary',action:'delete',date:'2026-01-01',expectedRevision:1})).status,409);
  assert.equal((await f.post({operation:'wallet',action:'add',amount:100})).status,409);
  assert.equal((await f.post({operation:'memory',action:'add',text:'记忆',requestId:'short'})).status,409);
});
test('新增记忆同时进入成长页面使用的权威记忆与来源记录',async()=>{
  const f=fixture();assert.equal((await f.post({operation:'memory',action:'add',text:'记得一起看星星'})).status,200);
  const memory=f.state().life.memories.find(m=>m.content==='记得一起看星星');assert.ok(memory?.valid);
  assert.ok(memory.sourceIds.every(id=>f.state().life.events.some(e=>e.eventId===id)));
});
test('旧设置入口撤销联网后，后续保存不会重新授权',async()=>{
  const f=fixture();await f.post({operation:'network',enabled:true});await f.post({operation:'ability',ability:'search',action:'grant'});
  const manage=createLifeManagement(f.store,f.gate,f.uow,()=>({body:{},emotions:{}}));
  await manage('main',{kind:'revoke',permission:'network',reason:'测试',version:f.state().version});
  assert.equal(f.state().legacy.config.networkLearning,false);
  await f.post({operation:'config',intelligence:74});assert.ok(!f.state().life.constraints.permissions.includes('network'));
});
