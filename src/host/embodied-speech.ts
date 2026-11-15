import {createHash} from 'node:crypto';
import {actionCatalog,validateActionParameters} from './action-parameters.js';
import {conversationContext} from './conversation-context.js';
import {humanityPrompt} from '../../vendor/dsh-pet/src/host/humanity.mjs';
import type {CanonicalEnvelope} from '../storage/postgres.js';
import type {PetGate,UnitOfWork,OutboxDispatcher} from '../storage/uow.js';
import type {ActionCoordinator} from './action-coordinator.js';

type Stream={stream(input:any):AsyncIterable<any>};
type Speech={petId:string;requestId:string;sourceIds:string[];allowActions:boolean};
const empty={type:'object',properties:{},additionalProperties:false};
const executable=new Set(Object.keys(actionCatalog));
executable.add('care.water');
executable.delete('self.express');

/** One tool-aware turn for every utterance. Text preceding a tool call is a
 * draft, not a published claim. Real receipts return to the same model. */
export function createEmbodiedSpeech(reader:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},gate:PetGate,uow:UnitOfWork,actions:ActionCoordinator,dispatcher:OutboxDispatcher,
  beginWork:(id:string,sourceIds:string[],key:string)=>Promise<unknown>,leaveWork:(id:string)=>Promise<unknown>) {
  async function sense(petId:string){
    const envelope=await reader.loadEnvelope(petId);if(!envelope)throw Error('生命状态不可用');
    const events=envelope.life.events.filter(e=>!Object.hasOwn(envelope.life.invalidSources,e.eventId) &&
      ['body.observed','body.adjusted','wallet','social.care','interaction','interaction.operation','interaction.worksite','labor.changed','action.receipt'].includes(e.type)).slice(-16);
    return {envelope,context:{感受:humanityPrompt(envelope.humanity),生活:conversationContext({...envelope.life,petId,version:envelope.version} as any,envelope),
      近期真实经历:events.map(e=>({id:e.eventId,at:e.occurredAt,actor:e.actorId??'未确认',type:e.type,detail:e.payload})),
      自我认识:envelope.life.selfModel,当前目标:envelope.life.goals.filter(g=>g.status==='active').slice(-6),精神:envelope.life.spirit,可用能力:envelope.life.constraints.capabilities.filter(c=>c.enabled)}};
  }
  async function execute(speech:Speech,type:string,parameters:Record<string,unknown>,key:string,signal:AbortSignal){
    if(!speech.allowActions||signal.aborted||gate.signal.aborted)throw Error('当前发言不能执行行动');
    if(type==='work.begin')return beginWork(speech.petId,speech.sourceIds,key);
    if(type==='work.leave'){const current=await reader.loadEnvelope(speech.petId);if(!current||current.life.constraints.paused)throw Error('自主活动已暂停');return leaveWork(speech.petId);}
    if(!executable.has(type)||type==='labor.step')throw Error('不支持的自主行动；搬砖请用 work.begin');
    validateActionParameters(type,parameters);
    const id='speech-action:'+createHash('sha256').update(key).digest('hex');
    await gate.run(speech.petId,async()=>{
      let current=await reader.loadEnvelope(speech.petId);if(!current||signal.aborted)throw Error('行动已取消');
      const prior=current.life.actions.find(a=>a.id===id);
      if(prior){if(prior.actionType!==type||JSON.stringify(prior.parameters)!==JSON.stringify(parameters))throw Error('行动标识冲突');return;}
      if(current.life.actions.some(a=>['PENDING','DISPATCHED','UNKNOWN'].includes(a.status)&&a.actionType!=='qq.send'))throw Error('身体还有未确认的行动，先等结果');
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
    return {actionId:id,status:result?.status??'UNKNOWN',receipt:fresh?.life.receipts.find(r=>r.actionId===id)??null};
  }
  return {wrap(model:Stream):Stream {return {async *stream(options:any){
    const speech=options.embodied as Speech|undefined;
    if(!speech){yield* model.stream(options);return;}
    const signal=AbortSignal.any([options.signal??gate.signal,gate.signal,AbortSignal.timeout(90000)]);
    const initial=await sense(speech.petId),messages=[...options.messages];
    const allowed=initial.envelope.life.constraints.capabilities.filter(c=>c.enabled&&(!c.requiresPermission||initial.envelope.life.constraints.permissions.includes(c.requiresPermission))).map(c=>c.name).filter(n=>executable.has(n)&&n!=='labor.step'&&!['care.feed','care.pet','care.soothe','care.accompany'].includes(n));
    if(!initial.envelope.life.constraints.capabilities.some(c=>c.name==='care.water')&&initial.envelope.life.constraints.capabilities.some(c=>c.name==='care.feed'&&c.enabled))allowed.push('care.water');
    const tools=[{name:'sense_self',description:'感知此刻身体、需求、钱包、近期真实互动与行动结果。',inputSchema:empty},
      ...(speech.allowActions?[{name:'act',description:'按自己的需要选择一次实际行动。吃饭先买后吃；口头说做了不算完成。'+JSON.stringify(actionCatalog),inputSchema:{type:'object',properties:{actionType:{type:'string',enum:allowed},parameters:{type:'object'}},required:['actionType','parameters'],additionalProperties:false}},
      {name:'begin_work',description:'自主决定履行已有工作约定，申请进入工地并搬一趟；不创建合同、不确认爸爸提案、不支付工资。',inputSchema:empty},
      {name:'leave_worksite',description:'自主离开自己进入的工地；被爸爸放进去时须等他接出。',inputSchema:empty}]:[])];
    const system=options.system+'\n每次开口前，结合自己的感受、目标、刚才爸爸的操作和真实结果，判断此刻需不需要工具；可以只说话或安静，不必为了使用工具而行动。需要吃饭、喝水、睡觉、走动、学习或搬砖时调用工具，不能用台词冒充行动。失败后自己决定换办法、休息或向爸爸商量；条件未变不要重复失败的动作。感受和判断属于你，操作归因只依据真实来源，不知道是谁造成的就不要认定。通过真实结果理解自己喜欢什么、身体能做什么，不宣称凭空获得意识。工具后的回复针对结果自然地说，未知结果不能说完成。\n此刻实况：'+JSON.stringify(initial.context);
    const seen=new Set<string>();
    for(let round=0;round<5;round++){
      if(signal.aborted)throw Error('发言已取消');
      let text='';const calls=new Map<number,{id:string;name:string;arguments:string}>();
      for await(const part of model.stream({...options,embodied:undefined,signal,system,messages,tools:round<4?tools:undefined})){
        if(part.type==='text')text+=part.text??'';
        if(part.type==='tool-call-delta'){
          const c=calls.get(part.index)??{id:'',name:'',arguments:''};
          if(part.id)c.id=part.id;if(part.name)c.name=part.name;c.arguments+=part.argumentsDelta??'';
          if(c.arguments.length>8000||(!calls.has(part.index)&&calls.size>=4))throw Error('工具调用过长');calls.set(part.index,c);
        }
      }
      if(!calls.size){if(signal.aborted)throw Error('发言已取消');if(!text.trim())throw Error('没有收到完整回复');yield {type:'text',text};return;}
      if(round===4)throw Error('工具调用超过本轮限制');
      messages.push({role:'assistant',content:[...(text?[{type:'text',text}]:[]),...Array.from(calls.values(),c=>({type:'tool-call',...c}))]});
      let index=0;
      for(const c of calls.values()){
        let result:unknown,isError=false;
        try{
          if(!c.id||!c.name)throw Error('工具调用无效');
          const p=JSON.parse(c.arguments||'{}'),fingerprint=c.name+JSON.stringify(p);
          if(seen.has(fingerprint))throw Error('本轮已尝试过相同行动，先依据现有结果决定');seen.add(fingerprint);
          if(c.name==='sense_self')result=(await sense(speech.petId)).context;
          else if(c.name==='act')result=await execute(speech,p.actionType,p.parameters,`${speech.requestId}:${round}:${index}`,signal);
          else if(c.name==='begin_work')result=await execute(speech,'work.begin',{},`${speech.requestId}:${round}:${index}`,signal);
          else if(c.name==='leave_worksite')result=await execute(speech,'work.leave',{},`${speech.requestId}:${round}:${index}`,signal);
          else throw Error('工具不存在');
        }catch(error){isError=true;result={status:'failed',reason:error instanceof Error?error.message:'行动失败'};}
        const current=await reader.loadEnvelope(speech.petId);
        messages.push({role:'tool',toolCallId:c.id,isError,content:JSON.stringify({result,身体:current?.humanity?.stats})});index++;
      }
    }
  }};}};
}
