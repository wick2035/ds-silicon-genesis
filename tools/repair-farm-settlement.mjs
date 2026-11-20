// Read-only by default. Applying requires the application's exclusive writer lease.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {repairFarmSettlement} from '../dist/host/farm-settlement-repair.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length<2||args.length>3||args[0]!=='--date'||(args[2]&&!['--apply','--dry-run'].includes(args[2])))
  throw Error('用法：repair-farm-settlement.mjs --date YYYY-MM-DD [--dry-run|--apply]');
const apply=args[2]==='--apply';
const config=JSON.parse(await fs.readFile(path.join(root,'data/dsh/dsh-pet/companion/postgres.json'),'utf8'));
if(config.namespace!=='desktop-pet'||!config.connection)throw Error('数据库配置无效');
const client=new pg.Client({...config.connection,connectionTimeoutMillis:5000,statement_timeout:15000,application_name:'silicon-farm-repair'});
await client.connect();
try{
  await client.query(apply?'BEGIN':'BEGIN READ ONLY');
  if(apply){
    const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");
    if(!lock.rows[0]?.acquired)throw Error('新版仍在运行，请自行正常退出后再修复；未关闭任何进程、未修改存档');
  }
  const result=await client.query("SELECT pet_id,version::text,payload FROM silicon_genesis.life_state WHERE pet_id=$1"+(apply?' FOR UPDATE':''),['main']);
  if(result.rowCount!==1)throw Error('main 存档不存在');
  const row=result.rows[0],draft=structuredClone(row.payload);
  if(draft.petId!==row.pet_id||draft.version!==Number(row.version))throw Error('存档版本不一致');
  const change=repairFarmSettlement(draft,args[1]);
  let backup;
  if(apply&&change.updated){
    const directory=path.join(root,'data/backups');await fs.mkdir(directory,{recursive:true});
    backup=path.join(directory,`farm-settlement-before-${args[1]}-${Date.now()}.json`);
    await fs.writeFile(backup,JSON.stringify({format:'farm-settlement-backup-v1',states:result.rows}),{flag:'wx',mode:0o600});
    draft.version++;
    const saved=await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1 AND version=$4',
      [row.pet_id,draft.version,JSON.stringify(draft),Number(row.version)]);
    if(saved.rowCount!==1)throw Error('存档已变化，修复已回滚');
  }
  await client.query(apply?'COMMIT':'ROLLBACK');
  console.log(JSON.stringify({mode:apply?'applied':'preview',...change,...(backup?{backup}:{})}));
}catch(error){await client.query('ROLLBACK');throw error;}finally{await client.end();}
