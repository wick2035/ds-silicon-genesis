import {hasForcedWork} from './forced-labor.js';
import {advanceSpirit} from '../kernel/spirit.js';
import {strategyScore} from '../kernel/index.js';
import {expireCommitments} from '../kernel/goal-lifecycle.js';
import {projectBody} from './body-projection.js';
import {blocksNewLabor} from './labor-pending.js';
import type {CanonicalHumanityAdapter} from './humanity-adapter.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork,OutboxDispatcher} from '../storage/uow.js';
import type {ActionCoordinator} from './action-coordinator.js';
import {randomUUID} from 'node:crypto';

/** Biological time always advances. An enabled autonomous pet may request a
 * meal already in inventory; the regular service path requires the actual
 * desktop animation receipt before inventory or body is changed. */
export function createDeterministicLife(humanity:CanonicalHumanityAdapter,reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},service:(id:string,input:Record<string,unknown>,origin?:'user'|'autonomous')=>Promise<unknown>,
  gate:PetGate,uow:UnitOfWork,actions:ActionCoordinator,dispatcher:OutboxDispatcher,refreshBudget:(petId:string)=>Promise<void>,tokenHeld:(petId:string)=>boolean=()=>false) {
  // A release can start pickup immediately, independently of the minute wakeup.
  async function pickup(petId:string,signal:AbortSignal):Promise<boolean> {
    if(signal.aborted)return false;
    const human=await humanity.get(petId);
    if(signal.aborted || human.restrained || human.helperReady!==true || human.sleeping)return false;
    return gate.run(petId,async()=>{
      let current=await reader.loadEnvelope(petId);
      if(!current || signal.aborted || current.life.constraints.paused || tokenHeld(petId))return false;
      const freshHuman=current.humanity as Record<string,any>;
      if(signal.aborted || freshHuman.restrained || freshHuman.helperReady!==true || freshHuman.sleeping || tokenHeld(petId))return false;
      const legacy=current.legacy as Record<string,any>;
      const coin=legacy.tokens?.coins?.find((c:any)=>c.status==='floor' && c.surface==='desktop');
      if(legacy.worksite?.inside || !coin || !current.life.constraints.capabilities.some(c=>c.name==='token.pickup' && c.enabled) || current.life.actions.some(a=>a.actionType==='token.pickup' && ['PENDING','DISPATCHED','UNKNOWN'].includes(a.status)))return false;
      const id='token-pickup:'+randomUUID(),at=new Date().toISOString();
      await uow.apply(petId,current.version,draft=>{draft.life.actions.push({id,petId,actionType:'token.pickup',parameters:{coinId:coin.id},priority:40,interruptPolicy:'safe-point',requiredCapabilities:['token.pickup'],expectedStateVersion:draft.version,sourceIds:[],status:'PROPOSED',createdAt:at,updatedAt:at});return {};});
      current=await reader.loadEnvelope(petId);if(!current || signal.aborted)return false;
      await actions.queue(petId,id,current.version);if(signal.aborted)return false;
      return (await dispatcher.dispatch(id)).status==='completed';
    });
  }
  async function run(petId:string,signal:AbortSignal,{allowAutonomous}:{allowAutonomous:boolean}) {
    if(signal.aborted)return;
    await refreshBudget(petId);
    if(signal.aborted)return;
    await gate.run(petId,async()=>{const state=await reader.loadEnvelope(petId);if(!state||signal.aborted)return;
      const now=new Date().toISOString(),at=Date.parse(now);
      if(!state.life.commitments.some(c=>c.status==='open'&&!!c.dueAt&&Number.isFinite(Date.parse(c.dueAt))&&Date.parse(c.dueAt)<=at&&c.sourceIds.every(id=>!Object.hasOwn(state.life.invalidSources,id))))return;
      await uow.apply(petId,state.version,draft=>{expireCommitments({...draft.life,petId},now);return {};});
    });
    if(signal.aborted)return;
    const human=await humanity.get(petId);
    const forceState=await reader.loadEnvelope(petId),forced=!!forceState&&hasForcedWork(forceState);
    if(signal.aborted || !forced&&(!allowAutonomous || human.restrained) || human.helperReady!==true)return;
    const resting=await reader.loadEnvelope(petId);
    if(!resting)return;const spirit=advanceSpirit(resting.life);
    if(human.sleeping&&!forced){if(spirit.mode==='sleep' && spirit.value>=100 || spirit.mode==='nap' && Date.now()-spirit.sleepStartedAt!>=1200000)await service(petId,{key:'auto-wake:'+spirit.sleepStartedAt,command:'/醒来'},'autonomous');return;}
    if(spirit.value<=2 && !(resting.legacy as any).worksite?.inside){await service(petId,{key:'auto-sleep:'+Math.floor(Date.now()/3600000),command:'/休息'},'autonomous');return;}
    if(Number.isFinite(human.restingUntil) && human.restingUntil>Date.now()&&!forced)return;
    const state=await reader.loadEnvelope(petId);
    if(signal.aborted || !state || state.life.constraints.paused&&!forced)return;
    const legacy=state.legacy as Record<string,any>, inventory=legacy.services?.inventory;
    // Only the worksite body may perform physical work while she is inside.
    // Desktop-only meals and coin pickup wait until she returns.
    const inWorksite=legacy.worksite?.inside===true;
    if(!inWorksite && Number.isFinite(human.stats?.satiety) && human.stats.satiety<=30 && Array.isArray(inventory) && inventory.some((i:any)=>i.status==='available') && !state.life.actions.some(a=>a.actionType==='service.eat-rice' && a.status==='UNKNOWN')) {
      if(!state.life.actions.some(a=>a.actionType==='service.eat-rice' && ['PENDING','DISPATCHED','UNKNOWN'].includes(a.status)))
        await service(petId,{key:'auto-meal:'+Math.floor(Date.now()/21600000),command:'/吃'},'autonomous');
      return;
    }
    // Buying is a real, separately authorized purchase. Never manufacture a
    // free meal or retry an unconfirmed purchase merely because time passed.
    const price=legacy.config?.costs?.feed, wallet=legacy.wallet;
    if(!inWorksite && Number.isFinite(human.stats?.satiety) && human.stats.satiety<=30 && Array.isArray(inventory) && !inventory.some((i:any)=>i.status==='available') &&
       Number.isFinite(price) && price>0 && wallet?.frozen!==true && Number.isFinite(wallet?.balance) && wallet.balance>=price &&
       state.life.constraints.capabilities.some(c=>c.name==='service.buy-rice'&&c.enabled) &&
       !state.life.actions.some(a=>a.actionType==='service.buy-rice'&&['PENDING','DISPATCHED','UNKNOWN'].includes(a.status))) {
      await service(petId,{key:'auto-buy:'+Math.floor(Date.now()/21600000),command:'/冰箱 买一碗白饭'},'autonomous');return;
    }
    if(!inWorksite && legacy.tokens?.coins?.some((c:any)=>c.status==='floor' && c.surface==='desktop')) {
      await pickup(petId,signal);return;
    }
    // A confirmed work permit authorizes a bounded physical step, not a
    // fabricated trip. Actual progress only comes from the helper receipt.
    await gate.run(petId,async()=>{
      let current=await reader.loadEnvelope(petId);if(!current||signal.aborted||current.life.constraints.paused&&!hasForcedWork(current))return;
      if(blocksNewLabor(current) || current.life.actions.some(a=>a.actionType==='service.eat-rice' && ['PENDING','DISPATCHED'].includes(a.status)))return;
      let pet=current.legacy as Record<string,any>, contract=pet.labor?.contracts?.find((c:any)=>c.status==='working');
      if(!contract || !Number.isFinite(contract.done) || contract.done>=contract.trips)return;
      if(contract.workPermit && contract.workDecisionEvent && Object.hasOwn(current.life.invalidSources,contract.workDecisionEvent)){await uow.apply(petId,current.version,draft=>{const c=(draft.legacy as Record<string,any>).labor?.contracts?.find((x:any)=>x.id===contract.id);if(c){c.workPermit=false;c.batchRemaining=0;c.nextDecision=0;}return {};});current=await reader.loadEnvelope(petId);if(!current)return;pet=current.legacy as Record<string,any>;contract=pet.labor?.contracts?.find((c:any)=>c.id===contract.id);if(!contract)return;}
      if(!contract.workPermit) {
        const now=Date.now();if(Number.isFinite(contract.nextDecision) && contract.nextDecision>now && !contract.forced)return;
        const state={...current.life,petId,version:current.version,...projectBody(current)};
        const dad=state.relationships.find(r=>r.personId==='dad'),score=strategyScore(state,'labor.step','execution');
        const overdue=(dad?.outstandingWages??0)>0, tired=state.body.stamina<35 || state.body.energy<30 || state.body.pain>=50 || state.body.sleeping || state.body.restrained;
        const workGoal=state.goals.some(g=>g.kind==='work' && g.status==='active' && g.sourceIds.every(id=>!Object.hasOwn(state.invalidSources,id)));
        const weak=score.samples>=3 && score.score<.3 && !workGoal;
        // A forced batch overrides the body/rest decision; the distress it causes
        // is recorded as real evidence downstream, not suppressed here.
        const choice=contract.forced?'work':(overdue||tired||weak?'rest':'work');
        await uow.apply(petId,current.version,draft=>{const c=(draft.legacy as Record<string,any>).labor?.contracts?.find((x:any)=>x.id===contract.id);if(!c||c.status!=='working'||c.workPermit||draft.life.constraints.paused&&!hasForcedWork(draft))throw Error('工作状态已变化');
          c.workPermit=choice==='work';c.batchRemaining=choice==='work'?Math.min(c.trips-c.done,workGoal?2:1):0;c.lastWorkDecision=now;c.nextDecision=now+(choice==='work'?60000:300000);c.behavior=choice==='work'?(contract.forced?'爸爸强行让我继续搬砖':'决定继续一小批工作'):'决定先休息并重新考虑';
          const site=(draft.legacy as Record<string,any>).worksite||={inside:false,forced:false};site.suppressUntilDecision=false;if(choice==='work'&&!site.inside)site.requested=true;
          const at=new Date(now).toISOString(),eventId='labor-decision:'+randomUUID();c.workDecisionEvent=eventId;draft.life.events.push({eventId,petId,type:'labor.decision',source:'scheduler',occurredAt:at,receivedAt:at,evidenceLevel:'inferred',payload:{contractId:c.id,choice,reason:contract.forced?'forced':overdue?'unpaid':tired?'body':weak?'experience':'agreement',sourceIds:[...(dad?.sourceIds||[]),...state.goals.filter(g=>g.kind==='work'&&g.status==='active').flatMap(g=>g.sourceIds)]}});return {};});
        if(choice!=='work')return;
        current=await reader.loadEnvelope(petId);if(!current||signal.aborted)return;pet=current.legacy as Record<string,any>;contract=pet.labor?.contracts?.find((c:any)=>c.id===contract.id);if(!contract?.workPermit)return;
      }
      if(!pet.worksite?.inside){
        if(!pet.worksite?.requested && !pet.worksite?.suppressUntilDecision)await uow.apply(petId,current.version,draft=>{const site=(draft.legacy as Record<string,any>).worksite||={inside:false,forced:false};if(!site.inside)site.requested=true;return {};});
        return;
      }
      let command=pet.world?.command;
      if(command && ['queued','running'].includes(command.status) && Number.isFinite(command.expires) && command.expires<=Date.now()) {
        await uow.apply(petId,current.version,draft=>{const world=(draft.legacy as Record<string,any>).world,old=world?.command;if(old?.id===command.id&&['queued','running'].includes(old.status)){(world.commandHistory||=[]).push({...structuredClone(old),status:'interrupted',interruptedReason:'expired'});world.commandHistory=world.commandHistory.slice(-50);old.status='interrupted';old.interruptedReason='expired';}return {};});
        current=await reader.loadEnvelope(petId);if(!current)return;pet=current.legacy as Record<string,any>;command=pet.world?.command;
      }
      if(command && ['queued','running'].includes(command.status) && (command.source!=='labor' || command.labor?.id!==contract.id))return;
      if(!command || !['queued','running'].includes(command.status) || command.source!=='labor' || command.labor?.id!==contract.id) {
        const now=Date.now(),id=randomUUID(),target=contract.carrying?'right':'left';
        await uow.apply(petId,current.version,draft=>{const p=draft.legacy as Record<string,any>,c=p.labor?.contracts?.find((x:any)=>x.id===contract.id);
          if(!c || c.status!=='working' || !c.workPermit || draft.life.constraints.paused&&!hasForcedWork(draft))throw Error('工作状态已变化');
          if(!p.worksite?.inside)throw Error('她不在工地里');
          p.world ||= {};p.world.command={id,epoch:id,source:'labor',forcedLabor:!!c.forced,surface:'web',issued:now,expires:now+90000,status:'queued',index:0,
            steps:[{action:'walk',target},{action:c.carrying?'putdown':'lift',target}],labor:{id:c.id,trip:c.done,leg:c.carrying?'deliver':'load',x:c.carrying?.78:.22}};return {};});
        current=await reader.loadEnvelope(petId);command=(current?.legacy as Record<string,any>)?.world?.command;
      }
      if(!current || !command || command.status!=='queued')return;
      const id=`labor-step:${command.id}:${command.index}`;
      if(current.life.actions.some(a=>a.id===id))return;
      const at=new Date().toISOString();
      await uow.apply(petId,current.version,draft=>{const live=(draft.legacy as Record<string,any>).world?.command;
        if(!live||live.id!==command.id||live.index!==command.index||live.status!=='queued')throw Error('工作步骤已变化');
        draft.life.actions.push({id,petId,actionType:'labor.step',parameters:{contractId:contract.id,commandId:command.id},priority:55,
          interruptPolicy:'safe-point',requiredCapabilities:['labor.step'],expectedStateVersion:draft.version,sourceIds:contract.workDecisionEvent?[contract.workDecisionEvent]:[],status:'PROPOSED',createdAt:at,updatedAt:at});return {};});
      current=await reader.loadEnvelope(petId);if(!current||signal.aborted)return;
      await actions.queue(petId,id,current.version);
      if(!signal.aborted){const receipt=await dispatcher.dispatch(id);if(receipt.status==='completed'&&!signal.aborted){const timer=setTimeout(()=>{if(!signal.aborted)void run(petId,signal,{allowAutonomous}).catch(()=>{});},0);timer.unref?.();}}
    });
  }
  return {pickup,run};
}
