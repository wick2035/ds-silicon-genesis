import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

/** verifyNoOldBridge must inspect a complete, trustworthy host inventory.
 * A free PostgreSQL lock alone is insufficient: the old bridge keeps running
 * after its database connection fails. Never infer absence from a status file. */
export async function cutoverQQ({home,targetHome,verifyNoOldBridge}) {
  if(typeof home!=='string'||!home||typeof targetHome!=='string'||!targetHome||typeof verifyNoOldBridge!=='function')throw Error('需要可信的旧 QQ 实例清单；不能仅凭数据库锁接管');
  const folder=join(home,'dsh-pet'), root=join(folder,'companion');
  const db=JSON.parse((await readFile(join(root,'postgres.json'),'utf8')).replace(/^\uFEFF/,''));
  if(db.namespace!=='desktop-pet'||!db.connection)throw Error('旧 companion 数据库配置无效');
  const client=new pg.Client({...db.connection,connectionTimeoutMillis:5000,statement_timeout:15000,application_name:'silicon-qq-cutover'});
  let temporary;
  try {
    await client.connect();
    const lock=await client.query("SELECT pg_try_advisory_lock(hashtext('pet_companion'),hashtext($1)) AS ok",[db.namespace]);
    if(!lock.rows[0]?.ok)throw Error('旧 companion 锁仍被占用，拒绝切换');
    if(await verifyNoOldBridge()!==true)throw Error('无法证明旧 QQ 连接不存在，拒绝切换');
    const configPath=join(folder,'qq-config.json'), raw=await readFile(configPath), config=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));
    if(!config || typeof config!=='object' || Array.isArray(config) || typeof config.enabled!=='boolean')throw Error('旧 QQ 配置格式无效');
    const target=join(targetHome,'dsh-pet'); await mkdir(target,{recursive:true,mode:0o700});
    const id=randomUUID(), backup=join(target,'qq-config.pre-cutover.json'), proof=join(target,'qq-cutover-proof.json'), targetConfig=join(target,'qq-config.json');
    const putSame=async(path,bytes)=>{try{await writeFile(path,bytes,{mode:0o600,flag:'wx'});}catch(e){if(e?.code!=='EEXIST'||!(await readFile(path)).equals(bytes))throw Error('目标文件存在且内容不匹配');}};
    let original=raw;
    if(!config.enabled) {
      try { const candidate=await readFile(targetConfig), parsed=JSON.parse(candidate.toString('utf8').replace(/^\uFEFF/,''));
        const disabled=Buffer.from(JSON.stringify({...parsed,enabled:false},null,2)+'\n');
        if(!candidate.equals(raw) && !disabled.equals(raw))throw Error('源配置与目标副本不匹配');
        original=candidate;
      } catch(e) {if(e?.code!=='ENOENT')throw e;}
    }
    await putSame(backup,original);await putSame(targetConfig,original);
    for(const name of ['qq-receipts.json','qq-outbound.json']) { try {const bytes=await readFile(join(folder,name));await putSame(join(target,name),bytes);} catch(e) {if(e?.code!=='ENOENT')throw e;} }
    const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
    const backupHash=digest(original);
    const sourceAfter=Buffer.from(JSON.stringify({...config,enabled:false},null,2)+'\n');
    if(config.enabled) {
      temporary=join(folder,`.qq-config-cutover-${id}.tmp`);
      await writeFile(temporary,sourceAfter,{mode:0o600,flag:'wx'});
      const current=await readFile(configPath);
      if(!current.equals(raw))throw Error('QQ 配置在切换期间发生变化');
      if(await verifyNoOldBridge()!==true)throw Error('旧 QQ 状态已变化，拒绝切换');
      await rename(temporary,configPath);temporary=undefined;
    }
    const finalSource=await readFile(configPath);
    const proofData={version:1,backup:'qq-config.pre-cutover.json',targetConfig:'qq-config.json',backupSha256:backupHash,sourceSha256:digest(finalSource),lock:'pet_companion:desktop-pet',verifiedNoOldBridge:true};
    const proofBytes=Buffer.from(JSON.stringify(proofData,null,2)+'\n');
    await putSame(proof,proofBytes);
    return {backup,proof};
  } finally {if(temporary)await unlink(temporary).catch(()=>{});await client.end().catch(()=>{});}
}

/** Read-only enumeration; no process identifiers or command lines are emitted. */
export async function verifyWindowsOldQQAbsent() {
  if(process.platform!=='win32')return false;
  const script=`$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ownerPid = ${process.pid}
$items = Get-CimInstance Win32_Process
foreach ($p in $items) {
  if ($p.ProcessId -eq $ownerPid -or $p.ProcessId -eq $PID) { continue }
  $name = ([string]$p.Name).ToLowerInvariant()
  if ($name -notmatch '^(node|nodejs|electron|deepseek|deepseek harness|dsh|python|pythonw)([0-9.]*)?\\.exe$') { continue }
  $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { exit 2 }
  if ($owner.Sid -ne $sid) { continue }
  if ([string]::IsNullOrWhiteSpace($p.CommandLine)) { exit 2 }
  if ($name -match '^(electron|deepseek|deepseek harness|dsh|python|pythonw)([0-9.]*)?\\.exe$') { exit 3 }
  $cmd = $p.CommandLine.ToLowerInvariant().Replace('/','\\')
  if ($cmd.Contains('dsh-pet') -or $cmd.Contains('pet-companion') -or $cmd.Contains('\\.dsh\\profiles\\desktop') -or $cmd.Contains('\\deepseek\\resources\\app')) { exit 3 }
}
exit 0`;
  try { await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,maxBuffer:16384}); return true; }
  catch { return false; }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const home=process.argv[2], targetHome=process.argv[3];
  if(!home || !targetHome || process.argv.length!==4) { process.stderr.write('用法: node tools/cutover-qq.mjs <旧 DSH_HOME> <目标 DSH_HOME>\n');process.exitCode=1; }
  else try { await cutoverQQ({home,targetHome,verifyNoOldBridge:verifyWindowsOldQQAbsent});process.stdout.write('QQ 配置切换完成，已保存备份与本地证明。\n'); }
  catch { process.stderr.write('QQ 切换未完成：旧实例、数据库锁或配置状态无法确认；请检查后重试。\n');process.exitCode=1; }
}
