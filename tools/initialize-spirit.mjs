// Authorized additive upgrade, with a private backup and the app's writer lock.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {initializeSpirit} from '../dist/host/spirit-initialization.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await fs.readFile(path.join(root,'data/dsh/dsh-pet/companion/postgres.json'),'utf8'));
if(config.namespace!=='desktop-pet'||!config.connection)throw Error('数据库配置无效');
const client=new pg.Client({...config.connection,connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'silicon-spirit-initialize'});
await client.connect();
try{
  await client.query('BEGIN');
  const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");
  if(!lock.rows[0]?.acquired)throw Error('应用正在运行；请正常关闭后再更新存档，不会结束现有进程');
  const rows=await client.query("SELECT pet_id,version::text,payload FROM silicon_genesis.life_state WHERE pet_id='main' FOR UPDATE");
  if(rows.rowCount!==1)throw Error('当前宠物存档不存在');
  const row=rows.rows[0],payload=row.payload;
  if(payload.petId!==row.pet_id||payload.version!==Number(row.version))throw Error('存档版本不一致');
  if(!payload.life.spirit||!['self.express','service.sweet'].every(name=>payload.life.constraints.capabilities.some(c=>c.name===name))){
    const directory=path.join(root,'data','backups');await fs.mkdir(directory,{recursive:true});
    const backup=path.join(directory,`spirit-before-${Date.now()}.json`);
    await fs.writeFile(backup,JSON.stringify({format:'spirit-initialization-backup-v1',states:rows.rows}),{flag:'wx',mode:0o600});
    initializeSpirit(payload);payload.version++;
    await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1',[row.pet_id,payload.version,JSON.stringify(payload)]);
    await client.query('COMMIT');console.log('精神系统已写入当前宠物存档；原档备份保存在 data/backups，余额与经历保持原值。');
  }else{await client.query('COMMIT');console.log('精神系统已存在，未覆盖当前精神与睡眠记录。');}
}catch(error){await client.query('ROLLBACK');throw error;}finally{await client.end();}
