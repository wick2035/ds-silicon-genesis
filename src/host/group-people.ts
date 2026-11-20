import type {LifeState} from '../kernel/types.js';

type RecordState=Pick<LifeState,'events'|'invalidSources'>;
type NameEvidence={name:string;at:string;sourceId:string;kind:'platform'|'self'|'dad'};
export type GroupPerson={actorId:string;names:NameEvidence[];remark?:NameEvidence;lastSeenAt?:string;lastMessage?:string;groupIds:string[]};

export function cleanGroupName(value:unknown):string|undefined {
  if(typeof value!=='string')return;
  const name=value.trim();
  if(name && name.length<=40 && !/[\x00-\x1f\x7f<>\u2028\u2029]/u.test(name))return name;
}

/** Only authenticated platform fields supply a platform nickname. */
export function platformNickname(author:{nickname?:unknown;username?:unknown}|undefined):string|undefined {
  return cleanGroupName(author?.nickname)??cleanGroupName(author?.username);
}

/** Names are source-backed descriptions, never identity or authority. Rebuild
 * from the event log so old conversations work without changing the archive. */
export function groupPeople(state:RecordState,groupId?:string):GroupPerson[] {
  const people=new Map<string,GroupPerson>();
  const person=(actorId:string)=>{
    if(!people.has(actorId))people.set(actorId,{actorId,names:[],groupIds:[]});
    return people.get(actorId)!;
  };
  const events=[...state.events].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const add=(actorId:string,name:unknown,event:typeof events[number],kind:NameEvidence['kind'])=>{
    const clean=cleanGroupName(name);
    if(!clean)return;
    person(actorId).names.push({name:clean,at:event.occurredAt,sourceId:event.eventId,kind});
  };
  for(const e of events){
    if(Object.hasOwn(state.invalidSources,e.eventId))continue;
    const p=e.payload as Record<string,unknown>|undefined;
    if(e.type==='social.message'&&e.source==='qq'&&p?.scene==='group'&&e.actorId?.startsWith('qq-member:')){
      const member=person(e.actorId);member.lastSeenAt=e.occurredAt;member.lastMessage=typeof p.text==='string'?p.text.slice(0,120):'';
      if(typeof p.groupId==='string'&&!member.groupIds.includes(p.groupId))member.groupIds.push(p.groupId);
      add(e.actorId,p.nickname,e,'platform');
      const text=typeof p.text==='string'?p.text.trim():'';
      const self=/^(?:我(?:现在)?(?:叫|的名字是|的昵称是)|(?:我的)?昵称(?:改成|叫|是))\s*[：:]?\s*([^\s，。！？,!?.]{1,40})[。！!？?]?$/u.exec(text);
      if(self && !/^(?:了|过|人|你|他|她|爸爸|爸|自己)$/u.test(self[1]))add(e.actorId,self[1],e,'self');
    }
    if(e.type==='conversation.user'&&e.actorId==='dad'&&['desktop','qq-c2c'].includes(e.source)&&typeof p?.text==='string'){
      const match=/\b(qq-member:[a-zA-Z0-9_-]{1,100})\s*(?:就是|叫|的(?:名字|昵称)是|的名字叫)\s*([^\s，。！？,!?.]{1,40})/u.exec(p.text);
      if(match)add(match[1],match[2].replace(/[啊呀啦]$/u,''),e,'dad');
    }
    if(e.type==='management.group-remark'&&e.source==='user'&&e.actorId==='dad'&&typeof p?.actorId==='string'&&p.actorId.startsWith('qq-member:')){
      const member=person(p.actorId),name=cleanGroupName(p.remark);
      if(name)member.remark={name,at:e.occurredAt,sourceId:e.eventId,kind:'dad'};
      else if(p.remark==='')delete member.remark;
    }
  }
  return [...people.values()].filter(p=>!groupId||p.groupIds.includes(groupId));
}

export function groupPeopleDirectory(state:RecordState) {
  return groupPeople(state).filter(p=>p.lastSeenAt).sort((a,b)=>Date.parse(b.lastSeenAt!)-Date.parse(a.lastSeenAt!)).map(p=>({
    actorId:p.actorId,remark:p.remark?.name??'',nickname:p.names.filter(n=>n.kind==='platform').at(-1)?.name??'',
    displayName:p.remark?.name??p.names.at(-1)?.name??'未备注群友',automaticName:p.names.at(-1)?.name??'未备注群友',lastSeenAt:p.lastSeenAt,lastMessage:p.lastMessage,
    history:[...new Set(p.names.map(n=>n.name))],
  }));
}

export function groupPeopleContext(state:RecordState,actorIds?:string[],query='') {
  const allowed=actorIds?new Set(actorIds):null;
  const all=groupPeople(state).filter(p=>(p.names.length||p.remark)&&(!allowed||allowed.has(p.actorId))).sort((a,b)=>
    Date.parse(a.lastSeenAt??a.remark?.at??a.names.at(-1)!.at)-Date.parse(b.lastSeenAt??b.remark?.at??b.names.at(-1)!.at));
  const matches=all.filter(p=>query && (query.includes(p.actorId)||(p.remark&&query.includes(p.remark.name))||p.names.some(n=>query.includes(n.name))));
  const selected=[...new Set([...all.slice(-8),...matches])].slice(-8);
  return selected.map(p=>{
    const latest=p.remark??p.names.at(-1)!;
    // One surviving source per distinct name; repeated platform observations
    // must not make a single turn depend on thousands of messages.
    const unique=new Map<string,NameEvidence>();
    for(const evidence of p.names){unique.delete(evidence.name);unique.set(evidence.name,evidence);}
    const relevant=[...unique.values()].filter(n=>query.includes(n.name));
    const names=[...new Set([...unique.values()].slice(-8).concat(relevant,latest))].slice(-8);
    return {actorId:p.actorId,currentName:latest.name,nameKind:latest.kind,...(p.remark?{remark:p.remark.name,preferredName:p.remark.name}:{}),history:[...new Set(names.map(n=>n.name))],sourceIds:[...new Set(names.map(n=>n.sourceId))]};
  });
}
