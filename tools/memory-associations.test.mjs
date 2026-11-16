import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../dist/kernel/index.js';
import {recallDocuments,lexicalRecall,memoryGraph} from '../dist/host/memory-associations.js';
import {promptData} from '../dist/host/prompt-data.js';

const at='2026-11-14T05:00:00.000Z';
const event=(id,type,text,extra={})=>({eventId:id,petId:'main',type,source:'desktop',actorId:'dad',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{text},...extra});
test('原始私聊可按话题回忆，未完成、群聊和失效来源不进入结果',()=>{
 const s=createInitialState('main',at);
 s.events.push(event('chat-user:a','conversation.user','我昨天喝了茉莉花茶'),event('chat-assistant:a','conversation.assistant','本鱼想尝尝', {causationId:'chat-user:a'}),event('chat-user:pending','conversation.user','还没回复的茉莉花茶'),event('group','conversation.user','群友喜欢茉莉花茶',{source:'qq-group',actorId:'qq-member:42'}));
 let docs=recallDocuments(s),found=lexicalRecall(docs,'茉莉花茶',8);assert.equal(found.length,1);assert.match(found[0].content,/爸爸：我昨天喝了茉莉花茶/);assert.match(found[0].content,/大肥鱼：本鱼想尝尝/);
 s.invalidSources['chat-user:a']='删除';docs=recallDocuments(s);assert.equal(lexicalRecall(docs,'茉莉花茶').length,0);assert.equal(memoryGraph(s,'茉莉花茶').nodes.length,0);
});
test('记忆和原文共享来源可显示关系，修正后旧内容失效',()=>{
 const s=createInitialState('main',at);s.events.push(event('user','conversation.user','爸爸喜欢茉莉花茶'));
 s.memories.push({id:'old',kind:'semantic',content:'爸爸喜欢茉莉花茶',sourceIds:['user'],evidenceLevel:'reported',valid:true,createdAt:at});
 let graph=memoryGraph(s,'茉莉花茶');assert.equal(graph.nodes.length,2);assert.equal(graph.edges[0].kind,'source');
 s.memories[0].valid=false;s.invalidSources.old='纠正';graph=memoryGraph(s,'茉莉花茶');assert.equal(graph.nodes.length,1);
});
test('群聊按群友身份和群渠道保留，不与私聊混为一人',()=>{
 const s=createInitialState('main',at);s.events.push(event('group-user','conversation.user','群友喜欢乌龙茶',{source:'qq-group',actorId:'qq-member:42',payload:{text:'群友喜欢乌龙茶',groupId:'g1'}}));
 const doc=recallDocuments(s).find(d=>d.id==='conversation:group-user');assert.match(doc.content,/群友-.*42/);assert.equal(doc.channel,'qq-group:g1');
});
test('压缩排序结果时优先保留排名靠前的内容',()=>{
 const items=Array.from({length:8},(_,i)=>({id:'item'+i,text:'内容'.repeat(100)}));
 const output=JSON.parse(promptData(items,400,{arrayOrder:'first'}));assert.equal(output[0].id,'item0');assert.ok(output.length<items.length);
});
