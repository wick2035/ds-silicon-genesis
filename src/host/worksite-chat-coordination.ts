import type {CanonicalEnvelope} from '../storage/postgres.js';

type Listener=(state:CanonicalEnvelope)=>void;
type CommitSource={onCommit(listener:Listener):()=>void};

/** Wait only for an already dispatched work step. Subscribing before reading
 * avoids missing a receipt between the snapshot and the wait. */
export function createWorksiteChatWait(reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},sources:CommitSource[]) {
  return async(petId:string,signal:AbortSignal):Promise<void>=>{
    let revision=0,wake:(()=>void)|undefined;
    const changed=(state:CanonicalEnvelope)=>{if(state.petId===petId){revision++;wake?.();}};
    const unsubscribe=sources.map(source=>source.onCommit(changed));
    const abort=()=>wake?.();signal.addEventListener('abort',abort);
    try {
      while(true){
        if(signal.aborted)throw Error('对话已取消');
        const observed=revision,state=await reader.loadEnvelope(petId);
        if(signal.aborted)throw Error('对话已取消');
        if(!state)throw Error('生命状态不可用');
        if(!state.life.actions.some(action=>action.actionType==='labor.step'&&action.status==='DISPATCHED'))return;
        if(revision!==observed)continue;
        await new Promise<void>(resolve=>{wake=resolve;if(signal.aborted)resolve();});wake=undefined;
      }
    } finally {signal.removeEventListener('abort',abort);for(const off of unsubscribe)off();}
  };
}
