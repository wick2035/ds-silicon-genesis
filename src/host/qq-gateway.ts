import { readFile } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { QQPetBridge } from '../../vendor/pet-plugins/behavior/qq-bridge.mjs';
import { CanonicalQQ, createQQExecutor, QQPlatformRejection, type QQIncoming, type QQTransport } from './qq-canonical.js';
import type { OutboxIntent, ExecutionReceipt } from '../storage/uow.js';
import type {QQTurnResult} from './qq-sleep.js';
import {platformNickname} from './group-people.js';

interface QQConfig { enabled:boolean; appId:string; appSecret:string; petId?:string; sandbox?:boolean; ownerOpenid?:string; groupOpenid?:string; groupOwnerOpenid?:string; groupEnabled?:boolean; groupMode?:'owner'|'mentions'|'all'; pairingCode?:string; pairingExpiresAt?:number; groupPairingCode?:string; groupPairingExpiresAt?:number }
export async function readQQConfig(path:string):Promise<QQConfig> {
  const config=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')) as QQConfig;
  if(!config || config.enabled!==true || !config.appId || !config.appSecret) throw new Error('QQ 配置未启用或凭据缺失');
  return config;
}
export interface QQGatewayOptions {
  config:QQConfig; canonical:CanonicalQQ; ingressAuthority:object; signal:AbortSignal;
  /** Uses the same authenticated conversation/model boundary as desktop. */
  onTurn(input:{petId:string;scene:'c2c'|'group';messages:Array<{text:string;isOwner:boolean;eventId:string}>;
    selectReplyTo?:(eventId:string)=>void;sleepCatchupId?:string},signal:AbortSignal):Promise<QQTurnResult>;
  /** Dispatches an already persisted outbox row, never directly sends. */
  dispatch(actionId:string):Promise<unknown>;
  onStatus?:(state:string)=>void;
  diagnosticPath?:string;
}

/** Private transport metadata only: never persist content, codes or OpenIDs. */
function diagnostics(path?:string) {
  const latest:Record<string,unknown>={startedAt:new Date().toISOString()};
  return (stage:string,details:Record<string,unknown>)=>{
    if(!path)return;
    latest[stage]={at:new Date().toISOString(),...details};
    if(stage==='inbound')latest.recentInbound=[...(Array.isArray(latest.recentInbound)?latest.recentInbound:[]),latest[stage]].slice(-12);
    try {writeFileSync(path+'.tmp',JSON.stringify(latest,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);}catch{}
  };
}
type Item={text:string;isOwner:boolean;eventId:string;messageId:string;receivedAt:number;sleepCatchupId?:string;deliveryAnchor?:{eventId:string;messageId:string}};
const qqId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\s<>\x00-\x1f]/u.test(value);
/** Reuses only original QQ gateway handshake, heartbeat and reconnection. All
 * application input, pairing and outbound delivery are overridden below. */
