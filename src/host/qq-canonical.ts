import { createHash,randomUUID } from 'node:crypto';
import {groupChatBlocked,groupMessageAllowed,assertGroupReplyAllowed} from './qq-group-access.js';
import {boundGroupId,groupProactiveState,assertGroupOpportunity,GROUP_OPENER_PRICE} from './qq-group-proactive-policy.js';
import { redactDadNames } from '../../vendor/pet-plugins/behavior/memory-privacy.mjs';
import { rebuildRelationships, validateProposal } from '../kernel/index.js';
import type { ActionProposal, LifeState } from '../kernel/types.js';
import type { BodyProjection, CanonicalEnvelope } from '../storage/postgres.js';
import type { PetGate, UnitOfWork, OutboxIntent, ExecutionReceipt } from '../storage/uow.js';

interface Reader { loadEnvelope(petId:string): Promise<CanonicalEnvelope|null> }
type Obj = Record<string,any>;
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
const key = (s:unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\x00-\x1f]/.test(s);
const relayKey = (eventId:string) => hash('proactive-relay:'+eventId);
const RELAY_LIFETIME=120000, CONTACT_INTERVAL=2*60*60*1000;
const MAX_REPLIES=3, SENTENCE_PRICE=0.2;
const sentenceSegmenter=new Intl.Segmenter('zh',{granularity:'sentence'});
const sentences=(text:string)=>text.split(/\r?\n/u).flatMap(line=>[...sentenceSegmenter.segment(line)].map(s=>s.segment.trim())).filter(Boolean);
function relayText(draft:CanonicalEnvelope,answerId:string):string|null {
  const answer=draft.life.events.find(e=>e.eventId===answerId);
  const request=draft.life.events.find(e=>e.eventId===answer?.causationId);
  const selfExpression=request?.type==='action.receipt' && draft.life.actions.some(a=>a.id===(request.payload as Obj)?.actionId && a.actionType==='self.express' && a.status==='COMPLETED');
  if(!answer||!request||answer.type!=='conversation.assistant'||answer.source!=='desktop'||(!selfExpression && (request.type!=='interaction.requested'||!['whisper','physical','care','worksite','completion'].includes(String((request.payload as Obj)?.kind))))||Object.hasOwn(draft.life.invalidSources,answerId)||Object.hasOwn(draft.life.invalidSources,request.eventId))return null;
  const text=redactDadNames(String((answer.payload as Obj)?.text||'').trim());
  let content='';for(const char of text){if(content.length+char.length>1800)break;content+=char;}
  return sentences(content).slice(0,MAX_REPLIES).join('')||null;
}
function nextReplySeq(draft:CanonicalEnvelope,replyTo:string,scene:string):number {
  return Math.max(0,...draft.life.actions.filter(a=>a.actionType==='qq.send' && (a.parameters as Obj).replyTo===replyTo && (a.parameters as Obj).scene===scene).map(a=>Number((a.parameters as Obj).replySeq)||1))+1;
}
export interface QQIdentity { appId:string; ownerOpenid?:string; groupOpenid?:string; groupOwnerOpenid?:string; groupEnabled:boolean; groupMode:'owner'|'mentions'|'all' }
export interface QQIncoming { messageId:string; scene:'c2c'|'group'; actorOpenid:string; groupOpenid?:string; text:string; occurredAt:string; mentioned?:boolean; nickname?:string; mentionsPet?:boolean; mentionOpenids?:string[]; replyToMessageId?:string }
const groupActorId=(identity:QQIdentity,openid:string)=>openid===identity.groupOwnerOpenid?'dad':'qq-member:'+hash(identity.appId+':'+openid).slice(0,24);

/** Canonical storage for one already authenticated QQ account. It never opens
 * a socket, reads old files, stores appSecret, or invokes the old QQ bridge. */
