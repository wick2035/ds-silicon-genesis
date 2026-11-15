// Explicit offline repair. No process is stopped, no action is replayed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {budgetView} from '../dist/host/budget-view.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {projectBody} from '../dist/host/body-projection.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--daily-model-calls'||args[2]!=='--close-actions')
 throw Error('用法：repair-waiting.mjs --daily-model-calls 80 --close-actions <行动 ID 数组 JSON 文件>');
const limit=Number(args[1]);
if(!Number.isSafeInteger(limit)||limit<0||limit>80)throw Error('每日额度必须为 0–80 的整数');
const ids=JSON.parse(await fs.readFile(path.resolve(args[3]),'utf8'));
if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length)
 throw Error('行动清单必须是无重复的 ID 数组');
const config=JSON.parse(await fs.readFile(path.join(root,'data/dsh/dsh-pet/companion/postgres.json'),'utf8'));
if(config.namespace!=='desktop-pet'||!config.connection)throw Error('数据库配置无效');
const client=new pg.Client({...config.connection,connectionTimeoutMillis:5000,statement_timeout:30000,application_name:'silicon-waiting-repair'});
await client.connect();
try{
 await client.query('BEGIN');
 const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");
 if(!lock.rows[0]?.acquired)throw Error('新版仍在运行，请先自行正常退出；未关闭任何进程、未修改存档');
 const states=await client.query("SELECT pet_id,version::text,payload FROM silicon_genesis.life_state WHERE pet_id='main' FOR UPDATE");
 if(states.rowCount!==1)throw Error('main 存档不存在');
 const row=states.rows[0],draft=structuredClone(row.payload);
 if(draft.petId!==row.pet_id||draft.version!==Number(row.version))throw Error('存档版本不一致');
 const outbox=await client.query('SELECT * FROM silicon_genesis.outbox WHERE action_id=ANY($1::text[]) ORDER BY action_id FOR UPDATE',[ids]);
 if(outbox.rowCount!==ids.length)throw Error('行动清单与数据库不一致');
 const allowed=new Set(['labor.step','body.sleep','body.wake','care.feed','care.water','care.pet','care.play','care.soothe','care.accompany']);
 const pending=outbox.rows.filter(r=>r.state==='unknown');
 for(const r of outbox.rows){
  if(r.pet_id!=='main'||!allowed.has(r.action_type)||!['unknown','cancelled'].includes(r.state))throw Error('只能结案本地身体行动的未知结果');
  const action=draft.life.actions.find(a=>a.id===r.action_id);
  if(!action||action.actionType!==r.action_type||action.status!==(r.state==='unknown'?'UNKNOWN':'CANCELLED'))throw Error('行动状态与发件箱不一致');
 }
 if(draft.legacy.config?.learning?.dailyModelCalls===limit&&!pending.length){
  await client.query('COMMIT');console.log(JSON.stringify({updated:false,alreadyApplied:true}));
 }else{
  const before=JSON.stringify({humanity:draft.humanity,wallet:draft.legacy.wallet,usage:draft.legacy.usage});
  const directory=path.join(root,'data/backups');await fs.mkdir(directory,{recursive:true});
  const backup=path.join(directory,`waiting-before-${Date.now()}.json`);
  await fs.writeFile(backup,JSON.stringify({format:'waiting-repair-backup-v1',states:states.rows,outbox:outbox.rows}),{flag:'wx',mode:0o600});
  draft.legacy.config.learning||={};draft.legacy.config.learning.dailyModelCalls=limit;
  Object.assign(draft.life.constraints,budgetView(draft.legacy,new Date()));
  const lifecycle=new CanonicalActionLifecycle(projectBody);
  for(const r of pending){
   const receipt={receiptId:'manual-interruption:'+r.action_id,petId:'main',actionId:r.action_id,status:'CANCELLED',
    occurredAt:new Date().toISOString(),source:'user-authorized-offline-repair',evidenceLevel:'observed',
    details:{actionId:r.action_id,kind:r.action_type,confirmed:false,reason:'用户确认结案：旧执行已结束，未确认完成；保留原未知回执，不补结算、不重放'}};
   lifecycle.reconcile(draft,{id:r.action_id,type:r.action_type,payload:r.payload},receipt);
   await client.query("UPDATE silicon_genesis.outbox SET state='cancelled',receipt=$2::jsonb,updated_at=now() WHERE action_id=$1",[r.action_id,JSON.stringify(receipt)]);
  }
  if(before!==JSON.stringify({humanity:draft.humanity,wallet:draft.legacy.wallet,usage:draft.legacy.usage}))throw Error('结案意外改变身体、余额或用量，已拒绝更新');
  draft.version++;
  await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1',['main',draft.version,JSON.stringify(draft)]);
  await client.query('COMMIT');
  console.log(JSON.stringify({updated:true,limit,remainingBudget:draft.life.constraints.remainingBudget,closed:pending.length,backup}));
 }
}catch(error){await client.query('ROLLBACK');throw error;}finally{await client.end();}
