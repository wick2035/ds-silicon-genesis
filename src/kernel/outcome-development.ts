import {randomUUID} from 'node:crypto';
import type {LifeState,DevelopmentRecord} from './types.js';
/** Recompute conservative summaries from distinct, valid receipt observations.
 * Earlier versions stay in the state, marked invalid rather than rewritten. */
export function rebuildOutcomeDevelopment(state:LifeState):void {
  const model=state.selfModel;if(!model)return;
  for(const type of ['labor.step','learning.observe'] as const){
    const label=type==='labor.step'?'工作':'探索';
    const observations=state.observations.filter(o=>o.valid&&o.strategy===type&&o.context==='execution'&&o.sourceIds.length&&o.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id))).slice(-12);
    const unique=[...new Map(observations.map(o=>[o.id,o])).values()];
    const update=(target:DevelopmentRecord[],key:string,value:string|undefined,sources:string[])=>{
      const old=target.filter(r=>r.valid&&r.label===key&&r.id.startsWith('outcome-development:'));
      const stable=old.length===1&&old[0].value===value&&JSON.stringify(old[0].sourceIds)===JSON.stringify(sources);
      if(stable)return;for(const item of old){item.valid=false;state.invalidSources[item.id]='结果汇总已更新';}
      if(value&&sources.length>=2)target.push({id:'outcome-development:'+randomUUID(),label:key,value,sourceIds:sources,valid:true});
    };
    const successes=unique.filter(o=>o.success), failures=unique.filter(o=>!o.success);
    const source=(items:typeof unique)=>[...new Set(items.flatMap(o=>o.sourceIds))];
    update(model.abilities,`${label}经历`,successes.length>=2?`有 ${successes.length} 次已确认完成的${label}经历；不保证下次一定成功`:undefined,source(successes));
    update(model.limitations,`${label}阻碍`,failures.length>=2?`有 ${failures.length} 次${label}未完成；原因需要结合具体回执判断`:undefined,source(failures));
    const chosen=successes.filter(o=>{const event=state.events.find(e=>e.eventId===o.sourceIds[0]);const action=state.actions.find(a=>a.id===(event?.payload as any)?.actionId);return action&&action.sourceIds.length>0&&action.sourceIds.every(id=>state.events.find(e=>e.eventId===id)?.source!=='user');});
    update(model.preferences,`${label}选择`,chosen.length>=2?`曾多次自主选择并完成${label}；是否喜欢仍需继续观察`:undefined,source(chosen));
    const subject=`结果观察:${type}`,old=state.beliefs.filter(b=>b.valid&&b.subject===subject&&b.id.startsWith('outcome-belief:')),sources=source(unique);
    const value=unique.length>=2?`近期 ${unique.length} 次${label}中有 ${successes.length} 次完成，属于可修正的经历统计`:undefined;
    const confidence=unique.length/(unique.length+2);
    if(!(old.length===1&&old[0].value===value&&JSON.stringify(old[0].sourceIds)===JSON.stringify(sources))){for(const b of old){b.valid=false;state.invalidSources[b.id]='结果汇总已更新';}if(value)state.beliefs.push({id:'outcome-belief:'+randomUUID(),subject,value,confidence,sourceIds:sources,valid:true});}
  }
}
