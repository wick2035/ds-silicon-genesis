import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import type { ExecutionReceipt, OutboxIntent } from '../storage/uow.js';

type Source={url:string;title:string;snippet:string};
const maxBytes=1_000_000;
function publicV4(ip:string):boolean {
  if(isIP(ip)!==4)return false;
  const [a,b,c]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
function checkedUrl(raw:string):URL {
  const u=new URL(raw);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port && !['80','443'].includes(u.port)||u.hostname==='localhost'||u.hostname.endsWith('.local'))throw new Error('只允许公开网页地址');
  return u;
}
/** Direct, DNS-pinned requests: no proxy, no credential forwarding and every
 * redirect is resolved and checked again. IPv6-only hosts fail closed. */
async function readPublic(raw:string,signal:AbortSignal,redirects=0):Promise<{url:string;body:string;contentType:string}> {
  if(signal.aborted)throw new Error('请求已取消');
  const url=checkedUrl(raw);const addresses=await lookup(url.hostname,{all:true,verbatim:true});
  const ipv4=addresses.filter(a=>a.family===4);
  if(!ipv4.length||ipv4.some(a=>!publicV4(a.address)))throw new Error('网页地址不是公开 IPv4 地址');
  const address=ipv4[0].address;
  return new Promise((resolve,reject)=>{
    const transport=url.protocol==='https:'?httpsRequest:httpRequest;
    const req=transport(url,{method:'GET',family:4,headers:{'accept':'text/html,text/plain,application/json','accept-encoding':'identity','user-agent':'DaFei-LifeOS/1.0'},lookup:((_host:any,opts:any,cb:any)=>opts?.all ? cb(null,[{address,family:4}]) : cb(null,address,4)) as any,signal},res=>{
      const status=res.statusCode||0;
      if([301,302,303,307,308].includes(status)) {const location=res.headers.location;res.resume();if(!location||redirects>=3){reject(new Error('网页重定向过多'));return;}readPublic(new URL(location,url).href,signal,redirects+1).then(resolve,reject);return;}
      const type=String(res.headers['content-type']||'').toLowerCase();
      if(status<200||status>=300||!(/^(text\/html|text\/plain|application\/json)/.test(type))||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.resume();reject(new Error('网页不可读取'));return;}
      let size=0;const chunks:Buffer[]=[];
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){req.destroy(new Error('网页过大'));return;}chunks.push(chunk);});
      res.on('end',()=>resolve({url:url.href,body:Buffer.concat(chunks).toString('utf8'),contentType:type}));res.on('error',()=>reject(new Error('网页读取失败')));
    });
    req.setTimeout(15000,()=>req.destroy(new Error('网页读取超时')));req.on('error',()=>reject(new Error(signal.aborted?'请求已取消':'网页读取失败')));req.end();
  });
}
const decode=(s:string)=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,Number(n))));
const plain=(s:string)=>decode(s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
export function createPublicWeb() {
  return {
    async search(input:{query:string;maxResults:number},signal:AbortSignal):Promise<{sources:Source[]}> {
      if(typeof input.query!=='string'||!input.query.trim()||input.query.length>300||!Number.isInteger(input.maxResults)||input.maxResults<1||input.maxResults>10)throw new Error('搜索参数无效');
      const sources:Source[]=[];
      // Results are only candidates; the executor still reads a public page.
      // Discard unrelated search titles rather than storing irrelevant pages as knowledge.
      const ignored=new Set(['什么','意思','如何','怎么','为什么','多少','查询','搜索','了解','介绍','定义']);
      const terms=[...new Set((input.query.toLowerCase().match(/[a-z0-9]{3,}|[\p{Script=Han}]{2,}/gu)||[]).flatMap(term=>/\p{Script=Han}/u.test(term)?Array.from({length:term.length-1},(_,i)=>term.slice(i,i+2)).filter(t=>!ignored.has(t)):[term]))];
      for(const provider of ['so','duckduckgo','bing'] as const){
        if(signal.aborted)throw new Error('请求已取消');
        try {
          const search=new URL(provider==='so'?'https://www.so.com/s':provider==='duckduckgo'?'https://html.duckduckgo.com/html/':'https://cn.bing.com/search');search.searchParams.set('q',input.query);
          const page=await readPublic(search.href,signal);
          const pattern=provider==='so'?/<h3\b[^>]*class=["'][^"']*\bres-title\b[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi:provider==='duckduckgo'?/<a\b([^>]*)>([\s\S]*?)<\/a>/gi:/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>[\s\S]*?<h2[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
          for(const match of page.body.matchAll(pattern)){
            try {if(provider==='duckduckgo'&&!/class=["'][^"']*result__a/i.test(match[1]))continue;const href=(provider==='so'?/data-mdurl=["']([^"']+)/i.exec(match[1])?.[1]:undefined)??/href=["']([^"']+)/i.exec(match[1])?.[1];if(!href)continue;let link=new URL(decode(href),page.url);const redirected=link.searchParams.get('uddg');if(redirected)link=new URL(redirected);checkedUrl(link.href);const title=plain(match[2]);if(title&&(!terms.length||terms.some(t=>title.toLowerCase().includes(t)))&&!sources.some(s=>s.url===link.href))sources.push({url:link.href,title:title.slice(0,200),snippet:''});}catch{/* skip malformed links */}
            if(sources.length>=input.maxResults)break;
          }
          if(sources.length)return {sources};
        } catch {if(signal.aborted)throw new Error('请求已取消');}
      }
      throw new Error('搜索服务没有返回可读取的结果');
    },
    async fetch(input:{url:string;maxChars:number},signal:AbortSignal):Promise<{url:string;content:string;untrusted:true}> {
      if(!Number.isInteger(input.maxChars)||input.maxChars<1||input.maxChars>10000)throw new Error('读取长度无效');
      const page=await readPublic(input.url,signal);const content=page.contentType.startsWith('text/html')?plain(page.body):page.body.trim();
      if(!content)throw new Error('网页没有可读取内容');return {url:page.url,content:content.slice(0,input.maxChars),untrusted:true};
    }
  };
}
interface Mcp {call(name:string,args:Record<string,unknown>,options:{signal:AbortSignal;timeoutMs:number}):Promise<unknown>;stop():void}
/** Lazy-owned child: only these read-only tools are available. */
export function createBiliReader(root:string) {
  let client:Mcp|undefined, opening:Promise<Mcp>|undefined, closed=false;
  async function get():Promise<Mcp>{
    if(closed)throw new Error('B站服务已关闭');if(client)return client;
    if(!opening)opening=(async()=>{const moduleUrl=new URL('../../vendor/pet-plugins/bili/upstream/lib/mcp.mjs',import.meta.url).href;const mod=await import(moduleUrl);if(closed)throw new Error('B站服务已关闭');const c=new mod.McpClient({command:path.join(root,'runtime','python311','python.exe'),args:[path.join(root,'data','bili','mcp_server.py')],cwd:path.join(root,'data','bili'),env:{BILI_DUTY_HOME:path.join(root,'data','bili'),BILI_MCP_TOOLS:'bili_search,bili_subtitle,bili_video_info'},log:()=>{}}) as Mcp;client=c;return c;})();
    try{return await opening;}finally{opening=undefined;}
  }
  return {async call(name:'bili_search'|'bili_subtitle'|'bili_video_info',args:Record<string,unknown>,signal:AbortSignal){if(!['bili_search','bili_subtitle','bili_video_info'].includes(name)||signal.aborted)throw new Error('B站操作不可用');const c=await get();try{return await c.call(name,args,{signal,timeoutMs:45000});}catch{throw new Error(signal.aborted?'B站请求已取消':'B站资料不可用，可能需要登录');}},close(){closed=true;client?.stop();client=undefined;}};
}
/** Trust boundary: only the registered dispatcher may invoke this executor.
 * Sources remain untrusted material; it never executes extracted instructions. */
export function createExplorationExecutor(web:ReturnType<typeof createPublicWeb>,bili:ReturnType<typeof createBiliReader>) {
  return async (_petId:string,intent:OutboxIntent,signal:AbortSignal):Promise<ExecutionReceipt>=>{
    try {
    if(signal.aborted)return {status:'cancelled',evidence:{actionId:intent.id,kind:'learning.observe',reason:'探索已取消'}};
    const p=intent.payload.parameters as Record<string,unknown>;
    if(intent.type!=='learning.observe'||!p||typeof p.query!=='string'||!p.query.trim()||p.query.length>300)throw new Error('探索参数无效');
    let documentUrl:string,content:string;
    if(p.kind==='bili'){
      const direct=p.query.match(/BV[A-Za-z0-9]{10}/)?.[0];const found=direct?null:await bili.call('bili_search',{keyword:p.query,num:2},signal);const id=direct||JSON.stringify(found).match(/BV[A-Za-z0-9]{10}/)?.[0];if(!id)throw new Error('未找到可读取视频');
      const subtitle=await bili.call('bili_subtitle',{bvid:id},signal);let value:any=subtitle;if(typeof value==='string'){try{value=JSON.parse(value);}catch{value={text:value};}}
      if(value?.error||value?.ok===false||typeof value?.text!=='string'||!value.text.trim()||/无字幕|没有字幕|未登录|登录失效/.test(value.text))throw new Error('视频字幕不可用，可能需要登录');
      documentUrl=`https://www.bilibili.com/video/${id}`;content=value.text.slice(0,4000);
    } else {
      const sources=p.kind==='fetch'&&typeof p.url==='string'?[p.url]:(await web.search({query:p.query,maxResults:5},signal)).sources.map(source=>source.url);
      let page:{url:string;content:string}|undefined;
      for(const url of sources){try{const candidate=await web.fetch({url,maxChars:4000},signal);if((p.kind!=='fetch' && candidate.content.trim().length<100) || /(?:^|\s)(?:404|访问的地址不存在|页面不存在)(?:\s|$)/u.test(candidate.content))continue;page ??=candidate;if(/是指|指的是|定义为/u.test(candidate.content)){page=candidate;break;}}catch{if(signal.aborted)throw new Error('探索已取消');}}
      if(!page)throw new Error('没有可读取的搜索结果');documentUrl=page.url;content=page.content;
    }
    if(signal.aborted)throw new Error('探索已取消');
    return {status:'completed',evidence:{actionId:intent.id,kind:'learning.observe',confirmed:true,documentUrl,content,untrusted:true,query:p.query,...(typeof p.followUpQuestion==='string' && p.followUpQuestion.trim() && p.followUpQuestion.length<=200?{followUpQuestion:p.followUpQuestion.trim()}:{})}};
    } catch {return {status:signal.aborted?'cancelled':'failed',evidence:{actionId:intent.id,kind:'learning.observe',reason:signal.aborted?'探索已取消':'资料获取失败'}};}
  };
}
