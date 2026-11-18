import { PostgresKernelStore, type BodyProjection, type LegacyProjection, type Queryable } from '../storage/postgres.js';
import { UnitOfWork, type Pool } from '../storage/uow.js';
import { PostgresWakeCoordinator } from './wake-coordinator.js';
import { WriterLease } from './writer-lease.js';

/** Call explicitly at startup. All writes and wake transactions use the very
 * session holding the advisory lock; a lost session rolls back its transaction. */
export async function openLifeStores(pool: Pool & Queryable, body: BodyProjection, legacy: LegacyProjection) {
  const lease = new WriterLease(pool);
  await lease.acquire();
  try {
    const source = await lease.query(`SELECT source_revision::text,source_checksum FROM silicon_genesis.legacy_import WHERE source_key='desktop-pet'`);
    if (source.rows.length !== 1 || !source.rows[0].source_revision || !source.rows[0].source_checksum)
      throw new Error('新版尚未完成独立导入');
    const store = new PostgresKernelStore(lease,body,lease,legacy,pool);
    const unitOfWork = new UnitOfWork(lease,lease);
    const wakes = new PostgresWakeCoordinator(lease,lease);
    return {lease,store,unitOfWork,wakes};
  } catch (error) { await lease.close(); throw error; }
}
