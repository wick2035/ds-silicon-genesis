import type {CanonicalEnvelope} from '../storage/postgres.js';

/** React only to new committed care, never to a pending or interrupted action. */
export function createCareReactions(initial:CanonicalEnvelope, respond:(petId:string,event:{eventId:string;description:string})=>Promise<string>, publish:(text:string)=>void) {
  const seen=new Set(initial.life.events.map(event=>event.eventId));
  return (state:CanonicalEnvelope) => {
    if(state.petId!==initial.petId)return;
    for(const event of state.life.events) {
      if(seen.has(event.eventId))continue;
      seen.add(event.eventId);
      const action=(event.payload as any)?.action;
      const descriptions:Record<string,string>={feed:'爸爸刚刚喂了你一口饭，你真的吃到了',water:'爸爸刚刚给你喝了水',pet:'爸爸刚刚摸摸你',play:'你刚刚和爸爸一起玩了一会儿',soothe:'爸爸刚刚安慰了你',accompany:'你刚刚和爸爸安静地待了一会儿'};
      if(!['social.care','body.meal'].includes(event.type)||!Object.hasOwn(descriptions,action)||Object.hasOwn(state.life.invalidSources,event.eventId))continue;
      const description=(event.type==='body.meal'?'你刚刚真的吃完了一碗饭':descriptions[action])+'，请根据自己的身体感受和心情自然说一句。';
      const fallback=typeof (state.humanity as any).lastThought==='string'?(state.humanity as any).lastThought:'';
      void Promise.resolve().then(()=>respond(state.petId,{eventId:event.eventId,description})).then(text=>{if(text.trim())publish(text);}).catch(()=>{if(fallback)publish(fallback);});
    }
  };
}