export class CanonicalQQ {
  readonly #ingress: object;
  readonly #relayStarted=new Map<string,number>();
  constructor(private readonly reader:Reader, private readonly uow:UnitOfWork, private readonly gate:PetGate,
    private readonly body:BodyProjection, ingressAuthority:object) {
    if (!ingressAuthority || typeof ingressAuthority !== 'object') throw new Error('QQ 通道凭据无效'); this.#ingress=ingressAuthority;
  }
  private async change<T>(petId:string, edit:(draft:CanonicalEnvelope)=>{value:T; intents?:OutboxIntent[]}):Promise<T> {
    return this.gate.run(petId,async()=>{
      const envelope=await this.reader.loadEnvelope(petId); if(!envelope || envelope.petId!==petId) throw new Error('生命状态不存在');
      if(this.gate.signal.aborted) throw new Error('写入租约已失去');
      let value!:T;
      await this.uow.apply(petId,envelope.version,draft=>{const result=edit(draft);value=structuredClone(result.value);return {intents:result.intents};});
      return value;
    });
  }
  async groupBlocked(petId:string):Promise<boolean> {
    const state=await this.reader.loadEnvelope(petId);
    return !state || groupChatBlocked(state);
  }
  /** Host imports already-read, validated old receipt arrays after proving the
   * old bridge stopped. Ambiguous historical outbound states remain UNKNOWN. */
  async importState(petId:string, identity:QQIdentity, receipts:Array<[string,number]>, outbound:Array<[string,{at:number;state:string}]>):Promise<void> {
    if(!identity || !key(identity.appId) || (identity.ownerOpenid !== undefined && !key(identity.ownerOpenid)) || typeof identity.groupEnabled!=='boolean' || !['owner','mentions','all'].includes(identity.groupMode) || (identity.groupOpenid !== undefined && !key(identity.groupOpenid)) || (identity.groupOwnerOpenid !== undefined && !key(identity.groupOwnerOpenid)) || !Array.isArray(receipts) || !Array.isArray(outbound)) throw new Error('QQ 导入数据无效');
    await this.change(petId,draft=>{
      const legacy=draft.legacy as Obj;
      const existing=legacy.qq?.identity as QQIdentity | undefined;
      if(existing && (existing.appId!==identity.appId || (identity.ownerOpenid && existing.ownerOpenid && identity.ownerOpenid!==existing.ownerOpenid) || (identity.groupOpenid && existing.groupOpenid && identity.groupOpenid!==existing.groupOpenid))) throw new Error('QQ 已绑定其他身份');
      const first=!legacy.qq;
      const qq=legacy.qq ||= {identity:structuredClone(identity),seen:{},outbound:{}};
      if(first) {
        if(!draft.life.constraints.capabilities.some(c=>c.name==='qq.send'))draft.life.constraints.capabilities.push({name:'qq.send',enabled:true,requiresPermission:'qq.send'});
        if(!draft.life.constraints.permissions.includes('qq.send'))draft.life.constraints.permissions.push('qq.send');
      }
      for(const row of receipts) { if(!Array.isArray(row)||!key(row[0])||!Number.isFinite(row[1])) throw new Error('QQ 接收回执损坏'); qq.seen[hash(row[0])] ??= {at:row[1],origin:'legacy'}; }
      for(const row of outbound) {
        if(!Array.isArray(row)||!key(row[0])||!row[1]||!Number.isFinite(row[1].at)||typeof row[1].state!=='string') throw new Error('QQ 发送回执损坏');
        const id=hash(row[0]); const state=row[1].state==='sent'?'sent':'unknown';
        if(!qq.outbound[id]) qq.outbound[id]={at:row[1].at,state,origin:'legacy'};
      }
      return {value:undefined};
    });
  }
  /** Host-only setup: write expiring code hashes, never credentials or plaintext codes. */
  async configurePairing(petId:string, codes:{owner?:{code:string;expiresAt:number};group?:{code:string;expiresAt:number}}):Promise<void> {
    await this.change(petId,draft=>{
      const qq=(draft.legacy as Obj).qq; if(!qq?.identity) throw new Error('QQ 尚未导入配置');
      qq.pairing ||= {};
      for(const kind of ['owner','group'] as const) { const value=codes[kind]; if(!value) continue;
        if(!key(value.code)||!Number.isFinite(value.expiresAt)) throw new Error('QQ 配对码无效');
        if(kind==='owner' ? qq.identity.ownerOpenid : qq.identity.groupOpenid) continue;
        const previous=qq.pairing[kind], digest=hash(value.code), now=Date.now();
        if(!previous || (previous.expiresAt<=now && value.expiresAt>now && previous.digest!==digest))
          qq.pairing[kind]={digest,expiresAt:value.expiresAt};
      }
      return {value:undefined};
    });
  }
  async pair(petId:string, message:QQIncoming, authority:object):Promise<{paired:boolean;eventId?:string}> {
    if(authority!==this.#ingress || !message || !key(message.messageId) || !key(message.actorOpenid) || !['c2c','group'].includes(message.scene) || typeof message.text!=='string' || !Number.isFinite(Date.parse(message.occurredAt))) throw new Error('QQ 配对消息无效');
    const kind=message.scene==='group'?'group':'owner';
    const prefix=kind==='group'?'/绑定群 ':'/绑定 ';
    if(!message.text.startsWith(prefix)) return {paired:false};
    return this.change<{paired:boolean;eventId?:string}>(petId,draft=>{
      const qq=(draft.legacy as Obj).qq; if(!qq?.identity || !qq.seen) throw new Error('QQ 尚未导入配置');
      if(message.scene==='group'&&groupChatBlocked(draft))return {value:{paired:false}};
      const pairing=qq.pairing?.[kind]; const code=message.text.slice(prefix.length).trim();
      if(!pairing || pairing.expiresAt<Date.now() || pairing.digest!==hash(code)) return {value:{paired:false}};
      if(kind==='owner') { if(qq.identity.ownerOpenid) return {value:{paired:false}}; qq.identity.ownerOpenid=message.actorOpenid; }
      else { if(!qq.identity.ownerOpenid || !key(message.groupOpenid) || qq.identity.groupOpenid) return {value:{paired:false}}; qq.identity.groupOpenid=message.groupOpenid; qq.identity.groupOwnerOpenid=message.actorOpenid; }
      delete qq.pairing[kind]; const oldKey=kind==='group'?'group:'+message.messageId:message.messageId; const receiptKey=hash(oldKey);
      if(qq.seen[receiptKey]) throw new Error('配对消息已处理');
      const eventId='qq-in:'+receiptKey; qq.seen[receiptKey]={at:Date.now(),eventId};
      draft.life.events.push({eventId,petId,type:'social.paired',source:'qq',actorId:'dad',occurredAt:message.occurredAt,receivedAt:new Date().toISOString(),evidenceLevel:'observed',payload:{scene:message.scene,messageId:message.messageId}});
      return {value:{paired:true,eventId}};
    });
  }
  /** Event source capability belongs to the authenticated QQ gateway only. */
  async receive(petId:string, message:QQIncoming, authority:object):Promise<{accepted:boolean;isOwner:boolean;eventId?:string}> {
    if(authority!==this.#ingress || !message || !key(message.messageId) || !key(message.actorOpenid) || !['c2c','group'].includes(message.scene) || typeof message.text!=='string' || !message.text.trim() || message.text.length>2000 || !Number.isFinite(Date.parse(message.occurredAt))) throw new Error('QQ 消息或来源无效');
    return this.change<{accepted:boolean;isOwner:boolean;eventId?:string}>(petId,draft=>{
      const qq=(draft.legacy as Obj).qq; if(!qq?.identity || !qq.seen || !qq.outbound) throw new Error('QQ 尚未接管');
      const identity=qq.identity as QQIdentity;
      if(message.scene==='group'&&!groupMessageAllowed(draft,message.occurredAt))return {value:{accepted:false,isOwner:false}};
      const isOwner=message.scene==='c2c' ? message.actorOpenid===identity.ownerOpenid : message.actorOpenid===identity.groupOwnerOpenid;
      if(message.scene==='c2c' && !isOwner) return {value:{accepted:false,isOwner:false}};
      if(message.scene==='group' && (!identity.groupEnabled || !identity.groupOpenid || message.groupOpenid!==identity.groupOpenid || (identity.groupMode==='owner'&&!isOwner) || (identity.groupMode==='mentions' && !message.mentioned))) return {value:{accepted:false,isOwner}};
      const oldKey=message.scene==='group'?'group:'+message.messageId:message.messageId;
      const receiptKey=hash(oldKey); if(qq.seen[receiptKey]) return {value:{accepted:false,isOwner}};
      const eventId='qq-in:'+receiptKey;
      if(Object.hasOwn(draft.life.invalidSources,eventId)) throw new Error('已删除事件不可重新导入');
      const now=new Date().toISOString(); qq.seen[receiptKey]={at:Date.now(),eventId};
      const mentionedActors=Array.isArray(message.mentionOpenids)?[...new Set(message.mentionOpenids.slice(0,16).filter(key).map(id=>groupActorId(identity,id)))]:[];
      const addressing=message.scene==='group'?{
        ...((message.mentionsPet??message.mentioned)===true?{mentionsPet:true}:{}),
        ...(mentionedActors.length?{mentionedActors}:{}),
        ...(key(message.replyToMessageId)&&message.replyToMessageId!==message.messageId?{replyToMessageId:message.replyToMessageId}:{})
      }:undefined;
      draft.life.events.push({eventId,petId,type:'social.message',source:'qq',actorId:message.scene==='group'?groupActorId(identity,message.actorOpenid):'dad',occurredAt:message.occurredAt,receivedAt:now,evidenceLevel:'observed',payload:{scene:message.scene,...(message.scene==='group'?{groupId:hash(identity.appId+':'+message.groupOpenid)}:{}),messageId:message.messageId,text:redactDadNames(message.text),isOwner,...(addressing&&Object.keys(addressing).length?{addressing}:{}),...(message.scene==='group' && typeof message.nickname==='string' && message.nickname.trim() && message.nickname.trim().length<=40 && !/[\x00-\x1f<>]/u.test(message.nickname) ? {nickname:message.nickname.trim()} : {})}});
      rebuildRelationships(draft.life);
      return {value:{accepted:true,isOwner,eventId}};
    });
  }
  /** Queues a send, never sends it. Destination comes solely from the paired identity. */
  async enqueue(petId:string, requestId:string, scene:'c2c'|'group', text:string, sourceEventId:string, replyTo:string, authority:object):Promise<string> {
    if(authority!==this.#ingress || !key(replyTo) || !key(requestId)||!['c2c','group'].includes(scene)||typeof text!=='string'||!text.trim()||text.length>1800||!key(sourceEventId)) throw new Error('QQ 发送意图无效');
    if(scene==='group' && [...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(text.trim())].length>15) throw new Error('群回复超过 15 字');
    return this.change(petId,draft=>{
      const qq=(draft.legacy as Obj).qq; if(!qq?.identity || !qq.outbound) throw new Error('QQ 尚未接管');
      const id=hash(requestId), previous=qq.outbound[id];
      const fingerprint=hash(JSON.stringify({scene,text:redactDadNames(text.trim()),sourceEventId,replyTo}));
      if(previous) { if(previous.actionId && previous.fingerprint===fingerprint) return {value:String(previous.actionId)}; throw new Error('QQ 发送标识已有历史回执或内容冲突，不能重发'); }
      const identity=qq.identity as QQIdentity; const destination=scene==='c2c'?identity.ownerOpenid:identity.groupOpenid;
      if(!key(destination) || (scene==='group'&&!identity.groupEnabled)) throw new Error('QQ 目标尚未绑定');
      const source=draft.life.events.find(event=>event.eventId===sourceEventId);
      if(replyTo && (!source || (source.payload as Obj)?.messageId!==replyTo)) throw new Error('QQ 回复来源不匹配');
      const actionId='qq-send:'+id;
      const content=redactDadNames(text.trim());
      const replySeq=nextReplySeq(draft,replyTo,scene);if(replySeq>MAX_REPLIES)throw Error('QQ 连续回复最多三条');
      const proposal:ActionProposal={id:actionId,petId,actionType:'qq.send',parameters:{scene,destination,content,replyTo,replySeq},priority:50,interruptPolicy:'noninterruptible',requiredCapabilities:['qq.send'],expectedStateVersion:draft.version,sourceIds:[sourceEventId]};
      const state:LifeState={...structuredClone(draft.life),petId,version:draft.version,...this.body(draft)};
      qq.outbound[id]={at:Date.now(),state:'pending',actionId,fingerprint};
      validateQQReply(draft,state,proposal);
      const at=new Date().toISOString();
      draft.life.actions.push({...proposal,status:'PENDING',createdAt:at,updatedAt:at});
      return {value:actionId,intents:[{id:actionId,type:'qq.send',payload:{actionId,petId,actionType:'qq.send',parameters:proposal.parameters}}]};
    });
  }
  async claimGroupOpportunity(petId:string,authority:object):Promise<CanonicalEnvelope|null> {
    if(authority!==this.#ingress)throw Error('QQ 通道凭据无效');
    const current=await this.reader.loadEnvelope(petId);if(!current)return null;
    const groupId=boundGroupId(current);if(!groupId)return null;
    const saved=(current.legacy as Obj).qq?.groupProactive;
    if(saved?.groupId===groupId&&(!groupProactiveState(current).ready||!Number.isFinite((current.legacy as Obj).wallet?.balance)||(current.legacy as Obj).wallet.balance<GROUP_OPENER_PRICE))return null;
    return this.change(petId,draft=>{
      const qq=(draft.legacy as Obj).qq,now=Date.now(),groupId=boundGroupId(draft);
      if(!groupId)return {value:null};
      if(qq.groupProactive?.groupId!==groupId){qq.groupProactive={groupId,enabledAt:now};return {value:null};}
      if(!groupProactiveState(draft,now).ready||!Number.isFinite((draft.legacy as Obj).wallet?.balance)||(draft.legacy as Obj).wallet.balance<GROUP_OPENER_PRICE)return {value:null};
      const id='group-opportunity:'+randomUUID(),at=new Date(now).toISOString();
      qq.groupProactive.lastAttemptAt=now;qq.groupProactive.lastAttemptId=id;
      const contextSourceIds=draft.life.events.filter(e=>!Object.hasOwn(draft.life.invalidSources,e.eventId)&&(e.payload as Obj)?.groupId===groupId&&(e.type==='social.message'&&e.source==='qq'||e.type==='conversation.assistant'&&e.source==='qq-group')).slice(-8).map(e=>e.eventId);
      draft.life.events.push({eventId:id,petId,type:'social.group-opportunity',source:'qq-group',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{groupId,price:GROUP_OPENER_PRICE,contextSourceIds}});
      return {value:structuredClone(draft)};
    });
  }
  async enqueueGroupOpener(petId:string,sourceId:string,text:string,authority:object):Promise<string|null> {
    if(authority!==this.#ingress)throw Error('QQ 通道凭据无效');
    const content=redactDadNames(text.trim());
    if(!content||content==='<qq-silent/>')return null;
    if([...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(content)].length>15||/[<>]/u.test(content))throw Error('群聊主动表达必须是15字内的完整正文');
    return this.change(petId,draft=>{
      const legacy=draft.legacy as Obj,qq=legacy.qq,id=hash('group-proactive:'+sourceId),old=qq?.outbound?.[id];
      if(old){if(draft.life.actions.find(a=>a.id===old.actionId)?.parameters.content!==content)throw Error('群聊主动表达内容冲突');return {value:old.actionId as string};}
      assertGroupOpportunity(draft,sourceId);
      if(!Number.isFinite(legacy.wallet?.balance)||legacy.wallet.balance<GROUP_OPENER_PRICE)return {value:null};
      const actionId='qq-send:'+id,answerId='group-opener:'+sourceId,at=new Date().toISOString(),scene='group';
      const fingerprint=hash(JSON.stringify({scene,text:content,sourceEventId:sourceId}));
      qq.outbound[id]={at:Date.now(),state:'pending',actionId,fingerprint,groupProactive:true,amount:GROUP_OPENER_PRICE,chargeState:'reserved'};
      const contextSourceIds=(draft.life.events.find(e=>e.eventId===sourceId)?.payload as Obj).contextSourceIds??[];
      draft.life.events.push({eventId:answerId,petId,type:'conversation.assistant',source:'qq-group',occurredAt:at,receivedAt:at,causationId:sourceId,evidenceLevel:'inferred',payload:{groupId:boundGroupId(draft),text:content,sourceIds:[sourceId,...contextSourceIds],proactive:true}});
      const proposal:ActionProposal={id:actionId,petId,actionType:'qq.send',parameters:{scene,destination:qq.identity.groupOpenid,content,groupProactive:true},priority:50,interruptPolicy:'noninterruptible',requiredCapabilities:['qq.send'],expectedStateVersion:draft.version,sourceIds:[sourceId,answerId]};
      const state:LifeState={...structuredClone(draft.life),petId,version:draft.version,...this.body(draft)};validateQQReply(draft,state,proposal);
      legacy.wallet.balance=Math.round((legacy.wallet.balance-GROUP_OPENER_PRICE)*100)/100;
      if(legacy.wallet.balance===0){legacy.wallet.emptySince=Date.now();delete legacy.wallet.emptyAskedAt;}
      const financeId='finance:'+actionId;
      (legacy.events||=[]).push({id:financeId,kind:'wallet-spend',text:'主动群聊消耗 0.4 饭钱',ts:Date.now()});
      draft.life.events.push({eventId:financeId,petId,type:'wallet.spend',source:'canonical',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{kind:'group-proactive',amount:GROUP_OPENER_PRICE,balance:legacy.wallet.balance,actionId}});
      draft.life.actions.push({...proposal,status:'PENDING',createdAt:at,updatedAt:at});
      return {value:actionId,intents:[{id:actionId,type:'qq.send',payload:{actionId,petId,actionType:'qq.send',parameters:proposal.parameters}}]};
    });
  }
  /** Only expressions committed after the QQ bridge starts are eligible. */
  async enableRelay(petId:string):Promise<void> {
    if(!this.#relayStarted.has(petId))this.#relayStarted.set(petId,Date.now());
  }
  /** Forward one recent proactive expression directly, without a QQ reply anchor. */
  async enqueueNextRelay(petId:string,authority:object):Promise<string|null> {
    if(authority!==this.#ingress)throw Error('QQ 通道凭据无效');
    return this.change(petId,draft=>{
      const qq=(draft.legacy as Obj).qq, started=this.#relayStarted.get(petId), now=Date.now();
      if(!Number.isFinite(started)||!key(qq?.identity?.ownerOpenid)||!qq.outbound)return {value:null};
      const attempts=(Object.values(qq.outbound) as Obj[]).filter(e=>e.proactive===true && Number.isFinite(e.at));
      if(attempts.some(e=>now-e.at<CONTACT_INTERVAL))return {value:null};

      for(const event of draft.life.events){
        const at=Date.parse(event.receivedAt);
        if(!Number.isFinite(at)||at<started!||at>now||now-at>RELAY_LIFETIME)continue;
        const content=relayText(draft,event.eventId);if(!content)continue;
        const id=relayKey(event.eventId);if(qq.outbound[id])continue;
        const wallet=(draft.legacy as Obj).wallet, amount=Math.round(sentences(content).length*SENTENCE_PRICE*100)/100;
        if(!Number.isFinite(wallet?.balance)||wallet.balance<amount)continue;
        const scene='c2c', actionId='qq-send:'+id, sourceEventId=event.eventId;
        const fingerprint=hash(JSON.stringify({scene,text:content,sourceEventId}));
        const proposal:ActionProposal={id:actionId,petId,actionType:'qq.send',parameters:{scene,destination:qq.identity.ownerOpenid,content,proactive:true},priority:50,interruptPolicy:'noninterruptible',requiredCapabilities:['qq.send'],expectedStateVersion:draft.version,sourceIds:[sourceEventId]};
        qq.outbound[id]={at:now,state:'pending',actionId,fingerprint,proactive:true,amount};
        const state:LifeState={...structuredClone(draft.life),petId,version:draft.version,...this.body(draft)};validateQQReply(draft,state,proposal);
        // Reserve the price with the durable send intent. Unknown delivery must
        // never be retried or charged a second time. Explicit contact fees also
        // apply when ordinary daily consumption is frozen.
        wallet.balance=Math.round((wallet.balance-amount)*100)/100;
        if(wallet.balance===0){wallet.emptySince=now;delete wallet.emptyAskedAt;}
        const financeId='finance:'+actionId,stampFinance=new Date(now).toISOString();
        ((draft.legacy as Obj).events ||= []).push({id:financeId,kind:'wallet-spend',text:`主动联系消耗 ${amount} token，余额 ${wallet.balance} token`,ts:now});
        draft.life.events.push({eventId:financeId,petId,type:'wallet.spend',source:'canonical',occurredAt:stampFinance,receivedAt:stampFinance,evidenceLevel:'observed',payload:{kind:'proactive',amount,balance:wallet.balance}});
        const stamp=new Date(now).toISOString();draft.life.actions.push({...proposal,status:'PENDING',createdAt:stamp,updatedAt:stamp});
        return {value:actionId,intents:[{id:actionId,type:'qq.send',payload:{actionId,petId,actionType:'qq.send',parameters:proposal.parameters}}]};
      }
      return {value:null};
    });
  }
}

/** Host supplies an authenticated transport using retained local credentials;
 * unknown delivery is never retried by this adapter. */
export interface QQTransport { send(input:{scene:'c2c'|'group';destination:string;content:string;replyTo?:string;replySeq?:number},signal:AbortSignal):Promise<{messageId:string}> }
export class QQPlatformRejection extends Error {}
export function createQQExecutor(transport:QQTransport) {
  return async (petId:string,intent:OutboxIntent,signal:AbortSignal):Promise<ExecutionReceipt>=>{
    const p=intent.payload.parameters as Obj;
    if(signal.aborted || intent.type!=='qq.send'||intent.payload.petId!==petId||intent.payload.actionId!==intent.id || !p || !['c2c','group'].includes(p.scene)||!key(p.destination)||typeof p.content!=='string'||!p.content.trim()||p.content.length>1800) return {status:'unknown',evidence:{reason:'QQ 发送意图无效'}};
    try {
      const result=await transport.send({scene:p.scene,destination:p.destination,content:p.content,...(typeof p.replyTo==='string'?{replyTo:p.replyTo}:{}),...(Number.isInteger(p.replySeq)?{replySeq:p.replySeq}:{})},signal);
      if(!result || !key(result.messageId)) return {status:'unknown',evidence:{reason:'QQ 未返回消息回执'}};
      return {status:'completed',evidence:{actionId:intent.id,kind:'qq.send',messageId:result.messageId}};
    } catch(error) { return p.groupProactive===true&&error instanceof QQPlatformRejection?{status:'failed',evidence:{reason:'QQ 平台拒绝主动群消息'}}:{status:'unknown',evidence:{reason:'QQ 发送结果不明，必须先对账'}}; }
  };
}










/** Only a host-authenticated reply recorded in the canonical QQ outbox may
 * continue while autonomous behavior is paused. All other validation remains. */
export function validateQQReply(draft:CanonicalEnvelope,state:LifeState,proposal:ActionProposal):void {
  const p=proposal.parameters as Obj, qq=(draft.legacy as Obj).qq;
  if(p.scene==='group')assertGroupReplyAllowed(draft,proposal.sourceIds[0]);
  const source=draft.life.events.find(e=>e.eventId===proposal.sourceIds[0]);
  const entry=Object.values(qq?.outbound||{}).find((x:any)=>x.actionId===proposal.id) as Obj|undefined;
  const fingerprint=hash(JSON.stringify({scene:p.scene,text:p.content,sourceEventId:proposal.sourceIds[0],replyTo:p.replyTo}));
  if(p.groupProactive===true){
    const answer=draft.life.events.find(e=>e.eventId===proposal.sourceIds[1]);
    if(proposal.actionType!=='qq.send'||proposal.sourceIds.length!==2||!entry?.groupProactive||entry!==qq.outbound[hash('group-proactive:'+proposal.sourceIds[0])]||entry.fingerprint!==fingerprint||entry.amount!==GROUP_OPENER_PRICE||p.scene!=='group'||p.destination!==qq.identity.groupOpenid||p.replyTo!==undefined||p.replySeq!==undefined||answer?.type!=='conversation.assistant'||answer.source!=='qq-group'||answer.causationId!==source?.eventId||(answer.payload as Obj)?.text!==p.content)throw Error('QQ 群聊主动表达来源无效');
    assertGroupOpportunity(draft,proposal.sourceIds[0],Date.now(),proposal.id);
    validateProposal(state,proposal);return;
  }
  if(p.proactive===true) {
    const at=Date.parse(source?.receivedAt||'');
    const valid=proposal.sourceIds.length===1 && entry?.proactive===true && entry===qq?.outbound?.[relayKey(proposal.sourceIds[0])] && p.scene==='c2c' && p.destination===qq?.identity?.ownerOpenid && p.replyTo===undefined && p.replySeq===undefined && relayText(draft,proposal.sourceIds[0])===p.content && Number.isFinite(at) && Date.now()>=at && Date.now()-at<=RELAY_LIFETIME;
    if(proposal.actionType!=='qq.send'||!entry||entry.fingerprint!==fingerprint||!valid)throw Error('QQ 主动表达来源无效');
    validateProposal(state,proposal);
    return;
  }
  const anchor=source;
  if(proposal.actionType!=='qq.send' || !entry || entry.fingerprint!==fingerprint || !anchor || anchor.source!=='qq' || anchor.evidenceLevel!=='observed' || !['social.message','social.paired'].includes(anchor.type) || (anchor.payload as Obj)?.messageId!==p.replyTo || (anchor.payload as Obj)?.scene!==p.scene || proposal.sourceIds.length!==1 || (p.replySeq!==undefined&&(!Number.isInteger(p.replySeq)||p.replySeq<1||p.replySeq>MAX_REPLIES))) throw Error('QQ 会话回复来源无效');
  const interactive={...state,constraints:{...state.constraints,paused:false}};
  validateProposal(interactive,proposal);
}
