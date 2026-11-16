import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../dist/kernel/index.js';
import {recallDocuments,lexicalRecall,memoryGraph} from '../dist/host/memory-associations.js';
import {CanonicalMemoryRetrieval} from '../dist/host/memory-retrieval.js';
import {forcedWorkEpisodes,asksAboutForcedWork,evidenceMemoryPrompt} from '../dist/host/memory-evidence.js';

const at=n=>`2026-11-15T09:${String(n).padStart(2,'0')}:00.000Z`;
const event=(id,type,time,payload,extra={})=>({eventId:id,petId:'main',type,source:'executor',occurredAt:time,receivedAt:time,evidenceLevel:'observed',payload,...extra});
function fixture(){
 const s=createInitialState('main',at(0));
 s.events.push(event('button-old','interaction.worksite',at(1),{action:'force-work'},{source:'user'}),event('button-new','interaction.worksite',at(2),{action:'force-work'},{source:'user'}));
 for(const [n,pain] of [[3,'2 → 6'],[4,'79 → 82']]){
  const result='result'+n,body='body'+n;
  s.events.push(event(result,'action.receipt',at(n),{status:'COMPLETED'}),event(body,'body.forced-labor',at(n),{sourceIds:['button-new',result],description:`被迫搬运；疼痛 ${pain}，压力 96 → 98，恐惧 99 → 100。`},{causationId:result}));
  s.memories.push({id:'memory'+n,kind:'autobiographical',content:`被迫搬运；疼痛 ${pain}，压力 96 → 98，恐惧 99 → 100。`,sourceIds:[body],evidenceLevel:'observed',valid:true,createdAt:at(n)});
 }
 s.events.push(event('context','body.action',at(5),{description:'白饭碗被收进柜子'}));
 s.memories.push({id:'other',kind:'episodic',content:'我看到东西不见了',sourceIds:['context'],evidenceLevel:'observed',valid:true,createdAt:at(5)});
 return s;
}
test('按钮真实回执组成最近经历，图谱和聊天均优先提供历史指标',async()=>{
 const s=fixture();const episodes=forcedWorkEpisodes(s);assert.equal(episodes[0].id,'worksite-episode:button-new');assert.match(episodes[0].content,/疼痛 2 → 6/);assert.match(episodes[0].content,/疼痛 79 → 82/);assert.match(episodes[0].content,/不是当前数值/);
 const q='你好好回忆一下上次我按下按钮发生了什么';assert.match(memoryGraph(s,q).nodes[0].id,/button-new/);
 // A stale index and an unhelpful reranker cannot hide primary observed evidence.
 const index={candidates:async()=>new Set(['memory:other'])};const ranker={score:async(_q,docs)=>docs.map(()=>0)};
 const search=new CanonicalMemoryRetrieval({},undefined,ranker,index);const found=await search.search('main',q,8,s);
 assert.equal(found[0].id,'worksite-episode:button-new');assert.match(found[0].content,/恐惧 99 → 100/);
 assert.match(evidenceMemoryPrompt([...found,...Array(10).fill({id:'noise',content:'x'.repeat(1000)})],s),/疼痛 79 → 82/);
 for(const text of ['强制干活','强制开工','强迫搬砖','搬砖按钮','强制工作'])assert.equal((await search.search('main',text,8,s))[0].id,'worksite-episode:button-new');
});
test('事件来源被撤销、回执失败、记忆被删除时不会伪造结果',()=>{
 const s=fixture();s.invalidSources.result4='撤销';let episode=forcedWorkEpisodes(s)[0];assert.match(episode.content,/疼痛 2 → 6/);assert.doesNotMatch(episode.content,/79 → 82/);
 s.memories.find(m=>m.id==='memory3').valid=false;episode=forcedWorkEpisodes(s)[0];assert.match(episode.content,/没有找到关联的有效用力回执/);assert.doesNotMatch(episode.content,/疼痛/);
 s.invalidSources['button-new']='撤销';assert.equal(forcedWorkEpisodes(s)[0].id,'worksite-episode:button-old');
 const t=fixture();t.events.find(e=>e.eventId==='result4').payload.status='FAILED';assert.doesNotMatch(forcedWorkEpisodes(t)[0].content,/79 → 82/);
});
test('一般经历也可按来源描述检索，避免借关联暴露已删除来源',async()=>{
 const s=fixture();assert.equal(lexicalRecall(recallDocuments(s),'柜子',8)[0].memory.id,'other');
 const index={candidates:async()=>new Set(['unrelated'])};const search=new CanonicalMemoryRetrieval({},undefined,undefined,index);
 assert.equal((await search.search('main','柜子',8,s))[0].id,'other');
 s.invalidSources.context='删除';assert.equal(lexicalRecall(recallDocuments(s),'柜子',8).length,0);
 assert.equal(asksAboutForcedWork('手机音量按钮怎么按'),false);
});
