import test from 'node:test';
import assert from 'node:assert/strict';
import {temporalContext} from '../dist/host/temporal-context.js';

const now=Date.parse('2026-11-16T00:41:40Z');
const at=s=>new Date(now+s*1000).toISOString();
function fixture(){
 const events=[{eventId:'previous',type:'conversation.user',source:'qq-c2c',actorId:'dad',occurredAt:at(-3600),payload:{}},
  {eventId:'current',type:'conversation.user',source:'qq-c2c',actorId:'dad',occurredAt:at(-2),payload:{}},
  {eventId:'feed',type:'social.care',source:'executor',actorId:'dad',occurredAt:at(-90),payload:{action:'feed'}},
  {eventId:'sleep-evidence',type:'action.receipt',causationId:'sleep-receipt',occurredAt:at(-7200),payload:{}},
  {eventId:'wake-evidence',type:'action.receipt',causationId:'wake-receipt',occurredAt:at(-3600),payload:{}}];
 return {life:{events,invalidSources:{},actions:[{id:'sleep',actionType:'body.sleep',status:'COMPLETED',receiptId:'sleep-receipt',sourceIds:[],parameters:{}},{id:'wake',actionType:'body.wake',status:'COMPLETED',receiptId:'wake-receipt',sourceIds:[],parameters:{}}],receipts:[{actionId:'sleep',receiptId:'sleep-receipt',status:'COMPLETED',occurredAt:at(-7200)},{actionId:'wake',receiptId:'wake-receipt',status:'COMPLETED',occurredAt:at(-3600)}]}};
}
test('uses confirmed sleep and wake times, preserves real feeding and excludes current message',()=>{
 const time=temporalContext(fixture(),now,['current']);
 assert.equal(time.clock.secondsSinceOwnerMessage,3600);assert.equal(time.clock.secondsSinceOwnerContact,90);
 assert.equal(time.lastConfirmedWake.ageSeconds,3600);assert.equal(time.lastRestDurationSeconds,3600);
 assert.match(time.lastConfirmedWake.localTime,/07:41:40/);assert.equal(JSON.parse(time.recentEvents[0].detail).action,'feed');
});
test('ignores future, invalidated, unconfirmed and unproven action records',()=>{
 const f=fixture();f.life.invalidSources['wake-evidence']=true;
 f.life.actions.push({id:'future',actionType:'body.wake',status:'COMPLETED',receiptId:'future-r',sourceIds:[],parameters:{}},{id:'failed',actionType:'body.wake',status:'FAILED',receiptId:'failed-r',sourceIds:[],parameters:{}});
 f.life.receipts.push({actionId:'future',receiptId:'future-r',status:'COMPLETED',occurredAt:at(5)},{actionId:'failed',receiptId:'failed-r',status:'FAILED',occurredAt:at(-10)});
 assert.equal(temporalContext(f,now).lastConfirmedWake,null);
});
