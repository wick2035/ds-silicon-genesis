import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {developmentMaterial,developmentDay} from '../dist/host/development-material.js';

test('大量群聊与念头的身份资料也计入预算，材料再多仍可生成且不改原档',()=>{
  const date='2026-11-20',events=[];
  for(let i=0;i<400;i++)events.push({eventId:'group-message:'+String(i).padStart(64,'a'),type:'social.message',source:'qq-group',actorId:i%3?'qq-member:'+String(i).padStart(32,'b'):'dad',occurredAt:date+'T'+String(Math.floor(i/20)%16).padStart(2,'0')+':00:00Z',evidenceLevel:'observed',payload:{text:'我今天想聊聊白饭与开心的事。'.repeat(80),groupId:'group'}});
  for(let i=0;i<48;i++){
    const sources=events.slice(i,i+16).map(e=>e.eventId),at=date+'T'+String(i%16).padStart(2,'0')+':10:00Z';
    events.push({eventId:'batch:'+i,type:'conversation.user',source:'qq-group',occurredAt:at,evidenceLevel:'observed',payload:{groupBatch:true,sourceIds:sources,text:'群聊'.repeat(600)}});
    events.push({eventId:'thought:'+i,type:'self.thought',source:'model',occurredAt:at,evidenceLevel:'inferred',payload:{text:'我有点委屈，也很想吃饭。'.repeat(60),sourceIds:['batch:'+i]}});
  }
  const state={life:{events,invalidSources:{}}},before=structuredClone(state),material=developmentMaterial(state,date);
  assert.ok(material.length>0);assert.ok(JSON.stringify(material).length<=24000);assert.ok(material.some(e=>e.type==='self.thought'));assert.ok(material.some(e=>e.type==='social.message'||e.type==='conversation.user'));
  for(const entry of material){assert.ok(events.some(e=>e.eventId===entry.id));for(const speaker of entry.speakers??[])assert.equal(speaker.actorId,events.find(e=>e.eventId===speaker.id).actorId);}
  assert.deepEqual(state,before);assert.deepEqual(developmentMaterial(state,date),material);
});

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
  const data={diaryDates:{'diary-memory':'2026-11-14'},memories:[{id:'diary-memory',content:'本鱼心里还没顺过来。',createdAt:'2026-11-15T08:00:00Z',kind:'autobiographical',sourceIds:[],valid:true}]};
  const [html,entry]=runInNewContext(helpers+"\n[growth(data),deferredDayRecords.get('2026-11-14')?.()]",{data,Date,Intl,view:{addEventListener(){}}});
  assert.match(html,/datetime="2026-11-14"/);
  assert.match(entry??html,/日记 · 2026-11-14 · 整理于/);
  assert.match(entry??html,/本鱼心里还没顺过来。/);
});

test('每日浏览显示最新日期与最新内容，保留空白日期，不改写聊天事件顺序',async()=>{
  const source=await readFile(new URL('../src/ui/app.js',import.meta.url),'utf8');
  const helpers=source.slice(source.indexOf('const recordCalendar='),source.indexOf('function timeline('));
  const items=[{at:'2026-11-12T23:00:00Z',text:'旧记录'},{at:'2026-11-14T23:00:00Z',text:'较早'},{at:'2026-11-15T02:00:00Z',text:'最新'}],original=structuredClone(items);
  const [html,newest,gap,old]=runInNewContext(helpers+
    "\n[dailyRows(items,e=>e.text,'at','记忆'),deferredDayRecords.get('2026-11-15')?.(),deferredDayRecords.get('2026-11-14')?.(),deferredDayRecords.get('2026-11-13')?.()]",
    {items,rows:(arr,fn)=>arr.map(fn).join(''),empty:String,Date,Intl,view:{addEventListener(){}}});
  assert.match(newest??html,/最新较早/);
  assert.match(html,/2026-11-14/);assert.equal(gap,'这一天没有记忆记录。');assert.equal(old,'旧记录');
  assert.doesNotMatch(html,/旧记录/);assert.deepEqual(items,original);
});
