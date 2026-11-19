import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate} from '../storage/uow.js';
import type {LegacyDomain} from './legacy-domain.js';
import {farmSeedShop} from './farm.js';

type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
const money=(value:unknown,max:number):value is number=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=max && Math.abs(value*100-Math.round(value*100))<1e-5;
const costNames=['chat','whisper','feed','diary','explore'] as const;

/** All writes go through the existing per-pet transaction and operation receipt. */
export function createFinanceManagement(store:Reader,gate:PetGate,domain:LegacyDomain) {
  return {
    read:async(id:string)=>{
      gate.signal.throwIfAborted();
      const envelope=await store.loadEnvelope(id);if(!envelope)throw Error('饭钱状态不可用');
      const p=envelope.legacy as Record<string,any>, labor=p.labor||{},contracts=Array.isArray(labor.contracts)?labor.contracts:[];
      const pending=contracts.filter((c:any)=>['offered','working','paused','queued'].includes(c.status) && c.done<c.trips);
      const seedShop=farmSeedShop(envelope.legacy);
      return {wallet:p.wallet,costs:{...p.config?.costs,riceSeed:seedShop.price},seedShop,labor:{current:pending[0]||null,queue:pending.slice(1),history:contracts.filter((c:any)=>['paid','declined','cancelled','unpaid'].includes(c.status)).slice().reverse(),execution:labor.execution||null},
        events:(Array.isArray(p.events)?p.events:[]).filter((e:any)=>['wallet','wallet-spend','labor'].includes(e.kind)).slice(-30).reverse().map((e:any)=>({id:e.id,text:e.text,ts:e.ts}))};
    },
    write:async(id:string,input:Record<string,unknown>)=>{
      const requestId=input.requestId;
      if(typeof requestId!=='string'||!/^[a-zA-Z0-9:-]{8,140}$/.test(requestId))throw Error('操作编号无效');
      if(input.kind==='wallet') {
        if(!['add','subtract','set','freeze'].includes(String(input.action)))throw Error('饭钱操作无效');
        if(!money(input.expectedBalance,1_000_000_000)||typeof input.expectedFrozen!=='boolean')throw Error('余额状态无效，请刷新后重试');
        if(input.action==='freeze') {if(typeof input.frozen!=='boolean')throw Error('消耗状态无效');}
        else if(!money(input.amount,1_000_000_000))throw Error('金额须为 0–1000000000，最多两位小数');
        if(input.action==='subtract' && (input.amount as number)>input.expectedBalance)throw Error('减少金额不能超过当前余额');
        if(input.action==='add' && (input.amount as number)+input.expectedBalance>1_000_000_000)throw Error('增加后余额不能超过 1000000000');
        return domain.wallet(id,requestId,{action:input.action,...(input.action==='freeze'?{frozen:input.frozen}:{amount:input.amount}),expectedBalance:input.expectedBalance,expectedFrozen:input.expectedFrozen});
      }
      if(input.kind==='costs') {
        const costs=input.costs;if(!costs||typeof costs!=='object'||Array.isArray(costs))throw Error('消费价格无效');
        const values=costs as Record<string,unknown>;
        const keys=Object.hasOwn(values,'riceSeed')?[...costNames,'riceSeed']:costNames;
        if(Object.keys(values).length!==keys.length||keys.some(k=>!money(values[k],100000)))throw Error('价格须为 0–100000，最多两位小数');
        return domain.configure(id,requestId,{costs:Object.fromEntries(keys.map(k=>[k,values[k]]))});
      }
      if(input.kind==='farm-seeds') {
        if(typeof input.count!=='number'||!Number.isSafeInteger(input.count)||input.count<1||!money(input.unitCharge,100000))throw Error('种子数量或报价无效');
        return domain.buyFarmSeeds(id,requestId,input.count,input.unitCharge);
      }
      if(input.kind==='labor') {
        const action=input.action;
        if(!['offer','pause','resume','adjust','cancel','settle-cancelled'].includes(String(action)))throw Error('工作操作无效');
        if(action==='offer'||action==='adjust') {
          if(!Number.isInteger(input.trips)||Number(input.trips)<1||Number(input.trips)>500||!Number.isInteger(input.wage)||Number(input.wage)<1||Number(input.wage)>1_000_000)throw Error('趟数须为 1–500，工钱须为 1–1000000 的整数');
          if(action==='adjust'&&(typeof input.id!=='string'||!input.id||input.id.length>140))throw Error('工作约定无效');
          return domain.laborAction(id,requestId,{action,...(action==='adjust'?{id:input.id}:{}),trips:input.trips,wage:input.wage});
        }
        if(typeof input.id!=='string'||!input.id||input.id.length>140)throw Error('工作约定无效');
        if(['pay','settle-cancelled'].includes(String(action)) && (!Number.isInteger(input.amount)||Number(input.amount)<0||Number(input.amount)>1_000_000))throw Error('工钱须为 0–1000000 的整数');
        return domain.laborAction(id,requestId,{action,id:input.id,...(['pay','settle-cancelled'].includes(String(action))?{amount:input.amount,key:requestId}:{})});
      }
      throw Error('不支持的饭钱操作');
    }
  };
}
