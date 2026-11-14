import { readFile } from 'node:fs/promises';
import { QQPetBridge } from '../../vendor/pet-plugins/behavior/qq-bridge.mjs';
import { CanonicalQQ, createQQExecutor, type QQIncoming, type QQTransport } from './qq-canonical.js';
import type { OutboxIntent, ExecutionReceipt } from '../storage/uow.js';

interface QQConfig { enabled:boolean; appId:string; appSecret:string; petId?:string; sandbox?:boolean; ownerOpenid?:string; groupOpenid?:string; groupOwnerOpenid?:string; groupEnabled?:boolean; groupMode?:'owner'|'mentions'|'all'; pairingCode?:string; pairingExpiresAt?:number; groupPairingCode?:string; groupPairingExpiresAt?:number }
export async function readQQConfig(path:string):Promise<QQConfig> {
  const config=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')) as QQConfig;
  if(!config || config.enabled!==true || !config.appId || !config.appSecret) throw new Error('QQ 配置未启用或凭据缺失');
  return config;
}
export interface QQGatewayOptions {
  config:QQConfig; canonical:CanonicalQQ; ingressAuthority:object; signal:AbortSignal;
  /** Uses the same authenticated conversation/model boundary as desktop. */
  onTurn(input:{petId:string;scene:'c2c'|'group';messages:Array<{text:string;isOwner:boolean;eventId:string}>},signal:AbortSignal):Promise<string|null>;
  /** Dispatches an already persisted outbox row, never directly sends. */
  dispatch(actionId:string):Promise<unknown>;
  onStatus?:(state:string)=>void;
}
type Item={text:string;isOwner:boolean;eventId:string;messageId:string;receivedAt:number};
/** Reuses only original QQ gateway handshake, heartbeat and reconnection. All
 * application input, pairing and outbound delivery are overridden below. */
