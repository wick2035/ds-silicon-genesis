import {randomUUID} from 'node:crypto';
import {HelperObserver, type HelperRestraintEvent} from './helper-observer.js';
import type {CanonicalHumanityAdapter} from './humanity-adapter.js';
import type {TrustedDesktopBridge} from './domain-executors.js';
import type {createDesktopCommandChannel} from './desktop-command-channel.js';

/** This object is supplied only to the generated helper process adapter, not
 * to HTTP handlers. Observations travel on the spawned child's stdout bridge. */
export function createHelperChannel(humanity:CanonicalHumanityAdapter, desktop:TrustedDesktopBridge,
  petIds:readonly string[], observerAuthority:object, sourceCapability:object,
  commands:ReturnType<typeof createDesktopCommandChannel>, observeSpace?:(petId:string,requestId:string,detail:unknown)=>Promise<unknown>, tokens?:(petId:string,requestId:string,detail:unknown)=>Promise<unknown>, disturb?:(petId:string,requestId:string,detail:unknown)=>Promise<unknown>, semantic?:(petId:string,requestId:string,detail:unknown)=>Promise<unknown>) {
  const allowed=new Set(petIds), observers=new Map<string,HelperObserver>();
  const epochs=new Map<string,string>();
  let epoch='', pending=Promise.resolve();
  const disconnected=(old:string) => {
    for(const id of allowed) commands.cancelPet(id);
    for(const observer of observers.values())observer.close(sourceCapability);
    observers.clear();
    epochs.clear();
    // A disconnected process cannot certify that the body is free to move.
    pending=pending.catch(()=>{}).then(async()=>{
      for(const petId of allowed) await humanity.observeRestraint(petId,{requestId:`helper:${old}:${randomUUID()}`,
        helperReady:false,restrained:true,observedAt:Date.now()},observerAuthority);
    });
    return pending;
  };
  return {
    opened(next:string) {
      if(!/^[a-f0-9]{32}$/.test(next))throw Error('桌宠通道标识无效');
      if(epoch)void disconnected(epoch).catch(()=>{});
      epoch=next;
    },
    closed(old:string) {
      if(old!==epoch)return;
      epoch='';void disconnected(old).catch(()=>{});
    },
    async receipt(sourceEpoch:string, value:Record<string,unknown>) {
      if(sourceEpoch!==epoch || value?.processEpoch!==epoch || typeof value.petId!=='string' || !allowed.has(value.petId))throw Error('桌宠回执通道不匹配');
      return commands.receipt(value);
    },
    /** Only the authenticated helper child transport may call this. HTTP and
     * model output are never accepted as observations. */
    async interaction(sourceEpoch:string, event:{epoch:string;petId:string;eventId:string;kind:'semantic'|'labor-disturb'|'tokens'|'space'|'pet'|'feed'|'collision'|'impact'|'knock'|'utensil'|'sleep'|'wake';detail?:unknown}) {
      if(sourceEpoch!==epoch || !event || !allowed.has(event.petId) || epochs.get(event.petId)!==event.epoch || !/^[a-zA-Z0-9-]{8,48}$/.test(event.eventId))throw Error('互动观察来源不可信');
      if(['collision','impact','knock','utensil','sleep'].includes(event.kind))commands.cancelPet(event.petId);
      const id=`helper:${event.epoch}:${event.eventId}`;
      if(event.kind==='semantic'){if(!semantic)throw Error('互动回应未接入');return semantic(event.petId,id,event.detail);}
      if(event.kind==='labor-disturb'){commands.cancelPet(event.petId);if(!disturb)throw Error('搬砖互动未接入');return {ok:true,labor:await disturb(event.petId,id,event.detail)};}
      if(event.kind==='tokens'){if(!tokens)throw Error('饭钱互动未接入');return tokens(event.petId,id,event.detail);}
      if(event.kind==='space'){if(!observeSpace)throw Error('活动空间观察未接入');return {ok:true,space:await observeSpace(event.petId,id,event.detail)};}
      if(event.kind==='feed'){if((event.detail as any)?.played!==true)throw Error('投喂动作没有完成');return {ok:true,state:await humanity.observeParentFeed(event.petId,id,observerAuthority)};}
      if(event.kind==='pet'){await humanity.act(event.petId,'pet',id);return {ok:true,state:await humanity.snapshot(event.petId)};}
      if(!['collision','impact','knock','utensil','sleep','wake'].includes(event.kind))throw Error('互动类型无效');
      if(event.kind==='collision') {const d=event.detail as any;if(!d||!['left','right','ceiling','floor'].includes(d.edge)||!Number.isFinite(d.speed)||d.speed<550||d.speed>10000)throw Error('碰撞观察无效');}
      if(event.kind==='impact' && (typeof event.detail!=='number'||!Number.isFinite(event.detail)||event.detail<0||event.detail>2))throw Error('晃动观察无效');
      if(event.kind==='knock') {const d=event.detail as any;if(!d||!Number.isInteger(d.count)||d.count<3||d.count>8)throw Error('敲击观察无效');}
      if(event.kind==='utensil') {const d=event.detail as any;if(!d||!['basin','bowl'].includes(d.kind)||!Number.isFinite(d.speed)||d.speed<1||d.speed>2500||!['user-drag','user-throw','unknown'].includes(d.origin))throw Error('物体碰撞观察无效');}
      await humanity.react(event.petId,event.kind,event.detail,id,observerAuthority);
      return {ok:true,state:await humanity.snapshot(event.petId)};
    },
    async observe(sourceEpoch:string,event:HelperRestraintEvent | {epoch:string;petId:string;kind:'closed';eventId:string;observedAt:number}) {
      if(sourceEpoch!==epoch || !event || !allowed.has(event.petId))throw Error('桌宠通道不匹配');
      if(event.kind==='closed') {
        if(epochs.get(event.petId)!==event.epoch) return;
        commands.cancelPet(event.petId);observers.get(event.petId)?.close(sourceCapability);observers.delete(event.petId);epochs.delete(event.petId);
        await humanity.observeRestraint(event.petId,{requestId:`helper:${event.epoch}:${event.eventId}`,helperReady:false,restrained:true,observedAt:event.observedAt},observerAuthority);
        return;
      }
      // Wake a dispatcher holding the per-pet gate before attempting to persist.
      if(event.kind==='grip')commands.cancelPet(event.petId);
      await pending;
      if(sourceEpoch!==epoch)throw Error('桌宠通道已结束');
      let observer=observers.get(event.petId);
      if(event.kind==='ready' && event.sequence===1){observer?.close(sourceCapability);observer=new HelperObserver(humanity,event.petId,event.epoch,sourceCapability,observerAuthority);observers.set(event.petId,observer);epochs.set(event.petId,event.epoch);}
      if(epochs.get(event.petId)!==event.epoch)throw Error('桌宠窗口观察代次不匹配');
      if(!observer)throw Error('桌宠尚未建立观察通道');
      await observer.observe(event,sourceCapability);
    }
  };
}
