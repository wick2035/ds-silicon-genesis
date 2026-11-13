import { createHash } from 'node:crypto';
import type { CanonicalEnvelope } from '../storage/postgres.js';

/** Materialize archived conversation without inferring facts or public visibility. */
export function importConversation(envelope: CanonicalEnvelope, document: string, importedAt: string, attachments: Array<{index:number; id:string; mediaType:string; data:string; size:number}> = []): {count:number; warnings:string[]} {
  const parsed: unknown = JSON.parse(document.replace(/^\uFEFF/,''));
  const groups = parsed && typeof parsed === 'object' ? Object.values(parsed as Record<string,unknown>) : [];
  const digest = createHash('sha256').update(document,'utf8').digest('hex');
  const legacy = envelope.legacy as Record<string,any>;
  legacy.conversationImports ||= {};

  const events = envelope.life.events;
  const seen = new Set(events.map(e=>e.eventId));
  const warnings:string[]=[];
  let count=0, ordinal=0, missing=0;
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    for (const thread of Object.values(group as Record<string,unknown>)) {
      const messages = thread && typeof thread === 'object' && Array.isArray((thread as any).messages) ? (thread as any).messages : [];
      for (const item of messages) {
        const index=ordinal++;
        if (!item || typeof item !== 'object' || !['user','assistant'].includes(item.role) || typeof item.content !== 'string') { warnings.push(`聊天记录 ${index} 格式不支持，仅保留原文`); continue; }
        const n=typeof item.ts==='number'?item.ts:NaN;
        if (!Number.isFinite(n) || Math.abs(n)>8640000000000000) {warnings.push(`聊天记录 ${index} 缺少有效时间，仅保留原文`);continue;}
        const eventId=`legacy:conversation:${digest}:${index}`;
        const at=new Date(n).toISOString();
        if(!seen.has(eventId)){events.push({eventId,petId:envelope.petId,type:`conversation.${item.role}`,source:'legacy',occurredAt:at,receivedAt:importedAt,evidenceLevel:item.role==='user'?'reported':'inferred',payload:{text:item.content,visibility:'private',archiveDigest:digest,archiveIndex:index,legacySource:typeof item.source==='string'?item.source:undefined}});seen.add(eventId);count++;}
        const imported=attachments.filter(a=>a.index===index);
        if(imported.length){legacy.attachments ||= {};for(const attachment of imported){legacy.attachments[attachment.id] ||= {mediaType:attachment.mediaType,data:attachment.data,size:attachment.size};const attachmentEventId=`${eventId}:attachment:${attachment.id.slice(6)}`;if(!seen.has(attachmentEventId)){events.push({eventId:attachmentEventId,petId:envelope.petId,type:'attachment.shared',source:'legacy',occurredAt:at,receivedAt:importedAt,evidenceLevel:'reported',causationId:eventId,payload:{attachmentId:attachment.id,mediaType:attachment.mediaType,visibility:'private'}});seen.add(attachmentEventId);count++;}}}
        if ((item.attachment || item.attachments || item.image || item.images) && !imported.length) missing++;
      }
    }
  }
  if(missing) warnings.push(`${missing} 条记录包含未迁移的附件定位信息；原文已归档，附件不可用`);
  events.sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  legacy.conversationImports[digest]={count,importedAt};
  return {count,warnings};
}
