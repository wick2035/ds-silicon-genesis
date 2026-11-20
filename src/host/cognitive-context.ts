import type {CognitiveWorkspace,LifeEvent} from '../kernel/types.js';
import type {CognitiveContext} from '../cognition/index.js';
import {CognitiveError,type CognitiveDiagnostics} from '../cognition/diagnostics.js';
import {cognitiveSelfModel,topicTerms} from './self-model-context.js';

export const COGNITIVE_INPUT_LIMIT=30000;
type Item=Record<string,any>;
const references=(value:unknown):string[]=>{
  if(!value||typeof value!=='object')return [];
  return Object.entries(value).flatMap(([key,item])=>key==='sourceIds'&&Array.isArray(item)?item.filter(x=>typeof x==='string'):
    ['sourceId','evidenceId','receiptEventId'].includes(key)&&typeof item==='string'?[item]:references(item));
};

/** One prompt-only projection. Complete optional items are admitted or omitted;
 * archives, resource identifiers, live permissions and budgets are never edited. */
export function buildCognitiveContext(snapshot:CognitiveWorkspace,clues:CognitiveContext,catalog:unknown,diagnostics?:CognitiveDiagnostics){
  const terms=topicTerms((snapshot.recentEvents??[]).filter(e=>e.type==='conversation.user').slice(-3).map(e=>JSON.stringify(e.payload)).join(' '));
  const score=(item:unknown)=>terms.filter(t=>JSON.stringify(item).toLowerCase().includes(t)).length;
  const ranked=<T>(items:T[])=>items.map((item,index)=>({item,index,score:score(item)})).sort((a,b)=>b.score-a.score||b.index-a.index).map(x=>x.item);
  const legacy=snapshot.legacyContext as Item|undefined,companion=legacy?.companion as Item|undefined;
  const sourceMap=new Map((snapshot.sourceEvents??[]).map(e=>[e.eventId,e]));
  const sources:Item={};
  const current:any={petId:snapshot.petId,stateVersion:snapshot.stateVersion,identity:snapshot.identity,
    spirit:snapshot.spirit,body:snapshot.body,emotions:snapshot.emotions,constraints:snapshot.constraints,
    currentActions:snapshot.currentActions??[],unconfirmedActions:[],environment:snapshot.environment,
    activeGoals:[],goalReviews:[],plans:[],commitments:[],relevantMemories:[],beliefs:[],relationships:[],recentEvents:[],goalReadings:[],
    selfModel:{stableIdentity:snapshot.identity,tendencies:[],evidence:[],conflicts:[]},worldModel:{facts:[]},
    ...(legacy?{legacyContext:{personaDescription:legacy.personaDescription,
      autonomy:legacy.autonomy,proactiveContact:legacy.proactiveContact,farm:legacy.farm,labor:legacy.labor,
      laborPayment:legacy.laborPayment,worksite:legacy.worksite,
      companion:companion?{...Object.fromEntries(Object.entries(companion).filter(([key])=>!['groupActivity','money','subjectiveContinuity','intentions','agreements'].includes(key))),groupActivity:[],subjectiveContinuity:[],intentions:[],agreements:[],money:{recentChanges:[],recentOwnerTalk:[]}}:undefined,
      traits:{},interests:[],skills:[],strategies:[],attempts:[],laborHistory:[]}}:{})};
  const context:any={observation:clues.observation??[],appraisal:clues.appraisal??[],motivations:clues.motivations??[],recall:[],rankedGoals:[]};
  const serialize=()=>JSON.stringify({可用行动及参数:catalog,当前:current,认知线索:context,来源:sources});
  const dropped=diagnostics?.trimmed??{};
  const evidence=(event:LifeEvent)=>({eventId:event.eventId,type:event.type,occurredAt:event.occurredAt,source:event.source,actorId:event.actorId,evidenceLevel:event.evidenceLevel});
  const sync=()=>{
    for(const id of Object.keys(sources))delete sources[id];
    for(const id of new Set(references(current))){const e=sourceMap.get(id);if(e)sources[id]=evidence(e);}
    const memories=new Set(current.relevantMemories.map((m:Item)=>m.id)),goals=new Set([...current.activeGoals,...current.goalReviews].map((g:Item)=>g.id));
    current.goalReadings=(snapshot.goalReadings??[]).filter(r=>memories.has(r.memoryId)&&goals.has(r.goalId)&&current.relevantMemories.some((m:Item)=>m.id===r.memoryId&&m.sourceIds.includes(r.evidenceId)));
    context.recall=(clues.recall??[]).filter(id=>memories.has(id));
    context.rankedGoals=(clues.rankedGoals??[]).filter(g=>goals.has(g.goalId));
  };
  sync();
  if(serialize().length>COGNITIVE_INPUT_LIMIT)throw new CognitiveError('context_overflow','当前身份、身体、权限和行动超过认知上下文容量');
  const available=COGNITIVE_INPUT_LIMIT-serialize().length;
  const backlog:Array<{name:string;target:Item;key:string;items:any[];used:number;limit:number}>=[];
  const shares:Record<string,number>={recentEvents:.20,unconfirmedActions:.03,goals:.10,goalReviews:.03,memories:.25,relationships:.07,commitments:.03,plans:.04,beliefs:.02,facts:.03,'selfModel.tendencies':.10,'selfModel.evidence':.02,'selfModel.conflicts':.03};
  const add=(name:string,target:Item,key:string,items:any[],budget:number)=>{
    target[key]=[];let used=0;
    const deferred:any[]=[],limit=budget;
    budget=Math.min(budget,Math.floor(available*(shares[name]??.0025)));
    for(const item of items){
      if(snapshot.sourceEvents&&references(item).some(id=>!sourceMap.has(id))){dropped[name]=(dropped[name]??0)+1;continue;}
      const before=serialize().length;target[key].push(item);sync();
      const after=serialize().length,bytes=after-before;
      if(used+bytes>budget||after>COGNITIVE_INPUT_LIMIT){target[key].pop();sync();dropped[name]=(dropped[name]??0)+1;deferred.push(item);}
      else used+=bytes;
    }
    backlog.push({name,target,key,items:deferred,used,limit});
  };
  const recent=[...(snapshot.recentEvents??[])].reverse().map(event=>{
    const item=event as Item,payload=item.payload;
    // A recent event cites its canonical record, not its entire transitive
    // provenance archive. Text and each selected speaker remain whole.
    const speakers=Array.isArray(item.speakers)?item.speakers.slice(0,2):undefined;
    dropped.eventSources=(dropped.eventSources??0)+(Array.isArray(payload?.sourceIds)?payload.sourceIds.length:0);
    dropped.speakers=(dropped.speakers??0)+Math.max(0,(item.speakers?.length??0)-2);
    return {...event,sourceIds:[event.eventId],...(speakers?{speakers,omittedSpeakers:item.speakers.length-speakers.length}:{}),
      payload:payload&&typeof payload==='object'&&!Array.isArray(payload)?Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='sourceIds')):payload};
  });
  const latestQuestion=recent.find(e=>e.type==='conversation.user'),latestMoment=recent.find(e=>e.momentSource);
  add('recentEvents',current,'recentEvents',[...new Set([latestMoment,latestQuestion,...recent].filter(Boolean))],6500);
  add('unconfirmedActions',current,'unconfirmedActions',[...(snapshot.unconfirmedActions??[])].reverse(),1200);
  add('goals',current,'activeGoals',ranked(snapshot.activeGoals??[]),2500);
  add('goalReviews',current,'goalReviews',ranked(snapshot.goalReviews??[]),1000);
  add('memories',current,'relevantMemories',snapshot.relevantMemories??[],8000);
  const self=cognitiveSelfModel(snapshot.selfModel,snapshot.sourceEvents??[],terms.join(' '));
  for(const key of ['tendencies','evidence','conflicts'] as const)add('selfModel.'+key,current.selfModel,key,self[key],key==='tendencies'?2000:1200);
  const relationships=ranked(snapshot.relationships??[]).sort((a,b)=>Number(b.personId==='dad')-Number(a.personId==='dad'));
  add('relationships',current,'relationships',relationships.map(r=>{
    const ids=r.sourceIds.slice(-2);dropped.relationshipSources=(dropped.relationshipSources??0)+r.sourceIds.length-ids.length;
    return {...r,sourceIds:ids};
  }),1800);
  add('commitments',current,'commitments',ranked(snapshot.commitments??[]),1200);
  add('plans',current,'plans',(snapshot.plans??[]).filter(p=>!p.goalId||current.activeGoals.some((g:Item)=>g.id===p.goalId)),1800);
  add('beliefs',current,'beliefs',ranked(snapshot.beliefs??[]),1000);
  add('facts',current.worldModel,'facts',ranked(snapshot.worldModel?.facts??[]),1200);
  if(legacy){
    for(const key of ['interests','skills','strategies','attempts','laborHistory'])add('legacy.'+key,current.legacyContext,key,ranked(Array.isArray(legacy[key])?legacy[key]:[]),600);
    if(companion){
      for(const key of ['groupActivity','subjectiveContinuity','intentions','agreements'])add('companion.'+key,current.legacyContext.companion,key,ranked(companion[key]??[]),800);
      const money=companion.money;
      if(money){for(const [key,value] of Object.entries(money)){
        if(Array.isArray(value))add('money.'+key,current.legacyContext.companion.money,key,ranked(value),600);
      }}
    }
  }
  // Reuse unspent shares one complete item per category. A large record must
  // not leave all relationship/self evidence empty while capacity sits unused.
  const priority=(name:string)=>name.startsWith('selfModel')?0:name==='relationships'?1:name==='goals'?2:3;
  backlog.sort((a,b)=>priority(a.name)-priority(b.name));
  let changed=true;
  while(changed){
    changed=false;
    for(const bucket of backlog){
      for(let index=0;index<bucket.items.length;index++){
        const item=bucket.items[index],before=serialize().length;
        bucket.target[bucket.key].push(item);sync();const after=serialize().length,bytes=after-before;
        if(bucket.used+bytes>bucket.limit||after>COGNITIVE_INPUT_LIMIT){bucket.target[bucket.key].pop();sync();continue;}
        bucket.used+=bytes;bucket.items.splice(index,1);dropped[bucket.name]--;changed=true;break;
      }
    }
  }
  sync();const input=serialize();
  if(input.length>COGNITIVE_INPUT_LIMIT)throw new CognitiveError('context_overflow','认知上下文超过限制');
  if(diagnostics)diagnostics.inputChars=input.length;
  return {input,snapshot:current as Omit<CognitiveWorkspace,'selfModel'>};
}
