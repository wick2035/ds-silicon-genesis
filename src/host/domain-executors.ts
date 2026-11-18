import type { ExecutionReceipt, OutboxIntent } from '../storage/uow.js';

export type DesktopActionKind='body.activity'|'service.eat-rice'|'care.feed'|'care.water'|'care.pet'|'care.play'|'care.soothe'|'care.accompany'|'labor.step'|'token.pickup'|'body.sleep'|'body.wake';
type Sender = (command: {actionId:string;petId:string;kind:DesktopActionKind;parameters:Record<string,unknown>}, signal:AbortSignal) => Promise<void>;
export interface DesktopReceipt {
  petId:string; actionId:string; kind:DesktopActionKind; status:'completed'|'failed'|'interrupted';
  played?:boolean; itemId?:string; commandId?:string; index?:number; surface?:string; x?:number; y?:number; coinId?:string;
  effortSeconds?:number; intensity?:number; travelDistance?:number; actionFraction?:number; forcedLabor?:boolean;
  reason?:string; distance?:number; activity?:string;
}
interface Pending { petId:string; kind:DesktopReceipt['kind']; resolve:(receipt:DesktopReceipt)=>void; reject:(error:Error)=>void }
/** A host must bind accept() exclusively to an authenticated helper process IPC
 * channel. Legacy renderer HTTP requests alone are not a trusted channel. */
