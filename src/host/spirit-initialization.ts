import {ensureSpirit,setSpiritRest} from '../kernel/spirit.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';

/** Additive archive upgrade. Existing explicit pauses, revocations and economic caps survive. */
export function initializeSpirit(draft:CanonicalEnvelope,now=Date.now()):void {
  ensureSpirit(draft.life,now);
  // Existing network grants authorize self-directed use without a per-thought approval.
  const pet=draft.legacy as Record<string,any>;
  for(const [name,ability] of [['learning.observe','search'],['image.observe','image']] as const){const granted=pet.abilities?.[ability]?.status==='granted';if(granted && (ability==='image'||pet.config?.networkLearning===true) && !draft.life.constraints.capabilities.some(c=>c.name===name))draft.life.constraints.capabilities.push({name,enabled:true,requiresPermission:ability==='image'?undefined:'network'});}
  if(draft.humanity.sleeping===true)setSpiritRest(draft.life,'sleep',now);
  for(const name of ['self.express','service.sweet'])if(!draft.life.constraints.capabilities.some(c=>c.name===name))draft.life.constraints.capabilities.push({name,enabled:true});
  const care=draft.life.constraints.capabilities.find(c=>c.name==='care.feed'&&c.enabled);
  if(care&&!draft.life.constraints.capabilities.some(c=>c.name==='care.water'))draft.life.constraints.capabilities.push({...care,name:'care.water'});
}
