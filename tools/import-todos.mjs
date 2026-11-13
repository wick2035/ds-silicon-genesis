#!/usr/bin/env node
// Run explicitly after stopping the new writer. The existing envelope is amended, never replaced.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {importLegacyTodos} from '../dist/host/canonical-todos.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url),{Client}=require('pg');
const args=process.argv.slice(2),opts=new Map();while(args.length){const k=args.shift(),v=args.shift();if(!['--config','--source','--pet','--backup'].includes(k)||!v||opts.has(k))throw Error('参数无效');opts.set(k,v);}
const configPath=opts.get('--config'),source=opts.get('--source'),petId=opts.get('--pet'),backup=opts.get('--backup');if(!configPath||!source||!petId||!backup||![configPath,source,backup].every(path.isAbsolute))throw Error('需要绝对路径 --config --source --backup 和 --pet');
const raw=await fs.readFile(source,'utf8'),cfg=JSON.parse(await fs.readFile(configPath,'utf8'));if(cfg.namespace!=='desktop-pet'||!cfg.connection)throw Error('数据库配置无效');
await fs.mkdir(path.dirname(backup),{recursive:true,mode:0o700});try{await fs.writeFile(backup,raw,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||await fs.readFile(backup,'utf8')!==raw)throw Error('备份已存在且内容不同');}
const client=new Client({...cfg.connection,application_name:'silicon-genesis-todo-import'});await client.connect();try{await client.query('BEGIN');try{
 const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('silicon_genesis:writer',0)) acquired");if(!lock.rows[0]?.acquired)throw Error('新版正在运行，拒绝导入');
 const q=await client.query('SELECT version::text,payload FROM silicon_genesis.life_state WHERE pet_id=$1 FOR UPDATE',[petId]);if(q.rowCount!==1)throw Error('生命状态不存在');const state=q.rows[0].payload, before=JSON.stringify(state),result=importLegacyTodos(state,raw,new Date().toISOString());
 if(JSON.stringify(state)!==before){const version=Number(q.rows[0].version)+1;if(!Number.isSafeInteger(version))throw Error('状态版本无效');state.version=version;await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1',[petId,version,JSON.stringify(state)]);}
 await client.query('COMMIT');console.log(`已审计导入 ${result.count} 条待办，摘要 ${result.digest}`);
 }catch(e){await client.query('ROLLBACK');throw e;}}finally{await client.end();}
