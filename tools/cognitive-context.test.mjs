import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState,workspace} from '../dist/kernel/index.js';
import {createCognitiveModel} from '../dist/host/cognitive-model.js';

test('growing relationship evidence and group history cannot block autonomous moments',async()=>{
  const at='2026-11-20T03:00:00.000Z',snapshot=workspace(createInitialState('main',at));
  const sourceIds=Array.from({length:4000},(_,i)=>'conversation:'+String(i).padStart(40,'0'));
  snapshot.relationships=[{personId:'dad',familiarity:95,trust:80,sourceIds,openCommitments:2,outstandingWages:12}];
  snapshot.legacyContext={personaDescription:'大肥鱼',traits:{},interests:[],skills:[],strategies:[],attempts:[],
    companion:{time:{now:at},food:{balance:3,inventory:[{id:'bowl',status:'available'}]},
      groupActivity:Array.from({length:12},(_,i)=>({id:'group:'+i,actorId:'qq-member:friend',text:'群友分享的经历'.repeat(100)})),
      money:{recentChanges:Array.from({length:6},(_,i)=>({id:'money:'+i,detail:{text:'历史账目'.repeat(200)}}))}}};
  const moment={text:'今天浇完水，突然觉得等水稻长大也挺有意思。',sourceId:'farm'};
  snapshot.recentEvents=[{eventId:'farm',type:'farm.tended',occurredAt:at,evidenceLevel:'observed',payload:'给水稻浇水',momentSource:true},
    ...Array.from({length:18},(_,i)=>({eventId:'chat:'+i,type:'conversation.user',occurredAt:at,evidenceLevel:'reported',payload:'聊天内容'.repeat(180),
      speakers:[{id:'speaker:'+i,actorId:'qq-member:friend',text:'朋友说的话'.repeat(180)}]}))];
  snapshot.relevantMemories=Array.from({length:12},(_,i)=>({id:'memory:'+i,kind:'episodic',content:'旧记忆'.repeat(900),sourceIds:['farm'],valid:true,evidenceLevel:'observed',createdAt:at}));
  const before=structuredClone(snapshot);
  let request;
  const model=createCognitiveModel({async *stream(input){request=input;yield {type:'text',text:JSON.stringify({action:null,goals:[],plan:[],interests:[],selfModel:[],moment})};}},()=>({provider:'test',model:'test'}));
  const result=await model.generate(snapshot,new AbortController().signal,{observation:[],recall:[],appraisal:[],motivations:[],rankedGoals:[]});
  assert.ok(request.messages[0].content.length<=30000);
  const sent=JSON.parse(request.messages[0].content).当前;
  assert.deepEqual(sent.relationships[0],{...snapshot.relationships[0],sourceIds:sourceIds.slice(-2)});
  assert.deepEqual(sent.legacyContext.companion.food,snapshot.legacyContext.companion.food);
  assert.deepEqual(sent.constraints,snapshot.constraints);
  assert.ok(sent.recentEvents.some(e=>e.eventId==='chat:17'));
  assert.ok(sent.recentEvents.some(e=>e.eventId==='farm'&&e.momentSource));
  assert.match(request.system,/本轮有可分享的新经历/);
  assert.deepEqual(result.moment,moment);
  assert.deepEqual(snapshot,before);
});
