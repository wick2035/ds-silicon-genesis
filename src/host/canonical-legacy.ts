import type { CanonicalEnvelope } from '../storage/postgres.js';

/** The implementation must make this a single version-checked durable write. */
export interface EnvelopeRepository {
  loadEnvelope(petId: string): Promise<CanonicalEnvelope | null>;
  commitEnvelope(petId: string, expectedVersion: number, next: CanonicalEnvelope): Promise<boolean>;
}

/** A detached working copy, never a substitute for a committed store. */
export interface LegacyWorkingCopy {
  readonly petId: string;
  readonly expectedVersion: number;
  legacy: Record<string, unknown>;
  humanity: Record<string, unknown>;
}

export type CommitResult =
  | { status: 'committed'; petId: string; version: number }
  | { status: 'conflict'; petId: string; expectedVersion: number };

/**
 * Bridge for an explicitly asynchronous host boundary. Legacy and humanity are
 * staged together; kernel-owned life is copied from the same original version.
 * This module never invokes legacy methods or external effects. Callers must not
 * publish, dispatch, reply, or invoke model/network/desktop effects while a copy
 * is being edited, and may do so only after status === 'committed'. A rejected
 * write or conflict requires discarding the copy and re-evaluating the operation.
 * A database error can have an unknown commit outcome and must be reconciled,
 * not retried blindly.
 */
export class CanonicalLegacyAdapter {
  private readonly pending = new WeakMap<LegacyWorkingCopy, CanonicalEnvelope>();
  constructor(private readonly repository: EnvelopeRepository) {}

  async begin(petId: string): Promise<LegacyWorkingCopy> {
    const envelope = await this.repository.loadEnvelope(petId);
    if (!envelope || envelope.petId !== petId) throw new Error('生命状态不存在');
    const original = structuredClone(envelope);
    const copy: LegacyWorkingCopy = {
      petId, expectedVersion: original.version,
      legacy: structuredClone(original.legacy), humanity: structuredClone(original.humanity)
    };
    this.pending.set(copy, original);
    return copy;
  }

  async commit(copy: LegacyWorkingCopy): Promise<CommitResult> {
    const original = this.pending.get(copy);
    if (!original) throw new Error('工作副本无效或已提交');
    // Consume even on rejection: an ambiguous database outcome is not replayable.
    this.pending.delete(copy);
    if (copy.petId !== original.petId || copy.expectedVersion !== original.version ||
        !copy.legacy || typeof copy.legacy !== 'object' || Array.isArray(copy.legacy) ||
        !copy.humanity || typeof copy.humanity !== 'object' || Array.isArray(copy.humanity))
      throw new Error('工作副本无效');
    const next: CanonicalEnvelope = {
      ...original, version: original.version + 1,
      legacy: structuredClone(copy.legacy), humanity: structuredClone(copy.humanity)
    };
    const committed = await this.repository.commitEnvelope(original.petId, original.version, next);
    return committed
      ? {status: 'committed', petId: original.petId, version: next.version}
      : {status: 'conflict', petId: original.petId, expectedVersion: original.version};
  }

  discard(copy: LegacyWorkingCopy): void { this.pending.delete(copy); }
}
