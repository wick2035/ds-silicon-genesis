import test from 'node:test';
import assert from 'node:assert/strict';
import {Cognition} from '../dist/cognition/index.js';
import {CognitiveResultCoordinator} from '../dist/host/cognitive-result.js';
import {createLifeApi, createLifeManagement} from '../dist/host/life-api.js';
import {createInitialState, invalidateDependents} from '../dist/kernel/index.js';
import {momentEventType, momentSources} from '../dist/kernel/moments.js';

function event(id, type, at, payload, extra = {}) {
  const stamp = new Date(at).toISOString();
  return {eventId:id, petId:'main', type, source:'fixture', occurredAt:stamp, receivedAt:stamp, evidenceLevel:'observed', payload, ...extra};
}

test('说说选题有真实近期来源，同一件事和账目流水不会重复占位', () => {
  const now = Date.parse('2026-11-19T14:00:00Z');
  const history = {invalidSources:{}, events:[
    event('rain', 'farm.weather', now - 18_000_000, {weather:'light-rain'}),
    event('rain-thought', 'self.thought', now - 60_000, {text:'我还惦记着苗', sourceIds:['rain']}),
    event('wallet', 'wallet', now - 10_000, {text:'饭钱到账'}),
    event('wallet-thought', 'self.thought', now - 5000, {text:'我想留着下次用', sourceIds:['wallet']}),
    event('absent-source', 'self.thought', now - 3000, {sourceIds:['missing']}),
    event('fail', 'action.receipt', now - 1000, {actionType:'labor.step', status:'FAILED'}),
    event('old', 'farm.tended', now - 90_000_000, {operation:'harvest'}),
    event('post', momentEventType, now - 10_800_000, {sourceIds:['rain']})
  ]};
  assert.deepEqual([...momentSources(history, now)], [['wallet-thought', '爸爸调整了饭钱']]);
  history.invalidSources.wallet = '已删除';
  assert.equal(momentSources(history, now).size, 0);
});

test('说说按香港日期最多两条，并跨日保留两小时的间隔', () => {
  const now = Date.parse('2026-11-19T15:59:00Z');
  const hour = 3_600_000;
  const first = event('first', momentEventType, now - 9 * hour, {});
  const second = event('second', momentEventType, now - 3 * hour, {});
  const rain = event('rain', 'farm.weather', now - 60_000, {weather:'light-rain'});
  const history = {invalidSources:{}, events:[first, second, rain]};
  assert.equal(momentSources(history, now).size, 0);
  assert.ok(momentSources(history, now + 60_000).has('rain'));
  second.occurredAt = new Date(now - 60_000).toISOString();
  assert.equal(momentSources(history, now + 60_000).size, 0);
});

test('说说沿用认知调用和成长接口，撤下来源失效的内容', async () => {
  const now = Date.now();
  let state = createInitialState('main', new Date(now - 5000).toISOString());
  state.constraints.paused = false;
  state.events.push(event('field', 'farm.tended', now - 2000, {operation:'water'}));
  state.events.push(event('thought', 'self.thought', now - 1000, {sourceIds:['field'], text:'本鱼看着水光开心'}));
  const memory = {id:'memory:thought', kind:'autobiographical', content:'本鱼看着水光开心', sourceIds:['thought', 'field'], evidenceLevel:'inferred', valid:true, createdAt:new Date(now-1000).toISOString()};
  state.memories.push(memory);
  const budget = {reserve:async()=>({}), withReserved:async(_id, _ticket, call)=>call()};
  const retrieval = {forCognition:async()=>[], world:async()=>({space:{}, inventory:[], capabilities:[], recentResults:[]})};
  let draft = {text:'浇完水还想在田边多待一会儿。', sourceId:'thought'}, calls = 0;
  const cognition = new Cognition({generate:async snapshot=>{
    calls++;
    assert.ok(snapshot.recentEvents.some(item=>item.eventId==='thought' && item.momentSource));
    return {moment:draft, action:null, goals:[], plan:[], interests:[], selfModel:[]};
  }}, budget, retrieval);
  const signal = new AbortController().signal;
  const propose = ()=>cognition.propose(state, signal, async()=>structuredClone(state));
  const accepted = await propose();
  assert.equal(accepted.status, 'proposed', accepted.reason);
  assert.equal(calls, 1);
  assert.deepEqual(accepted.candidates.moment, draft);
  for (draft of [{text:'没引用真实经历', sourceId:'unknown'}, {text:'太长'.repeat(100), sourceId:'thought'}]) {
    const rejected = await propose();
    assert.equal(rejected.status, 'proposed');
    assert.equal(rejected.candidates.moment, undefined);
  }

  const gate = {signal, run:async(_id, task)=>task()};
  const reader = {loadEnvelope:async()=>({version:state.version, life:structuredClone(state)})};
  const uow = {apply:async(_id, version, mutate)=>{
    const envelope = await reader.loadEnvelope();
    assert.equal(version, envelope.version);
    mutate(envelope);
    state = {...envelope.life, version:version+1};
  }};
  const projectBody = ()=>({body:state.body, emotions:state.emotions});
  const coordinator = new CognitiveResultCoordinator(reader, uow, gate, projectBody, {}, {});
  await coordinator.accept('main', accepted, signal);
  await coordinator.accept('main', accepted, signal);
  const api = createLifeApi({authorize:()=>true, petId:()=>state.petId, getState:async()=>state});
  const get = async endpoint=>(await (await api(new Request('http://localhost/api/life/'+endpoint))).json()).value;
  const {moments} = await get('growth');
  assert.equal(moments.length, 1);
  assert.equal(moments[0].text, accepted.candidates.moment.text);
  assert.equal(moments[0].context, '给稻田浇了水');
  assert.ok(!(await get('timeline')).some(item=>item.type===momentEventType));
  assert.equal(state.memories.length, 1);
  const posted = structuredClone(state);
  state.invalidSources.field = '来源已撤下';
  invalidateDependents(state);
  assert.deepEqual((await get('growth')).moments, []);
  state = posted;
  const manage = createLifeManagement(reader, gate, uow, projectBody);
  await manage('main', {kind:'memory', action:'delete', id:memory.id, expectedContent:memory.content, version:state.version, reason:'不再保留这个念头'});
  assert.deepEqual((await get('growth')).moments, []);
});
