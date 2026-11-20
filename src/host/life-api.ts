import {setGoalPlanStatus} from '../kernel/goal-lifecycle.js';
import { randomUUID } from 'node:crypto';
import { advanceSpirit } from '../kernel/spirit.js';
import type { LifeEvent, LifeState } from '../kernel/types.js';
import { invalidateDependents } from '../kernel/index.js';
import { momentEventType, readMoments } from '../kernel/moments.js';
import type { CanonicalEnvelope, BodyProjection } from '../storage/postgres.js';
import type { PetGate, UnitOfWork } from '../storage/uow.js';
import { isOwnerPrivateConversation } from './chat-identity.js';
import {cleanGroupName,groupPeopleDirectory} from './group-people.js';

type PageState = LifeState & {diaryDates?:Record<string,string>};

export interface LifeApiHost {
  authorize(request: Request): Promise<boolean> | boolean;
  petId(): Promise<string> | string;
  getState(petId: string, view?:'archive'): Promise<PageState>;
  getLifeSettings?(petId:string):Promise<{version:number;paused:boolean;permissions:string[];groupChatBlocked:boolean}>;
  groupChatBlocked?(petId:string):Promise<boolean>;
  /** Uses the same per-pet gate and UOW as the dispatcher. */
  manage?(petId: string, command: ManagementCommand): Promise<void>;
  searchMemories?(petId:string, query:string): Promise<unknown[]>;
  memoryGraph?(petId:string, query:string): Promise<unknown>;
  links?: {chat?:string;play?:string};
  shutdown?:()=>void;
  openWorksite?:(petId:string)=>Promise<void>;
  farm?:{requestOpen(petId:string):Promise<void>;weather(petId:string,weather:unknown):Promise<unknown>};
  finance?: {read:(petId:string)=>Promise<unknown>; write:(petId:string,input:Record<string,unknown>)=>Promise<unknown>};
  companion?: {read:(petId:string,signal:AbortSignal)=>Promise<unknown>; write:(petId:string,input:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>};
  model?: {read:(petId:string,signal:AbortSignal)=>Promise<unknown>; write:(petId:string,input:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>};
  attachments?:{put:(petId:string,requestId:string,input:{mediaType:string;data:Uint8Array})=>Promise<unknown>};
}
export type ManagementCommand =
  | {kind:'spirit'; value:number; requestId:string; reason:string; version:number}
  | {kind:'pause'; paused:boolean; reason:string; version:number}
  | {kind:'group-chat'; blocked:boolean; reason:string; version:number}
  | {kind:'group-remark'; actorId:string; remark:string; expectedRemark:string; reason:string; version:number}
  | {kind:'goal'; id:string; status:'active'|'paused'|'abandoned'; expectedStatus:string; reason:string; version:number}
  | {kind:'revoke'; permission:string; reason:string; version:number}
  | {kind:'memory'; id:string; action:'delete'|'correct'; expectedContent:string; content?:string; reason:string; version:number};
interface Reader {loadEnvelope(petId:string):Promise<CanonicalEnvelope|null>}
const validText=(v:unknown,max=500):v is string=>typeof v==='string' && v.trim().length>0 && v.length<=max;
/** Management edits are committed in the shared canonical envelope. No action
 * is dispatched here; the executor revalidates the latest state under the gate. */
export function createLifeManagement(reader: Reader, gate: PetGate, uow: UnitOfWork, projectBody: BodyProjection, interrupt?:(petId:string)=>void, groupChanged?:(blocked:boolean)=>void) {
  return async (petId:string, command:ManagementCommand) => {
    if((command.kind==='pause' && command.paused) || command.kind==='revoke') {
      const current=await reader.loadEnvelope(petId);
      if(!current || gate.signal.aborted)throw new Error('状态已变化，请刷新后重试');
      interrupt?.(petId);
    }
    return gate.run(petId,async()=>{
    const current=await reader.loadEnvelope(petId);
    if (!current || gate.signal.aborted) throw new Error('状态已变化，请刷新后重试');
    await uow.apply(petId,current.version,draft=>{
      const life=draft.life, now=new Date().toISOString(), eventId=`management:${randomUUID()}`;
      if(command.kind==='group-remark'){
        const person=groupPeopleDirectory(life).find(p=>p.actorId===command.actorId);
        if(!person||person.remark!==command.expectedRemark)throw Error('群友备注已变化，请刷新后重试');
        if(typeof command.remark!=='string'||(command.remark.trim()!==''&&!cleanGroupName(command.remark)))throw Error('备注姓名无效');
        const remark=command.remark.trim();
        if(remark!==person.remark)life.events.push({eventId,petId,type:'management.group-remark',source:'user',actorId:'dad',occurredAt:now,receivedAt:now,evidenceLevel:'reported',payload:{actorId:command.actorId,remark,reason:command.reason}});
        return {};
      }
      if(command.kind==='spirit') {
        const legacy=draft.legacy as Record<string,any>, receipts=legacy.spiritAdjustments??={};
        const prior=receipts[command.requestId];
        if(prior!==undefined){if(prior!==command.value)throw Error('调整标识冲突');return {};}
        const spirit=advanceSpirit(life), before=spirit.value;
        if(Math.abs(before-command.value)<0.005){receipts[command.requestId]=command.value;return {};}
        spirit.value=command.value;
        if(spirit.mode==='sleep'){spirit.sleepRecoveryAt=spirit.updatedAt;spirit.sleepRecoveryValue=command.value;}
        const text=command.value>before?'爸爸给我吃了一个金色 token，我的精神突然变好了。':'发生了一些变故，我的精神变差了。';
        const id='experience:'+command.requestId;
        life.events.push({eventId:id,petId,type:'spirit.experience',source:'environment',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{text}});
        life.memories.push({id:'memory:'+id,kind:'autobiographical',content:text,sourceIds:[id],evidenceLevel:'observed',valid:true,createdAt:now});
        receipts[command.requestId]=command.value;
        return {};
      }
      if(command.kind==='pause') life.constraints.paused=command.paused;
      else if(command.kind==='group-chat'){
        const legacy=draft.legacy as Record<string,any>;legacy.config??={};
        if((legacy.config.qqGroupBlocked===true)===command.blocked)return {};
        legacy.config.qqGroupBlocked=command.blocked;
        life.events.push({eventId,petId,type:'management.group-chat',source:'user',actorId:'dad',occurredAt:now,receivedAt:now,evidenceLevel:'observed',payload:{blocked:command.blocked,reason:command.reason,text:command.blocked?'爸爸禁止我看群消息和参与群聊了；私聊仍然可以。':'爸爸恢复了我看群消息和参与群聊的权限。禁止期间的群消息没有看过。'}});
        return {};
      }
      else if(command.kind==='goal') {
        const goal=life.goals.find(g=>g.id===command.id);
        if(!goal || goal.status!==command.expectedStatus || !({active:['paused','abandoned'],paused:['active','abandoned'],deferred:['active','paused','abandoned']} as Record<string,string[]>)[goal.status]?.includes(command.status)) throw new Error('目标状态已变化');
        goal.status=command.status;
        if(command.status==='active')delete goal.review;
        for(const plan of life.cognitivePlans??[]){
          if(plan.goalId!==goal.id||!['active','paused'].includes(plan.status))continue;
          setGoalPlanStatus(plan,command.status);
        }
      } else if(command.kind==='revoke') {
        life.constraints.permissions=life.constraints.permissions.filter(p=>p!==command.permission);
        // A later settings save must not silently restore an explicitly revoked
        // network permission from the legacy phone switch.
        if(command.permission==='network'){
          const legacy=draft.legacy as Record<string,any>;
          if(legacy.config?.networkLearning){legacy.config.networkLearning=false;const phone=legacy.growth?.phone;if(phone){phone.epoch=(Number(phone.epoch)||0)+1;phone.changedAt=Date.now();phone.closedByParent=true;phone.notice='closed';}}
        }
      } else {
        if(['__proto__','constructor','prototype'].includes(command.id)) throw new Error('记忆标识无效');
        const memory=life.memories.find(m=>m.id===command.id);
        if(!memory || !memory.valid || memory.content!==command.expectedContent) throw new Error('记忆已变化');
        memory.valid=false; life.invalidSources[memory.id]=command.reason;
        // Legacy recall reads these raw collections; mark the original and its
        // dependent records invalid in this same authoritative envelope.
        const match=/^legacy:(fact|memory|strategy|diary):(.+)$/.exec(memory.id);
        // Legacy records flatten their derivation to root events; invalidating
        // those roots mirrors the old store's blocked-source deletion policy.
        if(match) for(const source of memory.sourceIds) life.invalidSources[source]=command.reason;
        if(match){
          let oldId:string;try{oldId=decodeURIComponent(match[2]);}catch{throw new Error('旧记忆标识无效');}
          const p=draft.legacy as Record<string,any>, growth=p.growth;
          const lists=[p.facts,growth?.memories,growth?.strategies,growth?.skills].filter(Array.isArray) as Array<Array<Record<string,any>>>;
          const bad=new Set<string>([oldId]); let changed=true;
          if(match[1]==='diary' && p.diaries?.[oldId]) {p.diaries[oldId].deleted=true;p.deletedDays=[...new Set([...(Array.isArray(p.deletedDays)?p.deletedDays:[]),oldId])];}
          while(changed){changed=false;for(const list of lists)for(const item of list){if(!item||typeof item!=='object')continue;if(bad.has(item.id)||(Array.isArray(item.sources)&&item.sources.some((s:string)=>bad.has(s)))){if(!item.deleted){item.deleted=true;changed=true;}if(typeof item.id==='string')bad.add(item.id);if(typeof item.key==='string')bad.add(item.key);}}}
          if(growth && typeof growth==='object') growth.blocked=[...new Set([...(Array.isArray(growth.blocked)?growth.blocked:[]),...bad])];
          for(const item of life.memories){const m=/^legacy:(fact|memory|strategy|diary):(.+)$/.exec(item.id);if(m && bad.has(decodeURIComponent(m[2]))){item.valid=false;life.invalidSources[item.id]='旧档来源已失效';}}
        }
        const projected:LifeState={...life,petId,version:draft.version,...projectBody(draft)};
        invalidateDependents(projected);
        life.relationships=projected.relationships;
        if(command.action==='correct') {
          if(!validText(command.content,5000)) throw new Error('纠正内容无效');
          const newId=`memory:${randomUUID()}`;
          life.memories.push({id:newId,kind:memory.kind,content:command.content.trim(),sourceIds:[eventId],evidenceLevel:'reported',valid:true,createdAt:now});
          memory.correctedBy=newId;
        }
      }
      life.events.push({eventId,petId,type:'management.'+command.kind,source:'user',occurredAt:now,receivedAt:now,evidenceLevel:'reported',payload:{reason:command.reason,...(command.kind==='goal'?{goalId:command.id,status:command.status}:command.kind==='memory'?{memoryId:command.id,action:command.action}:command.kind==='revoke'?{permission:command.permission}:{paused:command.paused})}});
      return {};
    });
    if(command.kind==='group-chat')groupChanged?.(command.blocked);
    });
  };
}
const response=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});

