#!/usr/bin/env node
// Optional, idempotent initialization of the new location field. Never rewrite
// an existing location; a forced-entry lock must survive restarts and updates.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),{Client}=require('pg');
const config=JSON.parse(await fs.readFile(path.join(root,'data/dsh/dsh-pet/companion/postgres.json'),'utf8'));
if(config.namespace!=='desktop-pet'||!config.connection)throw Error('数据库配置无效');
const client=new Client({...config.connection,connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'silicon-worksite-initialize'});
await client.connect();
try{
  await client.query('BEGIN');
  try{
    const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");
    if(!lock.rows[0]?.acquired)throw Error('新版正在运行，不能修改它的状态');
    const rows=await client.query("SELECT pet_id,version::text,payload FROM silicon_genesis.life_state WHERE NOT (payload->'legacy' ? 'worksite') FOR UPDATE");
    if(rows.rowCount){
      const dir=path.join(root,'data','backups');await fs.mkdir(dir,{recursive:true,mode:0o700});
      const name=`worksite-before-${Date.now()}-${process.pid}.json`;
      await fs.writeFile(path.join(dir,name),JSON.stringify({format:'worksite-initialization-backup-v1',states:rows.rows}),{flag:'wx',mode:0o600});
      for(const row of rows.rows){
        const version=Number(row.version)+1;if(!Number.isSafeInteger(version))throw Error('生命状态版本无效');
        const payload=row.payload;payload.version=version;payload.legacy.worksite={inside:false,forced:false};
        await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1',[row.pet_id,version,JSON.stringify(payload)]);
      }
    }
    await client.query('COMMIT');console.log(`工地状态已初始化：${rows.rowCount} 只；已有位置未改动。`);
  }catch(e){await client.query('ROLLBACK');throw e;}
}finally{await client.end();}