export class CanonicalQQGateway extends QQPetBridge {
  readonly #options:QQGatewayOptions;
  readonly #diagnostic:ReturnType<typeof diagnostics>;
  #items:Item[]=[];
  #timer?:ReturnType<typeof setTimeout>;
  #batchStarted=0;
  #lastGroupReply=0;
  #groupPending=false;
  #groupReplies:Array<{anchor:Item;text:string;epoch:number;freshOnly?:boolean}>=[];
  #replyTimer?:ReturnType<typeof setTimeout>;
  #sendingGroup=false;
  #catchupItems:Item[]=[];
  #claimingSleep=false;
  #groupBlocked=false;
  #groupEpoch=0;
  #groupAbort=new AbortController();
  #queuedTurns=0;
  #serial:Promise<void>=Promise.resolve();
  #closed=false;
  #abort=()=>{this.stop();};
  readonly executor:(petId:string,intent:OutboxIntent,signal:AbortSignal)=>Promise<ExecutionReceipt>;
  constructor(options:QQGatewayOptions) {
    const diagnostic=diagnostics(options.diagnosticPath);
    super(options.config,{status:(status:any)=>{
      diagnostic('connection',{state:status.state,reason:status.reason,lastGroupEventType:status.groups?.lastEventType,lastGroupEventAt:status.groups?.lastEventAt});
      try{options.onStatus?.(status.state);}catch{}
    },canSpeak:()=>true});
    this.#options=options;
    this.#diagnostic=diagnostic;
    this.executor=createQQExecutor({send:(input,signal)=>this.sendMessage(input,signal)});
    if(options.signal.aborted) this.#closed=true; else options.signal.addEventListener('abort',this.#abort,{once:true});
  }
  async start():Promise<void> { if(this.#closed || this.#options.signal.aborted) throw new Error('QQ 通道不可用'); await super.start(); }
  setGroupBlocked(blocked:boolean):void {
    if(this.#groupBlocked===blocked)return;
    this.#groupBlocked=blocked;this.#groupEpoch++;
    this.#groupAbort.abort();this.#groupAbort=new AbortController();
    if(blocked){if(this.#timer)clearTimeout(this.#timer);if(this.#replyTimer)clearTimeout(this.#replyTimer);this.#replyTimer=undefined;this.#timer=undefined;this.#items=[];this.#catchupItems=[];this.#groupReplies=[];this.#batchStarted=0;}
  }
  /** Called by committed wake observations; the canonical claim survives restarts. */
  async resumeSleepInbox():Promise<void>{
    if(this.#claimingSleep||this.#closed||this.#groupBlocked||this.#options.signal.aborted)return;
    this.#claimingSleep=true;const epoch=this.#groupEpoch;
    try{
      const claim=await this.#options.canonical.claimSleepInbox(this.#options.config.petId||'main',this.#options.ingressAuthority);
      if(!claim||this.#closed||this.#groupBlocked||epoch!==this.#groupEpoch)return;
      const ids=new Set(claim.messages.map(m=>m.eventId));
      this.#items=this.#items.filter(m=>!ids.has(m.eventId));
      this.#batchStarted=this.#items[0]?.receivedAt??0;
      this.#catchupItems.push(...claim.messages.map(m=>({...m,isOwner:false,receivedAt:Date.now(),sleepCatchupId:claim.id,deliveryAnchor:claim.anchor})));
      this.scheduleGroup();
    }finally{this.#claimingSleep=false;}
  }
  /** No legacy api() send is allowed; gateway uses only GET /gateway. */
  async api(route:string, body?:unknown):Promise<any> {
    if(route!=='/gateway' || body!==undefined) throw new Error('QQ 直接发送被禁用');
    return this.request(route,undefined,this.#options.signal);
  }
  private async request(route:string,body:Record<string,unknown>|undefined,signal:AbortSignal):Promise<any> {
    if(this.#closed || signal.aborted) throw new Error('QQ 已停止');
    const access=await this.token();
    const response=await this.fetch(this.base+route,{method:body?'POST':'GET',headers:{Authorization:'QQBot '+access,'X-Union-Appid':this.#options.config.appId,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([signal,this.abort.signal,AbortSignal.timeout(15000)])});
    if(!response.ok) { if(response.status===401)this.expiresAt=0;if(response.status>=400&&response.status<500&&response.status!==408)throw new QQPlatformRejection('QQ 平台拒绝消息');throw new Error('QQ 平台请求失败'); }
    return response.json();
  }
  private async sendMessage(input:{scene:'c2c'|'group';destination:string;content:string;replyTo?:string;replySeq?:number},signal:AbortSignal):Promise<{messageId:string}> {
    if(input.scene==='group'){
      const epoch=this.#groupEpoch;
      if(this.#groupBlocked || await this.#options.canonical.groupBlocked?.(this.#options.config.petId||'main') || epoch!==this.#groupEpoch)throw Error('爸爸已禁止群聊');
      signal=AbortSignal.any([signal,this.#groupAbort.signal]);
    }
    if(input.scene==='group' && [...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(input.content)].length>15) throw new Error('群回复超过 15 字');
    const route=(input.scene==='group'?'/v2/groups/':'/v2/users/')+encodeURIComponent(input.destination)+'/messages';
    const result=await this.request(route,{content:input.content,msg_type:0,...(input.replyTo?{msg_id:input.replyTo,msg_seq:input.replySeq??1}:{})},signal);
    if(typeof result?.id!=='string'||!result.id) throw new Error('QQ 未返回消息回执');
    return {messageId:result.id};
  }
  async receive(message:any,scene:'c2c'|'group'='c2c',eventType=''):Promise<void> {
    if(this.#closed || this.#options.signal.aborted) return;
    const epoch=this.#groupEpoch;
    if(scene==='group'&&(this.#groupBlocked || await this.#options.canonical.groupBlocked?.(this.#options.config.petId||'main') || epoch!==this.#groupEpoch))return;
    this.#diagnostic('inbound',{scene,eventType});
    const actor=scene==='group'?message?.author?.member_openid:message?.author?.user_openid;
    if(typeof actor!=='string'||typeof message?.id!=='string'||typeof message?.content!=='string'||message.author?.bot===true || (scene==='group'&&this.botId===actor)) {this.#diagnostic('inbound',{scene,eventType,result:'invalid-or-self-message'});return;}
    const age=Date.now()-Date.parse(message.timestamp); if(!Number.isFinite(age)||age>240000||age < -60000){this.#diagnostic('inbound',{scene,eventType,result:'invalid-or-stale-timestamp'});return;}
    const text:string=message.content.trim();
    const platformAt=eventType==='GROUP_AT_MESSAGE_CREATE';
    let mentionsPet=false,mentionOpenids:string[]=[];
    if(scene==='group') {
      const isPet=(id:string)=>id===this.botId||id===this.#options.config.appId;
      const inline=[...text.matchAll(/<@!?([^>\s]+)>/gu)];
      const leading=[...(text.match(/^(?:<@!?[^>\s]+>\s*)+/u)?.[0]??'').matchAll(/<@!?([^>\s]+)>/gu)].map(m=>m[1]);
      const metadata=(message.mentions as unknown[]|undefined);
      const known=(Array.isArray(metadata)?metadata.slice(0,16):[]).map((value):unknown=>{
        const m=value as Record<string,unknown>|null;
        return m?.member_openid??m?.user_openid??m?.id;
      }).filter(qqId);
      // The gateway event says the bot was mentioned somewhere. When markup
      // survives, a mention inside the sentence can simply be its subject.
      mentionsPet=inline.length===0?(platformAt||known.some(isPet)):
        leading.some(isPet)||platformAt&&leading.length>0&&!inline.some(m=>isPet(m[1]));
      mentionOpenids=[...new Set((inline.length?leading:known).filter(qqId).filter(id=>!isPet(id)))].slice(0,16);
    }
    const reference=message.message_reference?.message_id;
    const input:QQIncoming={messageId:message.id,scene,actorOpenid:actor,text,occurredAt:message.timestamp,...(scene==='group'?{
      groupOpenid:message.group_openid,mentioned:platformAt,mentionsPet,mentionOpenids,...(qqId(reference)?{replyToMessageId:reference}:{}),
      nickname:platformNickname(message.author)
    }:{})};
    this.#diagnostic('inbound',{scene,eventType,characters:text.length,
      hasBindingWord:text.includes('绑定群'),commandOffset:text.indexOf('/绑定群'),
      startsWithAt:text.startsWith('@'),startsWithStructuredMention:text.startsWith('<@'),
      firstCodePoint:text.codePointAt(0),
      containsConfiguredGroupCode:scene==='group'&&!!this.#options.config.groupPairingCode&&text.includes(this.#options.config.groupPairingCode),
      whitespaceAfterCommand:text.includes('/绑定群')?text.codePointAt(text.indexOf('/绑定群')+4):undefined});
    const petId=this.#options.config.petId||'main';
    // Group mention IDs can differ from READY.user.id and AppID. A pairing
    // command is authorized by its one-time code, not by the mentioned ID.
    // Keep the original text for ordinary conversation and normalize pairing only.
    const withoutMentions=scene==='group'?text.replace(/^(?:<@!?[^>\s]+>\s*)+/u,''):text;
    const plainMentionCommand=scene==='group'?/^@[^\r\n]*?\s+(\/绑定群 \S+)\s*$/u.exec(withoutMentions)?.[1]:undefined;
    const pairingText=scene==='group'?(plainMentionCommand??(withoutMentions.startsWith('/绑定群 ')?withoutMentions:text)):text;
    const paired=await this.#options.canonical.pair(petId,{...input,text:pairingText},this.#options.ingressAuthority);
    if(/^\/绑定(?:群)?\s/u.test(pairingText))this.#diagnostic('pairing',{scene,paired:paired.paired});
    if(paired.paired && paired.eventId) { await this.respond(scene,[{text:'',isOwner:true,eventId:paired.eventId,messageId:message.id,receivedAt:Date.now()}],scene==='group'?'群绑定好啦。':'绑定好啦。'); return; }
    if(scene==='group')input.text=text.replace(/<@!?([^>\s]+)>/gu,(_tag,id,offset)=>
      offset===0&&[this.botId,this.#options.config.appId].includes(id)?'':[this.botId,this.#options.config.appId].includes(id)?'@大肥鱼':'@群友').trim();
    if(!input.text)return;
    const result=await this.#options.canonical.receive(petId,input,this.#options.ingressAuthority);
    if(!result.accepted||!result.eventId||this.#closed) return;
    const item={text:input.text,isOwner:result.isOwner,eventId:result.eventId,messageId:input.messageId,receivedAt:Date.parse(input.occurredAt)};
    if(scene==='c2c') { this.enqueueTurn(scene,[item]); return; }
    if(this.#groupBlocked||epoch!==this.#groupEpoch)return;
    if (!this.#items.length) this.#batchStarted=Date.now();
    this.#items.push(item);
    while(this.#items.length>24 || (this.#items.length>1 && this.#items.reduce((n,x)=>n+x.text.length,0)>6000)) this.#items.shift();
    // A reply still waiting for its send slot has not reached QQ. Let the next
    // turn consider the new speech instead of delivering that outdated draft.
    this.#groupReplies=this.#groupReplies.filter(reply=>!reply.freshOnly);
    if(!this.#groupReplies.length&&this.#replyTimer){clearTimeout(this.#replyTimer);this.#replyTimer=undefined;}
    this.scheduleGroup();
  }
  private scheduleGroup():void {
    if(this.#timer)clearTimeout(this.#timer);
    if(this.#closed || this.#groupBlocked || this.#groupPending || this.#sendingGroup || this.#groupReplies.length || (!this.#items.length&&!this.#catchupItems.length))return;
    // Four messages trigger immediately; otherwise wait one short pause.
    // Generation can overlap the send cooldown. Only delivery is rate limited.
    const now=Date.now(), readyAt=this.#catchupItems.length||this.#items.length>=4?now:Math.min(now+1000,this.#batchStarted+3000);
    const flushAt=Math.max(readyAt,this.#catchupItems.length?this.#lastGroupReply+10000:0,this.#queuedTurns>=4?now+1000:now);
    this.#timer=setTimeout(()=>{
      this.#timer=undefined;
      if(this.#queuedTurns>=4){this.scheduleGroup();return;}
      this.#groupPending=true;
      // Take the batch when the serial lane actually starts, not while it is
      // waiting behind a private turn. This includes messages arriving meanwhile.
      this.enqueueTurn('group',[]);
    },flushAt-now);
  }
  private enqueueTurn(scene:'c2c'|'group',items:Item[]):void {
    if(this.#queuedTurns>=4) {
      // Never silently drop an owner's message: reply with a transient notice
      // instead, so the sender knows to retry rather than assuming a send died.
      this.statusSafe('queue-full');
      if(!this.#closed&&!this.#options.signal.aborted) void this.respond(scene,items,scene==='c2c'?'我这边有点忙，稍等再发一次。':'我有点忙，稍后再聊。').catch(()=>{});
      return;
    }
    this.#queuedTurns++;
    const epoch=this.#groupEpoch;
    this.#serial=this.#serial.then(()=>this.runTurn(scene,items,epoch)).catch(()=>this.statusSafe('message-failed')).finally(()=>{
      this.#queuedTurns--;
      if(scene==='group'){this.#groupPending=false;this.scheduleGroup();}
    });
  }
  private statusSafe(state:string):void { try{this.#options.onStatus?.(state);}catch{} }
  private async runTurn(scene:'c2c'|'group',items:Item[],epoch=this.#groupEpoch):Promise<void> {
    if(scene==='group'&&(this.#groupBlocked||epoch!==this.#groupEpoch))return;
    if(scene==='group'&&!items.length){
      items=this.#catchupItems.length?this.#catchupItems.splice(0,3):this.#items.splice(0);
      this.#batchStarted=this.#items.length?Date.now():0;
    }
    items=items.filter(item=>Date.now()-item.receivedAt<=240000);
    if(!items.length||this.#closed||this.#options.signal.aborted)return;
    const started=Date.now();
    this.#diagnostic('turnStarted',{scene,messages:items.length,oldestAgeMs:started-items[0].receivedAt});
    let text:QQTurnResult,anchor=items.at(-1)!;
    // Bound a single turn so a stalled model/gateway can never wedge the whole
    // serial queue; the next owner message is then free to proceed.
    const turnAbort=new AbortController();
    const turnSignal=AbortSignal.any([this.#options.signal,turnAbort.signal,AbortSignal.timeout(90000),...(scene==='group'?[this.#groupAbort.signal]:[])]);
    try {
      text=await this.#options.onTurn({petId:this.#options.config.petId||'main',scene,messages:items.map(({text,isOwner,eventId})=>({text,isOwner,eventId})),
        ...(anchor.sleepCatchupId?{sleepCatchupId:anchor.sleepCatchupId}:{}),
        ...(scene==='group'?{selectReplyTo:(eventId:string)=>{anchor=items.find(item=>item.eventId===eventId)??anchor;}}:{})},turnSignal);
    } catch(error) {
      this.statusSafe('message-failed');
      if(this.#closed||this.#options.signal.aborted || scene==='group'&&(this.#groupBlocked||epoch!==this.#groupEpoch))return;
      const walletEmpty=error instanceof Error && error.message==='模拟饭钱已用完，请先添加饭钱';
      text=scene==='c2c'&&walletEmpty?'我的饭钱用完啦，请先加一点。':'我暂时没接上，请稍后再试。';
    }
    if(this.#closed||this.#options.signal.aborted||scene==='group'&&(this.#groupBlocked||epoch!==this.#groupEpoch))return;
    const superseded=scene==='group'&&!anchor.sleepCatchupId&&typeof text==='string'&&this.#items.length>0;
    this.#diagnostic('turnFinished',{scene,durationMs:Date.now()-started,pendingMessages:this.#items.length,superseded});
    if(superseded)return;
    if(typeof text==='string'){if(text.trim())await this.respond(scene,[anchor],text,scene==='group'&&!anchor.sleepCatchupId);}
    else if(text&&scene==='group'){
      for(const reply of text.replies){const target=items.find(item=>item.eventId===reply.anchorEventId);if(target&&reply.text.trim())this.#groupReplies.push({anchor:target,text:reply.text,epoch});}
      await this.flushGroupReplies();
    }
  }
  private async respond(scene:'c2c'|'group',items:Item[],text:string,freshOnly=false):Promise<void> {
    if(scene==='group'){
      const anchor=items.at(-1);if(!anchor||this.#closed||this.#groupBlocked)return;
      this.#groupReplies.push({anchor,text,epoch:this.#groupEpoch,freshOnly});await this.flushGroupReplies();return;
    }
    await this.sendResponse(scene,items,text);
  }
  /** Only the timer waits for group cooldown; private turns keep their serial lane. */
  private async flushGroupReplies():Promise<void>{
    if(this.#sendingGroup||this.#closed||this.#groupBlocked)return;
    if(this.#replyTimer)clearTimeout(this.#replyTimer);this.#replyTimer=undefined;
    const delay=this.#lastGroupReply+10000-Date.now();
    if(this.#groupReplies.length&&delay>0){this.#replyTimer=setTimeout(()=>{this.#replyTimer=undefined;void this.flushGroupReplies().catch(()=>this.statusSafe('message-failed'));},delay);return;}
    const reply=this.#groupReplies.shift();if(!reply){this.scheduleGroup();return;}
    this.#sendingGroup=true;
    try{if(reply.epoch===this.#groupEpoch&&Date.now()-reply.anchor.receivedAt<=240000)await this.sendResponse('group',[reply.anchor],reply.text);}
    finally{this.#sendingGroup=false;if(this.#groupReplies.length)this.#replyTimer=setTimeout(()=>{this.#replyTimer=undefined;void this.flushGroupReplies().catch(()=>this.statusSafe('message-failed'));},Math.max(0,this.#lastGroupReply+10000-Date.now()));else this.scheduleGroup();}
  }
  private async sendResponse(scene:'c2c'|'group',items:Item[],text:string):Promise<void> {
    const epoch=this.#groupEpoch;if(scene==='group'&&this.#groupBlocked)return;
    const last=items.at(-1); if(!last||this.#closed||this.#options.signal.aborted)return;
    const target=last.deliveryAnchor??last;
    const started=Date.now();this.#diagnostic('sendStarted',{scene,anchorAgeMs:started-last.receivedAt});
    const action=await this.#options.canonical.enqueue(this.#options.config.petId||'main',(last.sleepCatchupId?last.sleepCatchupId+':':'reply:')+target.messageId,scene,text,target.eventId,target.messageId,this.#options.ingressAuthority);
    if(!this.#closed&&!this.#options.signal.aborted && (scene!=='group'||!this.#groupBlocked&&epoch===this.#groupEpoch)) { try{await this.#options.dispatch(action);}finally{if(scene==='group')this.#lastGroupReply=Date.now();this.#diagnostic('sendFinished',{scene,durationMs:Date.now()-started});} }
  }
  stop():void {
    if(this.#closed)return; this.#closed=true;
    this.#groupAbort.abort();
    if(this.#timer)clearTimeout(this.#timer);if(this.#replyTimer)clearTimeout(this.#replyTimer);this.#items=[];this.#catchupItems=[];this.#groupReplies=[];
    this.#options.signal.removeEventListener('abort',this.#abort);
    super.stop();
  }
}
