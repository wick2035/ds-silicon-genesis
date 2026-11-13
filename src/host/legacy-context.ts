import type { LegacyProjection } from '../storage/postgres.js';

/** Read-only context from the canonical legacy domain. The caller supplies the
 * exact original persona text; historical records remain attributed data. */
export function legacyContext(personaDescription: string): LegacyProjection {
  if (typeof personaDescription !== 'string' || !personaDescription.trim()) throw new Error('原角色描述不可用');
  return envelope => {
    const pet = envelope.legacy as Record<string, any>, growth = pet.growth || {};
    const blocked = new Set<string>([...(Array.isArray(growth.blocked) ? growth.blocked : []), ...(Array.isArray(pet.forgotten) ? pet.forgotten : [])]);
    const groups = ['events','facts'].flatMap(key => Array.isArray(pet[key]) ? pet[key] : [])
      .concat(['memories','strategies','skills'].flatMap(key => Array.isArray(growth[key]) ? growth[key] : []));
    const index = new Map<string, any>();
    for (const item of groups) if (item && typeof item.id === 'string') index.set(item.id,item);
    const tombstones = envelope.life.invalidSources || {};
    const hidden = (id: unknown) => typeof id === 'string' && ['event','fact','memory','strategy','skill','tombstone']
      .some(group => Object.hasOwn(tombstones,`legacy:${group}:${encodeURIComponent(id)}`));
    const isValid = (item: any, seen = new Set<string>()): boolean => {
      if (!item || item.deleted || item.invalidated || blocked.has(item.id) || blocked.has(item.key) || hidden(item.id) || hidden(item.key) || seen.has(item.id)) return false;
      if (!Array.isArray(item.sources) || !item.sources.length) return Array.isArray(pet.events) && pet.events.includes(item);
      const next = new Set(seen).add(item.id);
      return item.sources.every((id: unknown) => typeof id === 'string' && isValid(index.get(id),next));
    };
    const records = (key: string) => (Array.isArray(growth[key]) ? growth[key] : []).filter((item: any) => isValid(item)).slice(-30).map((item: any) => ({
      id:item.id, name:item.name, instruction:item.instruction, status:item.status, sources:item.sources, ts:item.ts
    }));
    const attempts = (Array.isArray(growth.attempts) ? growth.attempts : []).filter((item: any) => item &&
      (!item.eventId || isValid(index.get(item.eventId))) && (!item.outcomeSource || isValid(index.get(item.outcomeSource))))
      .slice(-30).map((item: any) => ({id:item.id,goalId:item.goalId,strategyId:item.strategyId,
        status:item.status,eventId:item.eventId,outcomeSource:item.outcomeSource,ts:item.ts}));
    const versions = Array.isArray(growth.persona?.versions) ? growth.persona.versions : [];
    const latest = [...versions].reverse().find((v: any) => v && !v.invalidated && !v.reverted);
    const personaStillValid = !latest || Array.isArray(latest.sources) && latest.sources.every((id: unknown) => typeof id === 'string' && isValid(index.get(id)));
    const c=(pet.labor?.contracts||[]).find((x:any)=>['offered','working','paused','unpaid'].includes(x.status));
    const labor=c?{id:c.id,status:c.status,trips:c.trips,done:c.done,wage:c.wage,paid:c.paid,carrying:!!c.carrying,nextDecision:c.nextDecision,workPermit:!!c.workPermit,behavior:c.behavior,counter:c.counter??null}:null;
    return {labor,personaDescription,traits:structuredClone(personaStillValid ? growth.persona?.traits || {} : {}),
      interests:structuredClone(personaStillValid ? growth.persona?.interests || [] : []),skills:records('skills'),strategies:records('strategies'),attempts};
  };
}
