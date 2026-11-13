import type { PetGate, Pool, Client } from '../storage/uow.js';
import type { Queryable } from '../storage/postgres.js';
import { AsyncLocalStorage } from 'node:async_hooks';

interface LeaseClient extends Client {
  on(event: 'error'|'end', listener: () => void): this;
  removeListener(event: 'error'|'end', listener: () => void): this;
}

/** A single dedicated PostgreSQL session owns the right to run the new host. */
export class WriterLease implements PetGate, Pool, Queryable {
  private client: LeaseClient | null = null;
  private alive = false;
  private controller = new AbortController();
  private readonly context = new AsyncLocalStorage<{petId:string;active:boolean}>();
  private readonly tails = new Map<string, Promise<void>>();
  private connectionTail: Promise<void> = Promise.resolve();
  private readonly lost = () => { this.alive = false; this.controller.abort(new Error('写入租约已失去')); };
  constructor(private readonly pool: Pool) {}

  async acquire(): Promise<void> {
    if (this.client) throw new Error('写入租约已打开');
    this.controller = new AbortController();
    const client = await this.pool.connect() as LeaseClient;
    client.on('error', this.lost); client.on('end', this.lost);
    this.alive = true;
    let ownsNew = false;
    try {
      const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended('silicon_genesis:writer',0)) AS acquired");
      if (!this.alive || !result.rows[0]?.acquired) throw new Error('无法取得生命状态写入租约');
      ownsNew = true;
      this.client = client;
    } catch (error) {
      if (ownsNew && this.alive) await client.query("SELECT pg_advisory_unlock(hashtextextended('silicon_genesis:writer',0))").catch(() => {});
      this.alive = false; client.removeListener('error', this.lost); client.removeListener('end', this.lost); client.release(); throw error;
    }
  }

  assertHeld(): void { if (!this.client || !this.alive) throw new Error('写入租约不可用'); }
  get signal(): AbortSignal { return this.controller.signal; }

  /** Every write transaction must use this checkout, not the underlying pool.
   * Transactions and the advisory lock therefore share the same PG session. */
  async connect(): Promise<Client> {
    this.assertHeld();
    const previous = this.connectionTail;
    let unlock!: () => void;
    const current = new Promise<void>(resolve => { unlock=resolve; });
    this.connectionTail = previous.then(() => current, () => current);
    await previous.catch(() => {});
    try { this.assertHeld(); } catch (error) { unlock(); throw error; }
    const owned = this.client!;
    let released = false;
    return {
      query: async (sql, values) => {
        if (released) throw new Error('数据库连接已释放');
        // In-flight work must still be able to roll back after shutdown begins.
        if (sql.trim().toUpperCase() !== 'ROLLBACK') this.assertHeld();
        return owned.query(sql, values);
      },
      release: () => { if (!released) { released=true; unlock(); } }
    };
  }

  async query(sql: string, values?: unknown[]): Promise<{rows:any[];rowCount:number|null}> {
    const client = await this.connect();
    try { return await client.query(sql,values); } finally { client.release(); }
  }

  async run<T>(petId: string, operation: () => Promise<T>): Promise<T> {
    if (!petId) throw new Error('宠物标识无效');
    this.assertHeld();
    const owned = this.context.getStore();
    if (owned?.active && owned.petId === petId) return operation();
    if (owned?.active) throw new Error('不能在一个宠物的事务内锁定另一只宠物');
    const previous = this.tails.get(petId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    this.tails.set(petId, tail);
    await previous.catch(() => {});
    const owner = {petId,active:true};
    try { this.assertHeld(); return await this.context.run(owner, operation); }
    finally { owner.active=false; release(); if (this.tails.get(petId) === tail) this.tails.delete(petId); }
  }

  async close(timeoutMs = 15000): Promise<void> {
    if (!this.client) return;
    this.alive = false;
    this.controller.abort(new Error('生命系统正在关闭'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.tails.values(), this.connectionTail]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('仍有未结束的行动；保留租约并等待安全关闭')), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    const client = this.client; this.client = null;
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('silicon_genesis:writer',0))");
    }
    finally { client.removeListener('error', this.lost); client.removeListener('end', this.lost); client.release(); }
  }
}
