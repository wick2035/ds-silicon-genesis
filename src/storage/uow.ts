import {advanceSpirit} from '../kernel/spirit.js';
import type { CanonicalEnvelope, Queryable } from './postgres.js';
import type { ActionReceipt } from '../kernel/types.js';

export interface Client extends Queryable { release(): void }
export interface Pool { connect(): Promise<Client> }
export interface OutboxIntent { id: string; type: string; payload: Record<string, unknown> }
export interface ExecutionReceipt { status: 'completed'|'failed'|'cancelled'|'unknown'; evidence: Record<string, unknown> }

/** Domain functions supplied here must be pure: real effects belong to dispatch. */
export class UnitOfWork {
  private readonly listeners=new Set<(draft:CanonicalEnvelope)=>void>();
  constructor(private readonly pool: Pool, private readonly gate: PetGate) {}
  onCommit(listener:(draft:CanonicalEnvelope)=>void):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}

  async apply(petId: string, expectedVersion: number,
    change: (draft: CanonicalEnvelope) => { intents?: OutboxIntent[] }): Promise<CanonicalEnvelope> {
    return this.gate.run(petId, () => this.applyOwned(petId, expectedVersion, change));
  }

  private async applyOwned(petId: string, expectedVersion: number,
    change: (draft: CanonicalEnvelope) => { intents?: OutboxIntent[] }): Promise<CanonicalEnvelope> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT version::text,payload FROM silicon_genesis.life_state WHERE pet_id=$1 FOR UPDATE', [petId]);
      if (result.rows.length !== 1 || Number(result.rows[0].version) !== expectedVersion) throw new Error('生命状态已变化');
      const draft = structuredClone(result.rows[0].payload) as CanonicalEnvelope;
      if (draft.petId !== petId || draft.version !== expectedVersion) throw new Error('生命状态信封不一致');
      advanceSpirit(draft.life);
      const {intents = []} = change(draft);
      if (draft.petId !== petId || draft.version !== expectedVersion) throw new Error('领域操作不得修改身份或版本');
      if (Object.hasOwn(draft.life, 'body') || Object.hasOwn(draft.life, 'emotions')) throw new Error('身体状态只能由身体域保存');
      draft.version++;
      await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1', [petId,draft.version,JSON.stringify(draft)]);
      for (const intent of intents) {
        if (!intent.id || !intent.type || !intent.payload || typeof intent.payload !== 'object') throw new Error('行动意图无效');
        // A conflicting ID aborts the entire transaction, never silently drops an effect.
        await client.query(`INSERT INTO silicon_genesis.outbox(action_id,pet_id,action_type,payload,state)
          VALUES($1,$2,$3,$4::jsonb,'pending')`, [intent.id,petId,intent.type,JSON.stringify(intent.payload)]);
      }
      await client.query('COMMIT');
      for(const listener of this.listeners)try{listener(structuredClone(draft));}catch{/* visual observers cannot undo a committed transaction */}
      return draft;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

/** The host must use the same per-pet gate for every mutation and hold an
 * exclusive process/database ownership lease before starting any dispatcher. */
export interface PetGate { readonly signal: AbortSignal; run<T>(petId: string, operation: () => Promise<T>): Promise<T> }
export interface ActionLifecycle {
  /** Pure validation against the latest canonical state; may mark dispatched. */
  prepare(draft: CanonicalEnvelope, intent: OutboxIntent): {allowed: boolean; reason?: string};
  /** Pure projection of a trusted executor receipt into the same envelope. */
  complete(draft: CanonicalEnvelope, intent: OutboxIntent, receipt: ExecutionReceipt): void;
  reconcile(draft: CanonicalEnvelope, intent: OutboxIntent, receipt: ActionReceipt): void;
}