export class TrustedDesktopBridge {
  readonly #source: object;
  private readonly pending = new Map<string,Pending>();
  constructor(private readonly send: Sender, sourceCapability: object, private readonly timeoutMs = 30000) {
    if (!sourceCapability || typeof sourceCapability !== 'object' || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('桌宠可信通道无效');
    this.#source = sourceCapability;
  }
  accept(receipt: DesktopReceipt, sourceCapability: object): void {
    if (sourceCapability !== this.#source) throw new Error('桌宠回执来源不可信');
    const item = this.pending.get(receipt?.actionId);
    if (!item || item.petId !== receipt.petId || item.kind !== receipt.kind || !['completed','failed','interrupted'].includes(receipt.status)) throw new Error('桌宠回执不匹配');
    if (receipt.status === 'completed' && receipt.played !== true) throw new Error('桌宠动作没有实际播放');
    this.pending.delete(receipt.actionId); item.resolve(structuredClone(receipt));
  }
  /** Interrupts waiting effects immediately, before any pet-gated observation
   * write. A dispatched effect remains unknown until independently reconciled. */
  interruptPet(petId:string, sourceCapability:object): void {
    if(sourceCapability!==this.#source)throw new Error('桌宠观察来源不可信');
    for(const [id,item] of this.pending) if(item.petId===petId){this.pending.delete(id);item.reject(new Error('桌宠状态已变化'));}
  }
  async execute(petId:string, intent:OutboxIntent, signal:AbortSignal): Promise<ExecutionReceipt> {
    if (signal.aborted) return {status:'unknown',evidence:{reason:'写入租约已失去'}};
    if (!['body.activity','service.eat-rice','care.feed','care.water','care.pet','care.play','care.soothe','care.accompany','labor.step','token.pickup','body.sleep','body.wake'].includes(intent.type) || intent.payload.petId !== petId || intent.payload.actionId !== intent.id || !intent.payload.parameters || typeof intent.payload.parameters !== 'object' || Array.isArray(intent.payload.parameters)) throw new Error('桌宠行动无效');
    if (this.pending.has(intent.id)) throw new Error('桌宠行动正在等待回执');
    const kind = intent.type as DesktopReceipt['kind'];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const response = new Promise<DesktopReceipt>((resolve,reject) => {
      this.pending.set(intent.id,{petId,kind,resolve,reject});
      abort = () => { this.pending.delete(intent.id); reject(new Error('桌宠回执中断')); };
      signal.addEventListener('abort',abort,{once:true});
      timer = setTimeout(() => { this.pending.delete(intent.id); reject(new Error('桌宠回执超时')); },this.timeoutMs);
    });
    void response.catch(() => {});
    if (signal.aborted) abort?.();
    try {
      if (signal.aborted) throw new Error('写入租约已失去');
      // Start listening before dispatch, so a fast helper cannot race the waiter.
      await this.send({actionId:intent.id,petId,kind,parameters:structuredClone(intent.payload.parameters as Record<string,unknown>)},signal);
      const result = await response;
      const laborEffort=kind==='labor.step'&&result.effortSeconds!==undefined?{
        effortSeconds:result.effortSeconds,intensity:result.intensity,
        ...(result.travelDistance===undefined?{}:{travelDistance:result.travelDistance}),
        ...(result.actionFraction===undefined?{}:{actionFraction:result.actionFraction,index:result.index,forcedLabor:result.forcedLabor}),
      }:undefined;
      if (result.status !== 'completed') return {status:result.status === 'failed' ? 'failed' : 'cancelled',evidence:{actionId:intent.id,kind,reason:result.reason||result.status,...(laborEffort?{confirmed:true,...laborEffort}:{})}};
      const evidence: Record<string,unknown> = {actionId:intent.id,kind,confirmed:true,played:true};
      if(kind==='body.activity')Object.assign(evidence,{distance:result.distance,surface:result.surface,activity:result.activity});
      else if (kind === 'service.eat-rice'||kind.startsWith('care.')) evidence.itemId = result.itemId;
      else if(kind==='body.sleep'||kind==='body.wake')Object.assign(evidence,{restKind:kind==='body.sleep'?'sleep':'wake'});
      else if(kind==='token.pickup')Object.assign(evidence,{coinId:result.coinId,x:result.x,y:result.y,surface:result.surface});
      else Object.assign(evidence,{commandId:result.commandId,index:result.index,surface:result.surface,x:result.x,...laborEffort});
      return {status:'completed',evidence};
    } catch {
      // Once dispatch was attempted its outcome can be uncertain; never retry blindly.
      return {status:'unknown',evidence:{actionId:intent.id,kind,reason:'桌宠回执不可确认'}};
    } finally {
      if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort',abort);
      this.pending.delete(intent.id);
      // The sender may have failed before response was awaited; consume rejection.
      void response.catch(() => {});
    }
  }
}

/** Concrete executor registry consumed directly by OutboxDispatcher. Purchase is
 * a local simulation whose actual wallet/inventory mutation is the projector's
 * subsequent atomic commit, not an external purchase. */
export function createDomainExecutors(bridge: TrustedDesktopBridge): ReadonlyMap<string,(petId:string,intent:OutboxIntent,signal:AbortSignal)=>Promise<ExecutionReceipt>> {
  return new Map<string,(petId:string,intent:OutboxIntent,signal:AbortSignal)=>Promise<ExecutionReceipt>>([
    ...['self.express','service.sweet'].map(type=>[type,async(petId:string,intent:OutboxIntent,signal:AbortSignal):Promise<ExecutionReceipt>=>({status:signal.aborted?'cancelled':'completed',evidence:{actionId:intent.id,kind:type,confirmed:true}})] as const),
    ['body.activity',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['service.buy-rice',async (petId,intent,signal) => {
      if (signal.aborted || intent.payload.petId !== petId || intent.payload.actionId !== intent.id || intent.type !== 'service.buy-rice') return {status:'unknown',evidence:{reason:'购买意图不可确认'}};
      return {status:'completed',evidence:{actionId:intent.id,kind:'service.buy-rice',confirmed:true}};
    }],
    ['service.eat-rice',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['care.feed',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['care.water',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['care.pet',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['care.play',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['care.soothe',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['care.accompany',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['labor.step',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['token.pickup',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['body.sleep',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
    ['body.wake',(petId,intent,signal) => bridge.execute(petId,intent,signal)],
  ]);
}
