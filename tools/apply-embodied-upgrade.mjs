// Apply the approved personality and additive capability upgrade to the new
// archive only. Never reset body values, balances, memories or sleep debt.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {readJsonc} from '../vendor/dsh-pet/src/host/config/jsonc.ts';
import {initializeSpirit} from '../dist/host/spirit-initialization.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const configFile=path.join(root,'data/dsh/dsh-pet/main-config.jsonc');
const database=JSON.parse(await fs.readFile(path.join(root,'data/dsh/dsh-pet/companion/postgres.json'),'utf8'));
if(database.namespace!=='desktop-pet'||!database.connection)throw Error('数据库配置无效');
const config=readJsonc(configFile),pet=Array.isArray(config?.pets)?config.pets.find(p=>p.id==='main'):config?.pets?.main;
if(!pet)throw Error('当前角色配置不存在');
const persona=await fs.readFile(path.join(root,'persona.md'),'utf8');
const client=new pg.Client({...database.connection,connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'silicon-embodied-upgrade'});
await client.connect();
try{
  await client.query('BEGIN');
  const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");
  if(!lock.rows[0]?.acquired)throw Error('新版仍在运行，请正常退出新版后再执行更新；没有关闭任何进程');
  const rows=await client.query("SELECT pet_id,version::text,payload FROM silicon_genesis.life_state WHERE pet_id='main' FOR UPDATE");
  if(rows.rowCount!==1)throw Error('新版 main 存档不存在');
  const row=rows.rows[0],draft=row.payload;
  if(draft.petId!==row.pet_id||draft.version!==Number(row.version))throw Error('存档版本不一致');
  const needsState=draft.legacy.embodiedUpgrade!=='2026-11-15-v1';
  const needsPersona=pet.whisperPrompt!==persona;
  if(needsState||needsPersona){
    const backup=path.join(root,'data/backups',`embodied-before-${Date.now()}.json`);
    await fs.mkdir(path.dirname(backup),{recursive:true});
    await fs.writeFile(backup,JSON.stringify({format:'embodied-upgrade-backup-v1',states:rows.rows,config:await fs.readFile(configFile,'utf8')}),{flag:'wx',mode:0o600});
    if(needsState){initializeSpirit(draft);draft.legacy.embodiedUpgrade='2026-11-15-v1';draft.version++;
      await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1',[row.pet_id,draft.version,JSON.stringify(draft)]);}
    if(needsPersona){pet.whisperPrompt=persona;const tmp=configFile+'.embodied.tmp';await fs.writeFile(tmp,JSON.stringify(config,null,2)+'\n',{mode:0o600});await fs.rename(tmp,configFile);}
    await client.query('COMMIT');console.log(JSON.stringify({updated:true,backup,persona:needsPersona,state:needsState,valuesPreserved:true}));
  }else{await client.query('COMMIT');console.log(JSON.stringify({updated:false,alreadyApplied:true}));}
}catch(error){await client.query('ROLLBACK');throw error;}finally{await client.end();}
