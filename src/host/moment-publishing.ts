import {createHash} from 'node:crypto';
import {momentEventType, momentLimitReason, momentSources, readMoments, type MomentDraft} from '../kernel/moments.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import {redactDadNames} from '../../vendor/pet-plugins/behavior/memory-privacy.mjs';

export const speechMomentId=(requestId:string)=>'moment:speech:'+createHash('sha256').update(requestId).digest('hex');

/** Both cognition and chat publish through the same source and frequency checks. */
export function appendMoment(life:CanonicalEnvelope['life'],petId:string,draft:MomentDraft,id:string,now=Date.now()) {
  if(typeof draft?.text!=='string'||!draft.text.trim()||draft.text.trim().length>160||typeof draft.sourceId!=='string')throw Error('说说需要160字以内的正文和真实经历来源');
  const text=redactDadNames(draft.text).trim();
  if(!text)throw Error('说说正文为空');
  const prior=life.events.find(event=>event.eventId===id);
  if(prior){
    const posted=readMoments(life).find(moment=>moment.id===id);
    const data=prior.payload as {text?:string;sourceIds?:string[]};
    if(!posted||data.text!==text||!data.sourceIds?.includes(draft.sourceId))throw Error('这次请求已有不同或失效的说说');
    return {status:'COMPLETED' as const,moment:posted};
  }
  const limit=momentLimitReason(life,now);if(limit)throw Error(limit);
  const context=momentSources(life,now).get(draft.sourceId);
  if(!context)throw Error('这条经历已分享、过期或失效，请重新选择可分享的经历');
  const noteId='memory:'+draft.sourceId;
  const sourceIds=life.memories.some(memory=>memory.id===noteId&&memory.valid)?[draft.sourceId,noteId]:[draft.sourceId];
  const at=new Date(now).toISOString();
  life.events.push({eventId:id,petId,type:momentEventType,source:'model',occurredAt:at,receivedAt:at,evidenceLevel:'inferred',payload:{text,context,sourceIds}});
  return {status:'COMPLETED' as const,moment:{id,at,text,context}};
}

export function momentPublication(life:CanonicalEnvelope['life'],now=Date.now()) {
  const eligible=momentSources(life,now);
  return {scope:'本机生命空间',unavailableReason:momentLimitReason(life,now),
    recent:readMoments(life).slice(0,2),
    sources:life.events.filter(event=>eligible.has(event.eventId)).slice(-6).map(event=>({sourceId:event.eventId,at:event.occurredAt,context:eligible.get(event.eventId),experience:JSON.stringify(event.payload)?.slice(0,500)}))};
}
