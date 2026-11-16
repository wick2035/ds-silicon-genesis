import type {CanonicalEnvelope} from '../storage/postgres.js';

/** Host observers only read this detached committed snapshot. A single copy
 * avoids cloning the full archive for each observer; failures stay isolated. */
export function createCommitObservers() {
  const observers:Array<(state:CanonicalEnvelope)=>void>=[];
  return {
    add(observer:(state:CanonicalEnvelope)=>void) { observers.push(observer); },
    notify(state:CanonicalEnvelope) {
      for(const observer of observers)try{observer(state);}catch{/* observers cannot undo a commit */}
    }
  };
}
