import type {CanonicalEnvelope} from '../storage/postgres.js';

/** Only committed manual transfers produce a reaction, never historical replay. */
export function createWorksiteReactions(initial:CanonicalEnvelope,
  respond:(petId:string,event:{eventId:string;description:string},signal:AbortSignal)=>Promise<string>,
  publish:(petId:string,event:{eventId:string;action:'enter-forced'|'release'},text:string,fallback:boolean)=>Promise<void>) {
  const seen=new Set(initial.life.events.map(event=>event.eventId));
  return (state:CanonicalEnvelope)=>{
    if(state.petId!==initial.petId)return;
    for(const event of state.life.events){
      if(seen.has(event.eventId))continue;
      seen.add(event.eventId);
      const action=(event.payload as any)?.action;
      if(event.type!=='interaction.worksite'||!['enter-forced','release'].includes(action)||Object.hasOwn(state.life.invalidSources,event.eventId))continue;
      const transfer={eventId:event.eventId,action:action as 'enter-forced'|'release'};
      const fallback=action==='enter-forced'?'哎呀，爸爸把我放进工地啦，记得来接我哦。':'爸爸接我出来啦，谢谢爸爸。';
      const description=action==='enter-forced'?'爸爸刚刚把你拖进了搬砖网页，只有爸爸能接你出去。请根据自己的感受自然地对爸爸说一句话。':'爸爸刚刚把你从搬砖网页接回了桌面。请根据自己的感受自然地对爸爸说一句话。';
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
      const deadline=new Promise<{text:string;fallback:boolean}>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({text:fallback,fallback:true});},5000);});
      void Promise.race([Promise.resolve().then(()=>respond(state.petId,{eventId:event.eventId,description},controller.signal)).then(text=>({text:text.trim()||fallback,fallback:!text.trim()})).catch(()=>({text:fallback,fallback:true})),deadline])
        .finally(()=>clearTimeout(timer)).then(result=>publish(state.petId,transfer,result.text,result.fallback)).catch(error=>console.error('[worksite] 无法显示回应',error));
    }
  };
}
