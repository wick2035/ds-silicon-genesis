export type CognitiveFailure = 'context_overflow'|'recall_degraded'|'budget_exhausted'|'model_timeout'|'authentication_error'|'invalid_model_output'|'cognition_timeout'|'stopped'|'model_unavailable';
export interface CognitiveDiagnostics {
  warnings?:CognitiveFailure[];
  phase?:string;
  totalMs:number;
  stages:Record<string,number>;
  trimmed:Record<string,number>;
  inputChars?:number;
  recall?:{mode:'hybrid'|'lexical';reason?:string;queries:number};
}
export class CognitiveError extends Error {
  constructor(readonly code:CognitiveFailure,message:string){super(message);this.name='CognitiveError';}
}
/** Race every external stage, including implementations that ignore cancellation. */
export function abortable<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return work;
  if(signal.aborted){void work.catch(()=>{});return Promise.reject(signal.reason);}
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason??new CognitiveError('stopped','认知已停止'));
    signal.addEventListener('abort',abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export function failureCode(error:unknown):CognitiveFailure {
  if(error instanceof CognitiveError)return error.code;
  const e=error as {code?:string;status?:number;name?:string;message?:string}|null;
  if(e?.status===401||e?.status===403||e?.code==='authentication_error')return 'authentication_error';
  if(e?.name==='SyntaxError')return 'invalid_model_output';
  return 'model_unavailable';
}
