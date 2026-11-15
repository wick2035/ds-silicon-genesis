import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionStore} from '../vendor/pet-plugins/behavior/core.mjs';
import {LegacyDomain} from '../dist/host/legacy-domain.js';
import {createFinanceManagement} from '../dist/host/finance-management.js';
import {conversationContext} from '../dist/host/conversation-context.js';

function fixture(){
  const old=Object.create(CompanionStore.prototype);Object.assign(old,{data:{version:2,pets:{}},loaded:true,clock:Date.now,save(){},load(){}});
  let state={petId:'main',version:0,legacy:old.read('main'),humanity:{},life:{events:[],memories:[],invalidSources:{},actions:[],receipts:[],relationships:[],constraints:{permissions:[]}}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()},store={loadEnvelope:async()=>structuredClone(state)};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const draft=structuredClone(state);fn(draft);draft.version++;state=draft;}};
  const domain=new LegacyDomain(store,uow,gate,{}),finance=createFinanceManagement(store,gate,domain);
  const c={id:'contract',status:'working',trips:10,done:5,wage:100,paid:0,carrying:true,workPermit:true,payments:[],decisions:[]};
  state.legacy.labor={contracts:[c]};state.legacy.world={command:{id:'body-command',source:'labor',status:'running',labor:{id:c.id}}};
  return {finance,get:()=>state};
}
const write=(f,action,extra={})=>f.finance.write('main',{kind:'labor',requestId:'request-'+action,action,id:'contract',...extra});

test('途中修改条件保留已完成进度并使旧动作失效',async()=>{
  const f=fixture();await write(f,'adjust',{trips:12,wage:220});
  const p=f.get().legacy,c=p.labor.contracts[0];assert.equal(c.done,5);assert.equal(c.trips,12);assert.equal(c.wage,220);assert.equal(c.carrying,false);assert.equal(p.world.command.status,'interrupted');assert.equal(c.revisions[0].before.wage,100);
  await assert.rejects(f.finance.write('main',{kind:'labor',requestId:'request-bad-edit',action:'adjust',id:c.id,trips:4,wage:1}),/已完成/);
});
test('取消一半的工作不会自动结半薪，也不会阻止新增工作',async()=>{
  const f=fixture();await write(f,'cancel');await write(f,'cancel');
  const c=f.get().legacy.labor.contracts[0];assert.equal(c.status,'cancelled');assert.equal(c.done,5);assert.equal(c.paid,0);assert.equal(f.get().legacy.wallet.balance,10000);
  assert.equal((await f.finance.read('main')).labor.current,null);assert.equal((await f.finance.read('main')).labor.history[0].id,c.id);
  await f.finance.write('main',{kind:'labor',requestId:'request-new-task',action:'offer',trips:3,wage:30});assert.equal(f.get().legacy.labor.contracts.length,2);
  assert.equal(f.get().legacy.labor.contracts[0].done,5);
});
test('取消后的工钱可为零、部分或额外支付，重复请求只入账一次',async()=>{
  const f=fixture();await write(f,'cancel');await write(f,'settle-cancelled',{amount:0});
  const input={kind:'labor',requestId:'request-part-pay',action:'settle-cancelled',id:'contract',amount:37};
  await f.finance.write('main',input);await f.finance.write('main',input);
  assert.equal(f.get().legacy.wallet.balance,10037);assert.equal(f.get().legacy.labor.contracts[0].paid,37);assert.equal(f.get().legacy.labor.contracts[0].status,'cancelled');
});
test('取消事实和条件变化进入长期记忆及聊天上下文，不预设生命体的索薪结论',async()=>{
  const f=fixture();await write(f,'cancel');
  const state=f.get(),context=conversationContext(state.life,state);
  assert.equal(context.laborHistory[0].done,5);assert.equal(context.laborHistory[0].wage,100);assert.equal(context.laborHistory[0].paid,0);
  assert.ok(state.life.memories.some(m=>m.content.includes('实际完成 5/10')));
  assert.equal(context.laborHistory[0].claim,undefined);
});
