import {advanceSpirit,setSpiritRest} from '../kernel/spirit.js';
import { rebuildRelationships } from '../kernel/index.js';
import { advanceHumanity, describeHumanity, actHumanity, reactHumanity, adjustHumanity, humanityPrompt } from '../../vendor/dsh-pet/src/host/humanity.mjs';
import type { CanonicalEnvelope } from '../storage/postgres.js';
import type { PetGate, UnitOfWork } from '../storage/uow.js';

interface Reader { loadEnvelope(petId: string): Promise<CanonicalEnvelope | null> }
type HumanState = Record<string, any>;
const clamp = (n: number) => Math.max(0, Math.min(100, n));
const identifier = (value: string) => typeof value === 'string' && /^[a-zA-Z0-9:-]{8,140}$/.test(value);
const humanRestChanged=(before:HumanState,after:HumanState)=>before.restingUntil!==after.restingUntil;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** All mutation and receipts are committed to one envelope before this API resolves.
 * Callers must await success before rendering, replying or performing any effect.
 * The host must inject this asynchronous interface into migrated routes; it is not
 * compatible with legacy synchronous stores. */
export class CanonicalHumanityAdapter {
  readonly #executorAuthority: object;
  readonly #observerAuthority: object;
  constructor(private readonly reader: Reader, private readonly uow: UnitOfWork, private readonly gate: PetGate,
    executorAuthority: object, observerAuthority: object, private readonly clock: () => number = Date.now) {
    if (!executorAuthority || !observerAuthority || executorAuthority === observerAuthority) throw new Error('缺少可信执行器或观察者凭据');
    this.#executorAuthority = executorAuthority; this.#observerAuthority = observerAuthority;
  }
  private now(): number { const t = this.clock(); if (!Number.isFinite(t)) throw new Error('时间无效'); return t; }
  private async apply<T>(petId: string, edit: (human: HumanState, now: number, draft: CanonicalEnvelope) => { state: HumanState; result: T }): Promise<T> {
    return this.gate.run(petId, async () => {
      const current = await this.reader.loadEnvelope(petId);
      if (!current || current.petId !== petId || !current.humanity?.stats || !current.humanity?.emotions) throw new Error('生命身体状态不存在或无效');
      if (this.gate.signal.aborted) throw new Error('写入租约已失去');
      const now = this.now(); let result!: T;
      await this.uow.apply(petId, current.version, draft => {
        const edited = edit(structuredClone(draft.humanity), now, draft);
        if (!edited.state || !edited.state.stats || !edited.state.emotions) throw new Error('身体状态无效');
        const spirit=advanceSpirit(draft.life,now);
        if(edited.state.sleeping===true && spirit.mode==='awake')setSpiritRest(draft.life,'sleep',now);
        else if(edited.state.sleeping!==true && edited.state.restingUntil>now && (humanRestChanged(draft.humanity,edited.state)||spirit.mode==='awake'))setSpiritRest(draft.life,'nap',now);
        else if(edited.state.sleeping!==true && !(edited.state.restingUntil>now) && spirit.mode!=='awake')setSpiritRest(draft.life,'awake',now);
        draft.humanity = edited.state; result = structuredClone(edited.result);
        return {};
      });
      return result;
    });
  }
  async get(petId: string): Promise<HumanState> {
    return this.apply(petId, (human, now) => { const state = advanceHumanity(human, now); return {state, result:state}; });
  }
  async snapshot(petId: string): Promise<HumanState> {
    const envelope=await this.reader.loadEnvelope(petId),human=envelope?.humanity;
    if(!human?.stats||!human?.emotions||!Number.isFinite(human.updatedAt))throw Error('生命身体状态不存在或无效');
    return describeHumanity(structuredClone(human),this.now());
  }
  async prompt(petId: string): Promise<string> { const state = await this.get(petId); return humanityPrompt(state, this.now()); }
  async act(petId: string, action: string, requestId: string): Promise<HumanState> {
    if (!identifier(requestId)) throw new Error('照料操作需要稳定请求标识');
    if (['feed', 'water', 'explore'].includes(action)) throw new Error('该行动必须经真实执行回执');
    return this.apply(petId, (human, now, draft) => {
      const prior = human.canonicalActions?.[requestId];
      if (prior) { if (prior.action !== action || prior.kind !== 'act') throw new Error('照料标识冲突'); return {state:human,result:{...prior.result,state:describeHumanity(human,now),duplicate:true}}; }
      const result = actHumanity(human, action, now);
      if (!result.ok) return {state:human,result};
      const eventId = `care:${requestId}`, stamp = new Date(now).toISOString();
      if (draft.life.events.some(event => event.eventId === eventId)) throw new Error('照料事件冲突');
      draft.life.events.push({eventId,petId,type:'social.care',source:'user',actorId:'dad',occurredAt:stamp,receivedAt:stamp,evidenceLevel:'observed',payload:{action}});
      rebuildRelationships(draft.life);
      const {state: _snapshot, ...recorded} = result;
      const state = result.state; state.canonicalActions = {...human.canonicalActions, [requestId]:{kind:'act',action,result:recorded}};
      return {state,result};
    });
  }
  async react(petId: string, event: string, detail: unknown, requestId: string, observerAuthority: object): Promise<HumanState> {
    if (observerAuthority !== this.#observerAuthority || !identifier(requestId)) throw new Error('观察事件缺少可信来源或标识');
    return this.apply(petId, (human, now, draft) => {
      const prior = human.canonicalActions?.[requestId];
      if (prior) { if (prior.kind !== 'react' || prior.event !== event || !equal(prior.detail, detail)) throw new Error('观察标识冲突'); return {state:human,result:human}; }
      const state = reactHumanity(human, event, now, detail);
      const stamp=new Date(now).toISOString(), actor=event==='collision' && (detail as any)?.origin==='user-throw'?'dad':undefined;
      draft.life.events.push({eventId:'body-observation:'+requestId,petId,type:'body.observed',source:'helper',...(actor?{actorId:actor}:{}),occurredAt:stamp,receivedAt:stamp,evidenceLevel:'observed',payload:{event,detail}});
      state.canonicalActions = {...human.canonicalActions, [requestId]:{kind:'react',event,detail}};
      return {state,result:state};
    });
  }
  /** A helper-authenticated completed parent-feeding animation, not a purchase
   * or an inventory withdrawal. No state change occurs on an interrupted play. */
  async observeParentFeed(petId:string,requestId:string,authority:object):Promise<HumanState> {
    if(authority!==this.#observerAuthority || !identifier(requestId))throw Error('投喂缺少可信观察');
    return this.apply(petId,(human,now,draft)=>{
      const prior=human.canonicalActions?.[requestId];
      if(prior){if(prior.kind!=='parent-feed')throw Error('投喂标识冲突');return {state:human,result:describeHumanity(human,now)};}
      const result=actHumanity(human,'feed',now);if(!result.ok)throw Error(result.message||'当前不能喂饭');
      const stamp=new Date(now).toISOString();draft.life.events.push({eventId:'parent-feed:'+requestId,petId,type:'social.care',source:'helper',actorId:'dad',occurredAt:stamp,receivedAt:stamp,evidenceLevel:'observed',payload:{action:'feed'}});rebuildRelationships(draft.life);
      const state=result.state;state.canonicalActions={...human.canonicalActions,[requestId]:{kind:'parent-feed'}};
      return {state,result:describeHumanity(state,now)};
    });
  }
  async serviceAct(petId: string, action: string, requestId: string, authority: object): Promise<HumanState> {
    if (authority !== this.#executorAuthority || !['feed','explore'].includes(action) || !identifier(requestId)) throw new Error('生活服务回执无效');
    return this.apply(petId, (human, now) => {
      const previous = human.serviceActions?.[requestId];
      if (previous) { if (previous.action !== action) throw new Error('服务回执标识冲突'); return {state:human,result:{...previous,duplicate:true}}; }
      const result = actHumanity(human, action, now);
      if (!result.ok) return {state:human,result:{ok:false,message:result.message,state:result.state}};
      const state = result.state; state.serviceActions = {...human.serviceActions,[requestId]:{ok:true,at:now,action}};
      return {state,result:{ok:true,state}};
    });
  }
  async exertLabor(petId: string, requestId: string, seconds: number, intensity: number, authority: object): Promise<HumanState> {
    if (authority !== this.#executorAuthority || !/^labor-effort:[a-zA-Z0-9:-]{8,140}$/.test(requestId) || !Number.isFinite(seconds) || seconds < 0 || seconds > 30 || !Number.isFinite(intensity) || intensity < 1 || intensity > 1.7) throw new Error('搬运消耗回执无效');
    return this.apply(petId, (human, now) => {
      const previous = human.serviceActions?.[requestId];
      if (previous) { if (previous.action !== 'labor-effort' || previous.seconds !== seconds || previous.intensity !== intensity) throw new Error('搬运回执标识冲突'); return {state:human,result:{...previous,duplicate:true}}; }
      const state = advanceHumanity(human, now), effort = seconds * intensity;
      state.stats.stamina = clamp(state.stats.stamina - effort * .08); state.stats.energy = clamp(state.stats.energy - effort * .045); state.stats.satiety = clamp(state.stats.satiety - effort * .015);
      const result = {ok:true,at:now,action:'labor-effort',seconds,intensity};
      state.serviceActions = {...human.serviceActions,[requestId]:result}; return {state,result};
    });
  }
  async adjust(petId: string, patch: Record<string, number>, requestId: string, expectedRevision: number): Promise<HumanState> {
    if(!identifier(requestId))throw Error('调整需要稳定请求标识');
    return this.apply(petId, (human, now, draft) => { const prior=human.canonicalActions?.[requestId];if(prior){if(prior.kind!=='adjust'||!equal(prior.patch,patch))throw Error('调整标识冲突');return {state:human,result:{ok:true,state:describeHumanity(human,now),duplicate:true}};} const result = adjustHumanity(human, patch, requestId, expectedRevision, now);if(!result.ok)return {state:human,result};const stamp=new Date(now).toISOString();draft.life.events.push({eventId:'body-adjust:'+requestId,petId,type:'body.adjusted',source:'user',actorId:'dad',occurredAt:stamp,receivedAt:stamp,evidenceLevel:'observed',payload:{patch}});result.state.canonicalActions={...human.canonicalActions,[requestId]:{kind:'adjust',patch}};return {state:result.state,result}; });
  }
  async painThought(petId: string, collisionAt: number, interactionAt: number, thought: string, cryingUntil: number): Promise<HumanState | null> {
    if (typeof thought !== 'string' || thought.length > 2000) throw new Error('身体感受无效');
    return this.apply(petId, (human, now) => {
      const state = advanceHumanity(human, now);
      if (state.collision?.at !== collisionAt || state.lastInteraction !== interactionAt || state.cryingUntil !== cryingUntil) return {state:human,result:null};
      state.lastThought = thought; return {state,result:describeHumanity(state, now)};
    });
  }
  /** Only a trusted helper observation can establish or clear a grip. A ready
   * acknowledgement without an explicit released observation is insufficient. */
  async observeRestraint(petId: string, observation: {requestId:string; helperReady:boolean; restrained:boolean; observedAt:number}, authority: object): Promise<HumanState> {
    if (authority !== this.#observerAuthority || !identifier(observation.requestId) || typeof observation.helperReady !== 'boolean' || typeof observation.restrained !== 'boolean' || !Number.isFinite(observation.observedAt) || (!observation.helperReady && !observation.restrained)) throw new Error('缺少可信的身体抓取观测');
    return this.apply(petId, (human, now) => {
      if (observation.observedAt > now || observation.observedAt < (human.restraintObservedAt ?? 0)) throw new Error('抓取观测已过期');
      const previous = human.canonicalActions?.[observation.requestId];
      if (previous) { if (previous.kind !== 'restraint' || !equal(previous.observation,observation)) throw new Error('抓取观测标识冲突'); return {state:human,result:human}; }
      if (observation.observedAt > now || observation.observedAt < (human.restraintObservedAt ?? 0)) throw new Error('抓取观测已过期');
      const state = advanceHumanity(human, now); state.helperReady=observation.helperReady; state.restrained = observation.restrained; state.restraintObservedAt = observation.observedAt;
      state.canonicalActions = {...human.canonicalActions,[observation.requestId]:{kind:'restraint',observation}};
      return {state,result:state};
    });
  }
}
