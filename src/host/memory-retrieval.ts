import type {Memory,LifeState,CognitiveWorkspace} from '../kernel/types.js';
import type {Queryable} from '../storage/postgres.js';
import {speechSources} from '../kernel/speech-provenance.js';
import {lexicalRecall,recallDocuments,recalledMemory,recallTerms,type RecallDocument} from './memory-associations.js';
import type {LocalReranker} from './local-reranker.js';
import type {MemoryIndex} from './memory-index.js';
import type {MemoryEmbedding} from './memory-embedding.js';
import {asksAboutForcedWork} from './memory-evidence.js';
import {abortable,CognitiveError,failureCode,type CognitiveDiagnostics} from '../cognition/diagnostics.js';

export type RecallOptions={signal?:AbortSignal;diagnostics?:CognitiveDiagnostics};
/** The full pipeline requires an authoritative snapshot. Archive-only SQL has
 * a separate name and cannot be selected by accidentally omitting a parameter. */
export class CanonicalMemoryRetrieval {
  constructor(private readonly db:Queryable,private readonly idle?:{snapshot():{seconds:number}|undefined},private readonly reranker?:LocalReranker,private readonly index?:MemoryIndex,private readonly embedding?:MemoryEmbedding,private readonly recallTimeoutMs=5000) {}
  async searchSnapshot(state:LifeState,query:string,limit=12,options:RecallOptions={}):Promise<Memory[]> {
    if(!state?.petId||!Array.isArray(state.events)||!Array.isArray(state.memories)||typeof query!=='string'||query.length>500||!Number.isInteger(limit)||limit<1||limit>30)throw Error('记忆查询需要当前状态');
    return this.recallBatch(state,[query],limit,options);
  }
  private async recallBatch(state:LifeState,queries:string[],limit:number,options:RecallOptions):Promise<Memory[]> {
    options.signal?.throwIfAborted();
    const merged=[...new Set(queries.map(q=>q.normalize('NFKC').trim()).filter(Boolean))],query=merged.map(q=>q.slice(0,Math.max(1,Math.floor(500/Math.max(1,merged.length))-1))).join('\n');
    const deadline=performance.now()+this.recallTimeoutMs;
    const controller=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
    const timer=setTimeout(()=>controller.abort(new CognitiveError('recall_degraded','recall_timeout')),this.recallTimeoutMs);
    const docs=recallDocuments(state),local=lexicalRecall(docs,query,24);
    const note=(mode:'hybrid'|'lexical',reason?:string)=>{if(options.diagnostics){options.diagnostics.recall={mode,reason,queries:merged.length};if(mode==='lexical')options.diagnostics.warnings=[...new Set([...(options.diagnostics.warnings??[]),'recall_degraded' as const])];}};
    const measure=async<T>(name:string,work:()=>Promise<T>)=>{const started=performance.now();try{return await abortable(work(),signal);}finally{if(options.diagnostics)options.diagnostics.stages['recall.'+name]=performance.now()-started;}};
    const finish=(ranked:RecallDocument[])=>{
      const episode=asksAboutForcedWork(query)?docs.filter(d=>d.memory?.id.startsWith('worksite-episode:')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]:undefined;
      return (episode?[episode,...ranked.filter(d=>d.id!==episode.id&&!d.sourceIds.some(id=>episode.sourceIds.includes(id)))]:ranked).slice(0,limit).map(recalledMemory);
    };
    const pipeline=async()=>{
      const [semantic,ids]=await Promise.all([
        measure('semantic',()=>this.embedding?.candidates(state.petId,query,docs,signal)??Promise.reject(new CognitiveError('recall_degraded','embedding_unavailable'))),
        measure('keyword',()=>this.index?.candidates(state.version,state.petId,query,signal)??Promise.resolve(null))
      ]);
      signal.throwIfAborted();
      const q=new Set(recallTerms(query)),pool=ids?docs.filter(d=>ids.has(d.id)||d.linkedTerms?.some(t=>q.has(t))):docs;
      const lexical=lexicalRecall(pool,query,24),seeds=[...semantic.slice(0,3),...lexical.slice(0,3)];
      const expanded=[...new Set(seeds.flatMap(d=>d.terms))].slice(0,40).join(' ');
      const associated=expanded?lexicalRecall(docs,expanded,8):[];
      const candidates:RecallDocument[]=[];
      for(let i=0;i<24;i++)for(const d of [semantic[i],lexical[i],associated[i]]){
        if(d&&!candidates.some(x=>x.id===d.id||x.sourceIds.some(id=>d.sourceIds.includes(id))))candidates.push(d);
      }
      candidates.splice(24);signal.throwIfAborted();
      if(!candidates.length)return [];
      const scores=await measure('rerank',async()=>this.reranker?.score(query,candidates.map(d=>d.content),signal));
      signal.throwIfAborted();
      if(!scores||scores.length!==candidates.length)throw new CognitiveError('recall_degraded','reranker_unavailable');
      const threshold=Math.max(.005,Math.max(...scores)*.05);
      return candidates.map((d,i)=>({d,score:scores[i]})).filter(x=>x.score>=threshold).sort((a,b)=>b.score-a.score).map(x=>x.d);
    };
    try{if(performance.now()>=deadline)controller.abort(new CognitiveError('recall_degraded','recall_timeout'));signal.throwIfAborted();const ranked=await abortable(pipeline(),signal);note('hybrid');return finish(ranked);}
    catch(error){
      if(options.signal?.aborted)throw options.signal.reason;
      note('lexical',controller.signal.aborted?'recall_timeout':error instanceof CognitiveError?error.message:failureCode(error));
      controller.abort(error);return finish(local);
    }finally{clearTimeout(timer);}
  }
  /** Explicit legacy/archive lookup, with no semantic guarantees. */
  async searchArchive(petId:string,query:string,limit=12):Promise<Memory[]> {
    if(!petId||typeof query!=='string'||query.length>500||!Number.isInteger(limit)||limit<1||limit>30)throw Error('记忆查询无效');
    const terms=[...new Set(recallTerms(query))].slice(0,12);
    const result=await this.db.query(`WITH state AS MATERIALIZED (SELECT payload->'life'->'memories' AS memories, payload->'life'->'invalidSources' AS invalid FROM silicon_genesis.life_state WHERE pet_id=$1),
      terms AS MATERIALIZED (SELECT t, plainto_tsquery('simple',t) AS q FROM unnest($2::text[]) t),
      docs AS MATERIALIZED (SELECT m, m->>'content' AS content FROM state, jsonb_array_elements(COALESCE(memories,'[]'::jsonb)) m
        WHERE m->>'valid'='true' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(m->'sourceIds','[]'::jsonb)) s WHERE invalid ? s)),
      scored AS (SELECT m, (SELECT count(*) FROM terms WHERE to_tsvector('simple',docs.content) @@ q OR strpos(lower(docs.content),t)>0) AS score FROM docs)
      SELECT m FROM scored WHERE cardinality($2::text[])=0 OR score>0 ORDER BY score DESC, m->>'createdAt' DESC LIMIT $3`,[petId,terms,limit]);
    return result.rows.map(r=>r.m as Memory).filter(m=>m && typeof m.content==='string');
  }
  async world(state:LifeState,signal?:AbortSignal):Promise<NonNullable<import('../kernel/types.js').CognitiveWorkspace['environment']>> {
    const result=await abortable(this.db.query(`SELECT payload->'legacy'->'space' AS space, payload->'legacy'->'services'->'inventory' AS inventory FROM silicon_genesis.life_state WHERE pet_id=$1`,[state.petId]),signal);
    if(result.rows.length!==1)throw new Error('环境状态不可用');
    const raw=result.rows[0], source=raw.space && typeof raw.space==='object'?raw.space:{};
    const space=Object.fromEntries(['mode','confined','screens','area','home'].filter(k=>Object.hasOwn(source,k)).map(k=>[k,source[k]]));
    const inventory=Array.isArray(raw.inventory)?raw.inventory.slice(0,30).map((i:any)=>({id:i.id,name:i.name,status:i.status})):[];
    const images=state.events.filter(e=>e.type==='attachment.shared'&&!Object.hasOwn(state.invalidSources,e.eventId)&&typeof (e.payload as any)?.attachmentId==='string').slice(-10).map(e=>({attachmentId:(e.payload as any).attachmentId as string,sourceId:e.eventId}));
    const idle=this.idle?.snapshot();
    return {...(idle?{userIdleSeconds:idle.seconds}:{}),space,inventory,images,capabilities:state.constraints.capabilities.filter(c=>c.enabled&&c.name!=='care.feed'),recentResults:state.receipts.slice(-10).map(r=>({actionId:r.actionId,status:r.status,occurredAt:r.occurredAt}))};
  }
  async forCognition(state:LifeState,signal?:AbortSignal,diagnostics?:CognitiveDiagnostics):Promise<Memory[]> {
    const conversations=state.events.filter(e=>e.type==='conversation.user'&&!Object.hasOwn(state.invalidSources,e.eventId)).slice(-3);
    const query=conversations.reverse().map(e=>{const p=e.payload as Record<string,unknown>;return typeof p?.text==='string'?p.text:'';}).join(' ').slice(0,500);
    // Long recent conversations must not consume all search terms before an
    // older active question can retrieve its explanation.
    const goalQueries=[...new Set(state.goals.filter(g=>g.status==='active').map(g=>g.title.trim()).filter(Boolean))].slice(0,3);
    const matches=await this.recallBatch(state,[...goalQueries,query],18,{signal,diagnostics}), recent=state.memories.filter(m=>m.valid&&m.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id))).slice(-6);
    const felt=state.memories.filter(m=>m.valid&&m.feeling&&m.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id))).sort((a,b)=>(b.salience??0)-(a.salience??0)||Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,4);
    // Reading receipts for ongoing goals must survive unrelated conversation
    // and search snippets when the model is asked what it understood.
    const activeGoals=new Set(state.goals.filter(g=>g.status==='active').map(g=>g.id));
    const readingIds=new Set((state.actions??[]).filter(a=>a.goalId&&activeGoals.has(a.goalId)&&a.actionType==='learning.observe'&&
      a.parameters.kind==='fetch'&&a.status==='COMPLETED').map(a=>'knowledge:'+a.id));
    const readings=state.memories.filter(m=>readingIds.has(m.id)&&m.valid&&m.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id))).slice(-2).reverse();
    const unique=new Map([...readings,...matches,...recent,...felt].map(m=>[m.id,m]));
    return [...unique.values()].map(m=>({...m,speakers:speechSources(m.sourceIds,state)}));
  }
}
