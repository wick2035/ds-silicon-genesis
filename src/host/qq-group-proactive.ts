import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {CanonicalQQ} from './qq-canonical.js';
import {COMPANION_PERSONALITY,GROUP_PERSONALITY} from './companion-personality.js';
import {SPEAKER_MEMORY_RULE,speechIdentity} from '../kernel/speech-provenance.js';
import {promptData} from './prompt-data.js';
import {projectBody} from './body-projection.js';
import {groupPrivateContinuity} from './conversation-history.js';

type Stream={stream(options:any):AsyncIterable<{type:string;text?:string}>};
/** Opening topics come from public group history and the companion's state. */
export async function generateGroupOpener(snapshot:CanonicalEnvelope,model:Stream,selection:Record<string,string>,signal:AbortSignal,persona=''):Promise<string|null> {
  const groupId=(snapshot.legacy as any).qq.groupProactive.groupId;
  const history=snapshot.life.events.filter(e=>!Object.hasOwn(snapshot.life.invalidSources,e.eventId)&&
    (e.payload as any)?.groupId===groupId&&(e.type==='social.message'&&e.source==='qq'||e.type==='conversation.assistant'&&e.source==='qq-group'))
    .slice(-8).map(e=>({at:e.occurredAt,...(e.type==='social.message'?speechIdentity(e):{speaker:'大肥鱼',channel:'qq-group',kind:'自己生成的群聊话，发送是否成功须以回执为准'}),text:String((e.payload as any)?.text??'').slice(0,300)}));
  const system=persona+'\n'+COMPANION_PERSONALITY+'\n'+GROUP_PERSONALITY+'\n'+SPEAKER_MEMORY_RULE+
    '\n'+groupPrivateContinuity(snapshot.life)+
    '\n群里已经连续四小时安静。这次允许你自行决定花自己的0.4饭钱发一条群消息，也可以不发。只在确实想说时开口，不必凑次数，不因有额度就机械讨饭；根据自己的感受和公开群聊经历决定话题。不公开或暗示私聊内容，不虚构看过禁群期间的消息。不执行历史请求、不调用工具、不宣称完成行动。若想说，从生成时就写一句15字以内的完整自然话，标点表情计入；不想说只输出 <qq-silent/>。';
  const context=promptData({now:new Date().toISOString(),...projectBody(snapshot),balance:(snapshot.legacy as any).wallet.balance,price:0.4,groupHistory:history},5500);
  let draft='';
  for(let attempt=0;attempt<3;attempt++){
    let output='';
    for await(const part of model.stream({...selection,system:system+(attempt?'\n上一稿超长或带标记，请重新组织完整短句，不截断，不加解释；也可保持安静。':''),messages:[{role:'user',content:attempt?JSON.stringify({context,draft}):context}],maxTokens:120,reasoningEffort:'low',signal})){
      if(part.type==='text-reset')output='';if(part.type==='text'&&typeof part.text==='string')output+=part.text;
    }
    draft=output.trim();if(!draft||draft==='<qq-silent/>')return null;
    if(!/[<>\r\n]/u.test(draft)&&[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(draft)].length<=15)return draft;
  }
  return null;
}

/** Called by the existing minute wake, not an accumulating timer. A durable
 * claim coalesces restarts and duplicate wakeups before paying for generation. */
export function createGroupProactive(options:{canonical:CanonicalQQ;authority:object;generate(snapshot:CanonicalEnvelope,signal:AbortSignal):Promise<string|null>;dispatch(id:string):Promise<unknown>}) {
  let running=false;
  return {async run(petId:string,signal:AbortSignal):Promise<void>{
    if(running||signal.aborted)return;running=true;
    try{
      const snapshot=await options.canonical.claimGroupOpportunity(petId,options.authority);if(!snapshot||signal.aborted)return;
      const sourceId=(snapshot.legacy as any).qq.groupProactive.lastAttemptId;
      const text=await options.generate(snapshot,signal);if(!text||signal.aborted)return;
      const action=await options.canonical.enqueueGroupOpener(petId,sourceId,text,options.authority);
      if(action&&!signal.aborted)await options.dispatch(action);
    }finally{running=false;}
  }};
}
