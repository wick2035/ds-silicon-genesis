import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {LegacyDomain} from './legacy-domain.js';
type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
/** User-held tokens are accepted only from helper-channel's authenticated IPC.
 * No timer or GET invents a recovery; picking up requires a real action receipt. */
export function createHelperTokens(store:Reader,domain:LegacyDomain,authority:object) {
  const holds=new Map<string,number>();
  const snapshot=async(id:string)=>{const state=await store.loadEnvelope(id);if(!state)throw Error('生命状态不存在');const pet=state.legacy as Record<string,any>,t=pet.tokens||{coins:[],dropped:0,collected:0,recovered:0,lastDrop:0,plan:[],error:null};return {...structuredClone(t),coins:(t.coins||[]).filter((c:any)=>c.status==='floor'),balance:pet.wallet?.balance,value:100,held:(holds.get(id)||0)>Date.now(),thinking:false};};
  return {snapshot,close(){holds.clear();},async handle(id:string,requestId:string,body:any){
    if(!body||body.surface!=='desktop')throw Error('碎片活动端无效');let result:unknown;
    if(body.action==='hold')holds.set(id,Date.now()+5000);
    else if(body.action==='release')holds.delete(id);
    else if(body.action==='drop'){if((holds.get(id)||0)<=Date.now())throw Error('需要按住空格拖动身体');result=await domain.dropToken(id,requestId,body,authority);}
    else if(body.action==='collect'){const t=await snapshot(id);if(!t.coins.some((c:any)=>c.id===body.id&&c.surface==='desktop'))throw Error('碎片不在当前桌面');result=await domain.collectToken(id,requestId,body.id,authority);}
    else if(body.action==='layout')result=await domain.tokenLayout(id,requestId,body.positions,authority);
    else if(body.action==='recover')throw Error('拾取等待可信动作回执');
    else throw Error('未知碎片操作');
    return {ok:true,result,tokens:await snapshot(id)};
  }};
}
