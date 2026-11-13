import { randomUUID } from 'node:crypto';
import type { WakeCoordinator } from '../scheduler/index.js';
import type { PetGate, Pool } from '../storage/uow.js';

/** Persists a bounded event watermark and wake lease, never event contents. */
export class PostgresWakeCoordinator implements WakeCoordinator {
  constructor(private readonly pool: Pool, private readonly gate: PetGate) {}

  async claim(petId: string, now: string): Promise<{cursor:string;changed:boolean}|null> {
    if (!Number.isFinite(Date.parse(now))) throw new Error('唤醒时间无效');
    return this.gate.run(petId, async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const state = await client.query("SELECT jsonb_array_length(payload->'life'->'events') AS events FROM silicon_genesis.life_state WHERE pet_id=$1 FOR UPDATE",[petId]);
        if (state.rows.length !== 1 || !Number.isSafeInteger(state.rows[0].events)) throw new Error('生命事件不可用');
        await client.query('INSERT INTO silicon_genesis.wake_state(pet_id) VALUES($1) ON CONFLICT DO NOTHING',[petId]);
        const wake = await client.query('SELECT processed_count::text,next_wake_at,lease_until FROM silicon_genesis.wake_state WHERE pet_id=$1 FOR UPDATE',[petId]);
        const entry = wake.rows[0], processed = Number(entry.processed_count), events = state.rows[0].events;
        if (!Number.isSafeInteger(processed) || processed > events) throw new Error('生命事件游标不一致');
        if (entry.lease_until && Date.parse(entry.lease_until) > Date.parse(now) || Date.parse(entry.next_wake_at) > Date.parse(now)) {
          await client.query('ROLLBACK'); return null;
        }
        const cursor = randomUUID();
        await client.query(`UPDATE silicon_genesis.wake_state SET lease_token=$2,lease_until=$3::timestamptz + interval '2 minutes',claimed_count=$4 WHERE pet_id=$1`,[petId,cursor,now,events]);
        await client.query('COMMIT');
        return {cursor,changed:events>processed};
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }

  async finish(petId: string, cursor: string, nextWakeAt: string): Promise<void> {
    if (!Number.isFinite(Date.parse(nextWakeAt))) throw new Error('下次唤醒时间无效');
    await this.gate.run(petId, async () => {
      const client = await this.pool.connect();
      try {
        const result = await client.query(`UPDATE silicon_genesis.wake_state SET processed_count=claimed_count,next_wake_at=$3,
          lease_token=NULL,lease_until=NULL,claimed_count=NULL WHERE pet_id=$1 AND lease_token=$2 RETURNING pet_id`,[petId,cursor,nextWakeAt]);
        if (result.rowCount !== 1) throw new Error('唤醒租约已变化');
      } finally { client.release(); }
    });
  }

  async release(petId: string, cursor: string): Promise<void> {
    await this.gate.run(petId, async () => {
      const client = await this.pool.connect();
      try { await client.query('UPDATE silicon_genesis.wake_state SET lease_token=NULL,lease_until=NULL,claimed_count=NULL WHERE pet_id=$1 AND lease_token=$2',[petId,cursor]); }
      finally { client.release(); }
    });
  }
}
