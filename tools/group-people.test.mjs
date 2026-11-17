import test from 'node:test';
import assert from 'node:assert/strict';
import {groupPeopleContext} from '../dist/host/group-people.js';

const make=(id,actorId,text,at,extra={})=>({eventId:id,type:'social.message',source:'qq',actorId,occurredAt:at,payload:{scene:'group',text,...extra}});
const owner=(id,text,at)=>({eventId:id,type:'conversation.user',source:'desktop',actorId:'dad',occurredAt:at,payload:{text}});
const a='qq-member:aaaaaaaaaaaaaaaaaaaaaaaa',b='qq-member:bbbbbbbbbbbbbbbbbbbbbbbb';
const d=n=>`2026-11-${String(n).padStart(2,'0')}T00:00:00Z`;

test('names and later changes stay attached to unique actor and retain evidence',()=>{
 const state={invalidSources:{},events:[make('a',a,'你好',d(1),{nickname:'小鲸'}),make('b',b,'你好',d(2),{nickname:'小鲸'}),owner('c',`${a} 就是小金鲸啊`,d(3)),make('d',a,'我现在叫蓝鲸',d(4)),make('e',a,'你好',d(5),{nickname:'大蓝鲸'})]};
 const people=groupPeopleContext(state), first=people.find(p=>p.actorId===a), second=people.find(p=>p.actorId===b);
 assert.equal(people.length,2);assert.equal(first.currentName,'大蓝鲸');
 assert.deepEqual(first.history,['小鲸','小金鲸','蓝鲸','大蓝鲸']);
 assert.deepEqual(first.sourceIds,['a','c','d','e']);assert.equal(second.currentName,'小鲸');
 assert.equal(groupPeopleContext(state,[b]).length,1);
 state.invalidSources.e='removed';assert.equal(groupPeopleContext(state,[a])[0].currentName,'蓝鲸');
});

test('dad mapping and self introductions have explicit speakers; quoted or unsupported claims do not rename others',()=>{
 const state={invalidSources:{},events:[owner('one',`群友${a}\n就是小金鲸啊`,d(1)),make('two',b,`${a}就是骗子`,d(2)),make('three',b,'我叫了',d(3)),make('four',b,'我叫小蓝',d(4))]};
 const people=groupPeopleContext(state);assert.equal(people[0].actorId,a);assert.equal(people[1].currentName,'小蓝');assert.deepEqual(people[1].sourceIds,['four']);
});

test('an old nickname remains searchable after many changes and observations',()=>{
 const state={invalidSources:{},events:Array.from({length:12},(_,i)=>make(`n${i}`,a,'你好',d(i+1),{nickname:`昵称${i}`}))};
 state.events.push(make('repeat',a,'你好',d(13),{nickname:'昵称11'}));
 const person=groupPeopleContext(state,undefined,'昵称0是谁')[0];
 assert.ok(person.history.includes('昵称0'));assert.equal(person.currentName,'昵称11');
 assert.ok(person.sourceIds.includes('repeat'));assert.ok(!person.sourceIds.includes('n11'));
});
