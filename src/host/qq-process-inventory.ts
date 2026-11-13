import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

/** Fail closed when the Windows process inventory is incomplete. Processes
 * belonging to this installation are ignored; no process is terminated. */
export async function verifyOldQQAbsent(root:string):Promise<boolean> {
  if(process.platform!=='win32')return false;
  const encodedRoot=Buffer.from(root.toLowerCase().replaceAll('/','\\'),'utf16le').toString('base64');
  const script=`$ErrorActionPreference = 'Stop'
$root = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedRoot}'))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ownerPid = ${process.pid}
foreach ($p in (Get-CimInstance Win32_Process)) {
  if ($p.ProcessId -eq $ownerPid -or $p.ProcessId -eq $PID) { continue }
  $name = ([string]$p.Name).ToLowerInvariant()
  if ($name -notmatch '^(node|nodejs|electron|deepseek|deepseek harness|dsh|python|pythonw)([0-9.]*)?\\.exe$') { continue }
  $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { exit 2 }
  if ($owner.Sid -ne $sid) { continue }
  if ([string]::IsNullOrWhiteSpace($p.CommandLine)) { exit 2 }
  $cmd = $p.CommandLine.ToLowerInvariant().Replace('/','\\')
  if ($cmd.Contains($root)) { continue }
  if ($name -match '^(electron|deepseek|deepseek harness|dsh|python|pythonw)([0-9.]*)?\\.exe$') { exit 3 }
  if ($cmd.Contains('dsh-pet') -or $cmd.Contains('pet-companion') -or $cmd.Contains('\\.dsh\\profiles\\desktop') -or $cmd.Contains('\\deepseek\\resources\\app')) { exit 3 }
}
exit 0`;
  try {await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,maxBuffer:16384});return true;} catch{return false;}
}
