import test from 'node:test';
import assert from 'node:assert/strict';
import {Cognition,hasCognitiveDemand} from '../dist/cognition/index.js';
import {createInitialState,invalidateDependents} from '../dist/kernel/index.js';
import {goalsDueForReview,reviewGoal} from '../dist/kernel/goal-lifecycle.js';
import {CognitiveResultCoordinator} from '../dist/host/cognitive-result.js';
import {CanonicalActionLifecycle} from '../dist/host/action-lifecycle.js';
import {createWorksite} from '../dist/host/worksite.js';
import {createWorksiteReviews} from '../dist/host/worksite-reviews.js';
import {projectOutcome} from '../dist/host/outcome-projector.js';
import {hasLaborResources} from '../dist/host/forced-labor.js';
import {advanceHumanity,createHumanity} from '../vendor/dsh-pet/src/host/humanity.mjs';
import {rankWorkChoices,recordWorkChoice,recordWorkOutcome,laborPaymentHistory} from '../dist/host/work-experience.js';
import {advanceFarm,changeFarmWeather,completeFarmOperation,farmFacts} from '../dist/host/farm.js';

const DAY=86400000;
const start=Date.parse('2026-11-10T02:00:00Z');
const time=day=>new Date(start+day*DAY).toISOString();
const empty={action:null,goals:[],goalUpdates:[],plan:[],interests:[],selfModel:[]};
const capability='learning.observe';
const article='https://example.test/whale';
const quote='鲸类用歌声彼此交流，研究者使用水听器记录声音变化。';
const evidence=(eventId,type,occurredAt,payload={})=>({eventId,petId:'main',type,source:'fixture',occurredAt,receivedAt:occurredAt,evidenceLevel:'observed',payload});
const goal=(id,status='active',source='experience')=>({id,title:'了解座头鲸的歌声',kind:'self-directed',status,priority:50,urgency:10,research:true,sourceIds:[source]});
const step=(goalId,kind,params={})=>({goalId,actionType:capability,description:kind==='search'?'查找资料':'阅读资料',requiredCapabilities:[capability],
  sourceIds:['experience'],parameters:{kind,query:'座头鲸的歌声',...params}});

function fixture(seed) {
  const initial=createInitialState('main',time(0));
  initial.constraints={paused:false,remainingBudget:20,permissions:['network'],capabilities:[{name:capability,enabled:true,requiresPermission:'network'}]};
  initial.events.push(evidence('experience','body.observed',time(0),{description:'从桌面看到鲸类主题画面'}));
  let envelope=seed?structuredClone(seed):{petId:'main',version:0,life:initial,legacy:{wallet:{balance:1000},explorationCharges:{},events:[]},
    humanity:{stats:{stamina:42},helperReady:true,restrained:false,sleeping:false}};
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>structuredClone(envelope)};
  const projection=d=>({body:d.life.body,emotions:d.life.emotions});
  const uow={apply:async(_id,version,fn)=>{assert.equal(envelope.version,version);const draft=structuredClone(envelope);fn(draft);draft.version++;envelope=draft;}};
  const lifecycle=new CanonicalActionLifecycle(projection,()=>new Date());
  let nextStatus='completed';
  const receipt=(outcome,id)=>({
    status:outcome,evidence:outcome==='completed'?{actionId:id,kind:capability,confirmed:true,documentUrl:article,content:quote}:{reason:'隔离情境中暂时没有资料'}
  });
  const intent=a=>({id:a.id,type:a.actionType,payload:{actionId:a.id,petId:'main',actionType:a.actionType,parameters:a.parameters}});
  const dispatcher={hasExecutor:()=>true,dispatch:async id=>{
    const a=envelope.life.actions.find(item=>item.id===id);
    assert.equal(a.status,'PENDING');
    a.status='DISPATCHED';
    lifecycle.complete(envelope,intent(a),receipt(nextStatus,id));
    return {status:nextStatus};
  }};
  const actions={queue:async(_id,id)=>{const a=envelope.life.actions.find(item=>item.id===id);a.status='PENDING';envelope.legacy.explorationCharges[id]={status:'reserved',amount:0};}};
  const create=()=>new CognitiveResultCoordinator(store,uow,gate,projection,actions,dispatcher);
  let coordinator=create();
  const turn=async (answer,budget=20)=>{
    const model={generate:snapshot=>Promise.resolve(answer(snapshot))};
    const cognition=new Cognition(model,{reserve:async()=>budget?{}:null,withReserved:async(_p,_t,fn)=>fn()},
      {forCognition:async()=>envelope.life.memories,world:async()=>({space:null,inventory:[],capabilities:[],recentResults:[]})});
    const load=async()=>({...structuredClone(envelope.life),version:envelope.version});
    const result=await cognition.propose(await load(),gate.signal,load);
    if(result.status==='proposed')await coordinator.accept('main',result,gate.signal);
    return result;
  };
  return {turn,read:()=>envelope,create,dispatch:()=>coordinator.resume('main',gate.signal),restart:()=>{envelope=structuredClone(envelope);coordinator=create();},
    setOutcome:status=>{nextStatus=status;},reconcile:id=>{
      const a=envelope.life.actions.find(item=>item.id===id);
      const done={receiptId:'late:'+id,actionId:id,petId:'main',status:'COMPLETED',occurredAt:new Date().toISOString(),source:'fixture-executor',
        evidenceLevel:'verified',details:receipt('completed',id).evidence};
      lifecycle.reconcile(envelope,intent(a),done);
      lifecycle.reconcile(envelope,intent(a),done);
    }};
}

