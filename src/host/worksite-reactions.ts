import type {CanonicalEnvelope} from '../storage/postgres.js';

/** Only committed manual transfers produce a reaction, never historical replay. */
export function createWorksiteReactions(initial:CanonicalEnvelope,
  respond:(petId:string,event:{eventId:string;description:string},signal:AbortSignal)=>Promise<string>,
  publish:(petId:string,event:{eventId:string;action:'enter-forced'|'release'|'force-work'|'touch'|'drag'},text:string,fallback:boolean)=>Promise<void>) {
  const seen=new Set(initial.life.events.map(event=>event.eventId));
  return (state:CanonicalEnvelope)=>{
    if(state.petId!==initial.petId)return;
    for(const event of state.life.events){
      if(seen.has(event.eventId))continue;
      seen.add(event.eventId);
      const action=(event.payload as any)?.action;
      if(event.type!=='interaction.worksite'||!['enter-forced','release','force-work','touch','drag'].includes(action)||Object.hasOwn(state.life.invalidSources,event.eventId))continue;
      const transfer={eventId:event.eventId,action:action as 'enter-forced'|'release'|'force-work'|'touch'|'drag'};
      const description=action==='touch'?'爸爸刚刚在搬砖工地碰了碰你，请根据当前身体和心情自然回应。':action==='drag'?'爸爸刚刚在搬砖工地拖动了你，原来的动作被打断，请根据此刻感受自然回应。':action==='enter-forced'?'爸爸刚刚把你拖进了搬砖网页，只有爸爸能接你出去。请根据自己的感受自然地对爸爸说一句话。':action==='release'?'爸爸刚刚把你从搬砖网页接回了桌面。请根据自己的感受自然地对爸爸说一句话。':'爸爸刚刚强制你进入工地继续搬砖，违背了你的意愿。这次强迫已使恐惧与压力上升、安全感下降；实际疼痛与疲惫见身体记录。结合被强迫的经历、当前恐惧、疼痛和与爸爸的关系，自主决定如何反应、表达或抗议，不要把这当作自愿接活，不要编造未发生的搬运或伤害。';
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
      const deadline=new Promise<string>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve('');},30000);});
      void Promise.race([Promise.resolve().then(()=>respond(state.petId,{eventId:event.eventId,description},controller.signal)).catch(()=>''),deadline])
        .finally(()=>clearTimeout(timer)).then(text=>publish(state.petId,transfer,text.trim()||'【系统反馈】工地操作已记录，她暂时未能生成回应。请检查模型连接。',!text.trim())).catch(error=>console.error('[worksite] 无法显示回应',error));
    }
  };
}
