import {createHash,randomUUID} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';

type Todo={id:string;text:string;dueAt:number|null;done:boolean;createdAt:number;updatedAt:number;completedAt:number|null;lastRemindedAt:number|null};
type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id);
const text=(v:unknown)=>{if(typeof v!=='string'||!v.trim()||Array.from(v.trim()).length>200)throw Error('待办内容无效');return v.trim();};
const due=(v:unknown):number|null=>{if(v==null)return null;if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>864e13)throw Error('待办时间无效');return v;};
const list=(legacy:Record<string,any>):Todo[]=>Array.isArray(legacy.todos)?legacy.todos:[];
/** One-time, additive import. An imported ID is never resurrected or overwritten. */
export function importLegacyTodos(envelope:CanonicalEnvelope,raw:string,at:string):{count:number;digest:string} {
 const data=JSON.parse(raw.replace(/^\uFEFF/,''));if(!data||!Array.isArray(data.todos))throw Error('待办文件无效');
 const legacy=envelope.legacy as Record<string,any>,digest=createHash('sha256').update(raw).digest('hex');
 legacy.todoImports ||= {};if(legacy.todoImports[digest])return {count:0,digest};
 legacy.todos ||= [];legacy.todoTombstones ||= {};const seen=new Set(list(legacy).map(t=>t.id));let count=0;
 for(const row of data.todos){if(!row||!validId(row.id)||seen.has(row.id)||legacy.todoTombstones[row.id])continue;
  let value:string,when:number|null;try{value=text(row.text);when=due(row.dueAt);}catch{throw Error('待办文件包含无效记录，拒绝部分导入');}
  const created=Number.isFinite(row.createdAt)?row.createdAt:0,updated=Number.isFinite(row.updatedAt)?row.updatedAt:created,done=row.done===true;
  legacy.todos.push({id:row.id,text:value,dueAt:when,done,createdAt:created,updatedAt:updated,completedAt:done?(Number.isFinite(row.completedAt)?row.completedAt:updated):null,lastRemindedAt:Number.isFinite(row.lastRemindedAt)?row.lastRemindedAt:null});seen.add(row.id);count++;
 }
 legacy.todoImports[digest]={at,count};envelope.life.events.push({eventId:'todo-import:'+digest,petId:envelope.petId,type:'todo.imported',source:'legacy',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{digest,count}});return {count,digest};
}
export function createCanonicalTodos(store:Reader,gate:PetGate,uow:UnitOfWork){
 const run=async<T>(petId:string,fn:(legacy:Record<string,any>,events:CanonicalEnvelope['life']['events'],now:number)=>T)=>gate.run(petId,async()=>{const state=await store.loadEnvelope(petId);if(!state)throw Error('生命状态不存在');let result!:T;await uow.apply(petId,state.version,d=>{result=fn(d.legacy as Record<string,any>,d.life.events,Date.now());return {};});return result;});
 const event=(events:CanonicalEnvelope['life']['events'],petId:string,type:string,id:string,now:number)=>{const at=new Date(now).toISOString();events.push({eventId:'todo-event:'+randomUUID(),petId,type,source:'user',actorId:'dad',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{todoId:id}});};
 return {
  async list(petId:string){const s=await store.loadEnvelope(petId);if(!s)throw Error('生命状态不存在');return structuredClone(list(s.legacy as Record<string,any>)).sort((a,b)=>Number(a.done)-Number(b.done)||(a.done?(b.completedAt??0)-(a.completedAt??0):(a.dueAt??Infinity)-(b.dueAt??Infinity)||a.createdAt-b.createdAt));},
  create(petId:string,input:Record<string,unknown>){const value=text(input.text),when=due(input.dueAt);return run(petId,(l,e,now)=>{l.todos ||= [];const t:Todo={id:'todo-'+randomUUID(),text:value,dueAt:when,done:false,createdAt:now,updatedAt:now,completedAt:null,lastRemindedAt:null};l.todos.push(t);event(e,petId,'todo.created',t.id,now);return structuredClone(t);});},
  update(petId:string,id:string,input:Record<string,unknown>){if(!validId(id))throw Error('待办编号无效');if(!['text','dueAt','done'].some(k=>Object.hasOwn(input,k)))throw Error('没有可更新的字段');const value=Object.hasOwn(input,'text')?text(input.text):undefined,when=Object.hasOwn(input,'dueAt')?due(input.dueAt):undefined;if(input.done!==undefined&&typeof input.done!=='boolean')throw Error('待办状态无效');return run(petId,(l,e,now)=>{const t=list(l).find(x=>x.id===id);if(!t)throw Error('没有这条待办');if(value!==undefined)t.text=value;if(when!==undefined){t.dueAt=when;t.lastRemindedAt=null;}if(typeof input.done==='boolean'){t.done=input.done;t.completedAt=t.done?t.completedAt??now:null;if(!t.done)t.lastRemindedAt=null;}t.updatedAt=now;event(e,petId,'todo.updated',id,now);return structuredClone(t);});},
  remove(petId:string,id:string){if(!validId(id))throw Error('待办编号无效');return run(petId,(l,e,now)=>{const i=list(l).findIndex(x=>x.id===id);if(i<0)return 0;l.todos.splice(i,1);(l.todoTombstones ||= {})[id]=now;event(e,petId,'todo.deleted',id,now);return 1;});},
  async remind(petId:string,signal:AbortSignal,publish:(todo:Todo)=>Promise<void>|void){const s=await store.loadEnvelope(petId);const now=Date.now();if(signal.aborted||!s||!list(s.legacy as Record<string,any>).some(t=>!t.done&&t.dueAt!==null&&t.dueAt<=now&&t.lastRemindedAt===null))return;
   const item=await run(petId,(l,e,at)=>{const t=list(l).find(x=>!x.done&&x.dueAt!==null&&x.dueAt<=at&&x.lastRemindedAt===null);if(!t)return null;t.lastRemindedAt=at;const stamp=new Date(at).toISOString();e.push({eventId:'todo-reminder:'+randomUUID(),petId,type:'todo.reminder',source:'scheduler',occurredAt:stamp,receivedAt:stamp,evidenceLevel:'observed',payload:{todoId:t.id,dueAt:t.dueAt}});return structuredClone(t);});if(item&&!signal.aborted)await publish(item);
  }
 };
}
/** Legacy HTTP contract; the host handles authentication and resolves petId. */
export function createTodoRoute(todos:ReturnType<typeof createCanonicalTodos>,petId:string){return async(url:string,method:string,body?:string)=>{
 const path=new URL(url,'http://localhost').pathname,match=path.match(/\/todos(?:\/([^/]+))?$/);if(!match)return undefined;
 const json=(obj:unknown,status=200)=>({kind:'json' as const,status,obj,headers:{'cache-control':'no-store'}});
 try{const id=match[1];if(!id&&method==='GET')return json({ok:true,todos:await todos.list(petId)});if(id&&method==='DELETE')return json({ok:true,removed:await todos.remove(petId,id)});
  if((!id&&method==='POST')||(id&&method==='PATCH')){if(Buffer.byteLength(body||'')>16384)throw Error('请求过大');const input=JSON.parse(body||'null');if(!input||typeof input!=='object'||Array.isArray(input))throw Error('请求格式无效');return json({ok:true,todo:id?await todos.update(petId,id,input):await todos.create(petId,input)});}
  return json({ok:false,message:'请求方法无效'},405);
 }catch(error){return json({ok:false,message:error instanceof Error?error.message:'待办操作失败'},400);}
};}
