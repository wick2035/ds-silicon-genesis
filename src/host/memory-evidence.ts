import type {LifeState,Memory} from '../kernel/types.js';
import {historicalMemory} from './conversation-history.js';
import {promptData} from './prompt-data.js';

/** Reserve a separate budget so long chat history cannot truncate the actual
 * outcome and leave the model with only the first part of an episode. */
export function evidenceMemoryPrompt(memories:Memory[],state:LifeState):string {
  const evidence=memories.find(m=>m.id.startsWith('worksite-episode:'));
  return evidence?promptData(historicalMemory(evidence,state),1800,{arrayOrder:'first'}):'';
}

/** Build a disposable account from observed events, never from a chat claim.
 * A button and its effects are linked by the recorded source ID, not proximity. */
export function forcedWorkEpisodes(state:LifeState):Memory[] {
  const live=(id:string)=>!Object.hasOwn(state.invalidSources,id);
  const byId=new Map(state.events.map(e=>[e.eventId,e]));
  const buttons=state.events.filter(e=>e.type==='interaction.worksite'&&e.source==='user'&&e.evidenceLevel==='observed'&&live(e.eventId)&&(e.payload as any)?.action==='force-work');
  const remembered=new Set(state.memories.filter(m=>m.valid&&live(m.id)&&m.sourceIds.every(live)).flatMap(m=>m.sourceIds));
  const grouped=new Map<string,typeof state.events>();
  for(const e of state.events){
    const p=e.payload as any,ids=Array.isArray(p?.sourceIds)?p.sourceIds:[],cause=e.causationId&&byId.get(e.causationId);
    if(e.type!=='body.forced-labor'||e.evidenceLevel!=='observed'||!live(e.eventId)||!remembered.has(e.eventId)||typeof p.description!=='string'||
      !cause||cause.type!=='action.receipt'||!['COMPLETED','CANCELLED'].includes(String((cause.payload as any)?.status))||!live(cause.eventId)||!ids.every((id:string)=>byId.has(id)&&live(id)))continue;
    for(const id of ids)if(byId.get(id)?.type==='interaction.worksite'){const items=grouped.get(id)||[];items.push(e);grouped.set(id,items);}
  }
  return buttons.map((button):Memory=>{
    const effects=(grouped.get(button.eventId)||[]).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
    const first=effects[0],last=effects.at(-1);
    const clean=(value:string)=>value.replace(/\d+\.\d{3,}/gu,n=>String(Math.round(Number(n)*100)/100));
    const detail=first&&last ? `有实际用力回执。首条（${first.occurredAt}）：${clean((first.payload as any).description)} 末条（${last.occurredAt}）：${clean((last.payload as any).description)} 这是两个时点的记录，期间可能还有恢复或其他操作，不是当前数值，也不能由动作步骤推断搬完的趟数。` : '这次按钮没有找到关联的有效用力回执，不能据此断言搬运完成或没有发生。';
    const sourceIds=[...new Set([button.eventId,...(first?[first.eventId,first.causationId!]:[]),...(last?[last.eventId,last.causationId!]:[])])];
    return {id:'worksite-episode:'+button.eventId,kind:'autobiographical',content:`爸爸按下强制干活按钮（强制开工、强制搬砖），时间 ${button.occurredAt}。${detail}`,sourceIds,evidenceLevel:'observed',valid:true,createdAt:button.occurredAt};
  }).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
}

/** Only use the explicit control or a recollection of pressing a button;
 * do not conflate a generic button on another device with labor. */
export function asksAboutForcedWork(query:string):boolean {
  const work=/(?:干活|工作|搬砖|劳动|开工)/u.test(query);
  const force=/(?:强制|强迫|强行|被迫|逼)/u.test(query);
  const button=/(?:按钮|按键|开关)/u.test(query);
  const recollect=/(?:回忆|记得|记住|记忆|上次|之前|以前|发生了什么)/u.test(query);
  return work&&force || button&&work || button&&recollect&&/(?:按|摁|压)/u.test(query)&&!/(?:手机|电脑|音量|电源|键盘)/u.test(query);
}
