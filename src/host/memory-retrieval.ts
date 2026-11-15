import type { Memory, LifeState } from '../kernel/types.js';
import type { Queryable } from '../storage/postgres.js';
import {speechSources} from '../kernel/speech-provenance.js';

/** Uses the canonical envelope only; the query is parameterized and bounded.
 * PostgreSQL simple FTS plus literal matching covers both segmented terms and
 * Chinese text which PostgreSQL may treat as a single token. */
export class CanonicalMemoryRetrieval {
  constructor(private readonly db:Queryable,private readonly idle?:{snapshot():{seconds:number}|undefined}) {}
  async search(petId:string, query:string, limit=12, snapshot?:LifeState):Promise<Memory[]> {
    if(!petId||typeof query!=='string'||query.length>500||!Number.isInteger(limit)||limit<1||limit>30)throw new Error('记忆查询无效');
    const terms=[...new Set((query.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)||[]).flatMap(t=>/[\p{Script=Han}]/u.test(t)&&t.length>2?Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2)):[t]))].slice(0,12);
    if(snapshot){
      const live=snapshot.memories.filter(m=>m.valid&&m.sourceIds.every(id=>!Object.hasOwn(snapshot.invalidSources,id)));
      return live.map(m=>({m,score:terms.filter(t=>m.content.toLowerCase().includes(t)).length})).filter(x=>!terms.length||x.score>0).sort((a,b)=>b.score-a.score||b.m.createdAt.localeCompare(a.m.createdAt)).slice(0,limit).map(x=>x.m);
    }
    const result=await this.db.query(`WITH state AS MATERIALIZED (SELECT payload->'life'->'memories' AS memories, payload->'life'->'invalidSources' AS invalid FROM silicon_genesis.life_state WHERE pet_id=$1),
      terms AS MATERIALIZED (SELECT t, plainto_tsquery('simple',t) AS q FROM unnest($2::text[]) t),
      docs AS MATERIALIZED (SELECT m, m->>'content' AS content FROM state, jsonb_array_elements(COALESCE(memories,'[]'::jsonb)) m
        WHERE m->>'valid'='true' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(m->'sourceIds','[]'::jsonb)) s WHERE invalid ? s)),
      scored AS (SELECT m, (SELECT count(*) FROM terms WHERE to_tsvector('simple',docs.content) @@ q OR strpos(lower(docs.content),t)>0) AS score FROM docs)
      SELECT m FROM scored WHERE cardinality($2::text[])=0 OR score>0 ORDER BY score DESC, m->>'createdAt' DESC LIMIT $3`,[petId,terms,limit]);
    return result.rows.map(r=>r.m as Memory).filter(m=>m && typeof m.content==='string');
  }
  async world(state:LifeState):Promise<NonNullable<import('../kernel/types.js').CognitiveWorkspace['environment']>> {
    const result=await this.db.query(`SELECT payload->'legacy'->'space' AS space, payload->'legacy'->'services'->'inventory' AS inventory FROM silicon_genesis.life_state WHERE pet_id=$1`,[state.petId]);
    if(result.rows.length!==1)throw new Error('环境状态不可用');
    const raw=result.rows[0], source=raw.space && typeof raw.space==='object'?raw.space:{};
    const space=Object.fromEntries(['mode','confined','screens','area','home'].filter(k=>Object.hasOwn(source,k)).map(k=>[k,source[k]]));
    const inventory=Array.isArray(raw.inventory)?raw.inventory.slice(0,30).map((i:any)=>({id:i.id,name:i.name,status:i.status})):[];
    const images=state.events.filter(e=>e.type==='attachment.shared'&&!Object.hasOwn(state.invalidSources,e.eventId)&&typeof (e.payload as any)?.attachmentId==='string').slice(-10).map(e=>({attachmentId:(e.payload as any).attachmentId as string,sourceId:e.eventId}));
    const idle=this.idle?.snapshot();
    return {...(idle?{userIdleSeconds:idle.seconds}:{}),space,inventory,images,capabilities:state.constraints.capabilities.filter(c=>c.enabled&&c.name!=='care.feed'),recentResults:state.receipts.slice(-10).map(r=>({actionId:r.actionId,status:r.status,occurredAt:r.occurredAt}))};
  }
  async forCognition(state:LifeState):Promise<Memory[]> {
    const conversations=state.events.filter(e=>e.type==='conversation.user'&&!Object.hasOwn(state.invalidSources,e.eventId)).slice(-3);
    const query=[...conversations.reverse().map(e=>{const p=e.payload as Record<string,unknown>;return typeof p?.text==='string'?p.text:'';}),...state.goals.filter(g=>g.status==='active').map(g=>g.title)].join(' ').slice(0,500);
    const matches=await this.search(state.petId,query,12), recent=state.memories.filter(m=>m.valid&&m.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id))).slice(-6);
    const felt=state.memories.filter(m=>m.valid&&m.feeling&&m.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id))).sort((a,b)=>(b.salience??0)-(a.salience??0)||Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,4);
    const unique=new Map([...matches,...recent,...felt].map(m=>[m.id,m]));let remaining=9000;
    return [...unique.values()].map(m=>({...m,speakers:speechSources(m.sourceIds,state)})).filter(m=>{const size=JSON.stringify(m).length;if(size>remaining)return false;remaining-=size;return true;});
  }
}
