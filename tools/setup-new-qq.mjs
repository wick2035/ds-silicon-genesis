// Run only while the new host is stopped. Input and output live in the
// private dsh-pet directory; credentials and pairing codes never go to Git.
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {openLifeStores} from '../dist/host/stores.js';
import {projectBody} from '../dist/host/body-projection.js';
import {CanonicalQQ} from '../dist/host/qq-canonical.js';
import {prepareFreshQQ} from '../dist/host/qq-takeover.js';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const home=join(root,'data','dsh'),folder=join(home,'dsh-pet');
const pending=join(folder,'.qq-new-pending.json'), configPath=join(folder,'qq-fresh-config.json'), instructions=join(folder,'qq-fresh-pairing.txt');
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const credentials=await json(pending);
if(!/^\d+$/.test(credentials.appId)||typeof credentials.appSecret!=='string'||!credentials.appSecret.trim())throw Error('本地新机器人凭据无效');
try {const old=await json(join(folder,'qq-config.json'));if(old?.appId===credentials.appId)throw Error('旧机器人不能以新机器人模式接入');}
catch(error) {if(error.code!=='ENOENT')throw error;}
const db=await json(join(folder,'companion','postgres.json'));
if(db.namespace!=='desktop-pet'||!db.connection)throw Error('数据库配置无效');
const pool=new pg.Pool({...db.connection,connectionTimeoutMillis:5000,application_name:'silicon-setup-new-qq'});
let stores,gateway;
try {
  stores=await openLifeStores(pool,projectBody,()=>({}));
  const {lease,store,unitOfWork}=stores;
  const state=await store.loadEnvelope('main');
  if(!state)throw Error('未找到 main 的生命状态');
  const existing=state.legacy?.qq?.identity;
  if(existing && existing.appId!==credentials.appId)throw Error('已有其他 QQ 身份，需要单独迁移');
  const pendingRows=await lease.query("SELECT count(*)::int AS n FROM silicon_genesis.outbox WHERE action_type='qq.send' AND state IN ('pending','dispatched','unknown')");
  if(pendingRows.rows[0].n)throw Error('仍有未完成或待对账的 QQ 消息，不能切换');
  const backup=join(folder,`qq-before-new-${Date.now()}-${randomUUID()}.json`);
  await writeFile(backup,JSON.stringify(state),{flag:'wx',mode:0o600});
  let config;
  try {config=await json(configPath);} catch(error) {
    if(error.code!=='ENOENT')throw error;
    const expires=Date.now()+24*60*60*1000;
    config={enabled:true,appId:credentials.appId,appSecret:credentials.appSecret,petId:'main',sandbox:false,
      groupEnabled:true,groupMode:'all',pairingCode:randomBytes(12).toString('hex'),pairingExpiresAt:expires,
      groupPairingCode:randomBytes(12).toString('hex'),groupPairingExpiresAt:expires};
    await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  if(config.appId!==credentials.appId || config.appSecret!==credentials.appSecret)throw Error('已有新机器人配置与提供的凭据不一致');
  if(config.pairingExpiresAt<=Date.now() || config.groupPairingExpiresAt<=Date.now())throw Error('配对码已过期，需要重新生成');
  const guide=`新机器人 QQ 配对（到期时间：${new Date(config.pairingExpiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'})} 香港时间）\n\n启动新版大肥鱼后，先在 QQ 私聊机器人发送：\n/绑定 ${config.pairingCode}\n\n私聊绑定成功后，在目标 QQ 群中由主人发送（必要时先 @机器人）：\n/绑定群 ${config.groupPairingCode}\n\n配对码仅供主人使用，请勿分享。\n`;
  try {await writeFile(instructions,guide,{flag:'wx',mode:0o600});} catch(error) {if(error.code!=='EEXIST'||await readFile(instructions,'utf8')!==guide)throw error;}
  const ingressAuthority={};
  const canonical=new CanonicalQQ(store,unitOfWork,lease,projectBody,ingressAuthority);
  const result=await prepareFreshQQ({home,petId:'main',canonical,ingressAuthority,signal:lease.signal,onTurn:async()=>null,dispatch:async()=>{}});
  gateway=result.gateway;
  await unlink(pending);
  console.log('新机器人身份与配对码已准备；QQ 尚未连接。配对说明保存在 data/dsh/dsh-pet/qq-fresh-pairing.txt。');
} finally {gateway?.stop();await stores?.lease.close();await pool.end();}
