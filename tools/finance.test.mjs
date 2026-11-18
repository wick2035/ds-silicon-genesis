import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {LegacyDomain} from '../dist/host/legacy-domain.js';
import {createFinanceManagement} from '../dist/host/finance-management.js';
import {createLifeApi} from '../dist/host/life-api.js';
import {checkSimulatedSpending,settleSimulatedSpending} from '../dist/host/simulated-spending.js';
import {CanonicalChat} from '../dist/host/chat-service.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';
import {createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';

function fixture(){
  const old=Object.create(CompanionStore.prototype);old.data={version:2,pets:{}};old.loaded=true;old.clock=Date.now;old.save=()=>{};old.load=()=>{};
  const pet=old.read('main');
  let envelope={petId:'main',version:0,legacy:pet,humanity:{},life:{memories:[],events:[],invalidSources:{},relationships:[],constraints:{permissions:[]}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(envelope)};
  const uow={apply:async(_id,version,change)=>{assert.equal(version,envelope.version);const draft=structuredClone(envelope);change(draft);draft.version++;envelope=draft;return draft;}};
  const domain=new LegacyDomain(store,uow,gate,{}),finance=createFinanceManagement(store,gate,domain);
  return {finance,domain,store,gate,uow,get:()=>envelope};
}
const wallet=(id,action,amount,balance=10000,frozen=false)=>({kind:'wallet',requestId:id,action,amount,expectedBalance:balance,expectedFrozen:frozen});

test('余额调整、冻结、价格和并发检查使用同一账本',async()=>{
  const f=fixture();
  await f.finance.write('main',wallet('wallet-add-1','add',12.34));
  await f.finance.write('main',wallet('wallet-add-1','add',12.34));
  assert.equal(f.get().legacy.wallet.balance,10012.34);
  await assert.rejects(f.finance.write('main',wallet('wallet-stale','set',1)),/余额已变化/);
  await assert.rejects(f.finance.write('main',wallet('wallet-too-much','subtract',10013,10012.34)),/超过当前余额/);
  await assert.rejects(f.finance.write('main',wallet('wallet-precision','add',0.001,10012.34)),/两位小数/);
  await f.finance.write('main',wallet('wallet-sub-1','subtract',12.34,10012.34));
  await f.finance.write('main',wallet('wallet-set-1','set',0));
  await f.finance.write('main',{kind:'wallet',requestId:'wallet-freeze',action:'freeze',frozen:true,expectedBalance:0,expectedFrozen:false});
  await f.finance.write('main',{kind:'wallet',requestId:'wallet-unfreeze',action:'freeze',frozen:false,expectedBalance:0,expectedFrozen:true});
  const costs={chat:0.12,whisper:0,feed:22.22,diary:40,explore:50};
  await f.finance.write('main',{kind:'costs',requestId:'costs-change',costs});
  assert.deepEqual(f.get().legacy.config.costs,costs);
  assert.equal(f.get().legacy.wallet.frozen,false);
  assert.equal((await f.finance.read('main')).events.filter(e=>e.text.includes('饭钱')).length,5);
});

test('录入任务直接生效且欠薪可独立结算，重复支付只入账一次',async()=>{
  const f=fixture();
  await f.finance.write('main',{kind:'labor',requestId:'offer-first',action:'offer',trips:2,wage:80});
  const contract=f.get().legacy.labor.contracts[0],id=contract.id;
  assert.equal(contract.status,'queued');assert.equal(contract.workPermit,false);
  contract.done=2;contract.status='unpaid';
  await f.finance.write('main',{kind:'labor',requestId:'offer-second',action:'offer',trips:3,wage:100});
  assert.equal((await f.finance.read('main')).labor.current.trips,3);
  const pay={kind:'labor',requestId:'payment-123',action:'settle-cancelled',id,amount:80};
  await f.finance.write('main',pay);await f.finance.write('main',pay);
  assert.equal(f.get().legacy.wallet.balance,10080);
  assert.equal(f.get().legacy.labor.contracts[0].payments.length,1);
  assert.equal(f.get().legacy.labor.contracts[0].status,'paid');
});

test('种子单价可设为零，批量购买受饭钱和 72 束库存限制，重试只扣一次',async()=>{
  const f=fixture();
  const buy=(requestId,count,unitCharge)=>f.finance.write('main',{kind:'farm-seeds',requestId,count,unitCharge});
  const initial=await f.finance.read('main');
  assert.equal(initial.costs.riceSeed,1);
  assert.equal(initial.seedShop.stock,0);
  assert.equal(initial.seedShop.maxPurchase,72);
  assert.equal(initial.seedShop.perSeason,24);
  f.get().legacy.wallet.balance=48.01;
  await assert.rejects(buy('seed-over-budget',49,1),/饭钱不足/);
  await buy('seed-first-24',24,1);await buy('seed-first-24',24,1);
  assert.equal(f.get().legacy.wallet.balance,24.01);
  assert.equal((await f.finance.read('main')).seedShop.stock,24);
  assert.equal(f.get().life.events.filter(e=>e.type==='wallet.spend'&&e.payload.kind==='farm-seeds').length,1);
  const setPrice=(requestId,riceSeed)=>f.finance.write('main',{kind:'costs',requestId,costs:{...initial.costs,riceSeed}});
  await assert.rejects(setPrice('seed-price-bad',-1),/价格须为/);
  await setPrice('seed-price-zero',0);
  await assert.rejects(buy('seed-price-stale',1,1),/价格或消费状态已变化/);
  await assert.rejects(buy('seed-over-cap',49,0),/最多可放 72 束/);
  await buy('seed-fill-cap',48,0);
  assert.equal((await f.finance.read('main')).seedShop.stock,72);
  assert.equal(f.get().legacy.wallet.balance,24.01);
});

test('饭钱 HTTP 接口校验授权、方法及错误',async()=>{
  const f=fixture(),handler=createLifeApi({authorize:r=>r.headers.get('x-test')==='yes',petId:()=> 'main',getState:async()=>{throw Error('unexpected');},finance:f.finance});
  const req=(method,body,auth=true)=>new Request('http://localhost/api/life/finance',{method,headers:{...(auth?{'x-test':'yes'}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await handler(req('GET',null,false))).status,403);
  assert.equal((await handler(req('DELETE'))).status,405);
  const read=await handler(req('GET'));assert.equal((await read.json()).value.wallet.balance,10000);
  const fail=await handler(req('POST',wallet('wallet-invalid','add',0.001)));assert.equal(fail.status,409);assert.match((await fail.json()).error,/两位小数/);
  const ok=await handler(req('POST',wallet('wallet-http','add',5)));assert.equal(ok.status,200);assert.equal(f.get().legacy.wallet.balance,10005);
});

test('聊天和碎碎念不扣饭钱，日记继续使用饭钱与冻结规则',()=>{
  const f=fixture(),d=f.get(),p=d.legacy;p.wallet.balance=99.95;
  settleSimulatedSpending(d,'chat','test-chat');settleSimulatedSpending(d,'whisper','test-whisper');assert.equal(p.wallet.balance,99.95);
  assert.throws(()=>checkSimulatedSpending(d,'diary'),/不足/);
  p.wallet.frozen=true;settleSimulatedSpending(d,'diary','test-frozen');assert.equal(p.wallet.balance,99.95);
  p.wallet.frozen=false;p.wallet.balance=100;settleSimulatedSpending(d,'diary','test-diary');assert.equal(p.wallet.balance,0);
  checkSimulatedSpending(d,'chat');assert.equal(d.life.events.filter(e=>e.type==='wallet.spend').length,1);
});

test('聊天完成、失败和重复请求均不再扣饭钱',async()=>{
  const f=fixture(),life=f.get().life;
  Object.assign(life,{memories:[],commitments:[],actions:[],receipts:[],legacyContext:{personaDescription:'test'},body:{},emotions:{}});
  f.store.load=async()=>structuredClone(f.get().life);
  let fail=false;
  const model={agentDefaultModel:{currentSelection:()=>({provider:'test',model:'test'})},llm:{async *stream(){if(fail)throw Error('model unavailable');yield {type:'text',text:'好呀'};}}};
  const budget={runAs:async(_id,_kind,fn)=>fn()};
  const chat=new CanonicalChat(f.store,f.gate,f.uow,budget,model,async()=>[]);
  const input={requestId:'chat-request-123',petId:'main',channel:'desktop',actorId:'dad',text:'你好'};
  assert.equal(await chat.turn(input,new AbortController().signal),'好呀');
  assert.equal(f.get().legacy.wallet.balance,10000);
  assert.equal(await chat.turn(input,new AbortController().signal),'好呀');
  assert.equal(f.get().legacy.wallet.balance,10000);
  fail=true;await assert.rejects(chat.turn({...input,requestId:'chat-request-fail'},new AbortController().signal));
  assert.equal(f.get().legacy.wallet.balance,10000);
});

test('只有可信喂饭完成回执才扣除喂饭价格',()=>{
  const f=fixture(),draft=f.get(),at='2026-11-14T02:00:00.000Z';
  draft.humanity=createHumanity(Date.parse(at));
  const intent={id:'feed-action',type:'care.feed',payload:{parameters:{}}};
  projectOutcome(draft,intent,{status:'failed',evidence:{}},at,'receipt');
  assert.equal(draft.legacy.wallet.balance,10000);
  projectOutcome(draft,intent,{status:'completed',evidence:{confirmed:true,actionId:'feed-action',kind:'care.feed',played:true,itemId:'parent'}},at,'receipt');
  assert.equal(draft.legacy.wallet.balance,9980);
});
