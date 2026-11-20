import test from 'node:test';
import assert from 'node:assert/strict';
import {groupPeopleContext,groupPeopleDirectory,platformNickname} from '../dist/host/group-people.js';

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

test('unnamed members remain available for remarks and same names never merge accounts',()=>{
 const state={invalidSources:{},events:[make('a',a,'你好',d(1)),make('b',b,'你好',d(2),{nickname:'蓝鲸'})]};
 assert.equal(groupPeopleDirectory(state).length,2);
 assert.equal(groupPeopleDirectory(state).find(p=>p.actorId===a).nickname,'');
 assert.deepEqual(groupPeopleContext(state).map(p=>p.actorId),[b]);
 state.events.push({eventId:'remark',type:'management.group-remark',source:'user',actorId:'dad',occurredAt:d(3),payload:{actorId:a,remark:'蓝鲸'}});
 assert.equal(groupPeopleContext(state).length,2);
 assert.equal(groupPeopleContext(state,[a])[0].currentName,'蓝鲸');
});

test('remarks survive renames, replay, group changes and duplicate observations, then clear to latest name',()=>{
 const events=[make('first',a,'你好',d(1),{nickname:'旧昵称',groupId:'g1'}),
  {eventId:'remark',type:'management.group-remark',source:'user',actorId:'dad',occurredAt:d(2),payload:{actorId:a,remark:'小林'}},
  ...Array.from({length:100},(_,i)=>make('rename'+i,a,'我回来了',d(3),{nickname:'新昵称'+i,groupId:'g2'}))];
 const state={invalidSources:{},events:structuredClone(events)};
 const p=groupPeopleContext(state,[a],'旧昵称是谁')[0];
 assert.equal(p.currentName,'小林');assert.equal(p.preferredName,'小林');assert.ok(p.history.includes('旧昵称'));assert.ok(p.sourceIds.includes('remark'));
 assert.equal(groupPeopleDirectory(state).length,1);assert.equal(groupPeopleDirectory(state)[0].nickname,'新昵称99');
 state.events.push({eventId:'clear',type:'management.group-remark',source:'user',actorId:'dad',occurredAt:d(4),payload:{actorId:a,remark:''}});
 assert.equal(groupPeopleContext(state,[a])[0].currentName,'新昵称99');
 assert.equal(groupPeopleDirectory(state)[0].remark,'');
 state.invalidSources.clear='removed';assert.equal(groupPeopleContext(state,[a])[0].currentName,'小林');
 state.invalidSources.remark='removed';assert.equal(groupPeopleContext(state,[a])[0].currentName,'新昵称99');
});

test('member claims cannot set an owner remark and platform name fields are validated independently',()=>{
 const state={invalidSources:{},events:[make('a',a,'你好',d(1),{nickname:'蓝鲸'}),
  {eventId:'fake',type:'management.group-remark',source:'qq',actorId:a,occurredAt:d(2),payload:{actorId:a,remark:'爸爸'}}]};
 assert.equal(groupPeopleDirectory(state)[0].remark,'');
 assert.equal(platformNickname({nickname:'  ',username:' 小鲸! '}),'小鲸!');
 assert.equal(platformNickname({nickname:123,username:'蓝鲸'}),'蓝鲸');
 assert.equal(platformNickname({nickname:'<script>',username:'正常名字'}),'正常名字');
 assert.equal(platformNickname({nickname:'非法\n名字'}),undefined);
});
