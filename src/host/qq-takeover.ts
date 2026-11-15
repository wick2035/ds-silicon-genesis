import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanonicalQQ, type QQIdentity } from './qq-canonical.js';
import { CanonicalQQGateway, readQQConfig, type QQGatewayOptions } from './qq-gateway.js';

type Receipt = [string,number];
type Outbound = [string,{at:number;state:string}];
/** The owner of the old bridge must attest its own shutdown. No process or
 * window discovery/termination is performed by this module. An unavailable
 * or inconclusive hook leaves QQ offline. */
export interface LegacyQQStopHook {
  stopAndVerify():Promise<'stopped'|'absent'|'unknown'>;
}
export interface QQTakeoverOptions {
  legacyHome:string;
  canonical:CanonicalQQ;
  stopHook?:LegacyQQStopHook;
  ingressAuthority:object;
  signal:AbortSignal;
  onTurn:QQGatewayOptions['onTurn'];
  dispatch:QQGatewayOptions['dispatch'];
  onStatus?:QQGatewayOptions['onStatus'];
  diagnosticPath?:string;
}
async function optionalRows(path:string, kind:'inbound'|'outbound'):Promise<Receipt[]|Outbound[]> {
  let raw:string;
  try {raw=await readFile(path,'utf8');} catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw Error('QQ 历史回执无法读取');}
  let data:unknown;try{data=JSON.parse(raw.replace(/^\uFEFF/,''));}catch{throw Error('QQ 历史回执格式损坏');}
  if(!Array.isArray(data) || !data.every(row=>Array.isArray(row) && typeof row[0]==='string' && row[0].length>0 && (kind==='inbound' ? Number.isFinite(row[1]) : row[1] && Number.isFinite(row[1].at) && (row[1].state===undefined || typeof row[1].state==='string'))))throw Error('QQ 历史回执格式损坏');
  return kind==='outbound' ? data.map(row=>[row[0],{at:row[1].at,state:typeof row[1].state==='string'?row[1].state:'unknown'}] as Outbound) : data as Receipt[];
}
/** Imports only after explicit stop attestation, then builds an unstarted
 * gateway. Credentials stay in memory and are never included in its result. */
export async function prepareQQTakeover(options:QQTakeoverOptions):Promise<
  | {status:'offline';reason:'old-connection-unverified'}
  | {status:'ready';petId:string;gateway:CanonicalQQGateway;executor:CanonicalQQGateway['executor']}
> {
  if(options.signal.aborted)throw Error('QQ 接管已取消');
  const stopped=await options.stopHook?.stopAndVerify();
  if(stopped!=='stopped' && stopped!=='absent')return {status:'offline',reason:'old-connection-unverified'};
  if(options.signal.aborted)throw Error('QQ 接管已取消');
  const folder=join(options.legacyHome,'dsh-pet');
  const config=await readQQConfig(join(folder,'qq-config.json'));
  const [inbound,outbound]=await Promise.all([optionalRows(join(folder,'qq-receipts.json'),'inbound'),optionalRows(join(folder,'qq-outbound.json'),'outbound')]);
  const petId=config.petId||'main';
  const identity:QQIdentity={appId:config.appId,groupEnabled:config.groupEnabled===true,groupMode:config.groupMode??'owner',
    ...(config.ownerOpenid?{ownerOpenid:config.ownerOpenid}:{}),...(config.groupOpenid?{groupOpenid:config.groupOpenid}:{}),...(config.groupOwnerOpenid?{groupOwnerOpenid:config.groupOwnerOpenid}:{})};
  if(options.signal.aborted)throw Error('QQ 接管已取消');
  await options.canonical.importState(petId,identity,inbound as Receipt[],outbound as Outbound[]);
  const codes:{owner?:{code:string;expiresAt:number};group?:{code:string;expiresAt:number}}={};
  if(config.pairingCode && Number.isFinite(config.pairingExpiresAt) && config.pairingExpiresAt!>Date.now())codes.owner={code:config.pairingCode,expiresAt:config.pairingExpiresAt!};
  if(config.groupPairingCode && Number.isFinite(config.groupPairingExpiresAt) && config.groupPairingExpiresAt!>Date.now())codes.group={code:config.groupPairingCode,expiresAt:config.groupPairingExpiresAt!};
  if(codes.owner || codes.group)await options.canonical.configurePairing(petId,codes);
  const gateway=new CanonicalQQGateway({config,canonical:options.canonical,ingressAuthority:options.ingressAuthority,signal:options.signal,onTurn:options.onTurn,dispatch:options.dispatch,onStatus:options.onStatus,diagnosticPath:options.diagnosticPath});
  return {status:'ready',petId,gateway,executor:gateway.executor};
}