function workEpisode(draft,day,choice,success,index=0) {
  const contractId='contract-'+day+'-'+index;
  const context={contractId,stamina:'medium',phase:'early'};
  const ranked=rankWorkChoices(draft.life,context);
  const decision=recordWorkChoice(draft,{context,choice,recommended:ranked[0].choice,sourceIds:ranked[0].sourceIds},time(day));
  const receipt='finish-'+contractId;
  draft.life.events.push(evidence(receipt,success?'labor.trip':'labor.exhausted',time(day),{contractId}));
  recordWorkOutcome(draft,decision,receipt,success,time(day));
  recordWorkOutcome(draft,decision,receipt,success,time(day));
  return {decision,receipt};
}

test('七天轨迹中自主念想跨重启继续，受阻改计划，读到资料以后完成',async t=>{
  t.mock.timers.enable({apis:['Date'],now:start});
  const a=fixture(),b=fixture(a.read());
  assert.deepEqual(a.read(),b.read());
  await a.turn(()=>({...empty,goals:[{title:'了解座头鲸的歌声',description:'想知道它怎样发声',research:true,sourceIds:['experience']}]}));
  const id=a.read().life.goals[0].id;
  await a.turn(()=>({...empty,plan:[step(id,'search'),{...step(id,'fetch'),readSearchResult:true}]}));
  await a.dispatch();
  assert.equal(a.read().life.cognitivePlans[0].steps[0].status,'completed');
  assert.equal(a.read().life.goals[0].status,'active');
  t.mock.timers.setTime(start+DAY);
  a.restart();
  a.setOutcome('failed');
  await a.dispatch();
  const failed=a.read().life.cognitivePlans[0];
  assert.equal(failed.status,'failed');
  assert.equal(failed.steps[0].status,'completed');
  assert.equal(a.read().life.actions.at(-1).parameters.url,article);
  const failedId=failed.steps[1].receiptEventId;
  t.mock.timers.setTime(start+2*DAY);
  const prior=failed.steps[0].receiptEventId;
  await a.turn(snapshot=>{
    assert.equal(snapshot.plans[0].steps[1].receiptEventId,failedId);
    return {...empty,plan:[{...step(id,'fetch',{url:article}),sourceIds:['experience',prior]}]};
  });
  a.setOutcome('completed');
  const denied=await a.turn(()=>{throw Error('预算耗尽不能调用模型');},0);
  assert.equal(denied.reason,'budget_exhausted');
  assert.equal(a.read().life.cognitivePlans[1].steps[0].status,'pending');
  t.mock.timers.setTime(start+3*DAY);
  await a.dispatch();
  const readReceipt=a.read().life.cognitivePlans[1].steps[0].receiptEventId;
  await a.turn(snapshot=>{
    assert.ok(snapshot.relevantMemories.some(m=>m.sourceIds.includes(readReceipt)));
    assert.equal(snapshot.goalReadings[0].evidenceId,readReceipt);
    return {...empty,action:{actionType:capability,parameters:{kind:'search',query:'新的问题'},priority:50,
      interruptPolicy:'safe-point',requiredCapabilities:[capability],sourceIds:['unsupported-source']},
      goalUpdates:[{goalId:id,kind:'understood',evidenceId:readReceipt,
      understanding:quote+'这回答了我想知道歌声怎样被观察到的问题。'}]};
  });
  assert.equal(a.read().life.goals[0].status,'completed');
  assert.equal(a.read().life.selfModel.autobiography.length,1);
  assert.equal(a.read().life.selfModel.interests.length,1);

  for(const day of [1,2,3]){
    workEpisode(a.read(),day,'continue',false);
    workEpisode(a.read(),day,'rest',true,1);
    workEpisode(b.read(),day,'continue',true);
    workEpisode(b.read(),day,'rest',false,1);
  }
  for(const [index,run] of [a,b].entries()){
    run.read().legacy.farmSeedBundles=24;
    advanceFarm(run.read(),start+3*DAY,'fixed');
    changeFarmWeather(run.read(),index?'sunny':'heavy-rain',start+3*DAY);
    completeFarmOperation(run.read(),{operation:'plant'},'season',start+3*DAY);
    if(!index){
      completeFarmOperation(run.read(),{operation:'fertilize'},'rain-care-1',start+3*DAY);
      completeFarmOperation(run.read(),{operation:'fertilize'},'rain-care-2',start+3*DAY+4*60*60_000);
    }
    advanceFarm(run.read(),start+4*DAY,'fixed');
    assert.ok(run.read().life.worldModel.facts.some(f=>f.topic==='farm.settled'&&f.data.qualified===!index));
    const wages=run.read().life.events;
    wages.push(evidence('unpaid','social.labor.unpaid',time(4),{contractId:'wage',outstanding:100}));
    if(index)wages.push(evidence('payment','social.labor.payment',time(4),{contractId:'wage',outstanding:0}));
  }
  t.mock.timers.setTime(start+6*DAY);
  const chooseOnSite=async run=>{
    const state=run.read(),at=Date.now();
    state.humanity={...createHumanity(at),helperReady:true,restrained:false};
    state.humanity.stats.stamina=42;
    state.legacy.worksite={inside:true,sessionId:'new-session',workState:'running',completedInSession:15};
    state.legacy.labor={contracts:[{id:'new',status:'working',done:15,trips:40}]};
    const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
    const store={loadEnvelope:async()=>structuredClone(state)};
    const uow={apply:async(_id,_version,fn)=>{fn(state);}};
    const site=createWorksite(store,gate,uow,()=>null,()=>{});
    const model={agentDefaultModel:{currentSelection:()=>({provider:'controlled',model:'fixture'})},llm:{
      async *stream({messages}){
        const {choices}=JSON.parse(messages[0].content);
        yield {type:'text',text:JSON.stringify({decision:choices[0].choice==='rest'?'stop':'continue'})};
      }
    }};
    await new Promise(resolve=>{
      const reviews=createWorksiteReviews(store,gate,uow,{runAs:async(_id,_category,fn)=>fn()},model,
        (id,expected)=>site.act(id,'stop-work',expected),undefined,resolve);
      assert.equal(reviews.waiting(state),true);
    });
    return {chosen:state.life.events.findLast(e=>e.type==='labor.strategy')?.payload,workState:state.legacy.worksite.workState};
  };
  const [aChoice,bChoice]=await Promise.all([chooseOnSite(a),chooseOnSite(b)]);
  assert.equal(aChoice.chosen.choice,'rest');
  assert.equal(aChoice.workState,'stopped');
  assert.equal(bChoice.chosen.choice,'continue');
  assert.equal(bChoice.workState,'running');
  assert.ok(aChoice.chosen.recommendationSourceIds.length&&bChoice.chosen.recommendationSourceIds.length);
  assert.ok(a.read().life.selfModel.habits.some(h=>h.label==='work:rest'));
  assert.equal(laborPaymentHistory(a.read().life).overdue,1);
  assert.equal(laborPaymentHistory(a.read().life).overdueAmount,100);
  assert.equal(laborPaymentHistory(b.read().life).overdue,0);
  a.read().life.events.push(evidence('late-payment','social.labor.payment',time(6),{contractId:'wage',outstanding:0}));
  assert.equal(laborPaymentHistory(a.read().life).overdueAmount,0);
});

