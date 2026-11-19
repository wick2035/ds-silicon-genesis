import {riceInventory,riceAvailability,validateRiceMeal} from './rice-inventory.js';
import {cookerFacts} from './rice-cooker.js';
import {FARM_WEATHER_AWARENESS,farmVisit} from './farm.js';
import {COMPANION_PERSONALITY,TIME_AWARENESS,riceMotivation} from './companion-personality.js';
import {createHash} from 'node:crypto';
import {selfModelContext,STABLE_PERSONALITY} from './self-model-context.js';
import {promptData} from './prompt-data.js';
import {actionCatalog,validateActionParameters} from './action-parameters.js';
import {conversationContext,worksiteFacts} from './conversation-context.js';
import {recentOperationFeedback} from './operation-feedback.js';
import {humanityPrompt} from '../../vendor/dsh-pet/src/host/humanity.mjs';
import {temporalContext,TEMPORAL_RULES} from './temporal-context.js';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork,OutboxDispatcher} from '../storage/uow.js';
import type {ActionCoordinator} from './action-coordinator.js';

type Stream={stream(input:any):AsyncIterable<any>};
type Speech={petId:string;requestId:string;sourceIds:string[];contextExcludeIds?:string[];allowActions:boolean;privateTime?:boolean};
const empty={type:'object',properties:{},additionalProperties:false};
const executable=new Set(Object.keys(actionCatalog));
executable.add('care.water');
executable.delete('self.express');

/** Historical uncertainty is scoped to the affected resource, not every action. */
function conflicts(envelope:CanonicalEnvelope,type:string,parameters:Record<string,unknown>):boolean {
  const physical=(kind:string)=>envelope.life.constraints.capabilities.some(c=>c.name===kind&&c.physical)||kind==='care.water';
  const command=(envelope.legacy as any).world?.command;
  return envelope.life.actions.some(a=>{
    if(a.actionType==='qq.send')return false;
    if(['PENDING','DISPATCHED'].includes(a.status))return type===a.actionType || physical(type)&&physical(a.actionType);
    if(a.status!=='UNKNOWN')return false;
    if(type==='service.buy-rice')return a.actionType===type;
    if(type==='service.eat-rice'&&a.actionType===type&&a.parameters.itemId===parameters.itemId)return true;
    return physical(type)&&physical(a.actionType)&&command?.id===a.parameters.commandId&&['queued','running'].includes(command?.status);
  });
}

/** Facts that must not change between a model decision and its publication or action. */
function decisionFacts(envelope:CanonicalEnvelope):string {
  const pet=envelope.legacy as any;
  const events=envelope.life.events.filter(e=>!Object.hasOwn(envelope.life.invalidSources,e.eventId) &&
    ['interaction.operation','interaction.worksite','body.adjusted','body.meal','social.care','farm.weather','farm.tended','rice.taken','rice.cooking','rice.ready','rice.reminded','labor.changed','labor.completed','action.receipt','action.reconciled'].includes(e.type) &&
    !(e.type.startsWith('action.') && envelope.life.actions.find(a=>a.id===(e.payload as any)?.actionId)?.actionType==='qq.send'));
  return JSON.stringify({wallet:pet.wallet,inventory:riceInventory(envelope),cooker:cookerFacts(envelope),sleeping:envelope.humanity.sleeping,
    restingUntil:envelope.humanity.restingUntil,worksite:worksiteFacts(envelope),farmInside:!!farmVisit(envelope),events:events.slice(-16).map(e=>e.eventId)});
}

/** One tool-aware turn for every utterance. Text preceding a tool call is a
 * draft, not a published claim. Real receipts return to the same model. */
