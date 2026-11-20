import {appendFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {CognitiveResult} from '../cognition/index.js';

/** Diagnostics contain codes and sizes only, never prompts, memories or keys. */
export function createCognitionDiagnostics(directory:string){
  let pending=Promise.resolve();
  return {
    record(result:CognitiveResult){
      const at=new Date(),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
      const entry={at:at.toISOString(),status:result.status,reason:result.status==='degraded'?result.reason:undefined,diagnostics:result.diagnostics};
      const line=JSON.stringify(entry)+'\n';
      pending=pending.then(async()=>{await mkdir(directory,{recursive:true});await appendFile(join(directory,`cognition-${day}.jsonl`),line,'utf8');})
        .catch(()=>console.error('[cognition] 诊断日志暂时无法写入'));
      return pending;
    },
    flush:()=>pending
  };
}