function eventPayload(event:LifeEvent):Record<string,unknown> {
  return event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
}

function chatHistory(state:PageState) {
  return state.events.filter(e=>isOwnerPrivateConversation(e)&&!Object.hasOwn(state.invalidSources,e.eventId)&&typeof eventPayload(e).text==='string')
    .slice(-100).map(e=>{
      const {text,tokenUsage:usage,meme}=eventPayload(e);
      return {id:e.eventId,role:e.type==='conversation.user'?'user':'assistant',text,at:e.occurredAt,usage,meme};
    });
}

function timelineRow(event:LifeEvent) {
  const {title,summary,text,description,message}=eventPayload(event);
  return {occurredAt:event.occurredAt,evidenceLevel:event.evidenceLevel,source:event.source,actorId:event.actorId,type:event.type,
    description:[title,summary,text,description,message].find(value=>typeof value==='string'&&value.trim())};
}

function viewSources(state:PageState) {
  const sourceIds=new Set([
    ...state.goals.flatMap(g=>g.sourceIds),
    ...(state.cognitivePlans??[]).flatMap(p=>[...p.sourceIds,...p.steps.flatMap(step=>step.receiptEventId?[step.receiptEventId]:[])]),
    ...(state.worldModel?.facts??[]).filter(f=>f.valid).slice(-15).flatMap(f=>f.sourceIds),
    ...(state.selfModel?.habits??[]).filter(h=>h.valid).flatMap(h=>h.sourceIds),
    ...(state.selfModel?.interests??[]).filter(i=>i.valid).flatMap(i=>i.sourceIds),
    ...(state.selfModel?.autobiography??[]).filter(m=>m.valid).slice(-12).flatMap(m=>m.sourceIds)
  ]);
  const events=state.events.filter(e=>e.type!==momentEventType&&!Object.hasOwn(state.invalidSources,e.eventId));
  for(const event of events.slice(-500))sourceIds.add(event.eventId);
  const actions=new Map(state.actions.map(action=>[action.id,action]));
  return Object.fromEntries(events.filter(e=>sourceIds.has(e.eventId)).map(e=>{
    const payload=eventPayload(e),action=typeof payload.actionId==='string'?actions.get(payload.actionId):undefined;
    const text=[payload.text,payload.summary,payload.message,payload.description].find(value=>typeof value==='string'&&value.trim())
      ||(action?.actionType==='learning.observe'&&typeof action.parameters.query==='string'?'探索资料：'+action.parameters.query:e.type);
    return [e.eventId,{text,at:e.occurredAt}];
  }));
}