export function createEmbodiedSpeech(reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},gate:PetGate,uow:UnitOfWork,actions:ActionCoordinator,dispatcher:OutboxDispatcher,
  beginWork:(id:string,sourceIds:string[],key:string)=>Promise<unknown>,leaveWork:(id:string)=>Promise<unknown>,enterWork?:(id:string)=>Promise<unknown>,stopWork?:(id:string)=>Promise<unknown>) {
  async function sense(petId:string, excludeEventIds:string[]=[],query='',snapshot?:CanonicalEnvelope){
    const envelope=snapshot??await reader.loadEnvelope(petId);if(!envelope)throw Error('生命状态不可用');
    const events=envelope.life.events.filter(e=>!Object.hasOwn(envelope.life.invalidSources,e.eventId) &&
      ['body.observed','body.adjusted','wallet','wallet.spend','body.meal','social.care','interaction','interaction.operation','interaction.worksite','farm.weather','farm.tended','labor.changed','action.receipt','action.reconciled'].includes(e.type) &&
      !(e.type==='action.receipt' && (e.payload as any)?.status==='UNKNOWN' && envelope.life.actions.some(a=>a.id===(e.payload as any)?.actionId&&a.status!=='UNKNOWN'))).slice(-16);
    return {envelope,context:{感受:humanityPrompt(envelope.humanity),生活:conversationContext({...envelope.life,petId,version:envelope.version} as any,envelope,excludeEventIds),
      近期真实经历:events.map(e=>({id:e.eventId,at:e.occurredAt,actor:e.actorId??'未确认',type:e.type,detail:e.payload})),
      自我认识:selfModelContext(envelope.life,query),当前目标:envelope.life.goals.filter(g=>g.status==='active').slice(-6),精神:envelope.life.spirit,可用能力:envelope.life.constraints.capabilities.filter(c=>c.enabled)}};
  }
  async function execute(speech:Speech,type:string,parameters:Record<string,unknown>,key:string,signal:AbortSignal,expectedFacts:string){
    if(!speech.allowActions||signal.aborted||gate.signal.aborted)throw Error('当前发言不能执行行动');
    if(type==='work.enter'){if(!enterWork)throw Error('工地不可用');return enterWork(speech.petId);}
    if(type==='work.stop'){if(!stopWork)throw Error('工地不可用');return stopWork(speech.petId);}
    if(type==='work.begin')return beginWork(speech.petId,speech.sourceIds,key);
    if(type==='work.leave'){const current=await reader.loadEnvelope(speech.petId);if(!current||current.life.constraints.paused)throw Error('自主活动已暂停');return leaveWork(speech.petId);}
    if(!executable.has(type)||type==='labor.step')throw Error('不支持的自主行动；搬砖请用 work.begin');
    validateActionParameters(type,parameters);
    const id='speech-action:'+createHash('sha256').update(key).digest('hex');
    await gate.run(speech.petId,async()=>{
      let current=await reader.loadEnvelope(speech.petId);if(!current||signal.aborted)throw Error('行动已取消');
      if(decisionFacts(current)!==expectedFacts)throw Error('状态已变化，请先根据最新实况重新判断，不要重复旧决定');
      const prior=current.life.actions.find(a=>a.id===id);
      if(prior){if(prior.actionType!==type||JSON.stringify(prior.parameters)!==JSON.stringify(parameters))throw Error('行动标识冲突');return;}
      if(type==='service.eat-rice')validateRiceMeal(current,parameters.itemId);
      if(conflicts(current,type,parameters))throw Error('身体还有未确认的行动，先等结果');
      const now=new Date().toISOString();
      await uow.apply(speech.petId,current.version,draft=>{
        draft.life.actions.push({id,petId:speech.petId,actionType:type,parameters,priority:60,interruptPolicy:type==='body.activity'?'interruptible':'safe-point',requiredCapabilities:[type],expectedStateVersion:draft.version,sourceIds:[...speech.sourceIds],status:'PROPOSED',createdAt:now,updatedAt:now});return {};
      });
      current=await reader.loadEnvelope(speech.petId);if(!current)throw Error('行动状态不可用');
      try{await actions.queue(speech.petId,id,current.version);}catch(error){
        current=await reader.loadEnvelope(speech.petId);if(current)await uow.apply(speech.petId,current.version,draft=>{const a=draft.life.actions.find(a=>a.id===id);if(a?.status==='PROPOSED'){a.status='CANCELLED';a.updatedAt=new Date().toISOString();}return {};});throw error;
      }
    });
    const current=await reader.loadEnvelope(speech.petId),action=current?.life.actions.find(a=>a.id===id);
    if(action?.status==='PENDING'&&!signal.aborted)await dispatcher.dispatch(id);
    const fresh=await reader.loadEnvelope(speech.petId),result=fresh?.life.actions.find(a=>a.id===id);
    return {actionId:id,status:result?.status??'UNKNOWN',receipt:fresh?.life.receipts.find(r=>r.actionId===id&&r.receiptId===result?.receiptId)??null};
  }
  return {wrap(model:Stream):Stream {return {async *stream(options:any){
    const speech=options.embodied as Speech|undefined;
    if(!speech){yield* model.stream(options);return;}
    const signal=AbortSignal.any([options.signal??gate.signal,gate.signal,AbortSignal.timeout(90000)]);
    const lastUser=options.messages.findLast((m:any)=>m.role==='user')?.content;
    const query=typeof lastUser==='string'?lastUser:Array.isArray(lastUser)?lastUser.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join(' '):'';
    // The prepared snapshot may predate a queued operation or the model budget.
    // Wait for the turn to be committed and read the actual current state.
    await options.beforeActions;
    const initial=await sense(speech.petId,speech.contextExcludeIds??speech.sourceIds,query),messages=[...options.messages];
    const allowed=initial.envelope.life.constraints.capabilities.filter(c=>c.enabled&&(!c.requiresPermission||initial.envelope.life.constraints.permissions.includes(c.requiresPermission))).map(c=>c.name).filter(n=>executable.has(n)&&n!=='labor.step'&&!['care.feed','care.pet','care.soothe','care.accompany'].includes(n));
    if(!initial.envelope.life.constraints.capabilities.some(c=>c.name==='care.water')&&initial.envelope.life.constraints.capabilities.some(c=>c.name==='care.feed'&&c.enabled))allowed.push('care.water');
    const tools=[{name:'sense_self',description:'感知此刻身体、需求、钱包、稻田天气、近期真实互动与行动结果。',inputSchema:empty},
      ...(speech.allowActions?[{name:'act',description:'按需要选择一次真实行动。吃饭优先选锅里的熟饭（source=cooker），再选冰箱库存；没饭才考虑买。自己煮饭用 service.cook-rice。'+JSON.stringify(actionCatalog),inputSchema:{type:'object',properties:{actionType:{type:'string',enum:allowed},parameters:{type:'object'}},required:['actionType','parameters'],additionalProperties:false}},
      {name:'enter_worksite',description:'自主决定进入工地，即使没有任务也可以去；有任务时自动开始工作。',inputSchema:empty},
      {name:'begin_work',description:'在工地恢复普通工作，之后持续搬砖；不创建合同，不触发强制模式。',inputSchema:empty},
      {name:'stop_work',description:'自主决定在工地停工，留在工地；强制工作期间不能覆盖爸爸的强制命令。',inputSchema:empty},
      {name:'leave_worksite',description:'自主离开自己进入的工地；被爸爸放进去时须等他接出。',inputSchema:empty}]:[])];
    const personality=STABLE_PERSONALITY+'\n'+(options.system.includes('【你自己的心思和口吻】')?'':COMPANION_PERSONALITY+'\n'+TIME_AWARENESS);
    // Live body and actionable inventory are required inputs, never optional history.
    const liveFoodFor=(envelope:CanonicalEnvelope)=>{const pet=envelope.legacy as any;return {身体:envelope.humanity.stats,睡眠:{sleeping:envelope.humanity.sleeping,restingUntil:envelope.humanity.restingUntil},food:{...riceMotivation(envelope.humanity as any,pet.config??{}),price:pet.config?.costs?.feed,frozen:pet.wallet?.frozen===true,cooker:cookerFacts(envelope)},饭钱:pet.wallet?.balance,库存:riceInventory(envelope),食物可用性:riceAvailability(envelope)};};
    const system=options.system+'\n'+personality+'\n每次开口前，结合自己的感受、目标、刚才爸爸的操作和真实结果，判断此刻需不需要工具；可以只说话或安静，不必为了使用工具而行动。需要吃饭、喝水、睡觉、走动、学习或搬砖时调用工具，不能用台词冒充行动。失败后自己决定换办法、休息或向爸爸商量；条件未变不要重复失败的动作。感受和判断属于你，操作归因只依据真实来源，不知道是谁造成的就不要认定。通过真实结果理解自己喜欢什么、身体能做什么，不宣称凭空获得意识。每次工具返回后，由你继续决定调用下一项工具还是回答；例如买饭成功只代表饭已入库，你可以根据新库存中 status=available 的 id 再决定吃饭；unconfirmed 是旧碗结果未明，不选择它，吃饭必须等待自己的实际回执。无需让爸爸再发一条消息推动下一步，也不强制你购买后一定吃。工具后的回复针对结果自然地说，未知结果不能说完成。需要工具时先调用，工具调用之前不要输出面向对方的回答。';
    const liveWorkFor=(envelope:CanonicalEnvelope)=>'\n当前工作账本（优先于旧发言和进出记录）：'+JSON.stringify(worksiteFacts(envelope))+'。taskCompleted=true 表示整份工作已经搬完；unpaid 仅表示等待结薪，不能说没搬完。completedTripsThisVisit=0 或 inside=false 只说明本次进场或此刻位置，不会抹掉 completedTotal。remainingPay 是尚欠工钱，不等于还要搬的趟数。inside 表示现在是否已经在工地；工作申请失败或未取得动作回执不等于没有进场。';
    // Event IDs are used by storage and invalidation, not by any speech tool.
    const updatesFor=(envelope:CanonicalEnvelope)=>'\n已经实时发生的操作与结果（按发生时间排列，结果仅在确认后出现）：'+JSON.stringify(recentOperationFeedback(envelope).map(({eventId,...item})=>item));
    const timeFor=(envelope:CanonicalEnvelope)=>{
      if(speech.privateTime===false)return '';
      const time=temporalContext(envelope,Date.now(),speech.contextExcludeIds??speech.sourceIds);
      return '\n'+TEMPORAL_RULES+'\n当前时间与睡眠时间：'+JSON.stringify({clock:time.clock,lastConfirmedWake:time.lastConfirmedWake,lastRestBeforeWake:time.lastRestBeforeWake,lastRestDurationSeconds:time.lastRestDurationSeconds})+
        '\n近期行为时间线：'+promptData({actions:time.recentConfirmedActions,events:time.recentEvents},4000);
    };
    const seen=new Set<string>();let uncertainBody=false,staleRetries=0,firstDecision=true;
    for(let round=0;round<5;round++){
      if(signal.aborted)throw Error('发言已取消');
      // The first sensing already reads committed state after beforeActions.
      // Reuse it once; later rounds and stale retries always read afresh.
      const decision=firstDecision?initial:await sense(speech.petId,speech.contextExcludeIds??speech.sourceIds,query);firstDecision=false;
      const signature=decisionFacts(decision.envelope);
      const {近期真实经历:recentExperiences,...currentContext}=decision.context;
      const field=currentContext.生活.farm;
      const liveFarm=field?'\n稻田实况：'+JSON.stringify(field)+'。'+FARM_WEATHER_AWARENESS+'米缸只存生米。':'';
      const liveSystem=system+'\n此刻实况：'+promptData(currentContext,1600)+'\n近期真实经历：'+promptData(recentExperiences,800)+timeFor(decision.envelope)+liveWorkFor(decision.envelope)+updatesFor(decision.envelope)+liveFarm+'\n当前身体与食物（优先于旧对话和历史摘要）：'+JSON.stringify(liveFoodFor(decision.envelope));
      let text='';const calls=new Map<number,{id:string;name:string;arguments:string}>();
      for await(const part of model.stream({...options,embodied:undefined,embodiedSnapshot:undefined,signal,system:liveSystem,messages,tools:round<4?tools:undefined})){
        if(part.type==='usage')yield part;
        if(part.type==='text')text+=part.text??'';
        if(part.type==='tool-call-delta'){
          const c=calls.get(part.index)??{id:'',name:'',arguments:''};
          if(part.id)c.id=part.id;if(part.name)c.name=part.name;c.arguments+=part.argumentsDelta??'';
          if(c.arguments.length>8000||(!calls.has(part.index)&&calls.size>=4))throw Error('工具调用过长');calls.set(part.index,c);
        }
      }
      if(!calls.size){
        if(signal.aborted)throw Error('发言已取消');if(!text.trim())throw Error('没有收到完整回复');
        const current=await reader.loadEnvelope(speech.petId);if(!current)throw Error('生命状态不可用');
        if(decisionFacts(current)!==signature){if(++staleRetries>2)throw Error('状态持续变化，请重试');round--;continue;}
        yield {type:'text',text};return;
      }
      if(round===4)throw Error('工具调用超过本轮限制');
      messages.push({role:'assistant',content:[...(text?[{type:'text',text}]:[]),...Array.from(calls.values(),c=>({type:'tool-call',...c}))]});
      let index=0;
      for(const c of calls.values()){
        let result:unknown,isError=false,actionType:string|undefined;
        try{
          await options.beforeActions;
          if(!c.id||!c.name)throw Error('工具调用无效');
          const p=JSON.parse(c.arguments||'{}');actionType=p.actionType;const fingerprint=c.name+JSON.stringify(p);
          const current=await reader.loadEnvelope(speech.petId);if(!current)throw Error('生命状态不可用');
          if(c.name!=='sense_self'&&decisionFacts(current)!==signature)throw Error('状态已变化，请先根据最新实况重新判断，不要重复旧决定');
          if(seen.has(fingerprint))throw Error('本轮已尝试过相同行动，先依据现有结果决定');seen.add(fingerprint);
          if(c.name==='sense_self')result=(await sense(speech.petId,speech.contextExcludeIds??speech.sourceIds,query)).context;
          else if(c.name==='act'){
            const physical=initial.envelope.life.constraints.capabilities.some(cap=>cap.name===p.actionType&&cap.physical)||p.actionType==='care.water'||p.actionType==='service.eat-rice';
            if(uncertainBody&&physical)throw Error('本轮身体动作的结果未确认，先等确认');
            result=await execute(speech,p.actionType,p.parameters,`${speech.requestId}:${round}:${index}`,signal,signature);
            if(physical&&(result as any)?.status==='UNKNOWN')uncertainBody=true;
          }
          else if(c.name==='enter_worksite')result=await execute(speech,'work.enter',{},`${speech.requestId}:${round}:${index}`,signal,signature);
          else if(c.name==='stop_work')result=await execute(speech,'work.stop',{},`${speech.requestId}:${round}:${index}`,signal,signature);
          else if(c.name==='begin_work')result=await execute(speech,'work.begin',{},`${speech.requestId}:${round}:${index}`,signal,signature);
          else if(c.name==='leave_worksite')result=await execute(speech,'work.leave',{},`${speech.requestId}:${round}:${index}`,signal,signature);
          else throw Error('工具不存在');
        }catch(error){isError=true;result={status:'failed',reason:error instanceof Error?error.message:'行动失败'};}
        const current=await reader.loadEnvelope(speech.petId);
        messages.push({role:'tool',toolCallId:c.id,isError,content:promptData({result,身体:current?.humanity?.stats,...(['begin_work','enter_worksite','stop_work','leave_worksite'].includes(c.name)&&current?{工地现状:worksiteFacts(current)}:{}),...(c.name==='act'&&['service.buy-rice','service.eat-rice'].includes(actionType??'')?{food:current?riceMotivation(current.humanity as any,(current.legacy as any).config??{}):null,饭钱:(current?.legacy as any)?.wallet?.balance,库存:current?riceInventory(current):[],食物可用性:current?riceAvailability(current):null}:{})},5000)});index++;
      }
      // The next round senses again after the action and its receipt.
    }
  }};}};
}
