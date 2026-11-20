import type {LifeState, SelfModel,LifeEvent,DevelopmentRecord} from '../kernel/types.js';

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

/** Explicit expiry/supersession wins; undated contradictory claims stay marked
 * as uncertain instead of becoming a new identity. Versions remain traceable. */
export function cognitiveSelfModel(model:SelfModel|undefined,events:LifeEvent[],query='',now=Date.now()) {
  const byId=new Map(events.map(e=>[e.eventId,e])),terms=topicTerms(query);
  type Version=DevelopmentRecord&{category:string;revision:number;observedAt?:string};
  const supersededIds=new Set(Object.values(model??{}).flatMap(records=>(records as DevelopmentRecord[]).filter(r=>r.valid&&(!r.validFrom||Date.parse(r.validFrom)<=now)).flatMap(r=>r.supersedes??[])));
  const groups=new Map<string,Version[]>();
  for(const [category,records] of Object.entries(model??{}))for(const [index,record] of (records as DevelopmentRecord[]).entries()){
    if(!record.valid||supersededIds.has(record.id)||!record.sourceIds.length||record.validUntil&&Date.parse(record.validUntil)<=now||record.validFrom&&Date.parse(record.validFrom)>now)continue;
    const times=record.sourceIds.map(id=>byId.get(id)?.occurredAt).filter((s):s is string=>!!s).sort();
    const version={...record,category,revision:record.version??index+1,observedAt:record.createdAt??times.at(-1)};
    const key=category+':'+(category==='autobiography'?record.value:record.label).normalize('NFKC').trim().toLowerCase();
    groups.set(key,[...(groups.get(key)??[]),version]);
  }
  const tendencies:Record<string,unknown>[]=[],evidence:Record<string,unknown>[]=[],conflicts:Record<string,unknown>[]=[];
  const summary=(r:Version)=>({id:r.id,label:r.label,value:r.value,category:r.category,version:r.revision,observedAt:r.observedAt,sourceIds:r.sourceIds});
  for(const records of groups.values()){
    const superseded=new Set(records.flatMap(r=>r.supersedes??[]));
    const live=records.filter(r=>!superseded.has(r.id)).sort((a,b)=>(b.observedAt??'').localeCompare(a.observedAt??'')||b.revision-a.revision);
    const unique=[...new Map([...live].reverse().map(r=>[r.value.normalize('NFKC').trim(),r])).values()].reverse();
    if(!unique.length)continue;
    const latest=unique[0],versions=records.filter(r=>r.id!==latest.id).slice(-2).map(r=>({id:r.id,version:r.revision}));
    const entry={...summary(latest),previousVersions:versions,status:unique.length>1?'conflicted':'current'};
    if(latest.category==='autobiography')evidence.push(entry);else tendencies.push(entry);
    if(unique.length>1)conflicts.push({category:latest.category,label:latest.label,status:'unresolved',alternatives:unique.slice(0,2).map(summary)});
  }
  const rank=(items:Record<string,unknown>[])=>items.sort((a,b)=>terms.filter(t=>JSON.stringify(b).includes(t)).length-terms.filter(t=>JSON.stringify(a).includes(t)).length||String(b.observedAt??'').localeCompare(String(a.observedAt??'')));
  return {tendencies:rank(tendencies),evidence:rank(evidence),conflicts:rank(conflicts)};
}
