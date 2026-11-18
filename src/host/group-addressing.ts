import {createHash} from 'node:crypto';
import type {LifeEvent} from '../kernel/types.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import {groupSpeaker} from './chat-identity.js';
import {groupPeople} from './group-people.js';

type Payload={scene?:string;groupId?:string;messageId?:string;text?:string;addressing?:{
  mentionsPet?:boolean;mentionedActors?:string[];replyToMessageId?:string
}};
const payload=(event:LifeEvent)=>event.payload as Payload|undefined;
const nameKey=(name:string)=>name.normalize('NFKC').trim().toLowerCase();
const petNames=new Set(['大肥鱼','肥鱼']);
const label=(actor:string)=>actor==='pet'?'大肥鱼':groupSpeaker(actor);

export function groupAddressing(state:CanonicalEnvelope,batch:LifeEvent[]) {
  const groupId=payload(batch[0])?.groupId;
  const live=(id:string)=>!Object.hasOwn(state.life.invalidSources,id);
  const room=(event:LifeEvent)=>event.type==='social.message'&&event.source==='qq'&&
    payload(event)?.scene==='group'&&payload(event)?.groupId===groupId&&live(event.eventId);
  const publicMessages=typeof groupId==='string'?state.life.events.filter(room):[];
  const byMessageId=new Map(publicMessages.map(event=>[payload(event)?.messageId,event]));
  const identity=(state.legacy as Record<string,any>).qq?.identity;
  const sameGroup=typeof identity?.groupOpenid==='string'&&typeof identity.appId==='string'&&
    createHash('sha256').update(identity.appId+':'+identity.groupOpenid).digest('hex')===groupId;
  const inboundIds=new Set(batch.map(event=>event.eventId));
  const namedPeople=groupId?groupPeople(state.life,groupId):[];
  const currentNames=new Map(namedPeople.map(person=>[person.actorId,person.names.at(-1)?.name]));
  const describe=(actor:string)=>{
    const name=currentNames.get(actor);
    return name?`${name}（${label(actor)}）`:label(actor);
  };
  const names=new Map<string,Set<string>>([['爸爸',new Set(['dad'])]]);
  for(const person of namedPeople)for(const evidence of person.names){
    const key=nameKey(evidence.name),people=names.get(key)??new Set<string>();
    people.add(person.actorId);names.set(key,people);
  }
  const sentByPet=(messageId:string)=>sameGroup&&state.life.receipts.some(receipt=>{
    if(receipt.status!=='COMPLETED'||!live(receipt.receiptId)||receipt.details?.kind!=='qq.send'||receipt.details.messageId!==messageId)return false;
    return state.life.actions.some(action=>action.id===receipt.actionId&&action.receiptId===receipt.receiptId&&
      action.actionType==='qq.send'&&action.status==='COMPLETED'&&action.parameters.scene==='group'&&action.parameters.destination===identity.groupOpenid);
  });
  type Audience='pet'|'others'|'unresolved-quote'|'unspecified';
  function classify(event:LifeEvent) {
    const p=payload(event),text=String(p?.text??''),address=p?.addressing;
    const quoteId=address?.replyToMessageId;
    const quoted=quoteId?byMessageId.get(quoteId):undefined;
    const quoteActor=quoted?.actorId??(quoteId&&sentByPet(quoteId)?'pet':undefined);
    const direct=new Set((address?.mentionedActors??[]).filter(actor=>actor==='dad'||actor.startsWith('qq-member:')));
    if(address?.mentionsPet===true)direct.add('pet');
    if(!direct.size){
      // Only a leading address such as “小鲸，……” or “@小鲸 ……” singles
      // someone out. A name in the body may just be the topic.
      const unpunctuated=/^@?([^@\s，,:：、。！？!?]{1,40}?)(?=你)/u.exec(text)?.[1];
      const name=nameKey(/^@?([^@\s，,:：、。！？!?]{1,40})(?:[\s，,:：、]|$)/u.exec(text)?.[1]??'');
      const addressName=names.has(name)||petNames.has(name)?name:nameKey(unpunctuated??'');
      const matches=names.get(addressName);
      if(petNames.has(addressName)&&!matches?.size)direct.add('pet');
      else if(!petNames.has(addressName)&&matches?.size===1&&!matches.has(event.actorId??''))direct.add([...matches][0]);
      else if(quoteActor&&quoteActor!==event.actorId)direct.add(quoteActor);
    }
    const addressedTo:Audience=direct.has('pet')?'pet':direct.size?'others':quoteId&&!quoteActor?'unresolved-quote':'unspecified';
    return {eventId:event.eventId,speaker:groupSpeaker(event.actorId),actorId:event.actorId,text,addressedTo,
      ...(direct.size?{recipients:[...direct].map(describe)}:{}),
      ...(quoteId?{quotedSpeaker:quoteActor?describe(quoteActor):'引用对象未确认'}:{})};
  }
  const firstTime=Date.parse(batch[0].occurredAt);
  const recent=publicMessages.filter(event=>!inboundIds.has(event.eventId)&&Date.parse(event.occurredAt)<=firstTime&&firstTime-Date.parse(event.occurredAt)<=600000).slice(-6);
  const previous=recent.map(classify),lines=batch.map(classify);
  for(let index=0;index<lines.length;index++){
    const line=lines[index],prior=index>0?lines[index-1]:previous.at(-1),priorEvent=index>0?batch[index-1]:recent.at(-1);
    if(line.addressedTo!=='unspecified'||line.quotedSpeaker||prior?.addressedTo!=='others'||prior.actorId!==line.actorId||
      !priorEvent||!/^你(?!们)/u.test(line.text))continue;
    const gap=Date.parse(batch[index].occurredAt)-Date.parse(priorEvent.occurredAt);
    if(gap<0||gap>15000)continue;
    line.addressedTo='others';line.recipients=prior.recipients;
  }
  const quotedSources=batch.flatMap(event=>{
    const id=payload(event)?.addressing?.replyToMessageId;
    const quoted=id?byMessageId.get(id):undefined;
    return quoted?[quoted.eventId]:[];
  });
  return {lines,context:previous.map(({speaker,addressedTo,recipients,text})=>({speaker,addressedTo,recipients,text:text.slice(0,160)})),
    contextSources:[...new Set(recent.map(event=>event.eventId).concat(quotedSources))]};
}
