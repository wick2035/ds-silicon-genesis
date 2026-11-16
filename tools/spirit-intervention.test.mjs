import test from 'node:test';
import assert from 'node:assert/strict';
import {createLifeManagement,createLifeApi} from '../dist/host/life-api.js';
import {ensureSpirit,advanceSpirit,setSpiritRest} from '../dist/kernel/spirit.js';
import {interactionDescription} from '../dist/host/interaction-reactions.js';
function fixture(){
 let state={petId:'main',version:0,legacy:{},life:{events:[],memories:[],constraints:{permissions:[]}}};ensureSpirit(state.life);
 const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
 const reader={loadEnvelope:async()=>structuredClone(state)};
 const uow={apply:async(_id,v,fn)=>{assert.equal(v,state.version);const d=structuredClone(state);advanceSpirit(d.life);fn(d);d.version++;state=d;}};
 const manage=createLifeManagement(reader,gate,uow,()=>({}));
 const run=(value,requestId)=>manage('main',{kind:'spirit',value,requestId,version:state.version,reason:'主动调整精神力'});
 return {get:()=>state,run,manage};
}
test('intervention records the perceived experience and safely deduplicates retries',async()=>{
 const f=fixture();await f.run(95,'request-0001');let s=f.get();assert.equal(s.life.spirit.value,95);assert.match(s.life.memories[0].content,/爸爸.*金色 token/);assert.equal(interactionDescription(s.life.events[0]),s.life.memories[0].content);
 await f.run(95,'request-0001');assert.equal(f.get().life.events.length,1);await assert.rejects(f.run(96,'request-0001'),/冲突/);
 await f.run(10,'request-0002');s=f.get();assert.equal(s.life.spirit.value,10);assert.match(s.life.memories[1].content,/发生了一些变故/);assert.doesNotMatch(s.life.memories[1].content,/爸爸|调整|token/);assert.equal(s.life.events[1].payload.text,s.life.memories[1].content);
});
test('sleep adjustment remains continuous and preserves the original sleep duration',async()=>{
 const f=fixture(),s=f.get(),now=Date.now();setSpiritRest(s.life,'sleep',now-3600000);await f.run(20,'request-0003');const life=f.get().life,anchor=life.spirit.updatedAt;
 assert.equal(life.spirit.value,20);advanceSpirit(life,anchor+1000);assert.ok(life.spirit.value>=20&&life.spirit.value<21);setSpiritRest(life,'awake',anchor+3600000);assert.ok(life.spirit.lastSleepHours>1.99&&life.spirit.lastSleepHours<2.01);assert.equal(life.spirit.sleepRecoveryAt,undefined);
});
test('HTTP rejects invalid intervention values and request IDs',async()=>{
 const f=fixture();const api=createLifeApi({authorize:()=>true,petId:()=> 'main',manage:f.manage,getState:async()=>({...f.get().life,petId:'main',version:f.get().version,identity:{},goals:[],actions:[],events:f.get().life.events,invalidSources:{},constraints:{}})});
 for(const input of [{value:-1,requestId:'request-123'},{value:101,requestId:'request-123'},{value:50,requestId:'bad'}]){const r=await api(new Request('http://localhost/api/life/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'spirit',reason:'调整',version:0,...input})}));assert.equal(r.status,400);}
});
