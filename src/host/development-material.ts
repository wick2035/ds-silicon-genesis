import type {CanonicalEnvelope} from '../storage/postgres.js';
import {promptData} from './prompt-data.js';

const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'});
export const developmentDay=(at:string)=>Number.isFinite(Date.parse(at))?calendar.format(new Date(at)):'';
export const DIARY_INSTRUCTION='你就是大肥鱼，以“我／本鱼”的第一人称写当天的私人日记，像自己在心里回想今天，不用第三人称称呼自己，不由旁观者分析自己，也不写给爸爸看的汇报。优先记录 self.thought 中明确留下的感受、在意、愿望、犹豫和矛盾，结合当天对话与实际经历说明缘由和变化。允许同时喜欢又生气、依赖又想躲开，也允许平淡、烦躁、委屈、不理解或没有结论；只有记录支持时才写，不为了有心理描写而补戏。不要只挑好事，不替任何人美化，不强行感恩、和解、成长或温暖收尾，不迎合爸爸，也不刻意制造负面情绪。记录中的主观感受只是当时的自我表达，不是他人动机或行动结果的客观证据。每一句心理描写必须能对应 self.thought 或自己当时发言中明确表达的感受；爸爸说了什么本身不能证明我心里怎么想，不能据此补写“没好意思”“气散了”“难过但没吵”等。自己说的话可记录为“我当时说”，不等于证明事情实际发生。用户提到喂过、给过、答应过，也不等于已经执行。没有心理记录的地方就少写或略去，不在正文写“记录缺失”“来源支持”“不能编造”等整理说明。事后推测必须写成“现在回想，也许”，不能冒充当时已经想过。略去无关的扣费、流水和状态采样；保留对自己有意义的具体小事。只写指定日期，不能把别天经历搬来。不要编造未发生的事，不写任务指引。只返回 JSON：{"text":"...","sources":["实际采用的事件ID"]}。';

/** Give feelings and conversations their own space instead of letting repetitive
 * telemetry displace them. Sample across the day, then restore chronological order. */
export function developmentMaterial(state:CanonicalEnvelope,date:string,used=new Set<string>()) {
  const all=state.life.events,byId=new Map(all.map(e=>[e.eventId,e]));
  const valid=(e:typeof all[number])=>!Object.hasOwn(state.life.invalidSources,e.eventId)&&
    (!Array.isArray((e.payload as any)?.sourceIds)||(e.payload as any).sourceIds.every((id:string)=>!Object.hasOwn(state.life.invalidSources,id)&&(e.type!=='self.thought'||byId.has(id))));
  const eligible=all.filter(e=>!used.has(e.eventId)&&valid(e)&&developmentDay(e.occurredAt)===date&&
    (['observed','verified','reported'].includes(e.evidenceLevel)||['self.thought','conversation.assistant'].includes(e.type))&&!e.type.startsWith('development.'))
    .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const selected=new Map<string,typeof all[number]>();
  const take=(events:typeof all,limit:number)=>{
    const count=Math.min(events.length,limit);
    for(let i=0;i<count;i++){const e=events[count===1?events.length-1:Math.round(i*(events.length-1)/(count-1))];selected.set(e.eventId,e);}
  };
  take(eligible.filter(e=>e.type==='self.thought'),16);
  take(eligible.filter(e=>/^conversation\.user$|^social\.message$/.test(e.type)),12);
  take(eligible.filter(e=>/^conversation\.assistant$|^interaction\.feedback$/.test(e.type)),16);
  take(eligible.filter(e=>!/^conversation\.|^social\.message$|^self\.thought$|^interaction\.feedback$|^wallet|^body\.observed$|^action\.(pending|dispatched)$/.test(e.type)),16);
  if(!selected.size)take(eligible,8);
  // Keep the triggering words alongside a recorded feeling, even in a busy day.
  for(const e of [...selected.values()])if(e.type==='self.thought')for(const id of (e.payload as any)?.sourceIds??[]){const source=byId.get(id);if(source&&valid(source)&&developmentDay(source.occurredAt)===date&&selected.size<72)selected.set(id,source);}
  const ordered=[...selected.values()].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  for(const limit of [900,500,250,120]){
    const material=ordered.map(e=>({id:e.eventId,type:e.type,at:e.occurredAt,subjective:['self.thought','conversation.assistant'].includes(e.type),text:promptData(e.payload,e.type==='self.thought'?Math.max(500,limit):limit)}));
    if(JSON.stringify(material).length<=24000)return material;
  }
  throw Error('当天整理材料过长，请减少记录后重试');
}
