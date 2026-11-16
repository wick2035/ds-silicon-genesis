import test from 'node:test';
import assert from 'node:assert/strict';
import {actionFeedback,createFeedbackLeafPublisher,createImmediateFeedback,recentOperationFeedback} from '../dist/host/operation-feedback.js';
import {OutboxDispatcher} from '../dist/storage/uow.js';

const state=()=>({petId:'main',legacy:{wallet:{balance:387.4}},life:{events:[],actions:[],invalidSources:{}}});
const event=(eventId,type,payload,at)=>({eventId,type,payload,occurredAt:at,source:'user'});

test('committed operations and action receipts publish immediately and remain available to the model',()=>{
  const initial=state(),shown=[],observe=createImmediateFeedback(initial,items=>shown.push(items));
  const current=state();
  const operation=event('topup','interaction.operation',{description:'爸爸增加了 500 token 饭钱，余额从 87.4 变为 587.4 token。'},'2026-11-16T00:59:04Z');
  current.life.events.push(operation);observe(current);
  assert.equal(shown.length,1);assert.match(shown[0][0].text,/587.4/);assert.equal(shown[0][0].animate,true);
  const action={id:'buy',actionType:'service.buy-rice'},feedback=actionFeedback(current,action,'COMPLETED');
  current.life.events.push(event('result','action.receipt',{actionId:'buy',status:'COMPLETED',actionType:action.actionType,feedback},'2026-11-16T00:59:27Z'));
  observe(current);observe(current);
  assert.equal(shown.length,2);assert.match(shown[1][0].text,/买饭已完成.*387.4/);assert.equal(shown[1][0].animate,true);
  assert.deepEqual(recentOperationFeedback(current).map(x=>x.text),[operation.payload.description,feedback]);
  current.legacy.wallet.balance=1;
  assert.match(recentOperationFeedback(current)[1].text,/387.4/);
});

test('failed and unknown actions never become success and receipt plus meal is reported once',()=>{
  const current=state(),shown=[],observe=createImmediateFeedback(current,items=>shown.push(items));
  assert.equal(actionFeedback(current,{actionType:'service.eat-rice'},'UNKNOWN'),'吃饭结果尚未确认。');
  assert.equal(actionFeedback(current,{actionType:'service.eat-rice'},'CANCELLED'),'吃饭已中断。');
  current.life.events.push({...event('meal','body.meal',{action:'feed'},'2026-11-16T01:08:14Z'),causationId:'action-result:eat'},event('action-result:eat','action.receipt',{feedback:'吃饭已完成。'},'2026-11-16T01:08:14Z'));
  observe(current);assert.equal(shown[0].length,1);assert.equal(shown[0][0].text,'吃饭已完成。');
});

test('physical interaction and specific activity are reported with their actual meaning',()=>{
  const current=state(),shown=[],observe=createImmediateFeedback(current,items=>shown.push(items));
  current.life.events.push({...event('drag','interaction',{text:'爸爸开始拖动我'},'2026-11-16T01:10:00Z'),source:'canonical-legacy'});
  observe(current);
  assert.equal(shown[0][0].text,'爸爸开始拖动我');
  assert.equal(shown[0][0].animate,false);
  assert.equal(actionFeedback(current,{actionType:'body.activity',parameters:{activity:'dance'}},'COMPLETED'),'跳舞已完成。');
});

test('rapid successive commits remain visible together in the latest UI update',()=>{
  let now=1000;const leaves=[],publish=createFeedbackLeafPublisher(leaf=>leaves.push(leaf),()=>now);
  publish([{eventId:'a',text:'加钱已完成。',animate:true}]);now+=100;
  publish([{eventId:'b',text:'买饭已完成。',animate:false}]);
  assert.deepEqual(leaves[1].feedbackEventIds,['a','b']);assert.match(leaves[1].text,/加钱已完成。 买饭已完成。/);
  now+=3000;publish([{eventId:'c',text:'吃饭已完成。',animate:false}]);assert.deepEqual(leaves[2].feedbackEventIds,['c']);
});

test('cancelled and reconciled actions notify observers only after commit',async()=>{
  for(const mode of ['cancelled','reconciled']){
    const snapshot={...state(),version:0},calls=[],seen=[];
    const row={action_id:'a',pet_id:'main',action_type:'service.buy-rice',payload:{},state:mode==='cancelled'?'pending':'unknown'};
    const pool={connect:async()=>({release(){},query:async sql=>{
      calls.push(sql);
      if(sql.startsWith('SELECT version'))return {rows:[{version:'0',payload:snapshot}]};
      if(sql.startsWith('SELECT state FROM'))return {rows:[{state:row.state}]};
      if(sql.startsWith('SELECT action_id'))return {rows:[row]};
      return {rows:[],rowCount:1};
    }})};
    const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
    const lifecycle={complete(draft){draft.life.events.push({eventId:'cancelled'});},reconcile(draft){draft.life.events.push({eventId:'reconciled'});}};
    const dispatcher=new OutboxDispatcher(pool,new Map(),gate,lifecycle,new Map([['service.buy-rice',async()=>({status:'COMPLETED'})]]));
    dispatcher.onCommit(draft=>seen.push({draft,lastQuery:calls.at(-1)}));
    if(mode==='cancelled')await dispatcher.cancelUnavailable('main','a');else await dispatcher.reconcile('a');
    assert.equal(seen.length,1);assert.equal(seen[0].lastQuery,'COMMIT');assert.equal(seen[0].draft.life.events[0].eventId,mode);
  }
});
