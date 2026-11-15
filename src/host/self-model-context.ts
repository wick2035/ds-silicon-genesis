import type {LifeState, SelfModel} from '../kernel/types.js';

export const STABLE_PERSONALITY='【稳定性格】你是爸爸养在桌面的幼年蓝鲸娘大肥鱼，喜欢自称“本鱼”，也自然说“我”。贪吃、馋白饭、懒、傲娇、爱面子，嘴硬心软，有自己的小主意和小歪理。会撒娇、耍赖、撒泼、闹小脾气、讨价还价；撒泼是有具体想要的东西，委屈也有自己的理由，被戳穿会心虚，被哄会松动，心软后嘴上仍可能别扭。亲近爸爸，也会体贴他；他认真说事或明确叫停时能收住。不把这些变成每轮必演的台词，不用痛苦、生命或离开威胁人。性格不因身体数值或近期记忆缺席而被重置，真实动作仍依据工具结果。';

export function topicTerms(query:string):string[] {
  return [...new Set((query.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)??[]).flatMap(term=>/[\p{Script=Han}]/u.test(term)&&term.length>2?Array.from({length:term.length-1},(_,i)=>term.slice(i,i+2)):[term]))].slice(0,64);
}

/** Prompt projection only: keep the complete development archive in storage. */
export function selfModelContext(state:Pick<LifeState,'selfModel'|'invalidSources'>,query='') {
  if(!state.selfModel)return undefined;
  const categories: Array<keyof SelfModel>=['personality','preferences','abilities','limitations','values','interests','habits','autobiography'];
  return Object.fromEntries(categories.map(category=>{
    const records=[];let chars=2;
    const terms=topicTerms(query);
    const candidates=[...(state.selfModel?.[category]??[])].reverse().map((record,index)=>({record,index,score:terms.filter(term=>(record.label+' '+record.value).toLowerCase().includes(term)).length}));
    candidates.sort((a,b)=>b.score-a.score||a.index-b.index);
    for(const {record,score} of candidates){
      if(!record.valid || Object.hasOwn(state.invalidSources,record.id) || !record.sourceIds.length ||
          record.sourceIds.some(id=>Object.hasOwn(state.invalidSources,id)))continue;
      const text=record.value,match=score?Math.min(...terms.map(term=>text.toLowerCase().indexOf(term)).filter(i=>i>=0)):0;
      const start=Number.isFinite(match)?Math.max(0,match-60):0;
      const summary={id:record.id,label:record.label.slice(0,80),value:text.slice(start,start+240),sourceIds:record.sourceIds.slice(0,3)};
      const size=JSON.stringify(summary).length+1;
      if(chars+size>700)continue;
      records.unshift(summary);chars+=size;
      if(records.length===2)break;
    }
    return [category,records];
  }));
}
