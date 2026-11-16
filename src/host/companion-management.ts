import type { LegacyDomain } from './legacy-domain.js';

type Adapter = (url:string, method:string, body?:string, signal?:AbortSignal)=>Promise<{status:number;obj:unknown}>;
type Obj = Record<string,any>;

/** Authenticated life UI access to the same domain operations as the desktop. */
export function createCompanionManagement(adapter:Adapter, domain:LegacyDomain, interrupt:(id:string)=>void) {
  const call=async(path:string, method:string, input:Obj|undefined, signal:AbortSignal):Promise<Obj>=>{
    const result=await adapter('/dsh-pet-7340/humanity/'+path,method,input?JSON.stringify(input):undefined,signal);
    const data=result.obj as Obj;
    if(result.status>=400 || !data?.ok)throw Error(data?.message || data?.result?.message || '操作未完成');
    return data;
  };
  return {
    async read(_id:string,signal:AbortSignal) {
      const [body,companion]=await Promise.all([call('state','GET',undefined,signal),call('companion/state','GET',undefined,signal)]);
      const p=companion.state||{};
      return {body:{stats:body.state?.stats,adjustmentRevision:body.state?.adjustmentRevision},config:p.config,learning:p.learning,abilities:p.abilities,wishes:p.wishes,diaries:p.diaries,persona:p.growth?.persona,diaryRevisionGuard:true};
    },
    async write(id:string,input:Obj,signal:AbortSignal) {
      if(typeof input.requestId!=='string'||!/^[A-Za-z0-9-]{16,80}$/.test(input.requestId))throw Error('操作标识无效');
      const {operation,...payload}=input;
      if(operation==='network') {
        if(typeof payload.enabled!=='boolean')throw Error('联网开关无效');
        if(!payload.enabled)interrupt(id);
        await domain.configureNetwork(id,payload.requestId,payload.enabled);
        return {message:payload.enabled?'联网学习已开启，仍需分别授权能力':'联网学习已关闭'};
      }
      const paths:Record<string,string>={care:'care',adjust:'adjust',config:'companion/config',ability:'companion/ability',wish:'companion/wish',diary:'companion/diary',job:'companion/job',growth:'companion/growth',memory:'companion/memory'};
      if(!Object.hasOwn(paths,operation))throw Error('操作类型无效');
      if(operation==='care'&&!['feed','water','pet','accompany','play','soothe','rest','wake','explore'].includes(payload.action))throw Error('照料操作无效');
      if(operation==='job'&&!['diary','reflect','explore'].includes(payload.kind))throw Error('整理任务无效');
      if(operation==='growth'&&!['freeze','rollback'].includes(payload.action))throw Error('成长操作无效');
      const result=await call(paths[operation],'POST',payload,signal);
      return {message:result.text || result.result?.message || (result.pending?'请求已提交，等待执行回执':'操作已保存'),pending:!!result.pending || result.result?.status==='pending'};
    }
  };
}
