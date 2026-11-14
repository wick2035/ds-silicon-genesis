import type {CanonicalEnvelope} from '../storage/postgres.js';
import {TrustedDesktopBridge} from './domain-executors.js';
import type {DesktopActionKind} from './domain-executors.js';

type Reader={loadEnvelope(petId:string):Promise<CanonicalEnvelope|null>};
type Command={actionId:string;petId:string;kind:DesktopActionKind;parameters:Record<string,unknown>};
type Pending={command:Command;timer:ReturnType<typeof setTimeout>;startedAt?:number;intensity?:number;stage?:number;coin?:{id:string;x:number;y:number};world?:Record<string,any>};

/** Matches completed animation observations from the helper main process to the
 * one dispatched action. It never makes a client-provided receipt authoritative. */
export function createDesktopCommandChannel(store:Reader,sourceCapability:object) {
  const pending=new Map<string,Pending>();
  const bridge=new TrustedDesktopBridge(async(command,signal)=>{
    if(signal.aborted || pending.has(command.petId))throw Error('桌宠正在执行其他行动');
    const state=await store.loadEnvelope(command.petId), legacy=state?.legacy as Record<string,any>|undefined;
    if(!legacy)throw Error('桌宠状态不可用');
    if(command.kind==='labor.step') {
      const world=legacy.world?.command,p=command.parameters;
      if(!world || world.id!==p.commandId || world.labor?.id!==p.contractId || !Number.isSafeInteger(world.index) || !['desktop','web'].includes(world.surface))throw Error('桌宠工作命令已变化');
    } else if(command.kind==='token.pickup') {
      const coin=legacy.tokens?.coins?.find((c:any)=>c.id===command.parameters.coinId && c.status==='floor' && c.surface==='desktop');
      if(!coin || !Number.isFinite(coin.x) || !Number.isFinite(coin.y))throw Error('桌面碎片不可用');
    } else if(command.kind==='service.eat-rice') {
      const id=command.parameters.itemId, items=legacy.services?.inventory;
      if(typeof id!=='string' || !Array.isArray(items) || !items.some((item:any)=>item.id===id && ['available','reserved'].includes(item.status)))throw Error('食物不在可食用库存中');
    }
    const timer=setTimeout(()=>pending.delete(command.petId),70000);
    const coin=command.kind==='token.pickup'?legacy.tokens.coins.find((c:any)=>c.id===command.parameters.coinId):undefined;
    pending.set(command.petId,{command,timer,...(command.kind==='labor.step'?{world:structuredClone(legacy.world.command),intensity:legacy.world?.command?.labor?.leg==='deliver'?1.5:1}:{}),...(coin?{stage:0,coin:{id:coin.id,x:coin.x,y:coin.y}}:{})});
    signal.addEventListener('abort',()=>{const item=pending.get(command.petId);if(item?.command.actionId===command.actionId){clearTimeout(item.timer);pending.delete(command.petId);}},{once:true});
  },sourceCapability,65000);
  return {bridge,
    view(petId:string) {
      const c=pending.get(petId)?.command;
      if(!c)return undefined;
      if(c.kind==='labor.step')return structuredClone(pending.get(petId)!.world);
      if(c.kind==='body.sleep'||c.kind==='body.wake')return {id:c.actionId,actionId:c.actionId,index:0,surface:'desktop',status:'queued',source:'silicon-rest',restKind:c.kind==='body.sleep'?'sleep':'wake',expires:Date.now()+30000,steps:[{action:'rest'}]};
      if(c.kind==='token.pickup'){const item=pending.get(petId)!;return {id:c.actionId,actionId:c.actionId,coinId:item.coin!.id,index:item.stage,surface:'desktop',status:'queued',source:'tokens',expires:Date.now()+30000,steps:[{action:'walk'},{action:'pickup'}],coin:item.coin,locomotion:'walk'};}
      if(c.kind!=='service.eat-rice' && !c.kind.startsWith('care.'))return undefined;
      const care=c.kind.slice(5),itemId=c.kind==='service.eat-rice'?c.parameters.itemId:care==='feed'?'parent':care;
      return {id:c.actionId,actionId:c.actionId,itemId,index:0,surface:'desktop',status:'queued',source:'silicon-eat',expires:Date.now()+30000,steps:[{action:c.kind==='service.eat-rice'||care==='feed'?'eat':care==='water'?'drink':care}]};
    },
    async receipt(value:any) {
      const item=pending.get(value?.petId), c=item?.command;
      if(c?.kind==='body.sleep'||c?.kind==='body.wake') {
        if(value.id!==c.actionId || value.actionId!==c.actionId || value.restKind!==(c.kind==='body.sleep'?'sleep':'wake') || value.index!==0 || value.surface!=='desktop' || !['playing','completed','interrupted'].includes(value.status))throw Error('睡眠回执不匹配');
        if(value.status==='playing')return {ok:true};
        clearTimeout(item!.timer);pending.delete(c.petId);bridge.accept({petId:c.petId,actionId:c.actionId,kind:c.kind,status:value.status,played:value.played===true},sourceCapability);return {ok:true};
      }
      if(c?.kind==='token.pickup') {
        const coin=item!.coin!;if(value.id!==c.actionId || value.actionId!==c.actionId || value.coinId!==coin.id || value.index!==item!.stage || value.surface!=='desktop' || !['playing','completed','interrupted'].includes(value.status))throw Error('拾取回执不匹配');
        if(value.status==='playing')return {ok:true};
        if(value.status==='completed' && (value.played!==true || !Number.isFinite(value.x) || !Number.isFinite(value.y) || Math.hypot(value.x-coin.x,value.y-coin.y)>.045))throw Error('尚未走到碎片旁');
        if(value.status==='completed' && item!.stage===0){item!.stage=1;return {ok:true};}
        clearTimeout(item!.timer);pending.delete(c.petId);bridge.accept({petId:c.petId,actionId:c.actionId,kind:c.kind,status:value.status,played:value.played===true,coinId:coin.id,surface:'desktop',x:value.x,y:value.y},sourceCapability);return {ok:true};
      }
      if(c?.kind==='service.eat-rice'||c?.kind.startsWith('care.')) {
        if(value.id!==c.actionId || value.actionId!==c.actionId || value.itemId!==(c.kind==='service.eat-rice'?c.parameters.itemId:c.kind==='care.feed'?'parent':c.kind.slice(5)) || value.index!==0 || value.surface!=='desktop' || !['playing','completed','interrupted'].includes(value.status))throw Error('照料回执没有对应行动');
        if(value.status==='playing')return {ok:true};
        if(value.status==='completed' && value.played!==true)throw Error('照料动画未完成');
        clearTimeout(item!.timer);pending.delete(c.petId);
        const reasons=['睡眠、恢复、学习或爸爸正在互动','爸爸的互动或新动作打断了这次尝试','动作被其他互动打断','动作素材播放超时','照料动画素材不可用'];
        const reason=typeof value.reason==='string'&&reasons.includes(value.reason)?value.reason:undefined;
        bridge.accept({petId:c.petId,actionId:c.actionId,kind:c.kind,status:value.status,played:value.played===true,itemId:value.itemId,...(reason?{reason}:{})},sourceCapability);
        return {ok:true};
      }
      if(!c || c.kind!=='labor.step'||value.id!==c.parameters.commandId || value.surface!==item?.world?.surface || !Number.isSafeInteger(value.index) || !['playing','completed','interrupted'].includes(value.status))throw Error('桌宠回执没有对应行动');
      const state=await store.loadEnvelope(c.petId), world=(state?.legacy as Record<string,any>|undefined)?.world?.command;
      if(!world || world.id!==value.id || world.index!==value.index)throw Error('桌宠回执版本已变化');
      if(value.status==='playing'){item!.startedAt ??= Date.now();return {ok:true};}
      const effortSeconds=item!.startedAt===undefined?0:Math.max(0,Math.min(30,(Date.now()-item!.startedAt)/1000));
      clearTimeout(item!.timer);pending.delete(c.petId);
      bridge.accept({petId:c.petId,actionId:c.actionId,kind:'labor.step',status:value.status==='completed'?'completed':'interrupted',
        played:value.played===true,commandId:value.id,index:value.index,surface:value.surface,x:value.x,...(effortSeconds===undefined?{}:{effortSeconds,intensity:item!.intensity})},sourceCapability);
      return {ok:true};
    },
    cancelPet(petId:string){const item=pending.get(petId);if(!item)return;clearTimeout(item.timer);pending.delete(petId);if(item.command.kind==='token.pickup'){bridge.accept({petId,actionId:item.command.actionId,kind:'token.pickup',status:'interrupted'},sourceCapability);}else if(item.command.kind==='labor.step'){try{bridge.accept({petId,actionId:item.command.actionId,kind:'labor.step',status:'interrupted',effortSeconds:item.startedAt===undefined?0:Math.max(0,Math.min(30,(Date.now()-item.startedAt)/1000)),intensity:item.intensity},sourceCapability);}catch{bridge.interruptPet(petId,sourceCapability);}}else bridge.interruptPet(petId,sourceCapability);},
    cancelToken(petId:string){if(pending.get(petId)?.command.kind==='token.pickup')this.cancelPet(petId);},
    close(){for(const item of pending.values())clearTimeout(item.timer);pending.clear();}
  };
}
