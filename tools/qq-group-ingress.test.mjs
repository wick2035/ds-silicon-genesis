import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CanonicalQQGateway} from '../dist/host/qq-gateway.js';
import {CanonicalQQ} from '../dist/host/qq-canonical.js';

async function fixture(t) {
  const folder=await mkdtemp(join(tmpdir(),'qq-group-ingress-'));
  const diagnosticPath=join(folder,'status.json'),controller=new AbortController(),ingress={},sent=[];
  const state={petId:'main',version:0,legacy:{qq:{identity:{appId:'222',ownerOpenid:'private-owner',groupEnabled:true,groupMode:'all'},seen:{},outbound:{}}},life:{events:[]}};
  const canonical=new CanonicalQQ({loadEnvelope:async()=>state},{apply:async(_id,_version,change)=>{change(state);state.version++;}},
    {signal:controller.signal,run:async(_id,fn)=>fn()},()=>({}),ingress);
  await canonical.configurePairing('main',{group:{code:'private-code',expiresAt:Date.now()+60000}});
  // Keep real canonical pairing/receive; isolate the independent outbox validation.
  canonical.enqueue=async(...args)=>{sent.push(args);return 'reply-action';};
  const gateway=new CanonicalQQGateway({config:{enabled:true,appId:'222',appSecret:'private-secret',groupEnabled:true,groupMode:'all',groupPairingCode:'private-code'},
    canonical,ingressAuthority:ingress,signal:controller.signal,diagnosticPath,onTurn:async()=>{throw Error('pairing must bypass model');},dispatch:async()=>{}});
  gateway.botId='bot-id';
  t.after(async()=>{controller.abort();gateway.stop();await rm(folder,{recursive:true,force:true});});
  const message=content=>({id:'private-message',content,timestamp:new Date().toISOString(),group_openid:'private-group',author:{member_openid:'private-group-owner'}});
  return {gateway,state,sent,diagnosticPath,message};
}

for(const prefix of ['', '<@!bot-id> ', '<@bot-id>\n', '<@!222> ', '<@!opaque-group-mention> ', '<@!opaque-group-mention><@another-id> ', '@大肥鱼 ', '@机器人 昵称 ']) {
  test(`group binding survives packet routing and bot mention ${JSON.stringify(prefix)}`,async t=>{
    const f=await fixture(t);
    const socket={};f.gateway.socket=socket;
    const eventType=prefix.startsWith('@')?'GROUP_MESSAGE_CREATE':'GROUP_AT_MESSAGE_CREATE';
    await f.gateway.packet(JSON.stringify({op:0,s:1,t:eventType,d:f.message(prefix+'/绑定群 private-code')}),socket);
    // The transport intentionally dispatches receives without blocking heartbeats.
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.state.legacy.qq.identity.groupOpenid,'private-group');
    assert.equal(f.state.legacy.qq.identity.ownerOpenid,'private-owner');
    assert.equal(f.state.legacy.qq.pairing.group,undefined);
    assert.equal(f.sent.length,1);
    assert.equal(f.sent[0][3],'群绑定好啦。');
    const raw=await readFile(f.diagnosticPath,'utf8'),status=JSON.parse(raw);
    assert.equal(status.connection.lastGroupEventType,eventType);
    assert.equal(status.pairing.paired,true);
    assert.ok(status.recentInbound.some(item=>item.containsConfiguredGroupCode===true&&item.commandOffset>=0));
    assert.doesNotMatch(raw,/private-|bot-id|(?<![\w])222(?![\w])|绑定群/);
  });
}

test('mention normalization cannot bypass the one-time pairing code',async t=>{
  const f=await fixture(t);
  await f.gateway.receive(f.message('<@!someone-else> /绑定群 wrong-code'),'group','GROUP_MESSAGE_CREATE');
  assert.equal(f.state.legacy.qq.identity.groupOpenid,undefined);
  assert.equal(f.sent.length,0);
  const status=JSON.parse(await readFile(f.diagnosticPath,'utf8'));
  assert.equal(status.inbound.startsWithStructuredMention,true);
  assert.equal(status.inbound.containsConfiguredGroupCode,false);
  assert.equal(status.pairing.paired,false);
  assert.ok(status.inbound.commandOffset>0);
});

test('rejected timestamps and gateway failures remain diagnosable without content',async t=>{
  const f=await fixture(t);
  await f.gateway.receive({...f.message('private-content'),timestamp:'bad'},'group','GROUP_AT_MESSAGE_CREATE');
  f.gateway.setStatus('gateway-permission-4014','denied');
  const raw=await readFile(f.diagnosticPath,'utf8'),status=JSON.parse(raw);
  assert.equal(status.inbound.result,'invalid-or-stale-timestamp');
  assert.equal(status.connection.state,'gateway-permission-4014');
  assert.doesNotMatch(raw,/private-/);
});

test('gateway persists available group nickname without changing actor identity',async t=>{
 const f=await fixture(t);
 f.state.life.invalidSources={};f.state.life.relationships=[];
 await f.gateway.receive(f.message('/绑定群 private-code'),'group','GROUP_MESSAGE_CREATE');
 await f.gateway.receive({...f.message('你好'),id:'msg1',author:{member_openid:'someone',nickname:'小鲸'}},'group','GROUP_MESSAGE_CREATE');
 await f.gateway.receive({...f.message('改名啦'),id:'msg2',author:{member_openid:'someone',nickname:'蓝鲸'}},'group','GROUP_MESSAGE_CREATE');
 const messages=f.state.life.events.filter(e=>e.type==='social.message');
 assert.deepEqual(messages.map(e=>e.payload.nickname),['小鲸','蓝鲸']);
 assert.equal(messages[0].actorId,messages[1].actorId);
});
