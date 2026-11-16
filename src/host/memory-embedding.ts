import {createHash} from 'node:crypto';
import type {CanonicalEnvelope,PostgresKernelStore} from '../storage/postgres.js';
import type {WriterLease} from './writer-lease.js';
import type {ImportedModelConfig} from './model-facade.js';
import {recallDocuments,type RecallDocument} from './memory-associations.js';

const MODEL='qwen3.7-text-embedding-flash',DIMENSIONS=1024;
export const contentHash=(text:string)=>createHash('sha256').update(text).digest('hex');

// Deterministic random-hyperplane buckets provide an indexed, approximate
// shortlist without requiring PostgreSQL superuser access or pgvector.
export function vectorBuckets(vector:number[]):string[]{
  if(vector.length!==DIMENSIONS||!vector.every(Number.isFinite))return [];
  const result:string[]=[];let random=0x9e3779b9;
  for(let band=0;band<16;band++){
    let bits=0;
    for(let bit=0;bit<6;bit++){
      let sum=0;
      for(const value of vector){random=(Math.imul(random,1664525)+1013904223)>>>0;sum+=value*((random>>>31)?1:-1);}
      bits=(bits<<1)|(sum>=0?1:0);
    }
    result.push(`${band}:${bits}`);
  }
  return result;
}
/** Probe the four six-bit buckets sharing each four-bit prefix. This trades
 * some shortlist size for better recall of paraphrases at modest similarity. */
export function queryBuckets(vector:number[]):string[]{
  return vectorBuckets(vector).flatMap(bucket=>{const [band,bits]=bucket.split(':').map(Number),base=(bits>>2)<<2;return [0,1,2,3].map(n=>`${band}:${base+n}`);});
}
export function cosine(a:number[],b:number[]):number{
  if(a.length!==DIMENSIONS||b.length!==DIMENSIONS)return -1;
  let xy=0,xx=0,yy=0;for(let i=0;i<a.length;i++){xy+=a[i]*b[i];xx+=a[i]*a[i];yy+=b[i]*b[i];}
  return xx&&yy?xy/Math.sqrt(xx*yy):-1;
}

