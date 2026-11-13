import type { CanonicalHumanityAdapter } from './humanity-adapter.js';

/** Emitted only by a verified helper transport, never accepted from HTTP or a model. */
export interface HelperRestraintEvent {
  epoch: string;
  eventId: string;
  sequence: number;
  petId: string;
  kind: 'ready' | 'grip' | 'release';
  /** Ready is actionable only when it explicitly reports this boolean. */
  restrained: boolean;
  observedAt: number;
}
const token = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9-]{8,48}$/.test(s);
const equal = (a: HelperRestraintEvent,b: HelperRestraintEvent) =>
  a.epoch===b.epoch && a.eventId===b.eventId && a.sequence===b.sequence && a.petId===b.petId &&
  a.kind===b.kind && a.restrained===b.restrained && a.observedAt===b.observedAt;

/**
 * Bind one instance to one authenticated helper process, one pet, and one
 * fresh host-issued epoch. The private source capability must be held only by
 * the host's verified child-process channel handler. Neither renderer input,
 * an HTTP route, nor unverified legacy IPC may call this method directly.
 * The transport must deliver an explicit initial ready snapshot, then ordered
 * grip/release events; sequence gaps fail closed. Recreate on helper restart.
 */
export class HelperObserver {
  readonly #source: object;
  readonly #authority: object;
  private sequence=0;
  private ready=false;
  private closed=false;
  private readonly received=new Map<string,HelperRestraintEvent>();
  private chain: Promise<void>=Promise.resolve();
  constructor(private readonly humanity: CanonicalHumanityAdapter, private readonly petId: string,
    private readonly epoch: string, sourceCapability: object, observerAuthority: object) {
    if (!petId || !token(epoch) || !sourceCapability || !observerAuthority || sourceCapability===observerAuthority)
      throw new Error('可信桌宠观察通道无效');
    this.#source=sourceCapability; this.#authority=observerAuthority;
  }
  observe(event: HelperRestraintEvent, sourceCapability: object): Promise<void> {
    if (sourceCapability!==this.#source) return Promise.reject(new Error('桌宠观察来源不可信'));
    const snapshot=structuredClone(event);
    const operation=this.chain.then(async () => {
      if (this.closed || !snapshot || snapshot.epoch!==this.epoch || snapshot.petId!==this.petId ||
          !token(snapshot.eventId) || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence<1 ||
          !Number.isFinite(snapshot.observedAt) || snapshot.observedAt<=0 || typeof snapshot.restrained!=='boolean' ||
          !['ready','grip','release'].includes(snapshot.kind) ||
          (snapshot.kind==='grip' && !snapshot.restrained) || (snapshot.kind==='release' && snapshot.restrained))
        throw new Error('桌宠观察事件无效');
      const previous=this.received.get(snapshot.eventId);
      if (previous) { if (!equal(previous,snapshot)) throw new Error('桌宠观察标识冲突'); return; }
      if (snapshot.sequence!==this.sequence+1 || (!this.ready && snapshot.kind!=='ready') || (this.ready && snapshot.kind==='ready'))
        throw new Error('桌宠观察事件缺失或顺序错误');
      // The identifier is stable across delivery retries and accepted by the
      // humanity adapter; the adapter commits before this promise resolves.
      const requestId=`helper:${this.epoch}:${snapshot.eventId}`;
      await this.humanity.observeRestraint(this.petId,{requestId,helperReady:true,
        restrained:snapshot.restrained,observedAt:snapshot.observedAt},this.#authority);
      this.received.set(snapshot.eventId,snapshot); this.sequence=snapshot.sequence; this.ready=true;
    });
    this.chain=operation.catch(()=>{});
    return operation;
  }
  close(sourceCapability: object): void {
    if (sourceCapability!==this.#source) throw new Error('桌宠观察来源不可信');
    this.closed=true;
  }
}