test('香港日期内最多一个旧念想、人工暂停不复核，条件变化可唤回新念想',()=>{
  const f=fixture(),s=f.read().life;
  s.events.push(evidence('newer','body.observed',time(1)));
  s.goals=[goal('old','deferred'),goal('newer','deferred','newer'),goal('manual','paused')];
  assert.deepEqual(goalsDueForReview(s,start+2*DAY).map(g=>g.id),['old']);
  reviewGoal(s,{goalId:'old',decision:'defer',reason:'还没有资料',hours:24},start+2*DAY);
  assert.deepEqual(goalsDueForReview(s,start+2*DAY),[]);
  s.constraints.permissions=[];
  assert.deepEqual(goalsDueForReview(s,start+2*DAY).map(g=>g.id),['old']);
  assert.deepEqual(goalsDueForReview(s,start+3*DAY).map(g=>g.id),['newer','old']);
  assert.throws(()=>reviewGoal(s,{goalId:'manual',decision:'resume',reason:'恢复'},start+3*DAY),/不可复核/);
  assert.equal(hasCognitiveDemand(s),true);
});

test('待确认回执只卡原计划，迟到回执幂等，删证据后剩余计划失效',async()=>{
  const f=fixture();f.read().life.goals.push(goal('a'),{...goal('b'),title:'另一项研究'});
  await f.turn(()=>({...empty,plan:[step('a','search'),{...step('a','fetch'),readSearchResult:true}]}));
  f.setOutcome('unknown');await f.dispatch();
  const unknownId=f.read().life.actions[0].id;
  assert.equal(f.read().life.cognitivePlans[0].steps[0].status,'awaiting_receipt');
  f.restart();assert.equal(await f.dispatch(),false);
  await f.turn(()=>({...empty,plan:[step('b','search')]}));
  f.setOutcome('completed');await f.dispatch();
  assert.equal(f.read().life.cognitivePlans[1].status,'completed');
  f.reconcile(unknownId);
  const receipt=f.read().life.cognitivePlans[0].steps[0].receiptEventId;
  assert.equal(receipt,'action-reconciled:'+unknownId);
  f.read().life.invalidSources.experience='纠正原经历';
  invalidateDependents(f.read().life);
  assert.equal(f.read().life.cognitivePlans[0].status,'failed');
  assert.equal(await f.dispatch(),false);
});

