import type { Body, Emotions, KernelStore, LegacyCognitiveContext, LifeState } from '../kernel/types.js';
import type { PetGate } from './uow.js';

export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
type CognitiveState = Omit<LifeState, 'petId' | 'version' | 'body' | 'emotions' | 'legacyContext'>;
export interface CanonicalEnvelope {
  petId: string;
  version: number;
  legacy: Record<string, unknown>;
  humanity: Record<string, unknown>;
  life: CognitiveState;
}
export type BodyProjection = (envelope: Readonly<CanonicalEnvelope>) => {body: Body; emotions: Emotions};
export type LegacyProjection = (envelope: Readonly<CanonicalEnvelope>) => LegacyCognitiveContext;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const equal = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const budgetDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'});

/** Host mutations and kernel mutations must both use this envelope and CAS. */
export class PostgresKernelStore implements KernelStore {
  constructor(private readonly db: Queryable, private readonly projectBody: BodyProjection, private readonly gate: PetGate,
    private readonly projectLegacy: LegacyProjection, private readonly reads:Queryable=db) {}

  // These read-only projections are safe on a separate connection and avoid
  // transferring the archive on every scene refresh and animation receipt.
  async loadWorksiteCommand(petId:string):Promise<Record<string,any>|null> {
    const {rows}=await this.reads.query(
      "SELECT payload#>'{legacy,world,command}' AS command FROM silicon_genesis.life_state WHERE pet_id=$1",[petId]);
    return rows[0]?.command??null;
  }

  async loadWorksite(petId:string):Promise<{legacy:CanonicalEnvelope['legacy'];life:Pick<CognitiveState,'actions'>}|null> {
    const {rows}=await this.reads.query(`
      WITH subject AS MATERIALIZED (
        SELECT payload->'legacy' AS legacy,payload#>'{life,actions}' AS actions
        FROM silicon_genesis.life_state WHERE pet_id=$1
      )
      SELECT jsonb_build_object('worksite',legacy->'worksite','farmVisit',legacy->'farmVisit',
        'labor',legacy->'labor','wallet',jsonb_build_object('balance',legacy#>'{wallet,balance}'),
        'world',jsonb_build_object('command',legacy#>'{world,command}','commandHistory',legacy#>'{world,commandHistory}')) AS legacy,
        jsonb_path_query_array(actions,'$[*] ? (@.actionType == "labor.step" && @.status == "UNKNOWN")') AS actions
      FROM subject`,[petId]);
    return rows.length?{legacy:rows[0].legacy,life:{actions:rows[0].actions??[]}}:null;
  }

  loadEnvelope(petId: string): Promise<CanonicalEnvelope | null> {
    return this.readEnvelope(this.db,petId);
  }

  loadCommittedEnvelope(petId: string): Promise<CanonicalEnvelope | null> {
    return this.readEnvelope(this.reads,petId);
  }

  async loadLifeSettings(petId:string) {
    const {rows}=await this.reads.query(
      `SELECT version::text AS version, payload#>'{life,constraints,paused}' AS paused,
        payload#>'{life,constraints,permissions}' AS permissions,
        payload#>'{legacy,config,qqGroupBlocked}' AS "groupChatBlocked"
        FROM silicon_genesis.life_state WHERE pet_id=$1`,[petId]);
    const row=rows[0],version=Number(row?.version);
    if(!Number.isSafeInteger(version)||typeof row?.paused!=='boolean'||!Array.isArray(row.permissions))
      throw Error('生命设置不可用');
    return {version,paused:row.paused as boolean,permissions:row.permissions as string[],groupChatBlocked:row.groupChatBlocked===true};
  }

  private async readEnvelope(db:Queryable,petId:string):Promise<CanonicalEnvelope|null> {
    const result = await db.query(
      'SELECT version::text AS version, payload FROM silicon_genesis.life_state WHERE pet_id=$1', [petId]);
    if (!result.rows.length) return null;
    const { payload } = result.rows[0];
    const version = Number(result.rows[0].version);
    if (!Number.isSafeInteger(version) || payload?.petId !== petId || payload?.version !== version ||
        !payload.legacy || !payload.humanity || !payload.life ||
        Object.hasOwn(payload.life, 'body') || Object.hasOwn(payload.life, 'emotions') || Object.hasOwn(payload.life, 'legacyContext'))
      throw new Error('生命状态信封无效，已停止读取');
    return payload as CanonicalEnvelope;
  }

