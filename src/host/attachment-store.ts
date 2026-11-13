import {createHash} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
/** Bytes stay in the canonical PG envelope; references never contain a path. */
export function createAttachmentStore(store:Reader,gate:PetGate,uow:UnitOfWork) {
  async function put(petId:string,requestId:string,input:{mediaType:string;data:Uint8Array}) {
    if(!/^[A-Za-z0-9:-]{8,140}$/.test(requestId)||!(input.data instanceof Uint8Array)||input.data.length<12||input.data.length>5_000_000)throw Error('图片附件无效');
    const b=Buffer.from(input.data),type=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'?'image/webp':/^GIF8[79]a$/.test(b.subarray(0,6).toString())?'image/gif':'';
    if(!type||type!==input.mediaType)throw Error('图片格式不匹配');
    const digest=createHash('sha256').update(b).digest('hex'),id='image:'+digest,sourceEventId='attachment:'+createHash('sha256').update(petId+'\0'+requestId).digest('hex');
    await gate.run(petId,async()=>{const state=await store.loadEnvelope(petId);if(!state||gate.signal.aborted)throw Error('附件存储不可用');
      await uow.apply(petId,state.version,draft=>{const p=draft.legacy as Record<string,any>;p.attachments||={};const existing=draft.life.events.find(e=>e.eventId===sourceEventId);
        if(existing){if((existing.payload as any)?.attachmentId!==id)throw Error('附件请求编号冲突');return {};}
        p.attachments[id]||={mediaType:type,data:b.toString('base64'),size:b.length};
        const at=new Date().toISOString();draft.life.events.push({eventId:sourceEventId,petId,type:'attachment.shared',source:'user',actorId:'dad',occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{attachmentId:id,mediaType:type}});return {};});});
    return {petId,id,sourceEventId};
  }
  async function resolve(raw:unknown,signal:AbortSignal){const ref=raw as any;if(signal.aborted||!ref||typeof ref.petId!=='string'||!/^image:[a-f0-9]{64}$/.test(ref.id))throw Error('图片引用无效');
    const state=await store.loadEnvelope(ref.petId),item=(state?.legacy as any)?.attachments?.[ref.id];if(!item||!['image/png','image/jpeg','image/webp','image/gif'].includes(item.mediaType)||typeof item.data!=='string')throw Error('图片附件不存在');
    const data=Buffer.from(item.data,'base64');if(data.length!==item.size||data.length>5_000_000||'image:'+createHash('sha256').update(data).digest('hex')!==ref.id)throw Error('图片附件损坏');return {mediaType:item.mediaType,data};}
  return {put,resolve};
}
