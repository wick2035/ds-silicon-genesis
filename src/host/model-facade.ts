import { convertMessages, type ImageResolver } from './model-messages.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export interface ImportedModelConfig {
  version: 1;
  settings?: {automaticWhispers:boolean; whisperIntervalSec:number; maxTokens:number; timeoutMs:number; balanceProvider:string};
  defaultSelection: {provider:string; model:string};
  providers: Record<string, {api:'openai-completions'|'anthropic-messages'; baseURL:string; apiKey:string; models:string[]}>;
}
type Provider = ImportedModelConfig['providers'][string];
type Message = {role:'user'|'assistant'; content:string};
type StreamOptions = {provider:string; model:string; system?:string; messages:unknown[]; signal?:AbortSignal; maxTokens?:number; temperature?:number; reasoningEffort?:'low'; tools?:unknown[]};
export interface ModelBudget { reserve(provider:string, model:string, signal:AbortSignal): Promise<() => void | Promise<void>> }
export interface ModelFacadeOptions { leaseSignal:AbortSignal; budget:ModelBudget; resolveImage?:ImageResolver; timeoutMs?:number; persist?:(config:ImportedModelConfig)=>Promise<void> }
const quiet = {debug() {}, info() {}, warn() {}, error() {}};
const limit = 32768;
class ModelResultError extends Error {}
function fail(message: string): never { throw new Error(message); }
function validProvider(p: Provider): boolean {
  if (!p || !['openai-completions','anthropic-messages'].includes(p.api) || typeof p.apiKey !== 'string' || !p.apiKey || /\s/.test(p.apiKey) || !Array.isArray(p.models)) return false;
  try { const u=new URL(p.baseURL); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}
/** Configuration and lease remain in host memory, never in public model listings.
 * The lease signal must be aborted whenever the calling process loses ownership. */
export function createModelFacade(config: ImportedModelConfig, options: ModelFacadeOptions) {
  const {leaseSignal, budget, resolveImage}=options;
  let settings={automaticWhispers:false,whisperIntervalSec:300,maxTokens:1024,timeoutMs:options.timeoutMs??60000,balanceProvider:'',...config.settings};
  const validSettings=(s:typeof settings)=>typeof s.automaticWhispers==='boolean'&&Number.isInteger(s.whisperIntervalSec)&&s.whisperIntervalSec>=60&&s.whisperIntervalSec<=86400&&Number.isInteger(s.maxTokens)&&s.maxTokens>=128&&s.maxTokens<=4096&&Number.isInteger(s.timeoutMs)&&s.timeoutMs>=1000&&s.timeoutMs<=60000&&['','deepseek-official'].includes(s.balanceProvider);
  if (!config || config.version !== 1 || !config.providers || !config.defaultSelection || !budget || typeof budget.reserve !== 'function' || !leaseSignal ||
      typeof leaseSignal.addEventListener !== 'function' || !validSettings(settings)) fail('模型配置或租约无效');
  const providers=structuredClone(config.providers), selection={...config.defaultSelection};
  if (!providers[selection.provider] || !validProvider(providers[selection.provider]) || !providers[selection.provider].models.includes(selection.model)) fail('默认模型不可用');
  const active = new Set<AbortController>(); let disposed=false;
  const allowed=(provider:string,model:string) => !disposed && !leaseSignal.aborted && Object.hasOwn(providers,provider) && validProvider(providers[provider]) && providers[provider].models.includes(model);
  const llm = {
    listProviders: () => disposed || leaseSignal.aborted ? [] : Object.entries(providers).filter(([,p])=>validProvider(p)).map(([id])=>({id,name:id})),
    listModels: async (provider:string) => disposed || leaseSignal.aborted || !Object.hasOwn(providers,provider) || !validProvider(providers[provider]) ? [] : providers[provider].models.map(id=>({id,name:id})),
    resolveModelInfo: async (provider=selection.provider,model=selection.model,signal?:AbortSignal) => signal?.aborted || !allowed(provider,model) ? undefined : ({id:model,name:model}),
    stream: async function* (raw: unknown): AsyncIterable<any> {
      if (!raw || typeof raw !== 'object') return fail('模型请求无效');
      const o=raw as StreamOptions;
      if (!allowed(o.provider,o.model)) return fail('所选模型未授权或租约不可用');
      if (o.signal && typeof o.signal.addEventListener !== 'function') return fail('取消信号无效');
      const system=o.system ?? '';
      if (typeof system !== 'string' || system.length>limit || !Array.isArray(o.messages)) return fail('模型输入无效');
      if (o.maxTokens !== undefined && (!Number.isInteger(o.maxTokens) || o.maxTokens < 1 || o.maxTokens > 8192)) return fail('模型输出限制无效');
      if (o.temperature !== undefined && (!Number.isFinite(o.temperature) || o.temperature < 0 || o.temperature > 2)) return fail('模型温度无效');
      const timeoutMs=settings.timeoutMs, maxTokens=Math.min(o.maxTokens??settings.maxTokens,settings.maxTokens);
      const p=providers[o.provider], controller=new AbortController(), abort=()=>controller.abort();
      if (leaseSignal.aborted || o.signal?.aborted) return fail('模型请求已取消');
      leaseSignal.addEventListener('abort',abort,{once:true}); o.signal?.addEventListener('abort',abort,{once:true}); active.add(controller);
      const timer=setTimeout(abort,timeoutMs);
      // SDK may supply headers or inherit ambient config; reconstruct only the
      // configured credential and reject redirects and unexpected endpoints.
      const base=p.baseURL.replace(/\/+$/,''), expected=new URL(base+(p.api==='openai-completions'?'/chat/completions':'/v1/messages')).href;
      const transport: typeof fetch=async (url, init) => {
        const target=String(url), alt=p.api==='anthropic-messages'?new URL(base+'/messages').href:expected;
        if (target!==expected && target!==alt) throw new Error('模型端点不匹配');
        const headers=new Headers({'content-type':'application/json','accept':'application/json'});
        if(p.api==='openai-completions') headers.set('authorization',`Bearer ${p.apiKey}`);
        else {headers.set('x-api-key',p.apiKey);headers.set('anthropic-version','2023-06-01');}
        return fetch(target,{method:'POST',headers,body:init?.body,signal:controller.signal,redirect:'error'});
      };
      let chars=0,events=0,toolEvents=0; const toolIds=new Map<number,string>(); let release: (() => void | Promise<void>) | undefined;
      try {
        release=await budget.reserve(o.provider,o.model,controller.signal);
        if(typeof release!=='function' || controller.signal.aborted) throw new Error('budget');
        const messages=await convertMessages(o.messages,p.api,controller.signal,resolveImage);
        const tools = o.tools?.map((t:any)=>{if(!t || typeof t.name!=='string' || !t.name || !t.inputSchema || typeof t.inputSchema!=='object') throw new Error('tools'); return p.api==='openai-completions'?{type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}:{name:t.name,description:t.description,input_schema:t.inputSchema};});
        const shared={apiKey:p.apiKey,baseURL:base,maxRetries:0,timeout:timeoutMs,fetch:transport,logger:quiet,logLevel:'off' as const};
        if (p.api==='openai-completions') {
          const client=new OpenAI({...shared,organization:null,project:null,webhookSecret:null});
          const lowEffort=o.reasoningEffort==='low' && /(?:^|\.)maas\.aliyuncs\.com$/i.test(new URL(base).hostname) && /^deepseek-v4\.1-flash(?:-\d+)?$/i.test(o.model);
          const stream=await client.chat.completions.create({model:o.model,messages:[...(system?[{role:'system' as const,content:system}]:[]),...messages] as any,stream:true,n:1,...(tools?.length?{tools:tools as any}:{}),max_tokens:maxTokens,...(o.temperature!==undefined?{temperature:o.temperature}:{}),...(lowEffort?{reasoning_effort:'low' as const}:{})},{signal:controller.signal});
          for await(const chunk of stream) {
            if(controller.signal.aborted) throw new Error('cancelled');
            if(++events>4096) throw new Error('limit');
            const choice=chunk.choices.find(c=>c.index===0);
            if(choice?.finish_reason==='length') throw new ModelResultError('模型输出被截断，请提高输出 token 上限后重试');
            if(choice?.delta?.refusal || choice?.finish_reason==='content_filter') throw new ModelResultError('模型拒绝了本次请求');
            const text=choice?.delta?.content;
            if(text){chars+=text.length;if(chars>16384) throw new Error('limit');yield {type:'text-delta',index:0,text}; yield {type:'text',text};}
            for(const call of choice?.delta?.tool_calls ?? []) { if(call.id) toolIds.set(call.index,call.id); const id=toolIds.get(call.index) || ''; const name=call.function?.name; toolEvents++; const argumentsDelta=call.function?.arguments || ''; yield {type:'tool-call-delta',index:call.index+1,id,...(name?{name}:{}),argumentsDelta}; }
          }
        } else {
          const client=new Anthropic({...shared,authToken:null,webhookKey:null});
          const stream=await client.messages.create({model:o.model,system,messages:messages as any,max_tokens:maxTokens,stream:true,...(tools?.length?{tools:tools as any}:{}),...(o.temperature!==undefined?{temperature:Math.min(1,o.temperature)}:{})},{signal:controller.signal});
          for await(const chunk of stream) {
            if(controller.signal.aborted) throw new Error('cancelled');
            if(++events>4096) throw new Error('limit');
            if(chunk.type==='message_delta' && chunk.delta.stop_reason==='max_tokens') throw new ModelResultError('模型输出被截断，请提高输出 token 上限后重试');
            if(chunk.type==='message_delta' && chunk.delta.stop_reason==='refusal') throw new ModelResultError('模型拒绝了本次请求');
            if(chunk.type==='content_block_delta' && chunk.delta.type==='text_delta'){const text=chunk.delta.text;chars+=text.length;if(chars>16384) throw new Error('limit');yield {type:'text-delta',index:chunk.index,text}; yield {type:'text',text};}
            if(chunk.type==='content_block_start' && chunk.content_block.type==='tool_use') {toolIds.set(chunk.index,chunk.content_block.id); toolEvents++; yield {type:'tool-call-delta',index:chunk.index,id:chunk.content_block.id,name:chunk.content_block.name,argumentsDelta:''};}
            if(chunk.type==='content_block_delta' && chunk.delta.type==='input_json_delta') yield {type:'tool-call-delta',index:chunk.index,id:toolIds.get(chunk.index) || '',argumentsDelta:chunk.delta.partial_json};
          }
        }
        if(!chars && !toolEvents) throw new Error('empty');
      } catch (error) {
        const status=typeof error==='object' && error!==null && 'status' in error ? Number(error.status) : 0;
        const message=controller.signal.aborted?'模型请求已取消或超时':error instanceof ModelResultError?error.message:status===401||status===403?'模型服务认证失败，请检查 API 密钥和访问权限':status===404?'模型或接口不存在，请检查模型名称和服务地址':status===429?'模型服务额度不足或请求过于频繁':status>=500?'模型服务暂时不可用，请稍后重试':'模型请求未能完整完成，请检查服务配置';
        throw new Error(message);
      }
      finally {clearTimeout(timer);leaseSignal.removeEventListener('abort',abort);o.signal?.removeEventListener('abort',abort);controller.abort();active.delete(controller);if(release) await release();}
    }
  };
  const getSettings=()=>{const p=providers[selection.provider];return {protocol:p.api==='anthropic-messages'?'anthropic':'openai-compatible',baseUrl:p.baseURL,model:selection.model,hasKey:!!p.apiKey,...settings};};
  let saveQueue:Promise<unknown>=Promise.resolve();
  const doSaveSettings=async(input:Record<string,unknown>)=>{
    if(!options.persist || disposed || leaseSignal.aborted)throw Error('模型设置不可用');
    const nextSettings={...settings};
    for(const key of ['automaticWhispers','whisperIntervalSec','maxTokens','timeoutMs','balanceProvider'] as const)if(input[key]!==undefined)(nextSettings as any)[key]=input[key];
    if(!validSettings(nextSettings))throw Error('模型设置无效或余额服务不支持');
    const p=providers[selection.provider],next={...p,models:[...p.models]};
    if(input.protocol!==undefined){if(!['anthropic','openai-compatible'].includes(String(input.protocol)))throw Error('模型协议无效');next.api=input.protocol==='anthropic'?'anthropic-messages':'openai-completions';}
    if(typeof input.baseUrl==='string')next.baseURL=input.baseUrl;if(typeof input.apiKey==='string'&&input.apiKey)next.apiKey=input.apiKey;if(input.clearApiKey===true)throw Error('不能清除当前生效密钥');
    const model=typeof input.model==='string'?input.model:selection.model;if(!model || !validProvider(next))throw Error('模型配置无效');if(!next.models.includes(model))next.models.push(model);
    const updated={version:1 as const,settings:nextSettings,defaultSelection:{provider:selection.provider,model},providers:{...providers,[selection.provider]:next}};
    await options.persist(updated);providers[selection.provider]=next;selection.model=model;settings=nextSettings;return getSettings();
  };
  const saveSettings=(input:Record<string,unknown>)=>{const task=saveQueue.then(()=>doSaveSettings(input));saveQueue=task.catch(()=>{});return task;};
  const matchesCurrent=(input:Record<string,unknown>)=>!input || ((!input.protocol||input.protocol===getSettings().protocol)&&(!input.baseUrl||input.baseUrl===getSettings().baseUrl)&&(!input.model||input.model===getSettings().model)&&!input.apiKey);
  const discoverModels=async(input:Record<string,unknown>={})=>{
    if(!matchesCurrent(input))return {ok:false,code:'input',message:'请先保存设置，再查看模型列表'};
    if(disposed||leaseSignal.aborted)return {ok:false,code:'unavailable',message:'模型服务不可用'};
    const p=providers[selection.provider],base=p.baseURL.replace(/\/+$/,''),path=p.api==='anthropic-messages'&&!base.endsWith('/v1')?'/v1/models':'/models';
    const headers:Record<string,string>=p.api==='anthropic-messages'?{'x-api-key':p.apiKey,'anthropic-version':'2023-06-01'}:{authorization:`Bearer ${p.apiKey}`};
    try{
      const response=await fetch(base+path,{headers,redirect:'error',signal:AbortSignal.any([leaseSignal,AbortSignal.timeout(15000)])});
      if(!response.ok)return {ok:false,code:'provider',message:response.status===401||response.status===403?'模型服务认证失败，请检查 API 密钥和访问权限':'模型列表暂时不可用'};
      const data:any=await response.json();if(!Array.isArray(data?.data))throw Error('invalid');
      const ids=[...new Set<string>(data.data.map((x:any)=>x?.id).filter((id:unknown):id is string=>typeof id==='string'&&id.length>0&&id.length<=200))].slice(0,2000);
      return {ok:true,models:ids.map(id=>({id,name:id}))};
    }catch{return {ok:false,code:'provider',message:'模型列表暂时不可用'};}
  };
  const testConnection=async(input:Record<string,unknown>={})=>{if(!matchesCurrent(input))return {ok:false,message:'请先保存设置，再测试当前模型'};try{let text='';for await(const part of llm.stream({...selection,messages:[{role:'user',content:'Hi'}],maxTokens:1024,reasoningEffort:'low',signal:leaseSignal}))if(part.type==='text')text+=part.text;return {ok:!!text,message:text?'模型连接正常':'模型未返回内容'};}catch(error){return {ok:false,message:error instanceof Error?error.message:'模型连接失败'};}};
  const queryBalance=async()=>{if(!settings.balanceProvider)return {ok:false,provider:'',reason:'disabled'};const p=providers[selection.provider];if(p.api!=='openai-completions'||p.baseURL.replace(/\/+$/,'')!=='https://api.deepseek.com')return {ok:false,provider:'',reason:'unsupported'};try{const response=await fetch('https://api.deepseek.com/user/balance',{headers:{authorization:`Bearer ${p.apiKey}`},signal:AbortSignal.any([leaseSignal,AbortSignal.timeout(15000)]),redirect:'error'});if(!response.ok)throw Error('balance');const data:any=await response.json();if(!Array.isArray(data.balance_infos)||!data.balance_infos.length)throw Error('balance');const wallets=data.balance_infos.map((w:any)=>{if(typeof w.currency!=='string'||typeof w.total_balance!=='string'||typeof w.granted_balance!=='string'||typeof w.topped_up_balance!=='string')throw Error('balance');return {currency:w.currency,total:w.total_balance,granted:w.granted_balance,toppedUp:w.topped_up_balance};});return {ok:true,provider:'deepseek-official',shape:'money',data:{wallets}};}catch{return {ok:false,provider:'deepseek-official',reason:'fetch-error',message:'余额查询失败'};}};
  return {llm,getSettings,saveSettings,discoverModels,testConnection,queryBalance,agentDefaultModel:{currentSelection:()=>allowed(selection.provider,selection.model)?{...selection}:{provider:'',model:''}},dispose(){disposed=true;for(const c of active)c.abort();active.clear();}};
}
