import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorksiteReactions} from '../dist/host/worksite-reactions.js';

const state=events=>({petId:'main',life:{events,invalidSources:{}}});
const event=(eventId,action)=>({eventId,type:'interaction.worksite',payload:{action}});
const flush=()=>new Promise(setImmediate);

test('reacts once to each new manual transfer and ignores old or automatic events',async()=>{
  const old=event('old','enter-forced'),calls=[],published=[];
  const observe=createWorksiteReactions(state([old]),async(_id,e)=>{calls.push(e);return '接到啦。';},async(...args)=>published.push(args));
  const current=state([old,event('auto','enter-voluntary'),event('touch','touch'),event('in','enter-forced'),event('out','release')]);
  observe(current);observe(current);await flush();await flush();
  assert.deepEqual(calls.map(x=>x.eventId),['touch','in','out']);
  assert.deepEqual(published.map(x=>[x[1].action,x[2],x[3]]),[['touch','接到啦。',false],['enter-forced','接到啦。',false],['release','接到啦。',false]]);
});

test('does not invent speech when the model cannot respond',async()=>{
  const published=[];const observe=createWorksiteReactions(state([]),async()=>{throw Error('model unavailable');},async(...args)=>published.push(args));
  observe(state([event('out','release')]));await flush();await flush();
  assert.equal(published.length,1);assert.match(published[0][2],/^【系统反馈】/);assert.equal(published[0][3],true);
});
