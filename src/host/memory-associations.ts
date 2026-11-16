import type {LifeState,Memory} from '../kernel/types.js';
import {isOwnerPrivateConversation,groupSpeaker} from './chat-identity.js';
import {forcedWorkEpisodes,asksAboutForcedWork} from './memory-evidence.js';

/** A bounded, disposable view over the canonical archive. The archive, not
 * this projection, decides whether a record or its source is still valid. */
export type RecallDocument={id:string;content:string;sourceIds:string[];createdAt:string;kind:'memory'|'conversation';channel?:string;memory?:Memory;terms:string[];linkedTerms?:string[]};
const stop=new Set(['什么','怎么','这个','那个','我们','你们','自己','记得','记住','一下','可以','是否','就是','没有','一个','今天','昨天']);
const live=(state:LifeState,id:string)=>!Object.hasOwn(state.invalidSources,id);
export function recallTerms(text:string):string[]{
  const out:string[]=[];
  for(const t of text.normalize('NFKC').toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu)||[]){
    if(!/\p{Script=Han}/u.test(t)){out.push(t);continue;}
    if(t.length===1)continue;
    for(let i=0;i<t.length-1;i++){const term=t.slice(i,i+2);if(!stop.has(term))out.push(term);}
  }
  return out;
}
export function recallDocuments(state:LifeState):RecallDocument[]{
  const bySource=new Map(state.events.map(e=>[e.eventId,e]));
  const evidenceTerms=(ids:string[])=>{
    const seen=new Set<string>(),queue=ids.map(id=>({id,depth:0})),terms:string[]=[];
    for(let i=0;i<queue.length&&i<40;i++){
      const {id,depth}=queue[i];if(seen.has(id)||!live(state,id))continue;seen.add(id);
      const event=bySource.get(id);if(!event)continue;const payload=event.payload as any;
      if(typeof payload?.description==='string')terms.push(...recallTerms(payload.description));
      if(depth<2&&Array.isArray(payload?.sourceIds))for(const source of payload.sourceIds)if(typeof source==='string')queue.push({id:source,depth:depth+1});
    }
    return [...new Set(terms)];
  };
  const docs:RecallDocument[]=state.memories.filter(m=>m.valid&&live(state,m.id)&&m.sourceIds.every(id=>live(state,id))&&m.content.trim())
    .map(m=>{const linkedTerms=evidenceTerms(m.sourceIds);return {id:'memory:'+m.id,content:m.content,sourceIds:m.sourceIds,createdAt:m.createdAt,kind:'memory',memory:m,linkedTerms,terms:[...recallTerms(m.content),...linkedTerms]};});
  for(const m of forcedWorkEpisodes(state))docs.push({id:'memory:'+m.id,content:m.content,sourceIds:m.sourceIds,createdAt:m.createdAt,kind:'memory',memory:m,terms:recallTerms(m.content)});
  const events=state.events,byId=new Map(events.map(e=>[e.eventId,e]));
  const eligible=(e:typeof events[number])=>(isOwnerPrivateConversation(e)||(e.source==='qq-group'&&['conversation.user','conversation.assistant'].includes(e.type)&&typeof (e.payload as any)?.groupId==='string'))&&live(state,e.eventId)&&
    (!e.causationId||byId.has(e.causationId)&&live(state,e.causationId))&&
    (!Array.isArray((e.payload as any)?.sourceIds)||(e.payload as any).sourceIds.every((id:string)=>byId.has(id)&&live(state,id)))&&
    (e.source==='qq-group'||e.type!=='conversation.user'||!e.actorId||e.actorId==='dad')&&typeof (e.payload as any)?.text==='string'&&!!(e.payload as any).text.trim()&&!(e.payload as any).silent;
  const valid=events.filter(eligible),repliesByUser=new Map<string,typeof events[number]>();
  for(const e of valid)if(e.type==='conversation.assistant'&&e.causationId&&!repliesByUser.has(e.causationId))repliesByUser.set(e.causationId,e);
  for(const e of valid){
    if(e.type!=='conversation.user'||e.source!=='qq-group'&&e.eventId.startsWith('chat-user:')&&!repliesByUser.has(e.eventId))continue;
    let reply=repliesByUser.get(e.eventId);const isGroup=e.source==='qq-group';let deliveryId:string|undefined;
    if(isGroup&&reply){
      const incoming=Array.isArray((e.payload as any).sourceIds)?(e.payload as any).sourceIds:[];
      const action=state.actions.find(a=>a.actionType==='qq.send'&&a.status==='COMPLETED'&&a.parameters.scene==='group'&&a.parameters.content===(reply!.payload as any).text&&a.sourceIds.some(id=>incoming.includes(id)));
      const receipt=state.receipts.find(r=>r.actionId===action?.id&&r.receiptId===action?.receiptId&&r.status==='COMPLETED'&&r.details?.kind==='qq.send'&&typeof r.details.messageId==='string'&&live(state,r.receiptId));
      const delivery=receipt?events.find(x=>x.type==='action.receipt'&&x.causationId===receipt.receiptId&&(x.payload as any)?.actionId===action?.id&&live(state,x.eventId)):undefined;
      if(!delivery)reply=undefined;else deliveryId=delivery.eventId;
    }
    const items=reply?[e,reply]:[e];
    const individual=isGroup&&(e.payload as any).groupBatch===true?((e.payload as any).sourceIds||[]).map((id:string)=>byId.get(id)).filter(Boolean):[];
    const content=items.flatMap(x=>x===e&&individual.length?individual.map((source:any)=>`${groupSpeaker(source.actorId)}：${String(source.payload?.text||'').slice(0,600)}`):[`${x.type==='conversation.user'?(isGroup?groupSpeaker(x.actorId):'爸爸'):'大肥鱼'}：${String((x.payload as any).text).slice(0,600)}`]).join('\n');
    const incomingIds=isGroup&&Array.isArray((e.payload as any).sourceIds)?(e.payload as any).sourceIds as string[]:[];
    docs.push({id:'conversation:'+e.eventId,kind:'conversation',channel:isGroup?'qq-group:'+String((e.payload as any).groupId):e.source,content,sourceIds:[...new Set([...items.map(x=>x.eventId),...incomingIds,...(deliveryId?[deliveryId]:[])])],createdAt:e.occurredAt,terms:recallTerms(content)});
  }
  return docs;
}
export function lexicalRecall(docs:RecallDocument[],query:string,limit=8,dedupe=true):RecallDocument[]{
  const q=[...new Set(recallTerms(query))].slice(0,40);if(!q.length||!docs.length)return [];
  const df=new Map<string,number>();for(const doc of docs)for(const t of new Set(doc.terms))df.set(t,(df.get(t)||0)+1);
  const avg=docs.reduce((n,d)=>n+d.terms.length,0)/docs.length||1;
  const rank=(terms:string[])=>docs.map(d=>{const freq=new Map<string,number>();for(const t of d.terms)freq.set(t,(freq.get(t)||0)+1);let score=0;
    for(const t of terms){const tf=freq.get(t)||0;if(tf)score+=Math.log(1+(docs.length-(df.get(t)||0)+.5)/((df.get(t)||0)+.5))*tf*2.2/(tf+1.2*(.25+.75*d.terms.length/avg));}
    return {d,score};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.d.createdAt.localeCompare(a.d.createdAt));
  const initial=rank(q);if(!initial.length)return [];
  // Expand only from strong initial evidence. Shared terms are associations,
  // not factual relationships; the original query remains the dominant signal.
  const expansion=new Map<string,number>();for(const {d,score} of initial.slice(0,3))for(const t of new Set(d.terms))if(!q.includes(t)&&t.length>1){const n=df.get(t)||0;if(n>1&&n<Math.max(4,docs.length*.25))expansion.set(t,(expansion.get(t)||0)+score/(1+n));}
  const terms=[...expansion].sort((a,b)=>b[1]-a[1]).slice(0,8).map(x=>x[0]);
  const combined=new Map(initial.map(x=>[x.d.id,{d:x.d,score:x.score}]));
  if(terms.length)for(const x of rank(terms).slice(0,20)){const prior=combined.get(x.d.id);if(prior)prior.score+=x.score*.15;else combined.set(x.d.id,{d:x.d,score:x.score*.15});}
  const selected:RecallDocument[]=[];
  for(const x of [...combined.values()].sort((a,b)=>b.score-a.score||b.d.createdAt.localeCompare(a.d.createdAt))){
    if(dedupe&&selected.some(d=>d.sourceIds.some(id=>x.d.sourceIds.includes(id))))continue;
    selected.push(x.d);if(selected.length===limit)break;
  }
  return selected;
}
export function recalledMemory(d:RecallDocument):Memory{
  return d.memory??{id:d.id,kind:'episodic',content:'过去的聊天原文：\n'+d.content,sourceIds:d.sourceIds,evidenceLevel:'observed',valid:true,createdAt:d.createdAt};
}
export function memoryGraph(state:LifeState,query:string){
  const all=recallDocuments(state),docs=query.trim()?lexicalRecall(all,query,30,false):all.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30);
  if(asksAboutForcedWork(query)){const latest=all.filter(d=>d.memory?.id.startsWith('worksite-episode:')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];if(latest){const i=docs.findIndex(d=>d.id===latest.id);if(i>=0)docs.splice(i,1);docs.unshift(latest);docs.splice(30);}}
  const edges:Array<{source:string;target:string;kind:string;reason:string}>=[];
  for(let i=0;i<docs.length;i++)for(let j=i+1;j<docs.length;j++){
    const a=docs[i],b=docs[j],shared=a.sourceIds.filter(id=>b.sourceIds.includes(id));
    if(shared.length)edges.push({source:a.id,target:b.id,kind:'source',reason:'共同来源'});
    else if(a.kind==='conversation'&&b.kind==='conversation'&&a.channel===b.channel&&Math.abs(Date.parse(a.createdAt)-Date.parse(b.createdAt))<=30*60*1000)edges.push({source:a.id,target:b.id,kind:'continuity',reason:'同渠道相近时间的对话'});
    else {const terms=[...new Set(a.terms)].filter(t=>b.terms.includes(t)&&!stop.has(t));if(terms.length>=2)edges.push({source:a.id,target:b.id,kind:'terms',reason:'共同词项：'+terms.slice(0,3).join('、')});}
  }
  const sources=new Map(state.events.map(e=>[e.eventId,e]));
  return {nodes:docs.map(d=>({id:d.id,content:d.content,kind:d.kind,at:d.createdAt,channel:d.channel,sourceIds:d.sourceIds,sources:d.sourceIds.map(id=>{const e=sources.get(id);return {id,at:e?.occurredAt,channel:e?.source,speaker:e?.type==='conversation.assistant'?'大肥鱼':e?.actorId?groupSpeaker(e.actorId):undefined};})})),edges:edges.slice(0,100)};
}
