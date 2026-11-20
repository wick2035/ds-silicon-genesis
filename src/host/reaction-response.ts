import {abortable,CognitiveError,failureCode} from '../cognition/diagnostics.js';

/** A complete turn can include sensing, a model request and tool continuations. */
export const REACTION_TIMEOUT_MS=90000;
type Kind='care'|'worksite'|'interaction'|'physical';
const completed:Record<Kind,string>={care:'这次照料已完成',worksite:'工地操作已记录',interaction:'操作已记录',physical:'这次互动已记录'};
const reasons:Partial<Record<ReturnType<typeof failureCode>,string>>={
  context_overflow:'回应资料过长，暂时无法生成回应。',
  budget_exhausted:'当前模型额度或精神不足，暂时无法回应。',
  model_timeout:'回应生成超时，稍后可以继续和她说话。',
  authentication_error:'模型认证失败，请检查密钥和访问权限。',
  invalid_model_output:'模型未返回完整回应，稍后可以继续和她说话。',
};

/** Cancel promptly even if a dependency ignores the signal; never replay actions. */
export async function runReaction(respond:(signal:AbortSignal)=>Promise<string>,kind:Kind,signal?:AbortSignal):Promise<{text:string;fallback:boolean}|undefined> {
  if(signal?.aborted)return;
  const controller=new AbortController(),combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
  const timer=setTimeout(()=>controller.abort(new CognitiveError('model_timeout','回应生成超时')),REACTION_TIMEOUT_MS);
  try {
    const text=(await abortable(Promise.resolve().then(()=>{combined.throwIfAborted();return respond(combined);}),combined)).trim();
    if(signal?.aborted)return;
    combined.throwIfAborted();
    if(!text)throw new CognitiveError('invalid_model_output','模型未返回回应');
    return {text,fallback:false};
  } catch(error) {
    if(signal?.aborted)return;
    const code=failureCode(combined.aborted?combined.reason:error);
    // Never log prompts, provider response bodies, URLs or credentials.
    console.warn('[reaction]',{kind,code});
    return {text:`【系统反馈】${completed[kind]}。${reasons[code]??'暂时未能生成回应，稍后可以继续和她说话。'}`,fallback:true};
  } finally {clearTimeout(timer);controller.abort();}
}
