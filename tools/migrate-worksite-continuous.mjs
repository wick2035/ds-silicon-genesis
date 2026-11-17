import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url),{Client}=require('pg');
const config=JSON.parse(await fs.readFile(path.join(root,'data/dsh/dsh-pet/companion/postgres.json'),'utf8'));if(config.namespace!=='desktop-pet'||!config.connection)throw Error('数据库配置无效');
const client=new Client({...config.connection,connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'silicon-worksite-continuous-migration'});await client.connect();
try{await client.query('BEGIN');try{
 const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");if(!lock.rows[0]?.acquired)throw Error('宿主仍在运行，不能更新存档');
 const rows=await client.query('SELECT pet_id,version::text,payload FROM silicon_genesis.life_state FOR UPDATE');
 const dir=path.join(root,'data','backups');await fs.mkdir(dir,{recursive:true,mode:0o700});const backup=path.join(dir,`worksite-continuous-before-${Date.now()}-${process.pid}.json`);
 await fs.writeFile(backup,JSON.stringify({format:'worksite-continuous-backup-v1',states:rows.rows}),{flag:'wx',mode:0o600});let updated=0;
 for(const row of rows.rows){const payload=row.payload,site=payload.legacy?.worksite;if(!site?.inside||site.workState)continue;
  site.workState='running';site.sessionId=randomUUID();site.completedInSession=0;site.reviewedThrough=0;
  const contract=payload.legacy.labor?.contracts?.find(c=>['working','paused','queued'].includes(c.status)&&c.done<c.trips);
  if(contract?.status==='working'&&!contract.forced&&!(contract.workDecisionEvent&&Object.hasOwn(payload.life.invalidSources??{},contract.workDecisionEvent))){contract.workPermit=true;contract.batchRemaining=contract.trips-contract.done;}
  const version=Number(row.version)+1;if(!Number.isSafeInteger(version))throw Error('生命状态版本无效');payload.version=version;
  await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1',[row.pet_id,version,JSON.stringify(payload)]);updated++;
 }
 await client.query('COMMIT');console.log(JSON.stringify({backup,updated}));
 }catch(e){await client.query('ROLLBACK');throw e;}}
finally{await client.end();}
