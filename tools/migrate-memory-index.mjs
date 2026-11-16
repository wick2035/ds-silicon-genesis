import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {Client}=createRequire(import.meta.url)('pg');
const config=JSON.parse(await fs.readFile(path.join(root,'data/dsh/dsh-pet/companion/postgres.json'),'utf8'));
if(config.namespace!=='desktop-pet'||!config.connection)throw Error('数据库配置无效');
const client=new Client({...config.connection,connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'memory-index-migration'});
let locked=false;
try{
 await client.connect();
 const lock=await client.query("SELECT pg_try_advisory_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");
 if(!lock.rows[0]?.acquired)throw Error('新版正在运行，无法取得写入租约；未更改数据库');locked=true;
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const legacy=await client.query('SELECT * FROM silicon_genesis.legacy_import ORDER BY source_key');
 const documents=await client.query('SELECT * FROM silicon_genesis.legacy_document ORDER BY source_key,name');
 const states=await client.query('SELECT * FROM silicon_genesis.life_state ORDER BY pet_id');
 const outbox=await client.query('SELECT * FROM silicon_genesis.outbox ORDER BY action_id');
 const wakes=await client.query('SELECT * FROM silicon_genesis.wake_state ORDER BY pet_id');
 if(!states.rows.length)throw Error('没有可备份的生命状态');
 const backup=path.join(root,'data','backups',`before-memory-index-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
 const text=JSON.stringify({format:'silicon-genesis-export-v1',legacy:legacy.rows,documents:documents.rows,states:states.rows,outbox:outbox.rows,wakes:wakes.rows});
 await fs.mkdir(path.dirname(backup),{recursive:true});await fs.writeFile(backup,text,{flag:'wx',mode:0o600});
 const checked=JSON.parse(await fs.readFile(backup,'utf8'));if(checked.states.length!==states.rows.length)throw Error('备份校验失败');
 await client.query('COMMIT');
 await client.query('BEGIN');try{await client.query(await fs.readFile(path.join(root,'src/storage/memory-index.sql'),'utf8'));await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}
 console.log('备份已保存：'+backup);console.log('记忆索引数据库结构已更新；索引将在应用启动后重建。');
}finally{if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended('silicon_genesis:writer',0))").catch(()=>{});await client.end().catch(()=>{});}
