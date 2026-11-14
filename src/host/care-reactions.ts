import type {CanonicalEnvelope} from '../storage/postgres.js';

/** React only to new committed care, never to a pending or interrupted action. */
export function createCareReactions(initial:CanonicalEnvelope, respond:(petId:string,event:{eventId:string;description:string},signal:AbortSignal)=>Promise<string>, publish:(text:string)=>void) {
  const seen=new Set(initial.life.events.map(event=>event.eventId));
  const pending=new Map<string,Promise<string>>();
  const observe=(state:CanonicalEnvelope) => {
    if(state.petId!==initial.petId)return;
    for(const event of state.life.events) {
      if(seen.has(event.eventId))continue;
      seen.add(event.eventId);
      const action=(event.payload as any)?.action;
      const descriptions:Record<string,string>={feed:'爸爸刚刚喂了你一口饭，你真的吃到了',water:'爸爸刚刚给你喝了水',pet:'爸爸刚刚摸摸你',play:'你刚刚和爸爸一起玩了一会儿',soothe:'爸爸刚刚安慰了你',accompany:'你刚刚和爸爸安静地待了一会儿'};
      if(!['social.care','body.meal'].includes(event.type)||!Object.hasOwn(descriptions,action)||Object.hasOwn(state.life.invalidSources,event.eventId))continue;
      const description=(event.type==='body.meal'?'你刚刚真的吃完了一碗饭':descriptions[action])+'，请根据自己的身体感受和心情自然说一句。';
      const fallback=({feed:'嗯，好香，谢谢爸爸。',water:'咕噜……喝到啦，谢谢爸爸。',pet:'嗯，被摸到了。',play:'和爸爸一起玩真好。',soothe:'谢谢爸爸，我慢慢缓一缓。',accompany:'爸爸在旁边，真好。'} as Record<string,string>)[action];
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
      const deadline=new Promise<string>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(fallback);},5000);});
      const task=Promise.race([Promise.resolve().then(()=>respond(state.petId,{eventId:event.eventId,description},controller.signal)),deadline])
        .then(text=>text.trim()||fallback).catch(()=>fallback).finally(()=>clearTimeout(timer)).then(text=>{if(text)try{publish(text);}catch(error){console.error('[care] 无法显示回应',error);}return text;});
      pending.set(event.eventId,task);
      if(pending.size>100)pending.delete(pending.keys().next().value!);
    }
  };
  observe.wait=async(eventId:string,timeoutMs=6000):Promise<string|undefined>=>{
    const task=pending.get(eventId);if(!task)return undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([task,new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),timeoutMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  };
  return observe;
}

/** Care is a manual interaction; honour the same voice setting as a chat reply. */
export function careReactionLeaf(text:string,voiceEnabled:boolean) {
  return {text,careReaction:true,chatRecord:true,anim:false,duration:12000,...(voiceEnabled?{voiceTo:'desktop'}:{})};
}
