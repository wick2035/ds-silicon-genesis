import test from 'node:test';
import assert from 'node:assert/strict';
import {recentGroupActivity} from '../dist/host/group-conversation-context.js';
import {companionContext} from '../dist/host/companion-personality.js';

function fixture(){
  const now=Date.now(),at=new Date(now).toISOString();
  const event=(id,type,source,payload,causationId,actorId)=>({eventId:id,type,source,payload,causationId,actorId,occurredAt:at});
  const state={events:[event('q','social.message','qq',{scene:'group',groupId:'g',text:'我喜欢面条'},undefined,'qq-member:friend'),
    event('u','conversation.user','qq-group',{groupId:'g',sourceIds:['q'],text:'我喜欢面条'},'q','qq-member:friend'),
    event('a','conversation.assistant','qq-group',{groupId:'g',text:'本鱼爱白饭'},'u'),
    event('r-event','action.receipt','outbox',{actionId:'send'},'r')],
    actions:[{id:'send',actionType:'qq.send',sourceIds:['q'],parameters:{scene:'group',content:'本鱼爱白饭'},status:'COMPLETED',receiptId:'r'}],
    receipts:[{receiptId:'r',actionId:'send',status:'COMPLETED',details:{kind:'qq.send',messageId:'delivered'}}],invalidSources:{}};
  return {state,now};
}

test('group experience retains the companion, group member, channel, and delivery evidence',()=>{
  const {state,now}=fixture(),[item]=recentGroupActivity(state,now);
  assert.equal(item.speaker,'大肥鱼');assert.equal(item.channel,'qq-group');assert.equal(item.delivery,'已确认发送');
  assert.equal(item.heard[0].actorId,'qq-member:friend');assert.equal(item.heard[0].text,'我喜欢面条');
  assert.deepEqual(item.sourceIds,['a','u','q','r-event']);
  const context=companionContext({legacy:{config:{}},humanity:{},life:state},now);
  assert.equal(context.groupActivity[0].text,'本鱼爱白饭');
});

test('drafts and unknown sends cannot masquerade as delivered speech',()=>{
  const {state,now}=fixture();state.actions[0].status='PENDING';state.receipts=[];
  assert.equal(recentGroupActivity(state,now)[0].delivery,'发送尚未确认');
  state.actions[0].status='FAILED';assert.equal(recentGroupActivity(state,now)[0].delivery,'未发送成功');
});

test('deleted sources, silent turns, and expired experience are excluded',()=>{
  const {state,now}=fixture();state.invalidSources.q='deleted';assert.deepEqual(recentGroupActivity(state,now),[]);
  delete state.invalidSources.q;state.events[2].payload.silent=true;assert.deepEqual(recentGroupActivity(state,now),[]);
  delete state.events[2].payload.silent;assert.deepEqual(recentGroupActivity(state,now+86400001),[]);
});
