import { randomUUID } from 'node:crypto';
import type { CanonicalEnvelope } from '../storage/postgres.js';
import type { PetGate } from '../storage/uow.js';
import type { LegacyDomain } from './legacy-domain.js';
import type { CanonicalHumanityAdapter } from './humanity-adapter.js';
import {projectLegacySnapshot} from './legacy-snapshot.js';

type JsonResult = {kind:'json';status:number;obj:unknown;headers:Record<string,string>};
type Reader = {loadEnvelope(petId:string):Promise<CanonicalEnvelope|null>};
type Options = {store:Reader;gate:PetGate;domain:LegacyDomain;humanity:CanonicalHumanityAdapter;providers?:Record<string,boolean>;view?:(petId:string)=>unknown;service?:(petId:string,input:Record<string,unknown>)=>Promise<unknown>;waitCareResponse?:(eventId:string)=>Promise<string|undefined>;tokenSnapshot?:(petId:string)=>Promise<unknown>;interrupt?:(petId:string)=>void;responses?:(id:string,kind:'help'|'say'|'sleep-refused',signal:AbortSignal)=>Promise<string>;development?:{task:(id:string,kind:'diary'|'reflection',signal:AbortSignal,manual?:boolean,date?:string)=>Promise<boolean>};
  /** Authenticate and resolve the pet for BOTH HTTP and helper-origin requests. */
  resolvePet:(url:URL)=>Promise<{petId:string;name:string}>|{petId:string;name:string}};
const json=(obj:unknown,status=200):JsonResult=>({kind:'json',status,obj,headers:{'cache-control':'no-store'}});

/** Replacement for the old synchronous route, not a wrapper around its global
 * singleton. Unmigrated endpoints fail closed. Domain methods commit before they
 * return; external desktop actions can only originate from the canonical outbox. */
