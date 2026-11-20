import test from 'node:test';
import assert from 'node:assert/strict';
import {createLifeApi,createLifeManagement} from '../dist/host/life-api.js';
import {CanonicalQQ} from '../dist/host/qq-canonical.js';
import {groupPeopleContext,groupPeopleDirectory} from '../dist/host/group-people.js';
import {createLifeRoutes} from '../dist/host/life-routes.js';
import {createRequestSecurity,listenStandaloneServer} from '../vendor/dsh-pet/lib/silicon-host.js';

function fixture(){
 let state={petId:'main',version:0,legacy:{qq:{identity:{appId:'bot',ownerOpenid:'owner',groupOwnerOpenid:'group-owner',groupOpenid:'group',groupEnabled:true,groupMode:'all'},seen:{},outbound:{}}},humanity:{},life:{events:[],memories:[],goals:[],relationships:[],actions:[],invalidSources:{},constraints:{permissions:[]}}};
 const reader={loadEnvelope:async()=>structuredClone(state)},gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
 const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const draft=structuredClone(state);fn(draft);draft.version++;state=draft;}};
 const manage=createLifeManagement(reader,gate,uow,()=>({})),ingress={},qq=new CanonicalQQ(reader,uow,gate,()=>({}),ingress);
 const api=createLifeApi({authorize:()=>true,petId:()=> 'main',manage,getState:async()=>({...state.life,version:state.version})});
 const post=command=>api(new Request('http://localhost/api/life/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'group-remark',version:state.version,reason:'设置群友备注',expectedRemark:'',...command})}));
 const receive=(messageId,nickname,actorOpenid='friend')=>qq.receive('main',{messageId,nickname,actorOpenid,scene:'group',groupOpenid:'group',text:'你好',occurredAt:new Date().toISOString()},ingress);
 return {state:()=>state,post,receive,api};
}

test('authenticated remarks persist on the same canonical identity through renames and replay',async()=>{
 const f=fixture();await f.receive('first',undefined);
 const actorId=f.state().life.events[0].actorId;
 assert.equal((await f.post({actorId,remark:'小林'})).status,200);
 await f.receive('renamed','海盐');await f.receive('same-name','海盐','different-friend');
 const people=groupPeopleDirectory(JSON.parse(JSON.stringify(f.state().life)));
 assert.equal(people.length,2);assert.equal(people.find(p=>p.actorId===actorId).remark,'小林');
 assert.equal(people.find(p=>p.actorId===actorId).nickname,'海盐');
 assert.equal(groupPeopleContext(f.state().life,[actorId])[0].currentName,'小林');
 assert.equal(f.state().life.events.filter(e=>e.type==='management.group-remark').length,1);
 const page=await f.api(new Request('http://localhost/api/life/relationships?view=page'));
 assert.equal((await page.json()).value.people.length,2);
 assert.deepEqual((await (await f.api(new Request('http://localhost/api/life/relationships'))).json()).value,f.state().life.relationships);
 assert.equal((await f.post({actorId,remark:'',expectedRemark:'小林'})).status,200);
 assert.equal(groupPeopleContext(f.state().life,[actorId])[0].currentName,'海盐');
 assert.deepEqual(f.state().life.constraints.permissions,[]);
});

test('stale writes and unknown identities cannot overwrite names; unchanged saves do not create duplicate events',async()=>{
 const f=fixture();await f.receive('first','小鲸');const actorId=f.state().life.events[0].actorId;
 assert.equal((await f.post({actorId,remark:'小林'})).status,200);
 const count=f.state().life.events.length;
 assert.equal((await f.post({actorId,remark:'错误覆盖'})).status,409);
 assert.equal((await f.post({actorId,remark:'小林',expectedRemark:'小林'})).status,200);
 assert.equal(f.state().life.events.length,count);
 assert.equal((await f.post({actorId:'qq-member:unknown',remark:'猜测'})).status,409);
 assert.equal((await f.post({actorId:'dad',remark:'群友'})).status,400);
 for(const remark of [null,42,'a'.repeat(41),'a\nb','<script>','\u2028'])assert.equal((await f.post({actorId,remark})).status,400);
 const forbidden=createLifeApi({authorize:()=>false});
 assert.equal((await forbidden(new Request('http://localhost/api/life/relationships?view=page'))).status,403);
 assert.equal((await forbidden(new Request('http://localhost/api/life/manage',{method:'POST'}))).status,403);
});

test('removed group message sources cannot be used to register a remark',async()=>{
 const f=fixture();await f.receive('first','小鲸');const event=f.state().life.events[0];
 f.state().life.invalidSources[event.eventId]='deleted';
 assert.equal((await f.post({actorId:event.actorId,remark:'小林'})).status,409);
 assert.deepEqual(groupPeopleDirectory(f.state().life),[]);
});

test('the production host serves the new UI module and still protects member data',async t=>{
 const f=fixture(),security=createRequestSecurity();
 const server=await listenStandaloneServer({port:0,security,routes:createLifeRoutes(process.cwd(),f.api),logger:{debug(){},info(){},warn(){},error(){}}});
 t.after(()=>server.close());
 const origin=`http://127.0.0.1:${server.port}`;
 const asset=await fetch(origin+'/life/group-people.js');
 assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
 assert.match(await asset.text(),/export function renderGroupPeople/);
 assert.equal((await fetch(origin+'/api/life/relationships?view=page')).status,403);
 const authorized=await fetch(origin+'/api/life/relationships?view=page',{headers:{'x-dsh-pet-token':security.token}});
 assert.equal(authorized.status,200);assert.deepEqual((await authorized.json()).value.people,[]);
});
