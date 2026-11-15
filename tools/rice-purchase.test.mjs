import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRicePurchase,localRiceReconciler} from '../dist/host/rice-purchase.js';

test('rice purchase checks actual funds before dispatch, including frozen charges and inventory capacity',()=>{
 const s={legacy:{config:{costs:{feed:200}},wallet:{balance:10,frozen:false},services:{inventory:[]}}};
 assert.throws(()=>validateRicePurchase(s),/饭钱不足/);
 s.legacy.wallet.frozen=true;assert.doesNotThrow(()=>validateRicePurchase(s));
 s.legacy.services.inventory=Array.from({length:12},()=>({status:'available'}));assert.throws(()=>validateRicePurchase(s),/库存已满/);
});
test('local unknown purchase is resolved only when neither its atomic charge nor inventory exists',async()=>{
 const state={legacy:{services:{inventory:[]}},life:{events:[],actions:[{id:'buy',status:'UNKNOWN',actionType:'service.buy-rice'}]}};
 const resolver=localRiceReconciler({loadEnvelope:async()=>state}),intent={id:'buy',type:'service.buy-rice'},signal=new AbortController().signal;
 const result=await resolver('main',intent,signal);assert.equal(result.status,'FAILED');assert.equal(result.actionId,'buy');assert.match(result.details.reason,/未扣饭钱/);
 state.legacy.services.inventory.push({id:'rice:buy'});assert.equal(await resolver('main',intent,signal),null);
 state.legacy.services.inventory=[];state.life.events.push({eventId:'finance:buy'});assert.equal(await resolver('main',intent,signal),null);
});
