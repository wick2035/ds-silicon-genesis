import type {ActionProposal,LifeState} from '../kernel/types.js';

/** Drinking is self care, not evidence that dad supplied care. Reuse an
 * existing physical-care grant without rewriting saved capabilities. */
export function selfActionState(state:LifeState,proposal:ActionProposal):LifeState {
  if(proposal.actionType!=='care.water'||state.constraints.capabilities.some(c=>c.name==='care.water'))return state;
  const care=state.constraints.capabilities.find(c=>c.name==='care.feed'&&c.enabled);
  if(!care)return state;
  return {...state,constraints:{...state.constraints,capabilities:[...state.constraints.capabilities,{...care,name:'care.water'}]}};
}
