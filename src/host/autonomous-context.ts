import {createHash} from 'node:crypto';
import {cookerFacts,canConsiderCooking} from './rice-cooker.js';
import {riceInventory} from './rice-inventory.js';
import {riceMotivation} from './companion-personality.js';
import {farmFacts} from './farm.js';
import {validateAutonomousWork,autonomousWorkTypes} from './autonomous-work.js';
import {isOwnerPrivateConversation} from './chat-identity.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';

const guarded=new Set(['service.buy-rice','service.cook-rice','service.eat-rice','learning.observe','self.express']);
const day=(now:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);

/** Hunger fluctuations and unrelated events do not make the same failed purchase new. */
export function autonomousDecisionKey(state:CanonicalEnvelope,type:string,parameters:Record<string,unknown>,now=Date.now()):string|undefined {
  if(!guarded.has(type))return;
  const pet=state.legacy as any;
  const owner=state.life.events.filter(e=>e.type==='conversation.user'&&isOwnerPrivateConversation(e)&&
    !Object.hasOwn(state.life.invalidSources,e.eventId)).at(-1)?.eventId;
  const food=type.startsWith('service.')?{balance:pet.wallet?.balance,frozen:pet.wallet?.frozen,price:pet.config?.costs?.feed,
    inventory:riceInventory(state),cooker:cookerFacts(state),worksite:pet.worksite?.inside}:undefined;
  const network=type==='learning.observe'?{day:day(now),network:pet.config?.networkLearning,abilities:pet.abilities,limits:pet.config?.exploration}:undefined;
  const expression=type==='self.express'?{balance:pet.wallet?.balance,inventory:riceInventory(state),cooker:cookerFacts(state)}:undefined;
  const ordered=Object.fromEntries(Object.entries(parameters).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,value])=>[key,typeof value==='string'?value.normalize('NFKC').trim().replace(/\s+/gu,' '):value]));
  return createHash('sha256').update(JSON.stringify({type,parameters:ordered,owner,food,network,expression,
    permissions:state.life.constraints.permissions,capability:state.life.constraints.capabilities.find(c=>c.name===type)})).digest('hex');
}

export function repeatedAutonomousAction(state:CanonicalEnvelope,type:string,parameters:Record<string,unknown>,excludeId?:string,goalId?:string):boolean {
  const key=autonomousDecisionKey(state,type,parameters);if(!key)return false;
  return state.life.actions.some(a=>a.id!==excludeId&&a.autonomous&&a.decisionKey===key&&
    (type!=='learning.observe'||a.goalId===goalId)&&a.sourceIds.every(id=>!Object.hasOwn(state.life.invalidSources,id))&&
    (['PROPOSED','PENDING','DISPATCHED','FAILED','CANCELLED','UNKNOWN'].includes(a.status)||
      a.status==='COMPLETED'&&(type==='learning.observe'||type==='self.express')));
}

/** Read-only opportunities and outcomes accompany every comprehensive turn. */
export function autonomousContext(state:CanonicalEnvelope,now=Date.now()) {
  const pet=state.legacy as any,enabled=(name:string)=>state.life.constraints.capabilities.some(c=>c.name===name&&c.enabled&&(!c.requiresPermission||state.life.constraints.permissions.includes(c.requiresPermission)));
  const usage=pet.usage?.[day(now)]??{},food=riceMotivation(state.humanity as any,pet.config??{},now),field=farmFacts(state,now);
  const attempts=Object.values(pet.qq?.outbound??{}).filter((e:any)=>e.proactive===true&&Number.isFinite(e.at)) as any[];
  const lastContact=Math.max(0,...attempts.map(e=>e.at));
  const work=autonomousWorkTypes.map(actionType=>{try{validateAutonomousWork(state,actionType,now);return {actionType,available:true};}catch(error){return {actionType,available:false,reason:(error as Error).message};}});
  const searchesRemaining=Math.max(0,(pet.config?.exploration?.dailySearches??20)-(usage.searchRuns??0));
  const readingsRemaining=Math.max(0,(pet.config?.exploration?.dailyRuns??0)-(usage.exploreRuns??0));
  const canRead=enabled('learning.observe')&&pet.config?.networkLearning===true&&pet.abilities?.fetch?.status==='granted'&&readingsRemaining>0;
  const canSearch=canRead&&pet.abilities?.search?.status==='granted'&&searchesRemaining>0;
  return {cookerReminderId:cookerFacts(state).reminderId??undefined,activities:{
    learning:{available:canRead||canSearch,canRead,canSearch,searchesRemaining,readingsRemaining},
    expression:{available:enabled('self.express'),qqReady:!!pet.qq?.identity&&now-lastContact>=7200000&&Number(pet.wallet?.balance)>=.2,nextQQAt:lastContact?new Date(lastContact+7200000).toISOString():null},
    farm:{available:enabled('farm.tend')&&!!field?.operation,operation:field?.operation??null},work,
    food:{mealDue:food.mealDue,canConsiderCooking:canConsiderCooking(state)},
    diary:{enabled:pet.config?.diaryEnabled!==false,automaticAfter:'20:00 Asia/Hong_Kong'}},
    recentAttempts:state.life.actions.filter(a=>a.autonomous&&a.sourceIds.every(id=>!Object.hasOwn(state.life.invalidSources,id))).slice(-12).map(a=>({
      actionType:a.actionType,parameters:a.parameters,status:a.status,at:a.updatedAt,
      repeatBlocked:repeatedAutonomousAction(state,a.actionType,a.parameters,undefined,a.goalId),
      result:state.life.receipts.find(r=>r.actionId===a.id)?.details.reason}))};
}