function growthArchive(state:PageState) {
  const receipts=new Map<string,unknown>(), cancelled=new Map<unknown,unknown>(), failed=new Map<unknown,unknown>();
  for(const receipt of state.receipts) {
    if(['FAILED','CANCELLED'].includes(receipt.status)&&!receipts.has(receipt.actionId))receipts.set(receipt.actionId,receipt.details?.reason);
  }
  for(const event of state.events) {
    if(event.type==='action.cancelled') {
      const {actionId,reason}=eventPayload(event);
      if(!cancelled.has(actionId))cancelled.set(actionId,reason);
    } else if(event.type==='plan.failed') {
      const {planId,reason}=eventPayload(event);
      if(!failed.has(planId))failed.set(planId,reason);
    }
  }
  const plans=(state.cognitivePlans??[]).map(plan=>({...plan,reason:plan.steps
    .map(step=>step.actionId?(receipts.get(step.actionId)||cancelled.get(step.actionId)):undefined).find(reason=>typeof reason==='string')
    ||failed.get(plan.id)||(plan.status==='paused'?'计划已暂停':plan.status==='failed'?'行动未完成，请重新规划':undefined)}));
  return {version:state.version,sources:viewSources(state),memories:state.memories,beliefs:state.beliefs,observations:state.observations,
    selfModel:state.selfModel,worldModel:state.worldModel,plans,diaryDates:state.diaryDates};
}

