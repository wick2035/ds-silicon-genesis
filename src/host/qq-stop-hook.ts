import type {LegacyQQStopHook} from './qq-takeover.js';

/** Host-owned inventory of the exact old plugin instance(s). This contract is
 * deliberately not implemented by a PID, status-file or TCP-port heuristic. */
export interface LegacyQQInventory {
  inspect():Promise<{complete:boolean;bridges:LegacyQQBridgeHandle[]}>;
}
export interface LegacyQQBridgeHandle {
  readonly appId:string;
  readonly petId:string;
  readonly stopped:boolean;
  readonly socket?:{readonly readyState:number;addEventListener(type:'close',listener:()=>void,options?:{once:boolean}):void}|null;
  readonly queue?:Promise<unknown>;
  readonly proactiveQueue?:Promise<unknown>;
  stop():void;
}
/** Must be constructed in the old host from a verified registry, with handles
 * to the actual bridge objects. The caller must attest a complete inventory of
 * all hosts for this account; it must not infer absence from stale status files. */
export function createLegacyQQStopHook(inventory:LegacyQQInventory,identity:{appId:string;petId:string},signal:AbortSignal):LegacyQQStopHook {
  if(!identity.appId || !identity.petId)throw Error('QQ 接管身份无效');
  return {async stopAndVerify(){
    if(signal.aborted)return 'unknown';
    const first=await inventory.inspect();
    if(!first.complete)return 'unknown';
    const targets=first.bridges.filter(b=>b.appId===identity.appId && b.petId===identity.petId);
    if(targets.length!==first.bridges.length)return 'unknown';
    if(!targets.length)return 'absent';
    for(const bridge of targets) {
      const socket=bridge.socket;
      let closed:Promise<void>=Promise.resolve();
      if(socket && socket.readyState!==3) closed=new Promise(resolve=>socket.addEventListener('close',resolve,{once:true}));
      bridge.stop();
      let timer:ReturnType<typeof setTimeout>|undefined; let abort:(()=>void)|undefined;
      try {
        await Promise.race([
          Promise.all([closed,bridge.queue?.catch(()=>{}),bridge.proactiveQueue?.catch(()=>{})]),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('QQ 关闭确认超时')),10000);timer.unref?.();abort=()=>reject(Error('QQ 接管中断'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})
        ]);
      } catch {return 'unknown';} finally {if(timer)clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);}
      if(!bridge.stopped || (socket && socket.readyState!==3))return 'unknown';
    }
    const after=await inventory.inspect();
    if(signal.aborted || !after.complete || after.bridges.some(b=>b.appId!==identity.appId || b.petId!==identity.petId || !b.stopped || (b.socket && b.socket.readyState!==3)))return 'unknown';
    return 'stopped';
  }};
}
