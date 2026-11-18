import type {CanonicalEnvelope} from '../storage/postgres.js';

/** An unresolved result for the current trip cannot be replayed implicitly.
 * A deliberate retry records the action id without altering its UNKNOWN receipt. */
export function uncertainLabor(draft:{legacy:CanonicalEnvelope['legacy'];life:Pick<CanonicalEnvelope['life'],'actions'>}):string[] {
  const pet=draft.legacy as Record<string,any>,command=pet.world?.command;
  const active=pet.labor?.contracts?.find((c:any)=>['working','paused','queued'].includes(c.status)&&c.done<c.trips);
  const acknowledged=new Set<string>(pet.worksite?.acknowledgedUncertainActions??[]);
  if(!active)return [];
  return draft.life.actions.filter(a=>a.actionType==='labor.step'&&a.status==='UNKNOWN'&&!acknowledged.has(a.id)&&a.parameters?.contractId===active.id&&
    [command,...(pet.world?.commandHistory??[])].some((c:any)=>c?.id===a.parameters?.commandId&&c?.labor?.trip===active.done)).map(a=>a.id);
}

export function blocksNewLabor(draft:CanonicalEnvelope):boolean {
  const pet=draft.legacy as Record<string,any>,command=pet.world?.command;
  if(uncertainLabor(draft).length)return true;
  const active=pet.labor?.contracts?.find((c:any)=>['working','paused','queued'].includes(c.status)&&c.done<c.trips);
  if(active&&draft.life.actions.some(a=>a.actionType==='labor.step'&&a.status==='DISPATCHED'&&a.parameters?.contractId===active.id&&[command,...(pet.world?.commandHistory??[])].some((c:any)=>c?.id===a.parameters?.commandId&&c?.labor?.trip===active.done)))return true;
  return draft.life.actions.some(a=>a.actionType==='labor.step' && (
    a.status==='PENDING' ||
    ['DISPATCHED','UNKNOWN'].includes(a.status) && command?.id===(a.parameters as Record<string,unknown>)?.commandId && ['queued','running'].includes(command?.status)
  ));
}
