import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {CompanionStore} from './core.mjs';
import {terms} from './retrieval.mjs';

const require = createRequire(import.meta.url);
export const pg = () => require('pg');
const payloadOf = data => { const {postgres, ...payload} = data; return payload; };
const stable = value => Array.isArray(value)?value.map(stable):value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const checksum = data => createHash('sha256').update(JSON.stringify(stable(payloadOf(data)))).digest('hex');
export function indexedRecords(data) {
  const rows=[];
  for (const [pet_id,p] of Object.entries(data.pets)) {
    const groups = {event:p.events,fact:p.facts,memory:p.growth.memories,strategy:p.growth.strategies,
      skill:p.growth.skills||[],diary:Object.entries(p.diaries).map(([id,v])=>({...v,id}))};
    for (const [kind,items] of Object.entries(groups)) for (const item of items) {
      const body=String(item.text || item.instruction || '');
      rows.push({pet_id,kind,id:item.id,body,deleted:!!item.deleted,sources:item.sources||[],payload:item,
        search_terms:[...new Set(terms(body))].join(' ')});
    }
  }
  return rows;
}

// The synchronous host keeps a durable recovery journal; PostgreSQL stores the
// committed snapshot and indexed records together. No silent JSON-only fallback.
export class PostgresCompanionStore extends CompanionStore {
  static async open(root, config, {clock=Date.now,onError=()=>{}}={}) {
    if (config.namespace !== 'desktop-pet') throw Error('数据库命名空间无效');
    const store=new this(root,clock);store.namespace=config.namespace;store.onError=onError;
    store.client=new (pg().Client)({...config.connection,connectionTimeoutMillis:5000,
      statement_timeout:15000,application_name:'deepseek-pet-memory'});
    store.client.on('error',()=>{store.failure=Error('PostgreSQL 连接中断；恢复日志已保留，请重新打开应用');onError(store.failure);});
    try {
      await store.client.connect();
      const lock=await store.client.query("SELECT pg_try_advisory_lock(hashtext('pet_companion'),hashtext($1)) AS ok",[store.namespace]);
      if (!lock.rows[0].ok) throw Error('另一实例正在使用宠物数据库，未覆盖存档');
      const versions=await store.client.query('SELECT version FROM pet_companion.schema_version ORDER BY version');
      if (versions.rows.length!==1 || versions.rows[0].version!==1) throw Error('请先更新宠物数据库结构');
      CompanionStore.prototype.load.call(store);
      const local=structuredClone(store.data), meta=local.postgres, hasLocal=fs.existsSync(store.file);
      const row=(await store.client.query('SELECT revision::text,checksum,payload FROM pet_companion.snapshots WHERE namespace=$1',[store.namespace])).rows[0];
      store.revision=Number(row?.revision||0);
      if (!Number.isSafeInteger(store.revision)) throw Error('数据库版本号超出范围');
      if (row) {
        if (meta?.pending && meta.namespace===store.namespace && checksum(local)!==row.checksum) {
          const compatible=meta.baseRevision===store.revision ||
            meta.baseRevision+1===store.revision && meta.inFlightChecksum===row.checksum;
          if (!compatible) throw Error('恢复日志与数据库版本冲突；两份记录均已保留，需核对后恢复');
          store.data=local;
        } else if (!hasLocal) store.data=row.payload;
        else if (!meta) {
          // A legacy process may have saved after installation. Never overwrite it.
          if (checksum(local)!==row.checksum && !config.legacyImportPending) throw Error('检测到尚未迁移的旧版存档变化，请先重新迁移');
          store.data=config.legacyImportPending?local:row.payload;
        } else if (meta.namespace!==store.namespace) throw Error('存档数据库命名空间不一致');
        else store.data=row.payload;
      } else if (meta?.baseRevision>0) throw Error('数据库快照缺失；未用空库覆盖现有恢复日志');
      store.loaded=true;
      store.data.postgres={namespace:store.namespace,baseRevision:store.revision,pending:true};
      store.ready=true;store.save();await store.flush();return store;
    } catch (error) { await store.client.end().catch(()=>{});throw error; }
  }
  save() {
    if (!this.ready) return super.save();
    if (this.closed || this.failure) throw this.failure || Error('数据库存储已关闭');
    this.data.postgres={...this.data.postgres,namespace:this.namespace,baseRevision:this.revision,pending:true};
    super.save();
    // Coalesce synchronous mutations and use one bounded queue, not one snapshot per tick.
    if (!this.scheduled) {this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;void this.flush().catch(()=>{});});}
  }
  async flush() {
    if (this.running) {await this.running;if(this.data.postgres?.pending)return this.flush();return;}
    if (this.failure) throw this.failure;
    if (!this.data.postgres?.pending) return;
    this.running=this.commit();
    try {await this.running;} finally {this.running=null;}
    if (this.data.postgres.pending) return this.flush();
  }
  async commit() {
    const snapshot=structuredClone(payloadOf(this.data)), sum=checksum(snapshot),expected=this.revision;
    this.data.postgres.inFlightChecksum=sum;super.save();
    try {
      await this.client.query('BEGIN');
      const result=await this.client.query(`INSERT INTO pet_companion.snapshots(namespace,revision,checksum,payload)
        VALUES($1,1,$2,$3::jsonb) ON CONFLICT(namespace) DO UPDATE SET
        revision=pet_companion.snapshots.revision+1,checksum=EXCLUDED.checksum,payload=EXCLUDED.payload,updated_at=now()
        WHERE pet_companion.snapshots.revision=$4 RETURNING revision::text`,[this.namespace,sum,JSON.stringify(snapshot),expected]);
      if (!result.rowCount) throw Error('数据库版本冲突，未覆盖其他实例的数据');
      const rows=JSON.stringify(indexedRecords(snapshot));
      await this.client.query(`INSERT INTO pet_companion.records(namespace,pet_id,kind,id,body,deleted,sources,payload,search_vector)
        SELECT $1,r.pet_id,r.kind,r.id,r.body,r.deleted,r.sources,r.payload,to_tsvector('simple',r.search_terms)
        FROM jsonb_to_recordset($2::jsonb) AS r(pet_id text,kind text,id text,body text,deleted boolean,sources jsonb,payload jsonb,search_terms text)
        ON CONFLICT(namespace,pet_id,kind,id) DO UPDATE SET body=EXCLUDED.body,deleted=EXCLUDED.deleted,
        sources=EXCLUDED.sources,payload=EXCLUDED.payload,search_vector=EXCLUDED.search_vector
        WHERE pet_companion.records.payload IS DISTINCT FROM EXCLUDED.payload`,[this.namespace,rows]);
      await this.client.query(`DELETE FROM pet_companion.records t WHERE namespace=$1 AND NOT EXISTS
        (SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS r(pet_id text,kind text,id text)
        WHERE r.pet_id=t.pet_id AND r.kind=t.kind AND r.id=t.id)`,[this.namespace,rows]);
      await this.client.query('COMMIT');
      this.revision=Number(result.rows[0].revision);
      const pending=checksum(this.data)!==sum;
      this.data.postgres={namespace:this.namespace,baseRevision:this.revision,pending};
      super.save();
    } catch (error) {
      await this.client.query('ROLLBACK').catch(()=>{});
      this.failure=Error('PostgreSQL 写入失败；本地恢复日志已保留，停止后续写入以避免分叉');
      this.failure.cause=error;this.onError(this.failure);throw this.failure;
    }
  }
  storageStatus() {return {backend:'postgresql',revision:this.revision,pending:!!this.data.postgres?.pending,
    healthy:!this.failure,error:this.failure?.message||null};}
  async close() {if(this.closed)return;try{await this.flush();}finally{this.closed=true;await this.client.end();}}
}

export async function openCompanionStore(root, options={}) {
  const file=path.join(root,'postgres.json');
  if (!fs.existsSync(file)) return new CompanionStore(root,options.clock);
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  const active=path.join(root,'postgres-active.json');
  const transition=config.legacyImportPending && !fs.existsSync(active);
  const store=await PostgresCompanionStore.open(root,{...config,legacyImportPending:transition},options);
  if(transition)fs.writeFileSync(active,JSON.stringify({namespace:config.namespace,activatedAt:new Date().toISOString()}),{mode:0o600});
  return store;
}
