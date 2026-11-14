import {budgetView} from './budget-view.js';
import { createInitialState } from '../kernel/index.js';
import type { EvidenceLevel, Goal, LifeEvent, Memory } from '../kernel/types.js';
import type { CanonicalEnvelope } from '../storage/postgres.js';

type Obj = Record<string, any>;
export interface LegacyImportInput {
  petId: string;
  identity: { name: string; role: string };
  /** Import time is a checkpoint, not an invented historical event time. */
  importedAt: string;
  pet: Record<string, unknown>;
  humanity: Record<string, unknown>;
}
export interface LegacyImportResult { envelope: CanonicalEnvelope; warnings: string[] }
const array = (v: unknown): Obj[] => Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];
const strings = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x.length))] : [];
const time = (v: unknown): string | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Date.parse(v) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= 8640000000000000 ? new Date(n).toISOString() : undefined;
};
const namespace = (kind: string, id: string) => `legacy:${kind}:${encodeURIComponent(id)}`;
const level = (v: unknown): EvidenceLevel => ['observed','verified','reported','inferred','fictional'].includes(String(v)) ? v as EvidenceLevel : 'reported';

/** Pure conversion. Raw pet and humanity objects remain intact in the envelope.
 * Import is deliberately conservative: absent evidence is never upgraded. */
