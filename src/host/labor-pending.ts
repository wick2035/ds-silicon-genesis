import type {CanonicalEnvelope} from '../storage/postgres.js';

/** An unknown result is never counted or retried. Once its particular command
 * was interrupted, it must not permanently prevent a distinct later command. */
export function blocksNewLabor(draft:CanonicalEnvelope):boolean {
  const command=(draft.legacy as Record<string,any>).world?.command;
  return draft.life.actions.some(a=>a.actionType==='labor.step' && (
    ['PENDING','DISPATCHED'].includes(a.status) ||
    a.status==='UNKNOWN' && command?.id===(a.parameters as Record<string,unknown>)?.commandId && ['queued','running'].includes(command?.status)
  ));
}
