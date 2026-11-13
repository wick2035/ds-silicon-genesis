import {validateProposal} from '../kernel/index.js';
import type {ActionProposal,LifeState} from '../kernel/types.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
/** The marker and event are created only by the authenticated host service. */
export function validateManualService(draft:CanonicalEnvelope,state:LifeState,proposal:ActionProposal):void {
  const marker=(draft.legacy as Record<string,any>).manualServiceRequests?.[proposal.id];
  const event=draft.life.events.find(e=>e.eventId===marker?.sourceId);
  if(!['service.buy-rice','care.feed','service.eat-rice','body.sleep','body.wake','learning.observe','image.observe'].includes(proposal.actionType) || marker?.kind!==proposal.actionType || proposal.sourceIds.length!==1 || proposal.sourceIds[0]!==marker.sourceId || !event || event.source!=='user' || event.actorId!=='dad' || (event.payload as any)?.kind!==proposal.actionType || event.type!=='service.requested' || (event.payload as any)?.actionId!==proposal.id) throw Error('手动服务来源无效');
  validateProposal({...state,constraints:{...state.constraints,paused:false}},proposal);
}