export function createLegacyRequestAdapter({store,gate,domain,humanity,resolvePet,providers,view,service,waitCareResponse,tokenSnapshot,interrupt,development,responses}:Options) {
  return async (rawUrl:string,method:string,body?:string,signal?:AbortSignal):Promise<JsonResult> => {
    try {
      if (signal?.aborted || gate.signal.aborted) throw Error('请求或写入租约已结束');
      const url=new URL(rawUrl,'http://localhost');
      const marker='/humanity/'; const at=url.pathname.indexOf(marker);
      if(at<0)return json({ok:false,message:'没有这个接口'},404);
      const path=url.pathname.slice(at+1), who=await resolvePet(url), petId=who.petId;
      if(!petId)throw Error('未选择桌宠');
      const read=async()=>gate.run(petId,async()=>{const state=await store.loadEnvelope(petId);if(!state||state.petId!==petId)throw Error('生命状态不存在');return state;});
      if(method==='GET') {
        if(path==='humanity/state')return json({ok:true,name:who.name,state:await humanity.snapshot(petId)});
        if(path==='humanity/companion/tokens'){if(!tokenSnapshot)return json({ok:false,message:'饭钱互动未接入'},503);return json({ok:true,tokens:await tokenSnapshot(petId)});}
        if(path==='humanity/companion/world'){const state=await store.loadEnvelope(petId);if(!state||state.petId!==petId)throw Error('生命状态不存在');const world=projectLegacySnapshot(state,providers).world;const command=view?.(petId);return json({ok:true,world:{...world,command:command??null}});}
        const state=await read(), legacy=state.legacy as Record<string,any>;
        const projected=projectLegacySnapshot(state,providers);
        if(path==='humanity/companion/state')return json({ok:true,state:projected.state});
        if(path==='humanity/companion/export')return json({ok:true,archive:structuredClone(legacy)});
        if(path==='humanity/companion/labor')return json({ok:true,labor:projected.labor});
        if(path==='humanity/companion/service')return json({ok:true,services:projected.services});
        if(path==='humanity/companion/soft')return json({ok:true,soft:projected.world.soft});
        return json({ok:false,message:'接口尚未接入'},503);
      }
      if(method!=='POST')return json({ok:false,message:'请求方法不正确'},405);
      if(body && Buffer.byteLength(body)>1048576)return json({ok:false,message:'请求过大'},413);
      let input:any;try{input=JSON.parse(body||'{}');}catch{return json({ok:false,message:'请求格式不正确'},400);}
      if(!input||typeof input!=='object'||Array.isArray(input))throw Error('请求格式不正确');
      const requestId=typeof input.requestId==='string' ? input.requestId : `route:${randomUUID()}`;
      if((path==='humanity/companion/ability' && input.action!=='grant') || (path==='humanity/companion/config' && (input.networkLearning===false||input.autonomousPaused===true)) || (path==='humanity/companion/growth'&&input.action==='pause'&&input.paused===true))interrupt?.(petId);
      let result:unknown;
      if(path==='humanity/care' && ['rest','wake'].includes(input.action)){
        if(!service)throw Error('休息服务尚未接入');const outcome:any=await service(petId,{key:requestId,command:input.action==='rest'?'/休息':'/醒来'});
        if(!outcome.ok)throw Error(outcome.message||'休息状态未改变');return json({ok:true,text:outcome.message,pending:outcome.status==='pending',state:await humanity.snapshot(petId)});
      }
      if(path==='humanity/care'&&['feed','water','pet','play','soothe','accompany'].includes(input.action)){
        const commands:Record<string,string>={feed:'/喂',water:'/喝水',pet:'/摸摸',play:'/玩',soothe:'/安慰',accompany:'/陪伴'};
        if(!service)throw Error('照料服务尚未接入');const outcome:any=await service(petId,{key:requestId,command:commands[input.action]});
        if(!outcome.ok)throw Error(outcome.message||'照料未完成');
        const labels:Record<string,string>={feed:'喂饭',water:'喝水',pet:'摸摸',play:'玩耍',soothe:'安慰',accompany:'陪伴'};
        const state=await humanity.snapshot(petId),text=outcome.status==='done'?`${labels[input.action]}已完成。`:outcome.message;
        return json({ok:true,text,pending:outcome.status==='pending',state});
      }
      if(path==='humanity/care'&&input.action==='explore'){
        if(!service)throw Error('探索服务尚未接入');const outcome:any=await service(petId,{key:requestId,command:'/手机 想知道鲸鱼为什么会唱歌',careAction:'explore'});
        if(!outcome.ok)throw Error(outcome.message||'探索未完成');return json({ok:true,text:outcome.message,pending:outcome.status==='pending',state:await humanity.snapshot(petId)});
      }
      if(path==='humanity/companion/soft'){await domain.soft(petId,requestId,input);const state=await read();return json({ok:true,soft:projectLegacySnapshot(state,providers).world.soft});}
      if(path==='humanity/companion/world'&&input.action==='stop'){
        interrupt?.(petId);await domain.stopWorld(petId,requestId);const state=await read();return json({ok:true,world:projectLegacySnapshot(state,providers).world});
      }
      if(path==='humanity/companion/reaction' && input.action==='sleep-refused'){if(!responses)throw Error('回应服务尚未接入');const text=await responses(petId,'sleep-refused',signal??gate.signal);return json({ok:true,reaction:{ok:true,text}});}
      if(path==='humanity/companion/job'){
        if(input.kind==='help'||input.kind==='say'){if(!responses)throw Error('回应服务尚未接入');const text=await responses(petId,input.kind,signal??gate.signal),state=await read();return json({ok:true,result:{status:'done'},reaction:{ok:true,text},state:projectLegacySnapshot(state,providers).state});}
        if(input.kind==='diary'||input.kind==='reflect'){
          if(!development)throw Error('整理服务尚未接入');
          const completed=await development.task(petId,input.kind==='diary'?'diary':'reflection',signal??gate.signal,true,input.date);
          if(!completed)throw Error('今天已整理、没有新经历或日记已存在');
          const state=await read();return json({ok:true,result:{status:'done'},state:projectLegacySnapshot(state,providers).state});
        }
        if(input.kind==='explore'){
          if(!service)throw Error('探索服务尚未接入');const state=await read(),wish=(state.legacy as any).wishes?.find((w:any)=>w.id===input.wishId&&w.status==='pending');
          if(!wish || !['search','fetch','bili','image'].includes(wish.ability))throw Error('这个念想不可用');
          const outcome:any=await service(petId,{key:requestId,command:'/手机 '+wish.topic,wishId:wish.id,ability:wish.ability});
          const after=await read();return json({ok:!!outcome.ok,result:outcome,state:projectLegacySnapshot(after,providers).state},outcome.ok?200:400);
        }
        throw Error('这个整理任务尚不可用');
      }
      if(path==='humanity/companion/service'){
        if(input.command==='/冰箱'){const state=await read();return json({ok:true,key:input.key,command:input.command,menu:projectLegacySnapshot(state,providers).services.menu});}
        if(!service)return json({ok:false,message:'生活服务尚未接入'},503);return json(await service(petId,input));
      }
      if(path==='humanity/care')result=await humanity.act(petId,input.action,requestId);
      else if(path==='humanity/adjust')result=await humanity.adjust(petId,input.stats,requestId,input.expectedRevision);
      else if(path==='humanity/companion/wallet')result=await domain.wallet(petId,requestId,input);
      else if(path==='humanity/companion/config')result=await domain.configure(petId,requestId,input);
      else if(path==='humanity/companion/ability')result=await domain.grant(petId,requestId,input.ability,input.action);
      else if(path==='humanity/companion/memory')result=await domain.memory(petId,requestId,input);
      else if(path==='humanity/companion/growth')result=await domain.growthControl(petId,requestId,input);
      else if(path==='humanity/companion/diary')result=await domain.diary(petId,requestId,input);
      else if(path==='humanity/companion/wish')result=await domain.wish(petId,requestId,input);
      else if(path==='humanity/companion/labor' && ['offer','confirm','decline','pause','resume','counter','nudge','pay'].includes(input.action))result=await domain.laborAction(petId,requestId,input);
      else return json({ok:false,message:'该操作尚未接入可信执行通道'},503);
      if(path.startsWith('humanity/companion/')) {const state=await read();const projected=projectLegacySnapshot(state,providers);return json({ok:true,result,state:projected.state,...(path==='humanity/companion/labor'?{labor:projected.labor}:{})});}
      return json(result);
    } catch(error) {return json({ok:false,message:error instanceof Error?error.message:'请求失败'},400);}
  };
}
