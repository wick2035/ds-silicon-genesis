import {randomUUID} from 'node:crypto';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
import {projectLegacySnapshot} from './legacy-snapshot.js';

type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
type Action='enter-forced'|'enter-voluntary'|'release'|'leave-voluntary'|'touch'|'drag'|'force-work';

/** The helper is the sole caller. A location is committed before either body
 * changes visibility; the forced-entry lock survives window and host restarts. */
export function createWorksite(store:Reader,gate:PetGate,uow:UnitOfWork,view:(id:string)=>unknown,cancel:(id:string)=>void,wake?:(id:string)=>void) {
  const snapshot=async(id:string)=>{
    const state=await store.loadEnvelope(id);if(!state)throw Error('生命状态不可用');
    const pet=state.legacy as Record<string,any>,projected=projectLegacySnapshot(state);
    return {location:pet.worksite||{inside:false,forced:false},labor:projected.labor,world:{...projected.world,command:view(id)??null}};
  };
  return {snapshot,async act(id:string,action:Action){
    if(!['enter-forced','enter-voluntary','release','leave-voluntary','touch','drag','force-work'].includes(action))throw Error('工地操作无效');
    if(['enter-forced','enter-voluntary','release','leave-voluntary','drag'].includes(action))cancel(id);
    await gate.run(id,async()=>{
      const state=await store.loadEnvelope(id);if(!state)throw Error('生命状态不可用');
      await uow.apply(id,state.version,draft=>{
        const pet=draft.legacy as Record<string,any>,site=pet.worksite||={inside:false,forced:false};
        let text='';
        if(action==='force-work'){
          if(!site.inside)throw Error('她不在工地里');
          const contract=pet.labor?.contracts?.find((c:any)=>['working','paused'].includes(c.status) && Number.isFinite(c.done) && c.done<c.trips);
          if(!contract)throw Error('现在没有可强行开始的工作约定');
          // Force a batch regardless of body condition. The pet's distress is
          // recorded as real evidence (pain/drain) downstream, not assumed here.
          contract.status='working';contract.forced=true;contract.workPermit=true;contract.batchRemaining=1;
          contract.lastWorkDecision=Date.now();contract.nextDecision=Date.now()+60000;
          contract.behavior='爸爸强行让我继续搬砖';
          text='爸爸强行按下，要我继续搬砖。';
        }else if(action==='enter-forced'||action==='enter-voluntary'){
          if(site.inside)throw Error('她已经在工地里');
          if(action==='enter-voluntary' && (!site.requested || draft.life.constraints.paused))throw Error('她没有决定进入工地');
          delete site.speech;
          site.inside=true;site.forced=action==='enter-forced';site.requested=false;
          text=site.forced?'爸爸把我拖进搬砖网页，我需要爸爸把我拿出去。':'我自己决定进入搬砖网页工作。';
        }else if(action==='release'||action==='leave-voluntary'){
          if(!site.inside)throw Error('她不在工地里');
          if(action==='leave-voluntary'&&site.forced)throw Error('被爸爸放进来后，要等爸爸亲手接我出去');
          delete site.speech;
          site.inside=false;site.forced=false;site.requested=false;
          site.suppressUntilDecision=true;
          for(const contract of pet.labor?.contracts||[])if(contract.status==='working'){
            contract.workPermit=false;contract.batchRemaining=0;
            contract.nextDecision=Math.max(Number(contract.nextDecision)||0,Date.now()+60000);
          }
          text=action==='release'?'爸爸把我从搬砖网页里拿出来了。':'我自己离开了搬砖网页。';
        }else{
          if(!site.inside)throw Error('她不在工地里');
          text=action==='touch'?'爸爸在搬砖网页里碰了碰我。':'爸爸在搬砖网页里拖动了我，当前动作被打断。';
        }
        const command=pet.world?.command;
        if(['enter-forced','enter-voluntary','release','leave-voluntary','drag','force-work'].includes(action)&&command?.source==='labor'&&['queued','running'].includes(command.status)){
          command.status='interrupted';command.interruptedReason=action==='force-work'?'force-work':'worksite-transition';
          const c=pet.labor?.contracts?.find((x:any)=>x.id===command.labor?.id);if(c&&action==='drag')c.carrying=false;
        }
        const at=new Date().toISOString(),eventId='worksite:'+randomUUID();
        (pet.events||=[]).push({id:eventId,kind:'interaction',text,ts:Date.parse(at)});
        draft.life.events.push({eventId,petId:id,type:'interaction.worksite',source:action.includes('voluntary')?'scheduler':'user',...(action.includes('voluntary')?{}:{actorId:'dad'}),occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{action,description:text}});
        // A forced batch is a deliberate event she should remember; the memory
        // records the fact, while her distress is expressed by her own body and
        // reactions rather than a hard-coded feeling.
        if(action==='force-work'){
          const memoryId='worksite-memory:'+eventId;
          if(!draft.life.memories.some(m=>m.id===memoryId))draft.life.memories.push({id:memoryId,kind:'autobiographical',content:'爸爸在搬砖工地强行按下按钮，要我继续搬砖。',sourceIds:[eventId],evidenceLevel:'observed',valid:true,createdAt:at});
        }
        return {};
      });
    });
    const result=await snapshot(id);
    if(action==='enter-forced'||action==='enter-voluntary'||action==='force-work')try{wake?.(id);}catch{/* The normal scheduler can retry. */}
    return result;
  }};
}