export class CanonicalQQGateway extends QQPetBridge {
  readonly #options:QQGatewayOptions;
  #items:Item[]=[];
  #timer?:ReturnType<typeof setTimeout>;
  #batchStarted=0;
  #lastGroupReply=0;
  #queuedTurns=0;
  #serial:Promise<void>=Promise.resolve();
  #closed=false;
  #abort=()=>{this.stop();};
  readonly executor:(petId:string,intent:OutboxIntent,signal:AbortSignal)=>Promise<ExecutionReceipt>;
  constructor(options:QQGatewayOptions) {
    super(options.config,{status:()=>{},canSpeak:()=>true});
    this.#options=options;
    this.executor=createQQExecutor({send:(input,signal)=>this.sendMessage(input,signal)});
    if(options.signal.aborted) this.#closed=true; else options.signal.addEventListener('abort',this.#abort,{once:true});
  }
  async start():Promise<void> { if(this.#closed || this.#options.signal.aborted) throw new Error('QQ 通道不可用'); await super.start(); }
  /** No legacy api() send is allowed; gateway uses only GET /gateway. */
  async api(route:string, body?:unknown):Promise<any> {
    if(route!=='/gateway' || body!==undefined) throw new Error('QQ 直接发送被禁用');
    return this.request(route,undefined,this.#options.signal);
  }
  private async request(route:string,body:Record<string,unknown>|undefined,signal:AbortSignal):Promise<any> {
    if(this.#closed || signal.aborted) throw new Error('QQ 已停止');
    const access=await this.token();
    const response=await this.fetch(this.base+route,{method:body?'POST':'GET',headers:{Authorization:'QQBot '+access,'X-Union-Appid':this.#options.config.appId,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([signal,this.abort.signal,AbortSignal.timeout(15000)])});
    if(!response.ok) { if(response.status===401)this.expiresAt=0; throw new Error('QQ 平台请求失败'); }
    return response.json();
  }
  private async sendMessage(input:{scene:'c2c'|'group';destination:string;content:string;replyTo?:string},signal:AbortSignal):Promise<{messageId:string}> {
    if(input.scene==='group' && [...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(input.content)].length>15) throw new Error('群回复超过 15 字');
    const route=(input.scene==='group'?'/v2/groups/':'/v2/users/')+encodeURIComponent(input.destination)+'/messages';
    const result=await this.request(route,{content:input.content,msg_type:0,...(input.replyTo?{msg_id:input.replyTo,msg_seq:1}:{})},signal);
    if(typeof result?.id!=='string'||!result.id) throw new Error('QQ 未返回消息回执');
    return {messageId:result.id};
  }
  async receive(message:any,scene:'c2c'|'group'='c2c',eventType=''):Promise<void> {
    if(this.#closed || this.#options.signal.aborted) return;
    const actor=scene==='group'?message?.author?.member_openid:message?.author?.user_openid;
    if(typeof actor!=='string'||typeof message?.id!=='string'||typeof message?.content!=='string'||message.author?.bot===true || (scene==='group'&&this.botId===actor)) return;
    const age=Date.now()-Date.parse(message.timestamp); if(!Number.isFinite(age)||age>240000||age < -60000)return;
    const input:QQIncoming={messageId:message.id,scene,actorOpenid:actor,...(scene==='group'?{groupOpenid:message.group_openid,mentioned:eventType==='GROUP_AT_MESSAGE_CREATE'}:{}),text:message.content.trim(),occurredAt:message.timestamp};
    const petId=this.#options.config.petId||'main';
    const paired=await this.#options.canonical.pair(petId,input,this.#options.ingressAuthority);
    if(paired.paired && paired.eventId) { await this.respond(scene,[{text:'',isOwner:true,eventId:paired.eventId,messageId:message.id,receivedAt:Date.now()}],scene==='group'?'群绑定好啦。':'绑定好啦。'); return; }
    const result=await this.#options.canonical.receive(petId,input,this.#options.ingressAuthority);
    if(!result.accepted||!result.eventId||this.#closed) return;
    const item={text:input.text,isOwner:result.isOwner,eventId:result.eventId,messageId:input.messageId,receivedAt:Date.now()};
    if(scene==='c2c') { this.enqueueTurn(scene,[item]); return; }
    if (!this.#items.length) this.#batchStarted=Date.now();
    this.#items.push(item);
    while(this.#items.length>24 || (this.#items.length>1 && this.#items.reduce((n,x)=>n+x.text.length,0)>6000)) this.#items.shift();
    this.scheduleGroup();
  }
  private scheduleGroup():void {
    if(this.#timer)clearTimeout(this.#timer);
    const now=Date.now(), flushAt=Math.max(now,Math.min(now+4000,this.#batchStarted+12000),this.#lastGroupReply+10000);
    this.#timer=setTimeout(()=>{this.#timer=undefined; const items=this.#items.splice(0); this.#batchStarted=0; this.enqueueTurn('group',items);},flushAt-now);
  }
  private enqueueTurn(scene:'c2c'|'group',items:Item[]):void {
    if(this.#queuedTurns>=4) { this.statusSafe('queue-full'); return; }
    this.#queuedTurns++;
    this.#serial=this.#serial.then(()=>this.runTurn(scene,items)).catch(()=>this.statusSafe('message-failed')).finally(()=>{this.#queuedTurns--;});
  }
  private statusSafe(state:string):void { try{this.#options.onStatus?.(state);}catch{} }
  private async runTurn(scene:'c2c'|'group',items:Item[]):Promise<void> {
    items=items.filter(item=>Date.now()-item.receivedAt<=240000);
    if(!items.length||this.#closed||this.#options.signal.aborted)return;
    let text:string|null;
    try {
      text=await this.#options.onTurn({petId:this.#options.config.petId||'main',scene,messages:items.map(({text,isOwner,eventId})=>({text,isOwner,eventId}))},this.#options.signal);
    } catch(error) {
      this.statusSafe('message-failed');
      if(this.#closed||this.#options.signal.aborted)return;
      const walletEmpty=error instanceof Error && error.message==='模拟饭钱已用完，请先添加饭钱';
      text=scene==='c2c'&&walletEmpty?'我的饭钱用完啦，请先加一点。':'我暂时没接上，请稍后再试。';
    }
    if(text?.trim()&&!this.#closed&&!this.#options.signal.aborted) await this.respond(scene,items,text);
  }
  private async respond(scene:'c2c'|'group',items:Item[],text:string):Promise<void> {
    const last=items.at(-1); if(!last||this.#closed||this.#options.signal.aborted)return;
    const action=await this.#options.canonical.enqueue(this.#options.config.petId||'main','reply:'+last.messageId,scene,text,last.eventId,last.messageId,this.#options.ingressAuthority);
    if(!this.#closed&&!this.#options.signal.aborted) { await this.#options.dispatch(action); if(scene==='group')this.#lastGroupReply=Date.now(); }
  }
  stop():void {
    if(this.#closed)return; this.#closed=true;
    if(this.#timer)clearTimeout(this.#timer); this.#items=[];
    this.#options.signal.removeEventListener('abort',this.#abort);
    super.stop();
  }
}
