import test from 'node:test';
import assert from 'node:assert/strict';
import {riceAvailability,validateRiceMeal} from '../dist/host/rice-inventory.js';
import {createEmbodiedSpeech} from '../dist/host/embodied-speech.js';

const fixture=()=>({legacy:{config:{costs:{feed:200}},wallet:{balance:230},services:{inventory:[{id:'old-bowl',status:'available'}]}},life:{actions:[{id:'old-eat',actionType:'service.eat-rice',parameters:{itemId:'old-bowl'},status:'UNKNOWN'}]}});
test('old uncertain meal does not prohibit a funded purchase; only the affected bowl is excluded',()=>{
 const s=fixture();let food=riceAvailability(s);
 assert.equal(food.purchase.allowed,true);assert.deepEqual(food.availableItemIds,[]);assert.equal(food.inventory[0].status,'unconfirmed');
 s.legacy.wallet.balance-=200;s.legacy.services.inventory.push({id:'new-bowl',status:'available'});
 food=riceAvailability(s);assert.equal(food.purchase.allowed,false);assert.deepEqual(food.availableItemIds,['new-bowl']);
});
test('unresolved purchases, insufficient money and full inventory still block another purchase',()=>{
 for(const status of ['PENDING','DISPATCHED','UNKNOWN']){const s=fixture();s.life.actions.push({actionType:'service.buy-rice',status});assert.equal(riceAvailability(s).purchase.allowed,false);}
 const s=fixture();s.legacy.wallet.balance=30;assert.equal(riceAvailability(s).purchase.allowed,false);
 s.legacy.wallet.frozen=true;assert.equal(riceAvailability(s).purchase.allowed,true);
 s.legacy.services.inventory=Array.from({length:12},(_,id)=>({id,status:'available'}));assert.equal(riceAvailability(s).purchase.allowed,false);
});
test('dispatch rejects incomplete food IDs and uncertain old bowls before playing an animation',()=>{
 const s=fixture();assert.throws(()=>validateRiceMeal(s,'old-bow'),/完整 id/);assert.throws(()=>validateRiceMeal(s,'old-bowl'),/未确认/);
 s.legacy.services.inventory.push({id:'rice:speech-action:'+ 'a'.repeat(64),status:'available'});
 assert.doesNotThrow(()=>validateRiceMeal(s,'rice:speech-action:'+ 'a'.repeat(64)));
 s.legacy.services.inventory[1].status='eaten';assert.throws(()=>validateRiceMeal(s,'rice:speech-action:'+ 'a'.repeat(64)),/已经吃完/);
});
test('speech sees reconciliation instead of obsolete UNKNOWN and gets explicit permission to buy despite an old bowl',async()=>{
 const s=fixture();Object.assign(s,{petId:'main',version:1,humanity:{stats:{satiety:0},emotions:{}}});
 Object.assign(s.life,{invalidSources:{},goals:[],constraints:{capabilities:[],permissions:[]},receipts:[],events:[
 {eventId:'unknown-buy',type:'action.receipt',payload:{actionId:'buy',status:'UNKNOWN'}},
 {eventId:'resolved-buy',type:'action.reconciled',payload:{actionId:'buy',status:'FAILED'}}]});
 s.life.actions.push({id:'buy',actionType:'service.buy-rice',status:'FAILED',parameters:{},sourceIds:[]});
 s.life.actions[0].sourceIds=[];
 const gate={signal:new AbortController().signal};
 const speech=createEmbodiedSpeech({loadEnvelope:async()=>s},gate,{}, {},{},()=>{},()=>{});
 let seen=false;const model={async *stream(o){assert.ok(!o.system.includes('unknown-buy'));assert.ok(o.system.includes('resolved-buy'));assert.match(o.system,/"purchase":\{"allowed":true/);assert.match(o.system,/不阻止购买/);seen=true;yield {type:'text',text:'我再买一碗。'};}};
 for await(const _ of speech.wrap(model).stream({system:'角色',messages:[{role:'user',content:'吃饭'}],embodied:{petId:'main',sourceIds:[],requestId:'test',allowActions:true}})){}
 assert.equal(seen,true);
});