/** A separately created bot has its own OpenIDs and receipt namespace. Never
 * import the old bot's bindings or receipts into it. An existing canonical
 * identity for another app is rejected by importState. */
export async function prepareFreshQQ(options:Omit<QQTakeoverOptions,'legacyHome'|'stopHook'> & {home:string;petId:string}):Promise<{
  status:'ready';petId:string;gateway:CanonicalQQGateway;executor:CanonicalQQGateway['executor'];
}> {
  if(options.signal.aborted)throw Error('QQ 接入已取消');
  const folder=join(options.home,'dsh-pet');
  const config=await readQQConfig(join(folder,'qq-fresh-config.json'));
  if(!/^\d+$/.test(config.appId) || typeof config.appSecret!=='string' || !config.appSecret.trim() ||
    (config.groupMode!==undefined && !['owner','mentions','all'].includes(config.groupMode)) ||
    (config.petId||'main')!==options.petId || config.ownerOpenid || config.groupOpenid || config.groupOwnerOpenid)
    throw Error('新 QQ 机器人配置必须重新配对');
  try {
    const old=JSON.parse((await readFile(join(folder,'qq-config.json'),'utf8')).replace(/^\uFEFF/,''));
    if(old?.appId===config.appId)throw Error('旧机器人不能以新机器人模式接入');
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const identity:QQIdentity={appId:config.appId,groupEnabled:config.groupEnabled===true,groupMode:config.groupMode??'owner'};
  await options.canonical.importState(options.petId,identity,[],[]);
  const codes:{owner?:{code:string;expiresAt:number};group?:{code:string;expiresAt:number}}={};
  if(config.pairingCode && Number.isFinite(config.pairingExpiresAt) && config.pairingExpiresAt!>Date.now())codes.owner={code:config.pairingCode,expiresAt:config.pairingExpiresAt!};
  if(config.groupPairingCode && Number.isFinite(config.groupPairingExpiresAt) && config.groupPairingExpiresAt!>Date.now())codes.group={code:config.groupPairingCode,expiresAt:config.groupPairingExpiresAt!};
  if(codes.owner || codes.group)await options.canonical.configurePairing(options.petId,codes);
  if(options.signal.aborted)throw Error('QQ 接入已取消');
  const gateway=new CanonicalQQGateway({config,canonical:options.canonical,ingressAuthority:options.ingressAuthority,signal:options.signal,onTurn:options.onTurn,dispatch:options.dispatch,onStatus:options.onStatus,diagnosticPath:options.diagnosticPath});
  return {status:'ready',petId:options.petId,gateway,executor:gateway.executor};
}

/** Checks only the imported target files. Runtime ownership still requires the
 * independently supplied stop hook and the host's exclusive writer lease. */
export async function verifyQQCutoverProof(targetHome:string):Promise<boolean> {
  try {
    const folder=join(targetHome,'dsh-pet');
    const [proofBytes,config,backup]=await Promise.all(['qq-cutover-proof.json','qq-config.json','qq-config.pre-cutover.json'].map(name=>readFile(join(folder,name))));
    const proof=JSON.parse(proofBytes.toString('utf8'));
    const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
    return proof.version===1 && proof.verifiedNoOldBridge===true && proof.lock==='pet_companion:desktop-pet' && proof.backup==='qq-config.pre-cutover.json' && proof.targetConfig==='qq-config.json' && typeof proof.sourceSha256==='string' && /^[a-f0-9]{64}$/.test(proof.sourceSha256) && proof.backupSha256===digest(config) && proof.backupSha256===digest(backup);
  } catch { return false; }
}