test('权限撤销使待派发计划失败，未过期天气和日结事实可追溯',async()=>{
  const f=fixture();f.read().life.goals.push(goal('a'));
  await f.turn(()=>({...empty,plan:[step('a','search')]}));
  f.read().life.constraints.permissions=[];
  await f.dispatch();
  assert.equal(f.read().life.cognitivePlans[0].status,'failed');
  assert.equal(f.read().life.actions.length,0);
  const d=f.read();
  d.legacy.farmSeedBundles=24;
  advanceFarm(d,start,'fixed');
  const first=d.life.worldModel.facts.at(-1);
  changeFarmWeather(d,'light-rain',start+60000);
  const latest=d.life.worldModel.facts.at(-1);
  assert.notEqual(first.id,latest.id);
  assert.equal(first.validUntil,new Date(start+60000).toISOString());
  const now=farmFacts(d,start+60001);
  assert.equal(now.weatherEventId,latest.sourceIds[0]);
  d.life.invalidSources[now.weatherEventId]='天气证据失效';
  invalidateDependents(d.life);
  assert.equal(latest.valid,false);
});

test('相同的濒临耗尽情境下，趟间休息后能继续，固定继续策略耗尽',async t=>{
  const at=start+6*DAY;
  t.mock.timers.enable({apis:['Date'],now:at});
  const common=fixture().read();
  common.humanity={...createHumanity(at),helperReady:true,restrained:false};
  Object.assign(common.humanity.stats,{stamina:.1,energy:.01,satiety:.01});
  common.life.spirit={value:0};
  common.legacy.worksite={inside:true,sessionId:'session',workState:'running',completedInSession:15};
  common.legacy.labor={contracts:[{id:'active',status:'working',done:15,trips:20,carrying:true,workPermit:true}]};
  common.legacy.world={command:{id:'cmd',source:'labor',index:1,approached:true,status:'running',surface:'web',labor:{id:'active',leg:'deliver',trip:15,x:.8}}};
  const fixed=structuredClone(common),adaptive=structuredClone(common);
  const gate={signal:new AbortController().signal,run:async(_id,fn)=>fn()};
  const store={loadEnvelope:async()=>adaptive};
  const uow={apply:async(_id,_version,fn)=>{fn(adaptive);}};
  const site=createWorksite(store,gate,uow,()=>null,()=>{});
  const context={contractId:'active',stamina:'low',phase:'late'};
  const chosen={sessionId:'session',contractId:'active',learning:{context,recommended:'rest',sourceIds:[]}};
  await site.act('main','stop-work',chosen);
  const resumeAt=adaptive.legacy.worksite.learningRest.restingUntil;
  t.mock.timers.setTime(resumeAt);
  adaptive.humanity=advanceHumanity(adaptive.humanity,resumeAt);
  assert.ok(adaptive.humanity.stats.stamina>=20);
  await site.act('main','resume-work',{...chosen,sessionId:adaptive.legacy.worksite.sessionId,recovered:true});
  const conduct=(draft,stamp)=>{
    const intent={id:'step',type:'labor.step',payload:{parameters:{contractId:'active',commandId:'cmd'}}};
    const receipt={status:'completed',evidence:{actionId:intent.id,kind:intent.type,confirmed:true,commandId:'cmd',
      index:1,surface:'web',played:true,x:.8,effortSeconds:1,intensity:1.5}};
    draft.life.events.push(evidence('trip-result','action.receipt',stamp));
    projectOutcome(draft,intent,receipt,stamp,'trip-result');
    return hasLaborResources(draft);
  };
  assert.equal(conduct(fixed,new Date(at).toISOString()),false);
  assert.equal(conduct(adaptive,new Date(resumeAt).toISOString()),true);
  assert.equal(adaptive.life.observations.find(o=>o.strategy==='work:rest')?.success,true);
  assert.ok(adaptive.life.events.some(e=>e.type==='labor.strategy'&&e.payload.recovered&&e.payload.overrodeRecommendation));
});

