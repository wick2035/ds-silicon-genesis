import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {developmentMaterial,developmentDay} from '../dist/host/development-material.js';

test('日记只读取香港当天记录，念头及其原话不会被账本采样挤掉',()=>{
  const event=(id,type,at,payload={})=>({eventId:id,type,occurredAt:at,payload,evidenceLevel:type==='self.thought'?'inferred':'observed'});
  const events=[event('yesterday','conversation.user','2026-11-14T15:59:59Z'),event('dad','conversation.user','2026-11-14T16:00:00Z',{text:'哼'}),event('thought','self.thought','2026-11-14T16:01:00Z',{text:'摸不准爸爸是不是不高兴',feeling:'心虚又馋',sourceIds:['dad']})];
  for(let i=0;i<100;i++)events.push(event('wallet'+i,'wallet.spend','2026-11-15T01:00:00Z'));
  events.push(event('revoked','self.thought','2026-11-15T02:00:00Z',{sourceIds:['bad']}));
  events.push({...event('reply','conversation.assistant','2026-11-15T03:00:00Z',{text:'钱是加了，可我心里还没顺过来。',sourceIds:['dad']}),evidenceLevel:'inferred'});
  const state={life:{events,invalidSources:{bad:'已删除'}}},original=structuredClone(state);
  const material=developmentMaterial(state,'2026-11-15');
  assert.ok(material.some(e=>e.id==='dad'));assert.match(material.find(e=>e.id==='thought').text,/心虚又馋/);
  assert.ok(material.find(e=>e.id==='thought').subjective);assert.ok(!material.some(e=>['yesterday','revoked'].includes(e.id)));
  assert.match(material.find(e=>e.id==='reply').text,/心里还没顺过来/);
  assert.ok(material.length<10);assert.deepEqual(state,original);
  assert.equal(developmentDay('2026-11-14T16:00:00Z'),'2026-11-15');
});

test('补写的日记归到日记日期，保留实际整理时间',async()=>{
  const source=await readFile(new URL('../src/ui/app.js',import.meta.url),'utf8');
  const helpers=source.slice(source.indexOf('const esc='),source.indexOf('function settings('));
  const data={diaries:{'2026-11-14':{canonicalMemoryId:'diary-memory'}},memories:[{id:'diary-memory',content:'本鱼心里还没顺过来。',createdAt:'2026-11-15T08:00:00Z',kind:'autobiographical',sourceIds:[],valid:true}]};
  const html=runInNewContext(helpers+'\ngrowth(data)',{data,Date,Intl});
  assert.match(html,/日记 · 2026-11-14 · 整理于/);
  const day=html.indexOf('datetime="2026-11-14"');assert.ok(day>=0);assert.ok(html.indexOf('本鱼心里还没顺过来。')>day);
});

test('每日浏览显示最新日期与最新内容，保留空白日期，不改写聊天事件顺序',async()=>{
  const source=await readFile(new URL('../src/ui/app.js',import.meta.url),'utf8');
  const helpers=source.slice(source.indexOf('function recordDay('),source.indexOf('function timeline('));
  const items=[{at:'2026-11-12T23:00:00Z',text:'旧记录'},{at:'2026-11-14T23:00:00Z',text:'较早'},{at:'2026-11-15T02:00:00Z',text:'最新'}],original=structuredClone(items);
  const html=runInNewContext(helpers+"\ndailyRows(items,e=>e.text,'at','记忆')",{items,rows:(arr,fn)=>arr.map(fn).join(''),empty:String,Date,Intl});
  assert.ok(html.indexOf('最新')<html.indexOf('较早'));assert.ok(html.indexOf('较早')<html.indexOf('旧记录'));
  assert.match(html,/2026-11-14/);assert.match(html,/这一天没有记忆记录/);assert.deepEqual(items,original);
});
