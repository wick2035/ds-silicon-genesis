import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareFreshQQ} from '../dist/host/qq-takeover.js';
import {CanonicalQQ} from '../dist/host/qq-canonical.js';

async function fixture(t,config,old={appId:'111'}) {
  const home=await mkdtemp(join(tmpdir(),'fresh-qq-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const folder=join(home,'dsh-pet');await mkdir(folder);
  await writeFile(join(folder,'qq-fresh-config.json'),JSON.stringify(config));
  if(old)await writeFile(join(folder,'qq-config.json'),JSON.stringify(old));
  const calls=[];
  const canonical={importState:async(...args)=>calls.push(['import',...args]),configurePairing:async(...args)=>calls.push(['pair',...args])};
  return {home,calls,options:{home,petId:'main',canonical,ingressAuthority:{},signal:new AbortController().signal,onTurn:async()=>null,dispatch:async()=>{}}};
}
const valid=()=>({enabled:true,appId:'222',appSecret:'test-secret',petId:'main',groupEnabled:true,groupMode:'all',pairingCode:'owner-code',pairingExpiresAt:Date.now()+60000,groupPairingCode:'group-code',groupPairingExpiresAt:Date.now()+60000});

test('new bot starts with fresh identity and pairing without old receipts',async t=>{
  const {calls,options}=await fixture(t,valid());
  const result=await prepareFreshQQ(options);t.after(()=>result.gateway.stop());
  assert.equal(result.status,'ready');
  assert.deepEqual(calls[0],['import','main',{appId:'222',groupEnabled:true,groupMode:'all'},[],[]]);
  assert.equal(calls[1][2].owner.code,'owner-code');
  assert.equal(calls[1][2].group.code,'group-code');
  assert.equal(JSON.stringify(calls[0]).includes('test-secret'),false);
});

test('rejects the old app, reused OpenIDs, and wrong pet before writes',async t=>{
  for(const config of [{...valid(),appId:'111'},{...valid(),ownerOpenid:'old-user'},{...valid(),petId:'other'}]) {
    const {calls,options}=await fixture(t,config);
    await assert.rejects(prepareFreshQQ(options));
    assert.equal(calls.length,0);
  }
});

test('expired pairing codes are not registered',async t=>{
  const {calls,options}=await fixture(t,{...valid(),pairingExpiresAt:1,groupPairingExpiresAt:1});
  const result=await prepareFreshQQ(options);t.after(()=>result.gateway.stop());
  assert.deepEqual(calls.map(c=>c[0]),['import']);
});

test('a conflicting canonical identity prevents gateway creation',async t=>{
  const {options}=await fixture(t,valid());
  options.canonical.importState=async()=>{throw Error('QQ 已绑定其他身份');};
  await assert.rejects(prepareFreshQQ(options),/已绑定其他身份/);
});

test('successful bindings consume codes and startup cannot recreate them',async()=>{
  const ingress={},controller=new AbortController();
  const state={petId:'main',version:0,legacy:{qq:{identity:{appId:'222',groupEnabled:true,groupMode:'all'},seen:{},outbound:{}}},life:{events:[]}};
  const reader={loadEnvelope:async()=>state},gate={signal:controller.signal,run:async(_id,fn)=>fn()};
  const uow={apply:async(_id,_version,change)=>{change(state);state.version++;}};
  const canonical=new CanonicalQQ(reader,uow,gate,()=>({}),ingress);
  const codes={owner:{code:'owner-code',expiresAt:Date.now()+60000},group:{code:'group-code',expiresAt:Date.now()+60000}};
  await canonical.configurePairing('main',codes);
  const message={messageId:'m1',scene:'c2c',actorOpenid:'owner',text:'/绑定 owner-code',occurredAt:new Date().toISOString()};
  assert.equal((await canonical.pair('main',message,ingress)).paired,true);
  assert.equal((await canonical.pair('main',{...message,messageId:'m2',scene:'group',actorOpenid:'group-owner',groupOpenid:'group',text:'/绑定群 group-code'},ingress)).paired,true);
  await canonical.configurePairing('main',codes);
  assert.deepEqual(state.legacy.qq.pairing,{});
});
