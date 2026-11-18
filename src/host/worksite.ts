import {farmVisit} from './farm.js';
import {randomUUID} from 'node:crypto';
import {advanceHumanity} from '../../vendor/dsh-pet/src/host/humanity.mjs';
import {setSpiritRest} from '../kernel/spirit.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
import {hasForcedWork} from './forced-labor.js';
import {uncertainLabor} from './labor-pending.js';
import {projectLegacySnapshot} from './legacy-snapshot.js';

type Reader={loadEnvelope(id:string):Promise<CanonicalEnvelope|null>};
type Action='enter-forced'|'enter-voluntary'|'release'|'leave-voluntary'|'touch'|'drag'|'force-work'|'request-entry'|'stop-work'|'resume-work'|'retry-unconfirmed';

/** The helper is the sole caller. A location is committed before either body
 * changes visibility; the forced-entry lock survives window and host restarts. */
export function createWorksite(store:Reader,gate:PetGate,uow:UnitOfWork,view:(id:string)=>unknown,cancel:(id:string)=>void,wake?:(id:string)=>void) {
  const snapshot=async(id:string)=>{
    const state=await store.loadEnvelope(id);if(!state)throw Error('生命状态不可用');
    const pet=state.legacy as Record<string,any>,projected=projectLegacySnapshot(state);
    return {farmInside:!!farmVisit(state),location:pet.worksite||{inside:false,forced:false},waitingForReceipt:uncertainLabor(state).length>0,labor:projected.labor,world:{...projected.world,command:view(id)??null}};
  };
  return {snapshot,async act(id:string,action:Action,expected?:{sessionId:string;contractId:string}){
    if(!['enter-forced','enter-voluntary','release','leave-voluntary','touch','drag','force-work','request-entry','stop-work','resume-work','retry-unconfirmed'].includes(action))throw Error('工地操作无效');
    if(['enter-forced','enter-voluntary','release','leave-voluntary','drag'].includes(action))cancel(id);
    await gate.run(id,async()=>{
      const state=await store.loadEnvelope(id);if(!state)throw Error('生命状态不可用');
      await uow.apply(id,state.version,draft=>{
        const pet=draft.legacy as Record<string,any>,site=pet.worksite||={inside:false,forced:false};
        if(farmVisit(draft) && ['enter-forced','enter-voluntary','force-work','request-entry'].includes(action))throw Error('她在稻田里，请先接她回桌面');
        let text='';
        if(expected){const active=pet.labor?.contracts?.find((c:any)=>['working','paused','queued'].includes(c.status)&&c.done<c.trips);if(!site.inside||site.workState!=='running'||site.sessionId!==expected.sessionId||active?.status==='paused'||(active?.id??site.lastCompletedContractId)!==expected.contractId||hasForcedWork(draft))throw Error('工作状态已变化');}
        if(action==='retry-unconfirmed'){
          if(!site.inside)throw Error('她不在工地里');
          const uncertain=uncertainLabor(draft);if(!uncertain.length)throw Error('没有待确认的当前动作');
          site.acknowledgedUncertainActions=[...new Set([...(site.acknowledgedUncertainActions??[]),...uncertain])];
          site.workState='running';site.sessionId=randomUUID();site.completedInSession=0;site.reviewedThrough=0;delete site.stopReason;
          text='爸爸选择不计入未确认的动作，重新搬这一趟；原来的未知回执仍保留。';
        }else if(action==='request-entry'){
          if(site.inside||site.requested)throw Error('她已经在工地里或正在前往');
          if(draft.life.constraints.paused)throw Error('自主活动已暂停');
          site.requested=true;site.suppressUntilDecision=false;text='我决定去工地看看。';
        }else if(action==='stop-work'){
          if(!site.inside)throw Error('她不在工地里');
          if(hasForcedWork(draft))throw Error('强制干活正在进行，普通停工不能中断');
          site.workState='stopped';site.sessionId=randomUUID();site.stopReason='choice';
          text='我决定暂时停工，留在工地里。';
        }else if(action==='resume-work'){
          if(!site.inside)throw Error('她不在工地里');
          if(hasForcedWork(draft))throw Error('强制干活正在进行');
          if(site.workState!=='stopped')return {}; // Repeated resume must not reset the 15-trip counter.
          site.workState='running';site.sessionId=randomUUID();site.completedInSession=0;site.reviewedThrough=0;delete site.stopReason;
          text='恢复普通工作；有任务时会继续搬砖。';
        }else if(action==='force-work'){
          const labor=pet.labor||={contracts:[]};labor.contracts||=[];
          let contract=labor.contracts.find((c:any)=>['offered','working','paused','queued'].includes(c.status) && Number.isFinite(c.done) && c.done<c.trips);
          if(!contract){
            contract={id:randomUUID(),status:'working',trips:1,done:0,wage:0,wageUnspecified:true,paid:0,carrying:false,surface:'web',created:Date.now(),payments:[],decisions:[]};
            labor.contracts.unshift(contract);
          }
          site.inside=true;site.forced=true;site.requested=false;site.suppressUntilDecision=false;
          site.workState='running';site.sessionId=randomUUID();site.completedInSession=0;site.reviewedThrough=0;delete site.stopReason;
          delete site.speech;
          // Force a batch regardless of body condition. The pet's distress is
          // recorded as real evidence (pain/drain) downstream, not assumed here.
          contract.status='working';contract.forced=true;contract.workPermit=true;contract.batchRemaining=contract.trips-contract.done;
          contract.lastWorkDecision=Date.now();contract.nextDecision=Date.now()+60000;
          contract.behavior='爸爸强行让我继续搬砖';
          draft.humanity=advanceHumanity(draft.humanity,Date.now());
          const human=draft.humanity as Record<string,any>,clamp=(n:number)=>Math.max(0,Math.min(100,n));
          human.sleeping=false;human.restingUntil=0;human.awakeUntil=Date.now()+60000;setSpiritRest(draft.life,'awake');
          human.stats.stress=clamp(human.stats.stress+14);human.stats.security=clamp(human.stats.security-12);human.stats.comfort=clamp(human.stats.comfort-8);
          human.emotions.fear=clamp(human.emotions.fear+18);human.emotions.anger=clamp(human.emotions.anger+8);
          text=(contract.wageUnspecified===true?'爸爸强制让我进工地先搬一趟，尚未商量工钱。':'爸爸强行按下，要我按现有任务继续搬砖；这不代表我自愿答应。')+'这次被强迫使我紧张、害怕，安全感下降。实际搬运造成的疼痛和消耗另按身体回执记录。';
        }else if(action==='enter-forced'||action==='enter-voluntary'){
          if(site.inside)throw Error('她已经在工地里');
          if(action==='enter-voluntary' && (!site.requested || draft.life.constraints.paused))throw Error('她没有决定进入工地');
          delete site.speech;
          site.inside=true;site.forced=action==='enter-forced';site.requested=false;
          site.workState='running';site.sessionId=randomUUID();site.completedInSession=0;site.reviewedThrough=0;delete site.stopReason;
          text=site.forced?'爸爸把我拖进搬砖网页，我需要爸爸把我拿出去。':'我自己决定进入搬砖网页工作。';
        }else if(action==='release'||action==='leave-voluntary'){
          if(!site.inside)throw Error('她不在工地里');
          if(action==='leave-voluntary'&&site.forced)throw Error('被爸爸放进来后，要等爸爸亲手接我出去');
          delete site.speech;
          site.inside=false;site.forced=false;site.requested=false;site.workState='stopped';site.sessionId=randomUUID();
          site.suppressUntilDecision=true;
          for(const contract of pet.labor?.contracts||[])if(contract.status==='working'){
            contract.workPermit=false;contract.batchRemaining=0;contract.forced=false;
            contract.nextDecision=Math.max(Number(contract.nextDecision)||0,Date.now()+60000);
          }
          text=action==='release'?'爸爸把我从搬砖网页里拿出来了。':'我自己离开了搬砖网页。';
        }else{
          if(!site.inside)throw Error('她不在工地里');
          text=action==='touch'?'爸爸在搬砖网页里碰了碰我。':'爸爸在搬砖网页里拖动了我，当前动作被打断。';
        }
        const command=pet.world?.command;
        if(['enter-forced','enter-voluntary','release','leave-voluntary','drag'].includes(action)&&command?.source==='labor'&&['queued','running'].includes(command.status)){
          command.status='interrupted';command.interruptedReason='worksite-transition';
          const c=pet.labor?.contracts?.find((x:any)=>x.id===command.labor?.id);if(c&&action==='drag'){c.carrying=false;if(!hasForcedWork(draft)){site.workState='stopped';site.stopReason='interrupted';site.sessionId=randomUUID();}}
        }
        if(action==='force-work'&&command?.source==='labor'&&['queued','running'].includes(command.status))command.forcedLabor=true;
        const at=new Date().toISOString(),eventId='worksite:'+randomUUID();
        if(['enter-forced','force-work','touch','drag'].includes(action))site.speech={eventId,action,text:'【操作反馈】'+text,at:Date.parse(at)};
        (pet.events||=[]).push({id:eventId,kind:'interaction',text,ts:Date.parse(at)});
        draft.life.events.push({eventId,petId:id,type:'interaction.worksite',source:['enter-voluntary','leave-voluntary','request-entry','stop-work'].includes(action)?'scheduler':'user',...(['enter-voluntary','leave-voluntary','request-entry','stop-work'].includes(action)?{}:{actorId:'dad'}),occurredAt:at,receivedAt:at,evidenceLevel:'observed',payload:{action,description:text}});
        // A forced batch is a deliberate event she should remember; the memory
        // records the fact, while her distress is expressed by her own body and
        // reactions rather than a hard-coded feeling.
        if(action==='force-work'){
          const contract=pet.labor.contracts.find((c:any)=>c.status==='working'&&c.forced);contract.forcedSource=eventId;contract.workDecisionEvent=eventId;
          const memoryId='worksite-memory:'+eventId;
          if(!draft.life.memories.some(m=>m.id===memoryId))draft.life.memories.push({id:memoryId,kind:'autobiographical',content:text,sourceIds:[eventId],evidenceLevel:'observed',valid:true,createdAt:at});
        }
        return {};
      });
    });
    const result=await snapshot(id);
    if(['enter-forced','enter-voluntary','force-work','request-entry','resume-work','retry-unconfirmed'].includes(action))try{wake?.(id);}catch{/* The normal scheduler can retry. */}
    return result;
  }};
}
