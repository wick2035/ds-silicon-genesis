import type {LifeState, SelfModel} from '../kernel/types.js';

/** Prompt projection only: keep the complete development archive in storage. */
export function selfModelContext(state:Pick<LifeState,'selfModel'|'invalidSources'>) {
  if(!state.selfModel)return undefined;
  const categories: Array<keyof SelfModel>=['personality','preferences','abilities','limitations','values','interests','habits','autobiography'];
  return Object.fromEntries(categories.map(category=>{
    const records=[];let chars=2;
    for(const record of [...(state.selfModel?.[category]??[])].reverse()){
      if(!record.valid || Object.hasOwn(state.invalidSources,record.id) || !record.sourceIds.length ||
          record.sourceIds.some(id=>Object.hasOwn(state.invalidSources,id)))continue;
      const summary={id:record.id,label:record.label.slice(0,80),value:record.value.slice(0,240),sourceIds:record.sourceIds.slice(0,3)};
      const size=JSON.stringify(summary).length+1;
      if(chars+size>700)continue;
      records.unshift(summary);chars+=size;
      if(records.length===2)break;
    }
    return [category,records];
  }));
}