  async load(petId: string): Promise<LifeState | null> {
    const envelope = await this.loadEnvelope(petId);
    if (!envelope) return null;
    return this.projectEnvelope(envelope);
  }

  projectEnvelope(envelope:CanonicalEnvelope):LifeState {
    return {...structuredClone(this.projectReadState(envelope)),legacyContext:this.projectLegacy(envelope)};
  }

  /** Shares archive arrays with the envelope. Use only for read-only views. */
  projectReadState(envelope:CanonicalEnvelope):Omit<LifeState,'legacyContext'> {
    const life=envelope.life, constraints={...life.constraints}, legacy=envelope.legacy as Record<string,any>;
    const day=budgetDay.format(new Date());
    const limit=legacy.config?.learning?.dailyModelCalls, used=legacy.usage?.[day]?.totalCalls ?? 0;
    if(Number.isSafeInteger(limit) && limit>=0 && Number.isSafeInteger(used) && used>=0)
      constraints.remainingBudget=Math.max(0,Math.max(0,limit-2)-used);
    return {...life,constraints,petId:envelope.petId,version:envelope.version,...this.projectBody(envelope)};
  }

  async commitEnvelope(petId: string, expectedVersion: number, next: CanonicalEnvelope): Promise<boolean> {
    return this.gate.run(petId, () => this.commitEnvelopeOwned(petId, expectedVersion, next));
  }

  private async commitEnvelopeOwned(petId: string, expectedVersion: number, next: CanonicalEnvelope): Promise<boolean> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || next.petId !== petId ||
        next.version !== expectedVersion + 1 || !next.legacy || !next.humanity || !next.life ||
        Object.hasOwn(next.life, 'body') || Object.hasOwn(next.life, 'emotions') || Object.hasOwn(next.life, 'legacyContext'))
      throw new Error('生命状态信封或版本无效');
    const result = await this.db.query(
      `UPDATE silicon_genesis.life_state SET version=$3, payload=$4::jsonb, updated_at=now()
       WHERE pet_id=$1 AND version=$2 RETURNING pet_id`,
      [petId, expectedVersion, next.version, JSON.stringify(next)]);
    return result.rowCount === 1;
  }

  async commit(petId: string, expectedVersion: number, next: LifeState): Promise<boolean> {
    const current = await this.loadEnvelope(petId);
    if (!current || current.version !== expectedVersion) return false;
    const projected = this.projectBody(current);
    if (!equal(next.body, projected.body) || !equal(next.emotions, projected.emotions))
      throw new Error('身体和情绪只能由身体权威更新');
    if (!equal(next.legacyContext, this.projectLegacy(current))) throw new Error('原角色与成长上下文不能从认知投影修改');
    const {petId: nextId, version, body: _body, emotions: _emotions, legacyContext: _legacy, ...life} = next;
    return this.commitEnvelope(petId, expectedVersion, {...current, petId: nextId, version, life});
  }

  async create(initial: CanonicalEnvelope): Promise<boolean> {
    return this.gate.run(initial.petId, () => this.createOwned(initial));
  }

  private async createOwned(initial: CanonicalEnvelope): Promise<boolean> {
    if (initial.version !== 0 || !initial.petId || !initial.legacy || !initial.humanity || !initial.life ||
        Object.hasOwn(initial.life, 'body') || Object.hasOwn(initial.life, 'emotions') || Object.hasOwn(initial.life, 'legacyContext')) throw new Error('初始信封无效');
    const result = await this.db.query(
      `INSERT INTO silicon_genesis.life_state(pet_id,version,payload) VALUES($1,0,$2::jsonb)
       ON CONFLICT (pet_id) DO NOTHING RETURNING pet_id`, [initial.petId, JSON.stringify(initial)]);
    return result.rowCount === 1;
  }
}