test('复核时间到之前等待清醒，原计划保留并继续派发',async()=>{
  const f=fixture();
  f.read().life.goals.push(goal('a'));
  await f.turn(()=>({...empty,plan:[step('a','search')]}));
  const now=Date.now(),life=f.read().life;
  life.spirit={value:80,mode:'sleep',updatedAt:now,sleepStartedAt:now,sleepStartValue:80,awakeSince:now,lastSleepHours:0,
    config:{sleepHours:8,awakeHours:14,hourlyDrain:2,napPerHour:6,sweetGain:8,sweetCooldownHours:4}};
  assert.equal(await f.dispatch(),false);
  assert.equal(f.read().life.cognitivePlans[0].steps[0].status,'pending');
  life.spirit.mode='awake';
  assert.equal(await f.dispatch(),true);
  assert.equal(f.read().life.cognitivePlans[0].steps[0].status,'completed');
});

test('独立策略样本至少三条才改变排序，删回执及时撤销影响',()=>{
  const state=fixture().read();
  const context={contractId:'next',stamina:'medium',phase:'early'};
  for(const day of [1,2])workEpisode(state,day,'rest',true);
  assert.equal(rankWorkChoices(state.life,context)[0].choice,'continue');
  const third=workEpisode(state,3,'rest',true);
  assert.equal(state.life.observations.length,3);
  assert.equal(rankWorkChoices(state.life,context)[0].choice,'rest');
  state.life.invalidSources[third.receipt]='撤销一条搬砖回执';
  invalidateDependents(state.life);
  assert.equal(rankWorkChoices(state.life,context)[0].choice,'continue');
  assert.ok(state.life.events.some(e=>e.eventId===third.decision&&!Object.hasOwn(state.life.invalidSources,e.eventId)));
});

test('已排队的网络动作在实际派发之前再次查验细分授权',()=>{
  const draft=fixture().read();
  draft.legacy.config={networkLearning:true};
  draft.legacy.abilities={search:{status:'granted'},fetch:{status:'revoked'}};
  const a={id:'queued',petId:'main',actionType:capability,parameters:{kind:'search',query:'鲸的歌声'},
    status:'PENDING',priority:50,interruptPolicy:'safe-point',requiredCapabilities:[capability],expectedStateVersion:0,
    sourceIds:['experience'],createdAt:time(0),updatedAt:time(0)};
  draft.life.actions.push(a);
  const lifecycle=new CanonicalActionLifecycle(d=>({body:d.life.body,emotions:d.life.emotions}));
  const intent={id:a.id,type:a.actionType,payload:{petId:a.petId,actionId:a.id,actionType:a.actionType,parameters:a.parameters}};
  assert.match(lifecycle.prepare(draft,intent).reason,/探索权限不可用/);
  assert.equal(draft.life.actions[0].status,'PENDING');
});
