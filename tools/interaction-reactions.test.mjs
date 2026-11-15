import test from 'node:test';
import assert from 'node:assert/strict';
import {createInteractionReactions,interactionDescription} from '../dist/host/interaction-reactions.js';
import {createLegacyRequestAdapter} from '../dist/host/legacy-request-adapter.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const state=events=>({petId:'main',life:{events,invalidSources:{}}});
const event=(id,type='management.pause',payload={paused:true})=>({eventId:id,type,source:'user',payload});
const flush=()=>new Promise(setImmediate);

test('committed input is batched once, with every source, without replay or reply loops',async()=>{
  const controller=new AbortController(),calls=[],shown=[],old=event('old');
  const observe=createInteractionReactions(state([old]),async(_id,e)=>{calls.push(e);return '我知道啦。';},text=>shown.push(text),controller.signal);
  const current=state([old,event('a'),event('b','attachment.shared',{}),event('reply','conversation.assistant',{text:'reply'})]);
  observe(current);observe(current);await flush();
  assert.equal(calls.length,1);assert.deepEqual(calls[0].sourceIds,['a','b']);assert.match(calls[0].description,/暂停.*图片/);
  assert.deepEqual(shown,['我知道啦。']);
});
test('failed or empty generation has visible system feedback',async()=>{
  for(const respond of [async()=>'',async()=>{throw Error('offline');}]){
    const shown=[],controller=new AbortController();
    createInteractionReactions(state([]),respond,text=>shown.push(text),controller.signal)(state([event('a')]));await flush();
    assert.equal(shown.length,1);assert.match(shown[0],/^【系统反馈】.*操作已记录/);
  }
});
test('new input while a response runs is handled next; invalid and other pets are ignored',async()=>{
  let finish;const calls=[],controller=new AbortController();
  const observe=createInteractionReactions(state([]),async(_id,e)=>{calls.push(e);if(calls.length===1)await new Promise(r=>{finish=r;});return '收到';},()=>{},controller.signal);
  observe(state([event('a')]));await flush();
  const next=state([event('a'),event('b'),event('invalid')]);next.life.invalidSources.invalid='deleted';observe(next);
  observe({...state([event('other')]),petId:'other'});finish();await flush();
  assert.deepEqual(calls.map(c=>c.sourceIds),[['a'],['b']]);
});
test('shutdown cancels a stalled generation without later publication',async()=>{
  const controller=new AbortController(),shown=[];
  const observe=createInteractionReactions(state([]),async()=>new Promise(()=>{}),text=>shown.push(text),controller.signal);
  observe(state([event('a')]));await flush();controller.abort();await flush();
  assert.deepEqual(shown,[]);
});
test('machine ticks and automatic worksite transfers do not trigger manual reactions',()=>{
  for(const e of [event('a','interaction.requested'),event('b','action.pending'),event('c','interaction.worksite',{action:'enter-voluntary'})])assert.equal(interactionDescription(e),undefined);
});
test('care panel never mistakes an old thought for the new response',async()=>{
  const adapter=createLegacyRequestAdapter({store:{},gate:{signal:new AbortController().signal},domain:{},humanity:{snapshot:async()=>({lastThought:'旧的感受'})},resolvePet:()=>({petId:'main'}),service:async()=>({ok:true,status:'done',actionId:'test'}),waitCareResponse:async()=>undefined});
  const result=await adapter('/humanity/care','POST',JSON.stringify({action:'water'}));
  assert.match(result.obj.text,/照料已完成.*等她回应/);assert.doesNotMatch(result.obj.text,/旧的感受/);
});
test('manual service receipts distinguish failure, uncertainty and real completion',()=>{
  const current=state([{eventId:'request',type:'service.requested',source:'user'}]);
  current.life.actions=[{id:'rice',actionType:'service.buy-rice',sourceIds:['request']}];
  assert.match(interactionDescription(event('r','action.receipt',{actionId:'rice',status:'UNKNOWN'}),current),/尚未确认/);
  assert.match(interactionDescription(event('r','action.receipt',{actionId:'rice',status:'COMPLETED'}),current),/已确认完成/);
  current.life.actions[0].actionType='care.water';
  assert.equal(interactionDescription(event('r','action.receipt',{actionId:'rice',status:'COMPLETED'}),current),undefined);
  assert.match(interactionDescription(event('r','action.receipt',{actionId:'rice',status:'CANCELLED'}),current),/已中断/);
});
test('UI requests time out visibly and never instruct a blind repeat of a write',async()=>{
  const source=await readFile(new URL('../src/ui/bridge.js',import.meta.url),'utf8');
  const helper=source.slice(source.indexOf('async function fetchResult('),source.indexOf('async function request('));
  let expire,cleared=false;
  const context={AbortController,setTimeout:fn=>{expire=fn;return 1;},clearTimeout:()=>{cleared=true;},fetch:(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))))};
  const result=vm.runInNewContext(helper+"\nfetchResult('/write',{method:'POST'})",context);
  expire();await assert.rejects(result,/结果尚未确认.*刷新状态/);assert.equal(cleared,true);
});