/** A dispatched operation is never automatically replayed after a crash. */
export class OutboxDispatcher {
  hasExecutor(actionType:string):boolean { return this.executors.has(actionType); }
  async cancelUnavailable(petId:string,actionId:string):Promise<void> {
    await this.gate.run(petId,async()=>{const client=await this.pool.connect();try{
      await client.query('BEGIN');const s=await client.query('SELECT version::text,payload FROM silicon_genesis.life_state WHERE pet_id=$1 FOR UPDATE',[petId]);
      const rows=await client.query('SELECT action_id,action_type,payload,state FROM silicon_genesis.outbox WHERE action_id=$1 AND pet_id=$2 FOR UPDATE',[actionId,petId]);const row=rows.rows[0];
      if(!row||row.state!=='pending'||this.executors.has(row.action_type)||s.rows.length!==1)throw Error('待执行状态已变化');
      const draft=structuredClone(s.rows[0].payload) as CanonicalEnvelope;if(draft.petId!==petId||draft.version!==Number(s.rows[0].version))throw Error('生命状态不一致');
      const intent={id:row.action_id,type:row.action_type,payload:row.payload},receipt:ExecutionReceipt={status:'cancelled',evidence:{reason:'行动执行器不可用'}};
      this.lifecycle.complete(draft,intent,receipt);draft.version++;
      await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1',[petId,draft.version,JSON.stringify(draft)]);
      await client.query("UPDATE silicon_genesis.outbox SET state='cancelled',receipt=$2::jsonb,updated_at=now() WHERE action_id=$1",[actionId,JSON.stringify(receipt)]);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}});
  }
  private readonly active = new Map<string,{controller:AbortController;policy:string}>();
  private readonly listeners=new Set<(draft:CanonicalEnvelope)=>void>();
  onCommit(listener:(draft:CanonicalEnvelope)=>void):()=>void {this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  constructor(private readonly pool: Pool,
    private readonly executors: ReadonlyMap<string, (petId: string, intent: OutboxIntent, signal: AbortSignal) => Promise<ExecutionReceipt>>,
    private readonly gate: PetGate, private readonly lifecycle: ActionLifecycle,
    private readonly reconcilers: ReadonlyMap<string, (petId: string, intent: OutboxIntent, signal: AbortSignal) => Promise<ActionReceipt | null>>) {}

  /** Called after an authenticated pause/revocation request has been checked,
   * before it waits on the per-pet gate. Only interruptible work is aborted;
   * safe-point and noninterruptible work complete or time out normally. */
  interrupt(petId:string):void {
    const running=this.active.get(petId);
    if(running?.policy==='interruptible')running.controller.abort(new Error('用户暂停或撤销了权限'));
  }

  /** Only registered trusted adapters may query external receipts; callers
   * cannot supply a claimed result. Null leaves the action UNKNOWN. */
  async reconcile(actionId: string): Promise<boolean> {
    const read = await this.pool.connect();
    let row: any;
    try { row = (await read.query('SELECT action_id,pet_id,action_type,payload,state FROM silicon_genesis.outbox WHERE action_id=$1', [actionId])).rows[0]; }
    finally { read.release(); }
    if (!row || row.state !== 'unknown') throw new Error('行动不处于待对账状态');
    const petId = String(row.pet_id);
    return this.gate.run(petId, async () => {
      const resolver = this.reconcilers.get(row.action_type);
      if (!resolver) throw new Error('没有可信的行动对账器');
      const intent = {id:row.action_id,type:row.action_type,payload:row.payload};
      const receipt = await resolver(petId,intent,this.gate.signal);
      if (this.gate.signal.aborted) throw new Error('写入租约已失去');
      if (!receipt) return false;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const state = await client.query('SELECT version::text,payload FROM silicon_genesis.life_state WHERE pet_id=$1 FOR UPDATE', [petId]);
        const current = await client.query('SELECT state FROM silicon_genesis.outbox WHERE action_id=$1 AND pet_id=$2 FOR UPDATE', [actionId,petId]);
        if (state.rows.length !== 1 || current.rows[0]?.state !== 'unknown') throw new Error('行动状态已变化');
        const draft = structuredClone(state.rows[0].payload) as CanonicalEnvelope;
        if (draft.petId !== petId || draft.version !== Number(state.rows[0].version)) throw new Error('生命状态信封不一致');
        this.lifecycle.reconcile(draft,intent,receipt);
        draft.version++;
        await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1', [petId,draft.version,JSON.stringify(draft)]);
        await client.query('UPDATE silicon_genesis.outbox SET state=$2,receipt=$3::jsonb,updated_at=now() WHERE action_id=$1', [actionId,receipt.status.toLowerCase(),JSON.stringify(receipt)]);
        await client.query('COMMIT');
        return true;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }

  /** Call only after obtaining the exclusive application lease and proving no
   * previous dispatcher is alive. UNKNOWN requires executor-specific inquiry. */
  async recoverInterrupted(): Promise<number> {
    const read = await this.pool.connect();
    let rows: Array<{action_id:string;pet_id:string}>;
    try { rows = (await read.query("SELECT action_id,pet_id FROM silicon_genesis.outbox WHERE state='dispatched' ORDER BY created_at")).rows; }
    finally { read.release(); }
    let count = 0;
    for (const row of rows) await this.gate.run(row.pet_id, async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const state = await client.query('SELECT version::text,payload FROM silicon_genesis.life_state WHERE pet_id=$1 FOR UPDATE', [row.pet_id]);
        const action = await client.query('SELECT action_id,action_type,payload,state FROM silicon_genesis.outbox WHERE action_id=$1 AND pet_id=$2 FOR UPDATE', [row.action_id,row.pet_id]);
        if (!action.rows.length || action.rows[0].state !== 'dispatched') { await client.query('ROLLBACK'); return; }
        if (state.rows.length !== 1) throw new Error('生命状态不存在');
        const draft = structuredClone(state.rows[0].payload) as CanonicalEnvelope;
        if (draft.petId !== row.pet_id || draft.version !== Number(state.rows[0].version)) throw new Error('生命状态信封不一致');
        const intent = {id:action.rows[0].action_id,type:action.rows[0].action_type,payload:action.rows[0].payload};
        const receipt: ExecutionReceipt = {status:'unknown',evidence:{reason:'进程退出时执行结果未确认，须先对账'}};
        this.lifecycle.complete(draft,intent,receipt);
        draft.version++;
        await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1', [row.pet_id,draft.version,JSON.stringify(draft)]);
        await client.query("UPDATE silicon_genesis.outbox SET state='unknown',receipt=$2::jsonb,updated_at=now() WHERE action_id=$1", [row.action_id,JSON.stringify(receipt)]);
        await client.query('COMMIT'); count++;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
    return count;
  }

  async dispatch(actionId: string): Promise<ExecutionReceipt> {
    const lookup = await this.pool.connect();
    let petId: string;
    try {
      const result = await lookup.query('SELECT pet_id FROM silicon_genesis.outbox WHERE action_id=$1', [actionId]);
      if (result.rows.length !== 1) throw new Error('行动不存在');
      petId = result.rows[0].pet_id;
    } finally { lookup.release(); }
    return this.gate.run(petId, () => this.dispatchOwned(petId, actionId));
  }

  private async dispatchOwned(petId: string, actionId: string): Promise<ExecutionReceipt> {
    const client = await this.pool.connect();
    let intent: OutboxIntent, policy='noninterruptible';
    try {
      await client.query('BEGIN');
      const state = await client.query('SELECT version::text,payload FROM silicon_genesis.life_state WHERE pet_id=$1 FOR UPDATE', [petId]);
      const result = await client.query('SELECT action_id,pet_id,action_type,payload,state FROM silicon_genesis.outbox WHERE action_id=$1 FOR UPDATE', [actionId]);
      const row = result.rows[0];
      if (!row || row.pet_id !== petId || row.state !== 'pending' || state.rows.length !== 1) throw new Error('行动不处于待执行状态');
      if (!this.executors.has(row.action_type)) throw new Error('没有已注册的行动执行器');
      intent = {id:row.action_id,type:row.action_type,payload:row.payload};
      const draft = structuredClone(state.rows[0].payload) as CanonicalEnvelope;
      if (draft.petId !== petId || draft.version !== Number(state.rows[0].version)) throw new Error('生命状态信封不一致');
      const decision = this.lifecycle.prepare(draft, intent);
      policy=draft.life.actions.find(action=>action.id===actionId)?.interruptPolicy ?? 'noninterruptible';
      if (!decision.allowed) {
        const receipt: ExecutionReceipt = {status:'cancelled',evidence:{reason:decision.reason || '当前状态不允许执行'}};
        this.lifecycle.complete(draft, intent, receipt);
        draft.version++;
        await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1', [petId,draft.version,JSON.stringify(draft)]);
        await client.query("UPDATE silicon_genesis.outbox SET state='cancelled',receipt=$2::jsonb,updated_at=now() WHERE action_id=$1", [actionId,JSON.stringify(receipt)]);
        await client.query('COMMIT');
        return receipt;
      }
      draft.version++;
      await client.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1', [petId,draft.version,JSON.stringify(draft)]);
      await client.query("UPDATE silicon_genesis.outbox SET state='dispatched',updated_at=now() WHERE action_id=$1", [actionId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    let receipt: ExecutionReceipt;
    const controller=new AbortController();
    const cancel=()=>controller.abort(this.gate.signal.reason);
    this.gate.signal.addEventListener('abort',cancel,{once:true});
    this.active.set(petId,{controller,policy});
    try {
      if (this.gate.signal.aborted) throw new Error('写入租约不可用');
      receipt = await this.executors.get(intent.type)!(petId, intent, controller.signal);
      if (this.gate.signal.aborted) throw new Error('写入租约已失去');
      if (!receipt || !['completed','failed','cancelled','unknown'].includes(receipt.status) || !receipt.evidence || typeof receipt.evidence !== 'object') throw new Error('执行回执无效');
    } catch {
      receipt = {status:'unknown', evidence:{reason:'执行结果无法确认，须先对账'}};
    } finally {this.gate.signal.removeEventListener('abort',cancel);this.active.delete(petId);}
    // Once the ownership lease is lost, do not perform any more writes from
    // this process; the next owner will reconcile the durable dispatched row.
    if (this.gate.signal.aborted) throw new Error('写入租约已失去，行动结果须由新实例对账');
    const done = await this.pool.connect();
    try {
      await done.query('BEGIN');
      const state = await done.query('SELECT version::text,payload FROM silicon_genesis.life_state WHERE pet_id=$1 FOR UPDATE', [petId]);
      if (state.rows.length !== 1) throw new Error('生命状态不存在');
      const draft = structuredClone(state.rows[0].payload) as CanonicalEnvelope;
      if (draft.petId !== petId || draft.version !== Number(state.rows[0].version)) throw new Error('生命状态信封不一致');
      this.lifecycle.complete(draft, intent, receipt);
      draft.version++;
      await done.query('UPDATE silicon_genesis.life_state SET version=$2,payload=$3::jsonb,updated_at=now() WHERE pet_id=$1', [petId,draft.version,JSON.stringify(draft)]);
      const result = await done.query(`UPDATE silicon_genesis.outbox SET state=$2,receipt=$3::jsonb,updated_at=now()
        WHERE action_id=$1 AND state='dispatched' RETURNING action_id`, [actionId,receipt.status,JSON.stringify(receipt)]);
      if (result.rowCount !== 1) throw new Error('行动回执冲突，须对账');
      await done.query('COMMIT');
      for(const listener of this.listeners)try{listener(structuredClone(draft));}catch{/* committed state remains authoritative */}
      return receipt;
    } catch (error) { await done.query('ROLLBACK'); throw error; }
    finally { done.release(); }
  }
}