export function createLifeApi(host:LifeApiHost) {
  return async(request:Request):Promise<Response|undefined>=>{
    const url=new URL(request.url);if(!url.pathname.startsWith('/api/life/'))return undefined;
    if(!await host.authorize(request))return response(403,{ok:false,error:'没有访问权限'});
    const endpoint=url.pathname.slice('/api/life/'.length);
    if(!['snapshot','goals','timeline','relationships','growth','settings','chat-history','manage','memory-search','memory-graph','shutdown','attachment','finance','companion','model','worksite','farm','farm-weather'].includes(endpoint))return response(404,{ok:false,error:'没有这个接口'});
    if(request.method!=='GET' && !(request.method==='POST' && ['manage','shutdown','attachment','finance','companion','model','worksite','farm','farm-weather'].includes(endpoint)) || request.method==='GET' && ['manage','shutdown','attachment','worksite','farm','farm-weather'].includes(endpoint))return response(405,{ok:false,error:'请求方法不受支持'});
    try {
      if(endpoint==='shutdown') {if(!host.shutdown)return response(503,{ok:false,error:'关闭入口不可用'});setTimeout(host.shutdown,100);return response(200,{ok:true,value:{closing:true}});}
      const id=await host.petId();
      if(endpoint==='worksite'){if(!host.openWorksite)return response(503,{ok:false,error:'工地入口暂不可用'});try{await host.openWorksite(id);return response(200,{ok:true,value:{opened:true}});}catch(error){return response(503,{ok:false,error:error instanceof Error?error.message:'工地窗口暂不可用'});}}
      if(endpoint==='farm'||endpoint==='farm-weather'){
        if(!host.farm)return response(503,{ok:false,error:'稻田入口暂不可用'});
        if(endpoint==='farm'){await host.farm.requestOpen(id);return response(200,{ok:true,value:{opened:true}});}
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return response(415,{ok:false,error:'请求格式无效'});
        const input=await request.json().catch(()=>null);
        if(!input||typeof input.weather!=='string')return response(400,{ok:false,error:'请选择天气'});
        return response(200,{ok:true,value:await host.farm.weather(id,input.weather)});
      }
      if(endpoint==='attachment'){
        if(!host.attachments)return response(503,{ok:false,error:'图片服务尚未接入'});
        const type=request.headers.get('content-type')||'',requestId=request.headers.get('x-request-id')||'';
        if(!['image/png','image/jpeg','image/webp','image/gif'].includes(type)||!/^[A-Za-z0-9:-]{8,140}$/.test(requestId))return response(400,{ok:false,error:'图片格式或请求编号无效'});
        if(Number(request.headers.get('content-length')||0)>5_000_000)return response(413,{ok:false,error:'图片不能超过 5 MB'});
        const reader=request.body?.getReader();if(!reader)return response(400,{ok:false,error:'图片为空'});const chunks:Uint8Array[]=[];let size=0;
        for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>5_000_000){await reader.cancel();return response(413,{ok:false,error:'图片不能超过 5 MB'});}chunks.push(next.value);}
        const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
        return response(200,{ok:true,value:await host.attachments.put(id,requestId,{mediaType:type,data})});
      }
      if(endpoint==='finance' || endpoint==='companion' || endpoint==='model') {
        const manager=endpoint==='finance'?host.finance:endpoint==='companion'?host.companion:host.model;
        if(!manager)return response(503,{ok:false,error:'管理服务尚未接入'});
        if(request.method==='GET')return response(200,{ok:true,value:await manager.read(id,request.signal)});
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return response(415,{ok:false,error:'请求格式无效'});
        const raw=await request.text();if(raw.length>8192)return response(413,{ok:false,error:'请求过大'});
        let input:unknown;try{input=JSON.parse(raw);}catch{return response(400,{ok:false,error:'请求格式无效'});}
        if(!input||typeof input!=='object'||Array.isArray(input))return response(400,{ok:false,error:'请求格式无效'});
        return response(200,{ok:true,value:await manager.write(id,input as Record<string,unknown>,request.signal)});
      }
      if(request.method==='POST') {
        if(!host.manage)return response(503,{ok:false,error:'管理操作尚未接入'});
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return response(415,{ok:false,error:'请求格式无效'});
        const raw=await request.text();if(raw.length>8192)return response(413,{ok:false,error:'请求过大'});
        let c:any;try{c=JSON.parse(raw);}catch{return response(400,{ok:false,error:'请求格式无效'});}
        if(!c || typeof c!=='object' || Array.isArray(c) || !Number.isSafeInteger(c.version) || c.version<0 || !validText(c.reason) ||
          !(c.kind==='group-remark' && typeof c.actorId==='string' && /^qq-member:[a-zA-Z0-9_-]{1,100}$/.test(c.actorId) && typeof c.remark==='string' && c.remark.length<=40 && (c.remark===''||!!cleanGroupName(c.remark)) && typeof c.expectedRemark==='string' && c.expectedRemark.length<=40 || c.kind==='spirit' && typeof c.value==='number' && Number.isFinite(c.value) && c.value>=0 && c.value<=100 && typeof c.requestId==='string' && /^[A-Za-z0-9:-]{8,140}$/.test(c.requestId) || c.kind==='pause' && typeof c.paused==='boolean' || c.kind==='group-chat' && typeof c.blocked==='boolean' || c.kind==='goal' && validText(c.id,512) && validText(c.expectedStatus,30) && ['active','paused','abandoned'].includes(c.status) ||
            c.kind==='revoke' && validText(c.permission,200) || c.kind==='memory' && validText(c.id,512) && typeof c.expectedContent==='string' && c.expectedContent.length<=5000 && ['delete','correct'].includes(c.action) && (c.action!=='correct'||validText(c.content,5000))))return response(400,{ok:false,error:'操作内容或原因无效'});
        await host.manage(id,c as ManagementCommand);
      }
      if(endpoint==='memory-search'){if(!host.searchMemories)return response(503,{ok:false,error:'记忆检索不可用'});const query=url.searchParams.get('q')||'';if(query.length>500)return response(400,{ok:false,error:'搜索内容过长'});return response(200,{ok:true,value:await host.searchMemories(id,query)});}
      if(endpoint==='memory-graph'){if(!host.memoryGraph)return response(503,{ok:false,error:'记忆星图不可用'});const query=url.searchParams.get('q')||'';if(query.length>500)return response(400,{ok:false,error:'搜索内容过长'});return response(200,{ok:true,value:await host.memoryGraph(id,query)});}
      const view=url.searchParams.get('view');
      if((endpoint==='settings'||endpoint==='manage')&&host.getLifeSettings){
        const settings=await host.getLifeSettings(id);
        return response(200,{ok:true,value:endpoint==='settings'?settings:{version:settings.version}});
      }
      const state=await host.getState(id,endpoint==='growth'&&view!=='moments'?'archive':undefined);
      request.signal.throwIfAborted();
      let value:unknown;
      switch(endpoint){
        case 'settings':
          value={version:state.version,paused:state.constraints.paused,permissions:state.constraints.permissions,
            groupChatBlocked:host.groupChatBlocked?await host.groupChatBlocked(id):false};
          break;
        case 'manage':
          value={version:state.version};
          break;
        case 'chat-history':
          value=chatHistory(state);
          break;
        case 'timeline': {
          const events=state.events.filter(e=>e.type!==momentEventType);
          value=view==='page'?events.map(timelineRow):events;
          break;
        }
        case 'relationships':
          value=view==='page'?{version:state.version,items:state.relationships,people:groupPeopleDirectory(state)}:state.relationships;
          break;
        case 'growth':
          value=view==='moments'?{moments:readMoments(state)}:view==='archive'?growthArchive(state):{...growthArchive(state),moments:readMoments(state)};
          break;
        case 'goals':
          value={version:state.version,items:state.goals,plans:state.cognitivePlans??[],sources:viewSources(state)};
          break;
        case 'snapshot':
          value={version:state.version,sources:viewSources(state),identity:state.identity,spirit:state.spirit,body:state.body,emotions:state.emotions,
            activeGoals:state.goals.filter(g=>g.status==='active'),actions:state.actions.filter(a=>!['COMPLETED','FAILED','CANCELLED'].includes(a.status)),
            runtime:{paused:state.constraints.paused,remainingBudget:state.constraints.remainingBudget,budgetDay:state.constraints.budgetDay,
              interactiveRemaining:state.constraints.interactiveRemaining,permissions:state.constraints.permissions},links:host.links};
          break;
      }
      return response(200,{ok:true,value});
    }catch(error){return response(409,{ok:false,error:['finance','companion','model','farm','farm-weather'].includes(endpoint) && error instanceof Error ? error.message : '操作未完成或状态已变化，请刷新后重试'});}
  };
}
