import {farmVisit} from './farm.js';
import {availableRice} from './rice-inventory.js';
import {hasActiveConversation,hasRunningChat} from './active-conversation.js';
import {riceMotivation} from './companion-personality.js';
import {hasForcedWork,canChooseLabor,hasLaborResources} from './forced-labor.js';
import {advanceSpirit} from '../kernel/spirit.js';
import {expireCommitments} from '../kernel/goal-lifecycle.js';
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
      if(farmVisit(current) || legacy.worksite?.inside || !coin || !current.life.constraints.capabilities.some(c=>c.name==='token.pickup' && c.enabled) || current.life.actions.some(a=>a.actionType==='token.pickup' && ['PENDING','DISPATCHED','UNKNOWN'].includes(a.status)))return false;
      const id='token-pickup:'+randomUUID(),at=new Date().toISOString();
      await uow.apply(petId,current.version,draft=>{draft.life.actions.push({id,petId,actionType:'token.pickup',parameters:{coinId:coin.id},priority:40,interruptPolicy:'safe-point',requiredCapabilities:['token.pickup'],expectedStateVersion:draft.version,sourceIds:[],status:'PROPOSED',createdAt:at,updatedAt:at});return {};});
      current=await reader.loadEnvelope(petId);if(!current || signal.aborted)return false;
      await actions.queue(petId,id,current.version);if(signal.aborted)return false;
      return (await dispatcher.dispatch(id)).status==='completed';
    });
  }
  async function run(petId:string,signal:AbortSignal,{allowAutonomous,needsManaged=false}:{allowAutonomous:boolean;needsManaged?:boolean}) {
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
    if(signal.aborted||await runWorksite(petId,signal,allowAutonomous))return;
    if(signal.aborted || !allowAutonomous || human.restrained || human.helperReady!==true)return;
    const resting=await reader.loadEnvelope(petId);
    if(!resting||farmVisit(resting))return;if(hasActiveConversation(resting)&&!(resting.legacy as any).worksite?.inside&&!resting.life.actions.some(a=>a.actionType==='labor.step'&&a.status==='PENDING'))return;const spirit=advanceSpirit(resting.life);
    if(human.sleeping){if(spirit.mode==='sleep' && spirit.value>=100 || spirit.mode==='nap' && Date.now()-spirit.sleepStartedAt!>=1200000)await service(petId,{key:'auto-wake:'+spirit.sleepStartedAt,command:'/醒来'},'autonomous');return;}
    if(!needsManaged && spirit.value<=2 && !(resting.legacy as any).worksite?.inside && !(resting.legacy as any).labor?.contracts?.some((c:any)=>c.status==='working'&&c.workPermit)){await service(petId,{key:'auto-sleep:'+Math.floor(Date.now()/3600000),command:'/休息'},'autonomous');return;}
    if(Number.isFinite(human.restingUntil) && human.restingUntil>Date.now()&&!(resting.legacy as any).labor?.contracts?.some((c:any)=>c.status==='working'&&c.workPermit))return;
    const state=await reader.loadEnvelope(petId);
    if(signal.aborted || !state || state.life.constraints.paused)return;
    const legacy=state.legacy as Record<string,any>, inventory=legacy.services?.inventory, meals=availableRice(state);
    // Only the worksite body may perform physical work while she is inside.
    // Desktop-only meals and coin pickup wait until she returns.
    const inWorksite=legacy.worksite?.inside===true;
    const mealDue=riceMotivation(human,legacy.config??{}).mealDue;
    if(!needsManaged && !inWorksite && mealDue && meals.length>0) {
      if(!state.life.actions.some(a=>a.actionType==='service.eat-rice' && ['PENDING','DISPATCHED'].includes(a.status)))
        await service(petId,{key:'auto-meal:'+Math.floor(Date.now()/60000),command:'/吃'},'autonomous');
      return;
    }
    // Buying is a real, separately authorized purchase. Never manufacture a
    // free meal or retry an unconfirmed purchase merely because time passed.
    const price=legacy.config?.costs?.feed, wallet=legacy.wallet;
    if(!needsManaged && !inWorksite && mealDue && Array.isArray(inventory) && !meals.length && !inventory.some((i:any)=>i.status==='available') &&
       Number.isFinite(price) && price>0 && wallet?.frozen!==true && Number.isFinite(wallet?.balance) && wallet.balance>=price &&
       state.life.constraints.capabilities.some(c=>c.name==='service.buy-rice'&&c.enabled) &&
       !state.life.actions.some(a=>a.actionType==='service.buy-rice'&&['PENDING','DISPATCHED','UNKNOWN'].includes(a.status))) {
      await service(petId,{key:'auto-buy:'+Math.floor(Date.now()/60000),command:'/冰箱 买一碗白饭'},'autonomous');return;
    }
    if(!inWorksite && legacy.tokens?.coins?.some((c:any)=>c.status==='floor' && c.surface==='desktop')) {
      await pickup(petId,signal);return;
    }
    if(inWorksite){await runWorksite(petId,signal,allowAutonomous);return;}
    await gate.run(petId,async()=>{
      const current=await reader.loadEnvelope(petId);if(!current||signal.aborted||current.life.constraints.paused||farmVisit(current))return;
      const pet=current.legacy as Record<string,any>;
      if(pet.worksite?.inside)return;
      const pending=current.life.actions.find(a=>a.actionType==='labor.step'&&a.status==='PENDING');
      if(pending){await dispatcher.dispatch(pending.id);return;}
      if(!canChooseLabor(current))return;
      if(blocksNewLabor(current) || current.life.actions.some(a=>a.actionType==='service.eat-rice' && ['PENDING','DISPATCHED'].includes(a.status)))return;
      const contract=activeContract(pet);
      if(!contract || contract.status!=='working' || !contract.workPermit)return;
      if(contract.workDecisionEvent && Object.hasOwn(current.life.invalidSources,contract.workDecisionEvent))return;
      if(!pet.worksite?.requested && !pet.worksite?.suppressUntilDecision)await uow.apply(petId,current.version,draft=>{const site=(draft.legacy as Record<string,any>).worksite||={inside:false,forced:false};if(!site.inside)site.requested=true;return {};});
    });
  }

  function activeContract(pet:Record<string,any>) {
    return pet.labor?.contracts?.find((c:any)=>['working','paused','queued'].includes(c.status)&&Number.isFinite(c.done)&&c.done<c.trips);
  }

  async function runWorksite(petId:string,signal:AbortSignal,allowAutonomous:boolean):Promise<boolean> {
    return gate.run(petId,async()=>{
      const current=await reader.loadEnvelope(petId),pet=current?.legacy as Record<string,any>|undefined;
      if(!current||!pet?.worksite?.inside)return false;
      if(signal.aborted||farmVisit(current))return true;
      const forced=hasForcedWork(current);
      if(!forced && pet.worksite.workState!=='stopped' && !hasLaborResources(current)){
        await uow.apply(petId,current.version,draft=>{
          const site=(draft.legacy as Record<string,any>).worksite;
          site.workState='stopped';site.stopReason='exhausted';site.sessionId=randomUUID();
          return {};
        });
        return true;
      }
      const human=current.humanity as Record<string,any>;
      if(human.helperReady!==true || !forced&&(!allowAutonomous||human.restrained||human.sleeping||current.life.constraints.paused||pet.worksite.workState==='stopped'))return true;
      if(hasRunningChat(current))return true;
      let id=current.life.actions.find(a=>a.actionType==='labor.step'&&a.status==='PENDING')?.id;
      if(!id){
        if(blocksNewLabor(current)||current.life.actions.some(a=>a.actionType==='service.eat-rice'&&['PENDING','DISPATCHED'].includes(a.status)))return true;
        const contract=activeContract(pet);
        if(!contract||contract.status==='paused'||contract.workDecisionEvent&&Object.hasOwn(current.life.invalidSources,contract.workDecisionEvent))return true;
        if(forced ? contract.status!=='working'||!contract.workPermit&&!contract.forced : !canChooseLabor(current))return true;
        if(!forced&&human.restingUntil>Date.now()&&!contract.workPermit)return true;
        const command=pet.world?.command,now=Date.now();
        const live=command&&['queued','running'].includes(command.status);
        const expired=live&&Number.isFinite(command.expires)&&command.expires<=now;
        if(live&&!expired&&(command.source!=='labor'||command.labor?.id!==contract.id||command.status!=='queued'))return true;
        const commandId=live&&!expired?command.id:randomUUID(),index=live&&!expired?command.index:0;
        const actionId=`labor-step:${commandId}:${index}`;
        const previous=current.life.actions.find(a=>a.id===actionId);
        if(previous&&previous.status!=='PROPOSED')return true;

        await uow.apply(petId,current.version,draft=>{
          const p=draft.legacy as Record<string,any>,c=activeContract(p),world=p.world||={};
          if(!c.workPermit||c.status==='queued'){
            c.status='working';c.workPermit=true;c.batchRemaining=c.trips-c.done;
          }
          if(expired){
            (world.commandHistory||=[]).push({...world.command,status:'interrupted',interruptedReason:'expired'});
            world.commandHistory=world.commandHistory.slice(-50);
          }
          if(!live||expired){
            const target=c.carrying?'right':'left';
            world.command={id:commandId,epoch:commandId,source:'labor',forcedLabor:!!c.forced,surface:'web',issued:now,expires:now+90000,status:'queued',index,
              steps:[{action:'walk',target},{action:c.carrying?'putdown':'lift',target}],labor:{id:c.id,trip:c.done,leg:c.carrying?'deliver':'load',x:c.carrying?.78:.22}};
          }
          if(!previous){
            const at=new Date(now).toISOString();
            draft.life.actions.push({id:actionId,petId,actionType:'labor.step',parameters:{contractId:c.id,commandId},priority:55,
              interruptPolicy:'safe-point',requiredCapabilities:['labor.step'],expectedStateVersion:draft.version,sourceIds:c.workDecisionEvent?[c.workDecisionEvent]:[],status:'PROPOSED',createdAt:at,updatedAt:at});
          }
          return actions.queueDraft(draft,actionId);
        });
        id=actionId;
      }
      if(!signal.aborted&&(await dispatcher.dispatch(id)).status==='completed'&&!signal.aborted){
        const timer=setImmediate(()=>{if(!signal.aborted)void runWorksite(petId,signal,allowAutonomous).catch(()=>{});});
        timer.unref();
      }
      return true;
    });
  }
  return {pickup,run,runWorksite};
}