export class MemoryEmbedding {
  private readonly provider?:{url:string;key:string};
  private pending?:CanonicalEnvelope;
  private running=false;
  private timer?:NodeJS.Timeout;
  private state:'ready'|'indexing'|'degraded'='degraded';
  private count=0;private total=0;
  constructor(private readonly lease:WriterLease,private readonly store:PostgresKernelStore,config:ImportedModelConfig){
    for(const p of Object.values(config.providers||{})){
      try{const u=new URL(p.baseURL);if(u.protocol!=='https:'||!/(^|\.)maas\.aliyuncs\.com$/.test(u.hostname)||!p.apiKey)continue;
        u.pathname='/api/v1/services/embeddings/text-embedding/text-embedding';u.search='';u.hash='';this.provider={url:u.href,key:p.apiKey};break;
      }catch{/* Ignore unrelated providers. */}
    }
    lease.signal.addEventListener('abort',()=>{if(this.timer)clearTimeout(this.timer);},{once:true});
  }
  status(){return {state:this.state,indexed:this.count,total:this.total};}
  private async embed(texts:string[],kind:'query'|'document',timeout:number):Promise<number[][]>{
    if(!this.provider||!texts.length||texts.length>20)throw Error('embedding unavailable');
    const response=await fetch(this.provider.url,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${this.provider.key}`,'content-type':'application/json'},
      body:JSON.stringify({model:MODEL,input:{texts},parameters:{dimension:DIMENSIONS,text_type:kind,...(kind==='query'?{instruct:'Retrieve relevant past conversations and memories that help respond to this conversation.'}:{})}}),
      signal:AbortSignal.any([this.lease.signal,AbortSignal.timeout(timeout)])});
    if(!response.ok)throw Error('embedding request failed');
    const body:any=await response.json(),items=body?.output?.embeddings;
    if(!Array.isArray(items)||items.length!==texts.length)throw Error('invalid embeddings');
    const ordered=new Array<number[]>(texts.length);
    for(const item of items){if(!Number.isInteger(item.index)||item.index<0||item.index>=texts.length||ordered[item.index]||!Array.isArray(item.embedding)||item.embedding.length!==DIMENSIONS||!item.embedding.every(Number.isFinite))throw Error('invalid embedding');ordered[item.index]=item.embedding;}
    if(ordered.some(x=>!x))throw Error('incomplete embeddings');return ordered;
  }
  schedule(envelope:CanonicalEnvelope,delay=1000){
    this.pending=envelope;if(this.timer||this.running||this.lease.signal.aborted)return;
    this.lease.detach(()=>{this.timer=setTimeout(()=>{this.timer=undefined;void this.run();},delay);this.timer.unref();});
  }
  private async run(){
    if(this.running||!this.pending||this.lease.signal.aborted)return;
    this.running=true;const envelope=this.pending;this.pending=undefined;
    try{
      if(!this.provider)throw Error('embedding unavailable');
      this.state='indexing';const docs=recallDocuments(this.store.projectEnvelope(envelope));this.total=docs.length;
      const existing=await this.lease.query('SELECT document_id,content_hash FROM silicon_genesis.memory_index_embedding WHERE pet_id=$1 AND model=$2',[envelope.petId,MODEL]);
      const known=new Map(existing.rows.map(row=>[String(row.document_id),String(row.content_hash)]));
      const missing=docs.filter(d=>known.get(d.id)!==contentHash(d.content));this.count=docs.length-missing.length;
      for(let start=0;start<missing.length;start+=10){
        if(this.lease.signal.aborted)return;
        const batch=missing.slice(start,start+10),vectors=await this.embed(batch.map(d=>d.content),'document',15000);
        await this.lease.run(envelope.petId,async()=>{
          const current=await this.store.loadEnvelope(envelope.petId);if(!current)return;
          const valid=new Map(recallDocuments(this.store.projectEnvelope(current)).map(d=>[d.id,contentHash(d.content)]));
          for(let i=0;i<batch.length;i++){
            const d=batch[i],hash=contentHash(d.content);if(valid.get(d.id)!==hash)continue;
            await this.lease.query(`INSERT INTO silicon_genesis.memory_index_embedding(pet_id,document_id,content_hash,model,embedding,buckets) VALUES($1,$2,$3,$4,$5::real[],$6::text[])
              ON CONFLICT(pet_id,document_id) DO UPDATE SET content_hash=EXCLUDED.content_hash,model=EXCLUDED.model,embedding=EXCLUDED.embedding,buckets=EXCLUDED.buckets`,[envelope.petId,d.id,hash,MODEL,vectors[i],vectorBuckets(vectors[i])]);
            this.count++;
          }
        });
      }
      await this.lease.run(envelope.petId,async()=>{
        const current=await this.store.loadEnvelope(envelope.petId);if(!current)return;
        const ids=recallDocuments(this.store.projectEnvelope(current)).map(d=>d.id);
        await this.lease.query('DELETE FROM silicon_genesis.memory_index_embedding WHERE pet_id=$1 AND NOT(document_id=ANY($2::text[]))',[envelope.petId,ids]);
      });
      this.state='ready';
    }catch{this.state='degraded';if(!this.pending&&!this.lease.signal.aborted)this.pending=envelope;}
    finally{this.running=false;if(this.pending)this.schedule(this.pending,this.state==='degraded'?30000:1000);}
  }
  async candidates(petId:string,query:string,docs:RecallDocument[]):Promise<RecallDocument[]>{
    if(!this.provider||!docs.length)return [];
    try{
      const [vector]=await this.embed([query],'query',4000),buckets=queryBuckets(vector);
      const rows=await this.lease.query(`SELECT document_id,content_hash,embedding FROM silicon_genesis.memory_index_embedding WHERE pet_id=$1 AND model=$2 AND buckets && $3::text[]
        ORDER BY (SELECT count(*) FROM unnest(buckets) b WHERE b=ANY($3::text[])) DESC,document_id LIMIT 1000`,[petId,MODEL,buckets]);
      const live=new Map(docs.map(d=>[d.id,d]));
      return rows.rows.map(row=>{const doc=live.get(String(row.document_id));return {doc,score:doc&&contentHash(doc.content)===row.content_hash?cosine(vector,row.embedding):-1};})
        .filter((x):x is {doc:RecallDocument;score:number}=>!!x.doc&&x.score>=.25).sort((a,b)=>b.score-a.score).slice(0,24).map(x=>x.doc);
    }catch{this.state='degraded';return [];}
  }
}
