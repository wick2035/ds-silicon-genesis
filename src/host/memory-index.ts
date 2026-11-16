import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PostgresKernelStore} from '../storage/postgres.js';
import type {WriterLease} from './writer-lease.js';
import {recallDocuments,recallTerms} from './memory-associations.js';

/** Rebuilt from an immutable committed envelope. A completed version is only
 * published when every batch still matches the authoritative version. */
export class MemoryIndex {
  private pending?:CanonicalEnvelope;
  private timer?:NodeJS.Timeout;
  private running=false;
  constructor(private readonly lease:WriterLease,private readonly store:PostgresKernelStore){lease.signal.addEventListener('abort',()=>{if(this.timer)clearTimeout(this.timer);},{once:true});}
  schedule(envelope:CanonicalEnvelope,delay=1000){
    this.pending=envelope;if(this.timer||this.running||this.lease.signal.aborted)return;
    this.lease.detach(()=>{this.timer=setTimeout(()=>{this.timer=undefined;void this.run();},delay);this.timer.unref();});
  }
  private async run(){
    if(this.running||!this.pending||this.lease.signal.aborted)return;this.running=true;
    const envelope=this.pending;this.pending=undefined;let failed=false;
    try{
      const docs=recallDocuments(this.store.projectEnvelope(envelope));
      const invalidated=await this.lease.run(envelope.petId,async()=>{const current=await this.store.loadEnvelope(envelope.petId);if(!current||current.version!==envelope.version)return false;await this.lease.query('DELETE FROM silicon_genesis.memory_index_status WHERE pet_id=$1',[envelope.petId]);return true;});
      if(!invalidated)return;
      for(let start=0;start<docs.length;start+=50){
        if(this.pending||this.lease.signal.aborted)return;
        const batch=docs.slice(start,start+50).map(d=>({id:d.id,terms:d.terms,payload:{kind:d.kind,sourceIds:d.sourceIds,createdAt:d.createdAt}}));
        const ok=await this.lease.run(envelope.petId,async()=>{
          const current=await this.store.loadEnvelope(envelope.petId);if(!current||current.version!==envelope.version)return false;
          await this.lease.query(`INSERT INTO silicon_genesis.memory_index_document(pet_id,document_id,source_version,terms,payload)
            SELECT $1, row->>'id',$2,ARRAY(SELECT jsonb_array_elements_text(row->'terms')),row->'payload' FROM jsonb_array_elements($3::jsonb) row
            ON CONFLICT(pet_id,document_id) DO UPDATE SET source_version=EXCLUDED.source_version,terms=EXCLUDED.terms,payload=EXCLUDED.payload`,[envelope.petId,envelope.version,JSON.stringify(batch)]);return true;
        });if(!ok)return;
      }
      await this.lease.run(envelope.petId,async()=>{const current=await this.store.loadEnvelope(envelope.petId);if(!current||current.version!==envelope.version)return;
        await this.lease.query('DELETE FROM silicon_genesis.memory_index_document WHERE pet_id=$1 AND source_version<>$2',[envelope.petId,envelope.version]);
        await this.lease.query('DELETE FROM silicon_genesis.memory_index_term_stat WHERE pet_id=$1',[envelope.petId]);
        await this.lease.query(`INSERT INTO silicon_genesis.memory_index_term_stat(pet_id,term,source_version,document_frequency,total_frequency)
          SELECT $1,term,$2,count(DISTINCT document_id),count(*) FROM silicon_genesis.memory_index_document CROSS JOIN LATERAL unnest(terms) AS term
          WHERE pet_id=$1 AND source_version=$2 GROUP BY term`,[envelope.petId,envelope.version]);
        await this.lease.query(`INSERT INTO silicon_genesis.memory_index_status(pet_id,source_version,document_count) VALUES($1,$2,$3)
          ON CONFLICT(pet_id) DO UPDATE SET source_version=EXCLUDED.source_version,document_count=EXCLUDED.document_count,updated_at=now()`,[envelope.petId,envelope.version,docs.length]);});
    }catch{failed=true;if(!this.pending&&!this.lease.signal.aborted)this.pending=envelope;/* Retry while chat uses the canonical snapshot. */}
    finally{this.running=false;if(this.pending)this.schedule(this.pending,failed?30000:1000);}
  }
  async candidates(stateVersion:number,petId:string,query:string):Promise<Set<string>|null>{
    const terms=[...new Set(recallTerms(query))].slice(0,40);if(!terms.length)return null;
    try{const result=await this.lease.query(`SELECT d.document_id FROM silicon_genesis.memory_index_status s
      JOIN silicon_genesis.memory_index_document d ON d.pet_id=s.pet_id AND d.source_version=s.source_version
      WHERE s.pet_id=$1 AND s.source_version=$2 AND d.terms && $3::text[]
      ORDER BY (SELECT count(*) FROM unnest($3::text[]) t WHERE t=ANY(d.terms)) DESC,d.document_id LIMIT 500`,[petId,stateVersion,terms]);
      return result.rows.length?new Set(result.rows.map(r=>String(r.document_id))):null;
    }catch{return null;}
  }
}