export function importLegacy(input: LegacyImportInput): LegacyImportResult {
  if (!input || typeof input.petId !== 'string' || !input.petId.trim() ||
      !input.identity || typeof input.identity.name !== 'string' || !input.identity.name.trim() ||
      typeof input.identity.role !== 'string' || !input.identity.role.trim() || !time(input.importedAt) ||
      !input.pet || typeof input.pet !== 'object' || Array.isArray(input.pet) ||
      !input.humanity || typeof input.humanity !== 'object' || Array.isArray(input.humanity)) throw new Error('旧档导入输入无效');
  const pet = structuredClone(input.pet) as Obj, humanity = structuredClone(input.humanity);
  const growth = pet.growth && typeof pet.growth === 'object' ? pet.growth : {};
  const warnings: string[] = [];
  const initial = createInitialState(input.petId, time(input.importedAt)!);
  const {body: _body, emotions: _emotions, petId: _petId, version: _version, ...life} = initial;
  life.identity = structuredClone(input.identity);
  Object.assign(life.constraints,budgetView(pet,new Date(input.importedAt)));
  life.constraints.paused = pet.config?.autonomousPaused === true || Boolean(growth.stopAt);
  // These describe executable operations, not blanket network authorization.
  // The executor also checks the imported per-ability grant at dispatch time.
  life.constraints.capabilities = [
    {name:'service.buy-rice',enabled:true},
    {name:'care.feed',enabled:true,physical:true,bodyLimits:{allowInjured:true,minStamina:-1,maxPain:101}},
    {name:'service.eat-rice',enabled:true,physical:true,bodyLimits:{allowInjured:true,minStamina:-1,maxPain:101}},
    {name:'labor.step',enabled:true,physical:true},
    {name:'body.activity',enabled:true,physical:true},
    {name:'token.pickup',enabled:true,physical:true,bodyLimits:{allowInjured:true,minStamina:-1}},
    {name:'body.sleep',enabled:true,physical:true,bodyLimits:{allowInjured:true,minStamina:-1,maxPain:101}},
    {name:'body.wake',enabled:true,physical:true,bodyLimits:{allowSleeping:true,allowInjured:true,minStamina:-1,maxPain:101}},
    {name:'image.observe',enabled:true},
    {name:'learning.observe',enabled:true,requiresPermission:'network'}
  ];
  if(pet.config?.networkLearning === true && Object.values(pet.abilities || {}).some((a:any)=>a?.status==='granted'))
    life.constraints.permissions.push('network');
  const all = [...array(pet.events), ...array(pet.facts), ...array(growth.memories), ...array(growth.strategies), ...array(growth.skills)];
  const byId = new Map<string, Obj>();
  for (const item of all) {
    if (typeof item.id !== 'string' || !item.id) { warnings.push('部分旧记录没有标识，保留在旧档中'); continue; }
    if (byId.has(item.id)) throw new Error(`旧档记录标识冲突：${item.id}`);
    byId.set(item.id,item);
  }
  const blocked = new Set([...strings(growth.blocked), ...strings(pet.forgotten)]);
  for (const item of all) if (item.deleted || item.invalidated) { if (item.id) blocked.add(item.id); if (item.key) blocked.add(item.key); }
  const eventIds = new Set(array(pet.events).map(e => e.id).filter((x): x is string => typeof x === 'string'));
  const valid = (item: Obj | undefined, seen = new Set<string>()): boolean => {
    if (!item || typeof item.id !== 'string' || blocked.has(item.id) || blocked.has(item.key) || item.deleted || item.invalidated || seen.has(item.id)) return false;
    if (eventIds.has(item.id)) return true;
    const next = new Set(seen).add(item.id), sources = strings(item.sources);
    return sources.length > 0 && sources.every(id => valid(byId.get(id),next));
  };
  const roots = (item: Obj, seen = new Set<string>()): string[] => {
    if (!valid(item) || seen.has(item.id)) return [];
    if (eventIds.has(item.id)) return [namespace('event',item.id)];
    const next = new Set(seen).add(item.id);
    return [...new Set(strings(item.sources).flatMap(id => roots(byId.get(id)!,next)))];
  };
  for (const event of array(pet.events)) {
    if (typeof event.id !== 'string' || !event.id) continue;
    const occurredAt = time(event.ts ?? event.occurredAt);
    if (!occurredAt) { warnings.push(`事件 ${event.id} 缺少有效时间，仅保留原档`); continue; }
    const id = namespace('event',event.id);
    const actor = event.sourceIdentity && typeof event.sourceIdentity === 'object' ? event.sourceIdentity : undefined;
    const record: LifeEvent = {eventId:id,petId:input.petId,type:typeof event.kind === 'string' && event.kind ? event.kind : 'legacy.event',
      source:'legacy',occurredAt,receivedAt:occurredAt,evidenceLevel:level(event.evidenceLevel),
      payload:structuredClone(event), ...(typeof actor?.participant === 'string' ? {actorId:actor.participant} : {})};
    life.events.push(record);
    if (!valid(event)) life.invalidSources[id] = '旧档删除或屏蔽';
  }
  const available = new Set(life.events.map(e => e.eventId));
  const sourceRoots = (item: Obj) => roots(item).filter(id => available.has(id));
  const addMemory = (item: Obj, group: string, kind: Memory['kind'], text: unknown, stamp: unknown) => {
    if (typeof item.id !== 'string' || typeof text !== 'string' || !text.trim()) return;
    const createdAt = time(stamp), sourceIds = sourceRoots(item), isValid = valid(item) && sourceIds.length > 0;
    if (!createdAt) { warnings.push(`${group} ${item.id} 缺少有效时间，仅保留原档`); return; }
    const id=namespace(group,item.id);
    life.memories.push({id,kind,content:text,sourceIds,evidenceLevel:level(item.evidenceLevel),valid:isValid,createdAt});
    if (!isValid) life.invalidSources[id]='旧档删除、屏蔽或来源缺失';
  };
  for (const fact of array(pet.facts)) addMemory(fact,'fact','episodic',fact.text,fact.ts);
  for (const memory of array(growth.memories)) addMemory(memory,'memory',memory.kind === 'agreement' ? 'commitment' : memory.layer === 'strategy' ? 'procedural' : 'semantic',memory.text,memory.ts);
  for (const strategy of array(growth.strategies)) addMemory(strategy,'strategy','procedural',strategy.instruction,strategy.ts);
  for (const [day, diary] of Object.entries(pet.diaries && typeof pet.diaries === 'object' ? pet.diaries : {})) {
    if (!diary || typeof diary !== 'object') continue;
    const d=diary as Obj, item={...d,id:day};
    const deleted = strings(pet.deletedDays).includes(day) || d.deleted;
    const sources = strings(d.sources), sourceIds = [...new Set(sources.flatMap(id => {const source=byId.get(id);return source ? roots(source) : [];}))].filter(id=>available.has(id));
    const createdAt=time(d.updatedAt ?? d.ts);
    if (typeof d.text !== 'string' || !d.text.trim() || !createdAt) { warnings.push(`日记 ${day} 缺少内容或时间，仅保留原档`); continue; }
    const id=namespace('diary',day), isValid=!deleted && sourceIds.length>0 && sources.every(id=>valid(byId.get(id)));
    life.memories.push({id,kind:'autobiographical',content:d.text,sourceIds,evidenceLevel:level(d.evidenceLevel),valid:isValid,createdAt});
    if (!isValid) life.invalidSources[id]='旧日记删除或来源缺失';
  }
  const goalStatuses: Record<string,Goal['status']>={active:'active',paused:'paused',satisfied:'deferred',expired:'deferred',exhausted:'deferred'};
  const goalIds = new Set<string>();
  for (const g of array(growth.goals)) {
    if (typeof g.id !== 'string' || !g.id) continue;
    if (goalIds.has(g.id)) throw new Error(`旧目标标识冲突：${g.id}`); goalIds.add(g.id);
    const sources=strings(g.sources), sourceIds=[...new Set(sources.flatMap(id=>{const source=byId.get(id);return source?roots(source):[]}))].filter(id=>available.has(id));
    if (!sourceIds.length || sources.some(id=>!valid(byId.get(id))) || !goalStatuses[g.status]) { warnings.push(`目标 ${g.id} 来源或状态不足，仅保留原档`); continue; }
    life.goals.push({id:namespace('goal',g.id),title:typeof g.motivation==='string'&&g.motivation.trim()?g.motivation:String(g.kind||'旧目标'),kind:String(g.kind||'legacy'),priority:0,urgency:0,status:goalStatuses[g.status],sourceIds});
  }
  for (const key of blocked) life.invalidSources[namespace('tombstone',key)]='旧档删除或屏蔽标记';
  warnings.push('旧档人格版本、技能、尝试和关系数值未直接转换；完整原文保留在 legacy 中。');
  return {envelope:{petId:input.petId,version:0,legacy:pet,humanity,life},warnings};
}
