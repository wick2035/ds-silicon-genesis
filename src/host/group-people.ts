import type {LifeState} from '../kernel/types.js';

type RecordState=Pick<LifeState,'events'|'invalidSources'>;
type NameEvidence={name:string;at:string;sourceId:string;kind:'platform'|'self'|'dad'};
export type GroupPerson={actorId:string;names:NameEvidence[]};

/** Names are source-backed descriptions, never identity or authority. Rebuild
 * from the event log so old conversations work without changing the archive. */
export function groupPeople(state:RecordState,groupId?:string):GroupPerson[] {
  const people=new Map<string,NameEvidence[]>();
  const events=[...state.events].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const add=(actorId:string,name:unknown,event:typeof events[number],kind:NameEvidence['kind'])=>{
    if(typeof name!=='string')return;
    const clean=name.trim().replace(/[。！!？?，,\s]+$/u,'');
    if(!clean || clean.length>40 || /[\r\n\x00-\x1f<>]/u.test(clean))return;
    const names=people.get(actorId)??[];
    names.push({name:clean,at:event.occurredAt,sourceId:event.eventId,kind});people.set(actorId,names);
  };
  for(const e of events){
    if(Object.hasOwn(state.invalidSources,e.eventId))continue;
    const p=e.payload as Record<string,unknown>|undefined;
    if(e.type==='social.message'&&e.source==='qq'&&p?.scene==='group'&&(!groupId||p.groupId===groupId)&&e.actorId?.startsWith('qq-member:')){
      add(e.actorId,p.nickname,e,'platform');
      const text=typeof p.text==='string'?p.text.trim():'';
      const self=/^(?:我(?:现在)?(?:叫|的名字是|的昵称是)|(?:我的)?昵称(?:改成|叫|是))\s*[：:]?\s*([^\s，。！？,!?.]{1,40})[。！!？?]?$/u.exec(text);
      if(self && !/^(?:了|过|人|你|他|她|爸爸|爸|自己)$/u.test(self[1]))add(e.actorId,self[1],e,'self');
    }
    if(e.type==='conversation.user'&&e.actorId==='dad'&&['desktop','qq-c2c'].includes(e.source)&&typeof p?.text==='string'){
      const match=/\b(qq-member:[a-zA-Z0-9_-]{1,100})\s*(?:就是|叫|的(?:名字|昵称)是|的名字叫)\s*([^\s，。！？,!?.]{1,40})/u.exec(p.text);
      if(match&&(!groupId||people.has(match[1])))add(match[1],match[2].replace(/[啊呀啦]$/u,''),e,'dad');
    }
  }
  return [...people].map(([actorId,names])=>({actorId,names}));
}

export function groupPeopleContext(state:RecordState,actorIds?:string[],query='') {
  const allowed=actorIds?new Set(actorIds):null;
  const all=groupPeople(state).filter(p=>!allowed||allowed.has(p.actorId)).sort((a,b)=>
    Date.parse(a.names.at(-1)!.at)-Date.parse(b.names.at(-1)!.at));
  const matches=all.filter(p=>query && (query.includes(p.actorId)||p.names.some(n=>query.includes(n.name))));
  const selected=[...new Set([...all.slice(-8),...matches])].slice(-8);
  return selected.map(p=>{
    const latest=p.names.at(-1)!;
    // One surviving source per distinct name; repeated platform observations
    // must not make a single turn depend on thousands of messages.
    const unique=new Map<string,NameEvidence>();
    for(const evidence of p.names){unique.delete(evidence.name);unique.set(evidence.name,evidence);}
    const relevant=[...unique.values()].filter(n=>query.includes(n.name));
    const names=[...new Set([...unique.values()].slice(-8).concat(relevant,latest))].slice(-8);
    return {actorId:p.actorId,currentName:latest.name,nameKind:latest.kind,history:names.map(n=>n.name),sourceIds:names.map(n=>n.sourceId)};
  });
}
