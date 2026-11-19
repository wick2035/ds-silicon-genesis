import {createWorksiteReviews} from './worksite-reviews.js';
import {createWorksiteChatWait} from './worksite-chat-coordination.js';
import {createLaborCompletionNotices} from './labor-completion-notices.js';
import {companionContext,COMPANION_PERSONALITY} from './companion-personality.js';
import {createInteractionReactions} from './interaction-reactions.js';
import {createFeedbackLeafPublisher,createImmediateFeedback} from './operation-feedback.js';
import {createCommitObservers} from './commit-observers.js';
import {groupChatBlocked} from './qq-group-access.js';
import {readMemeChoices,withMemeSpeech,type MemeSource} from './meme-speech.js';
import {createEmbodiedSpeech} from './embodied-speech.js';
import {initializeSpirit} from './spirit-initialization.js';
import {createCanonicalTodos,createTodoRoute} from './canonical-todos.js';
import {createLegacyResponses} from './legacy-responses.js';
import {createCareReactions,careReactionLeaf} from './care-reactions.js';
import {createWorksiteReactions} from './worksite-reactions.js';
import {createSemanticGrounding} from './semantic-grounding.js';
import {projectLegacySnapshot} from './legacy-snapshot.js';
import {readFile,writeFile,rename,realpath,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {LifeKernel,invalidateDependents} from '../kernel/index.js';
import type {LifeState} from '../kernel/types.js';
import {Cognition} from '../cognition/index.js';
import {LifeScheduler} from '../scheduler/index.js';
import {OutboxDispatcher} from '../storage/uow.js';
import {openLifeStores} from './stores.js';
import {projectBody} from './body-projection.js';
import {legacyContext} from './legacy-context.js';
import {CanonicalHumanityAdapter} from './humanity-adapter.js';
import {LegacyDomain} from './legacy-domain.js';
import {createLegacyRequestAdapter} from './legacy-request-adapter.js';
import {createDesktopCommandChannel} from './desktop-command-channel.js';
import {createHelperChannel} from './helper-channel.js';
import {createFarmScene} from './farm-scene.js';
import {createRiceCooker} from './rice-cooker.js';
import {createWorksite} from './worksite.js';
import {createDomainExecutors} from './domain-executors.js';
import {CanonicalActionLifecycle} from './action-lifecycle.js';
import {ActionCoordinator} from './action-coordinator.js';
import {CognitiveResultCoordinator} from './cognitive-result.js';
import {DurableCognitiveBudget} from './cognitive-budget.js';
import {createModelFacade} from './model-facade.js';
import {createGroupProactive,generateGroupOpener} from './qq-group-proactive.js';
import {createCognitiveModel} from './cognitive-model.js';
import {CanonicalMemoryRetrieval} from './memory-retrieval.js';
import {LocalReranker} from './local-reranker.js';
import {MemoryEmbedding} from './memory-embedding.js';
import {memoryGraph} from './memory-associations.js';
import {MemoryIndex} from './memory-index.js';
import {createPublicWeb,createBiliReader,createExplorationExecutor} from './network-services.js';
import {createLifeApi,createLifeManagement} from './life-api.js';
import {createCompanionManagement} from './companion-management.js';
import {createFinanceManagement} from './finance-management.js';
import {CanonicalChat,createChatHttp} from './chat-service.js';
import {isOwnerPrivateConversation} from './chat-identity.js';
import {startStandalone} from './standalone.js';
import {createLegacyServiceActions} from './legacy-service-actions.js';
import {createDeterministicLife} from './deterministic-life.js';
import {createAutonomousNeeds} from './autonomous-needs.js';
import {localRiceReconciler} from './rice-purchase.js';
import {createHelperTokens} from './helper-tokens.js';
import {isPresentationRoute} from './visual-routes.js';
import {CanonicalQQ} from './qq-canonical.js';
import {prepareFreshQQ,prepareQQTakeover,verifyQQCutoverProof} from './qq-takeover.js';
import {verifyOldQQAbsent} from './qq-process-inventory.js';
import type {CanonicalQQGateway} from './qq-gateway.js';
import {createDevelopment} from './development.js';
import {createAttachmentStore} from './attachment-store.js';
import {DesktopIdle} from './desktop-idle.js';
import {createImageObserver} from './image-observer.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(import.meta.url);
const {Pool}=require('pg');
const readJson=async(path:string)=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
function connectionUri(config:any):string {
  if(typeof config?.connectionString==='string')return config.connectionString;
  if(!config || !config.host || !config.port || !config.database || !config.user || typeof config.password!=='string')throw Error('本地数据库配置无效');
  const url=new URL('postgresql://localhost');url.hostname=config.host;url.port=String(config.port);
  url.pathname='/'+encodeURIComponent(config.database);url.username=config.user;url.password=config.password;return url.href;
}

export async function main():Promise<void> {
  const dbConfig=await readJson(join(root,'data','dsh','dsh-pet','companion','postgres.json'));
  if(dbConfig.namespace!=='desktop-pet')throw Error('数据库来源配置无效');
  const parser=await import(pathToFileURL(join(root,'vendor','dsh-pet','src','host','config','jsonc.ts')).href);
  const config=parser.readJsonc(join(root,'data','dsh','dsh-pet','main-config.jsonc'));
  const configuredPet=Array.isArray(config?.pets)?config.pets.find((entry:any)=>entry?.id==='main'):config?.pets?.main;
  const persona=configuredPet?.whisperPrompt || (await readFile(join(root,'persona.md'),'utf8'));
  if(typeof persona!=='string'||!persona.trim())throw Error('当前角色描述不可用');
  const modelConfig=await readJson(join(root,'data','model-config.json'));
  const pool=new Pool({...dbConfig.connection,application_name:'silicon-genesis'});
  let stores:Awaited<ReturnType<typeof openLifeStores>>|undefined,app:Awaited<ReturnType<typeof startStandalone>>|undefined,scheduler:LifeScheduler|undefined;
  let model:ReturnType<typeof createModelFacade>|undefined,bili:ReturnType<typeof createBiliReader>|undefined;
  let qq:CanonicalQQGateway|undefined;
  let groupConversation:ReturnType<typeof createGroupProactive>|undefined;
  try {
    stores=await openLifeStores(pool,projectBody,legacyContext(persona));
    const {lease,store,unitOfWork,wakes}=stores;
    const pets=await lease.query('SELECT pet_id FROM silicon_genesis.life_state ORDER BY pet_id');
    const ids=pets.rows.map(row=>String(row.pet_id));
    const petId=ids.includes('main')?'main':ids.length===1?ids[0]:'';
    if(!petId)throw Error('未找到唯一的已迁移宠物');
    await lease.run(petId,async()=>{const state=await store.loadEnvelope(petId),command=(state?.legacy as any)?.world?.command;
      if(state && command && ['queued','running'].includes(command.status))await unitOfWork.apply(petId,state.version,draft=>{
        const legacy=draft.legacy as any,old=legacy.world?.command;
        if(old && ['queued','running'].includes(old.status)){const pending=draft.life.actions.some(a=>a.actionType==='labor.step'&&a.status==='PENDING'&&a.parameters.commandId===old.id);if(pending&&old.status==='queued'){old.expires=Date.now()+90000;}else{(legacy.world.commandHistory||=[]).push({...structuredClone(old),status:'interrupted',interruptedReason:'host-restarted'});legacy.world.commandHistory=legacy.world.commandHistory.slice(-50);old.status='interrupted';old.interruptedReason='host-restarted';}}
        return {};
      });});
    // Register the executable capability for existing archives without a schema migration.
    await lease.run(petId,async()=>{const state=await store.loadEnvelope(petId);if(state&&!state.life.constraints.capabilities.some(c=>c.name==='body.activity'))await unitOfWork.apply(petId,state.version,draft=>{draft.life.constraints.capabilities.push({name:'body.activity',enabled:true,physical:true});return {};});});
    // A forced batch may drive stamina/energy negative; labor.step must not be
    // blocked by the default body limits. The decision layer (tired/forced) owns
    // whether she works, so widen the physical floor on existing archives.
    await lease.run(petId,async()=>{const state=await store.loadEnvelope(petId);if(!state)return;const cap=state.life.constraints.capabilities.find(c=>c.name==='labor.step');if(cap&&(!cap.bodyLimits||cap.bodyLimits.minStamina===undefined||cap.bodyLimits.minStamina>=0))await unitOfWork.apply(petId,state.version,draft=>{const c=draft.life.constraints.capabilities.find((x:any)=>x.name==='labor.step');if(c)c.bodyLimits={...(c.bodyLimits||{}),allowSleeping:true,allowRestrained:true,allowInjured:true,minStamina:-101,maxPain:101};return {};});});
    await lease.run(petId,async()=>{const state=await store.loadEnvelope(petId);if(state&&(!state.life.spirit||!['self.express','service.sweet'].every(name=>state.life.constraints.capabilities.some(c=>c.name===name))))await unitOfWork.apply(petId,state.version,draft=>{initializeSpirit(draft);return {};});});
    const farm=createFarmScene(store,lease,unitOfWork);
    await farm.clearVisit(petId);
    await lease.run(petId,async()=>{
      const state=await store.loadEnvelope(petId);
      if(!state)return;
      const missing=[{name:'farm.tend',enabled:true,physical:true},{name:'service.cook-rice',enabled:true}]
        .filter(cap=>!state.life.constraints.capabilities.some(item=>item.name===cap.name));
      if(missing.length)await unitOfWork.apply(petId,state.version,draft=>{draft.life.constraints.capabilities.push(...missing);return {};});
    });
    await farm.settle(petId);
    const cooker=createRiceCooker(store,lease,unitOfWork);
    await cooker.settle(petId);
    const authority={},observerAuthority={},helperAuthority={};
    const humanity=new CanonicalHumanityAdapter(store,unitOfWork,lease,authority,observerAuthority);
    const domain=new LegacyDomain(store,unitOfWork,lease,observerAuthority);
    const tokens=createHelperTokens(store,domain,observerAuthority);
    const commandChannel=createDesktopCommandChannel(store,helperAuthority);
    let worksiteWake:(id:string)=>void=()=>{};
    let wakeNeeds:(id:string)=>void=()=>{};
    const worksite=createWorksite(store,lease,unitOfWork,id=>commandChannel.view(id),id=>commandChannel.cancelPet(id),id=>worksiteWake(id));
    let wakeTokenPickup:(id:string)=>void=()=>{};
    let semanticResponse:((id:string,requestId:string,detail:unknown)=>Promise<unknown>)|undefined;
    const desktopIdle=new DesktopIdle();
    const helper=createHelperChannel(humanity,commandChannel.bridge,[petId],observerAuthority,helperAuthority,commandChannel,
      (id,requestId,detail)=>domain.observeSpace(id,requestId,detail,observerAuthority),
      async(id,requestId,detail)=>{const action=(detail as any)?.action;
        if(action==='hold'||action==='collect')commandChannel.cancelToken(id);
        const result=await tokens.handle(id,requestId,detail);
        if(action==='release'||action==='recover'||action==='collect')wakeTokenPickup(id);
        return result;
      },
      async(id,requestId,detail)=>{const d=detail as any;if(!d||typeof d.id!=='string'||typeof d.key!=='string'||![d.fromX,d.toX].every((n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1))throw Error('搬砖拖动观察无效');await domain.laborAction(id,requestId,{action:'disturb',id:d.id,key:d.key,surface:'desktop',fromX:d.fromX,toX:d.toX},observerAuthority);const state=await store.loadEnvelope(id);if(!state)throw Error('状态不可用');return projectLegacySnapshot(state).labor;},
      (id,requestId,detail)=>{if(!semanticResponse)throw Error('互动服务尚未就绪');return semanticResponse(id,requestId,detail);},
      (id,action)=>action==='snapshot'?worksite.snapshot(id):worksite.act(id,action as Parameters<typeof worksite.act>[1]),desktopIdle,id=>worksiteWake(id),farm,cooker,id=>wakeNeeds(id));
    bili=createBiliReader(root);
    const executors=new Map(createDomainExecutors(commandChannel.bridge));
    executors.set('farm.tend',farm.execute);
    executors.set('learning.observe',createExplorationExecutor(createPublicWeb(),bili));
    const reconcileRice=localRiceReconciler(store);
    const localRiceActions=['service.buy-rice','service.cook-rice'];
    const dispatcher=new OutboxDispatcher(lease,executors,lease,new CanonicalActionLifecycle(projectBody),new Map(localRiceActions.map(kind=>[kind,reconcileRice])));
    await dispatcher.recoverInterrupted();
    const recovered=await store.loadEnvelope(petId);
    for(const action of recovered?.life.actions??[])if(localRiceActions.includes(action.actionType)&&action.status==='UNKNOWN')await dispatcher.reconcile(action.id);
    const kernel=new LifeKernel(store,authority), budget=new DurableCognitiveBudget(store,unitOfWork,lease);
    const attachments=createAttachmentStore(store,lease,unitOfWork);
    model=createModelFacade(modelConfig,{leaseSignal:lease.signal,budget,resolveImage:attachments.resolve,persist:async value=>{const file=join(root,'data','model-config.json'),temporary=file+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await rename(temporary,file);}});
    executors.set('image.observe',createImageObserver(store,budget,model));
    const actions=new ActionCoordinator(unitOfWork,projectBody);
    const service=createLegacyServiceActions(store,lease,unitOfWork,actions,dispatcher);
    const speech=createEmbodiedSpeech({loadEnvelope:farm.settle},lease,unitOfWork,actions,dispatcher,async(id)=>worksite.act(id,'resume-work'),
      id=>worksite.act(id,'leave-voluntary'),id=>worksite.act(id,'request-entry'),id=>worksite.act(id,'stop-work'));
    let memeSource:MemeSource=async()=>[];
    const replyMemes=new Map<string,string>();
    const rememberMeme=(text:string,meme?:string)=>{if(meme)replyMemes.set(text,meme);else replyMemes.delete(text);if(replyMemes.size>100)replyMemes.delete(replyMemes.keys().next().value!);};
    model.llm=Object.assign({...model.llm,stream:withMemeSpeech(speech.wrap(model.llm),(id,mode)=>memeSource(id,mode)).stream},{embodiedTools:true});
    const grounding=createSemanticGrounding(store,budget,model,id=>commandChannel.observation(id));
    // Cognition generates expression with current facts; tool execution keeps
    // its own state and permission checks, without a second model reviewing speech.
    executors.set('self.express',async(id,intent,signal)=>{
      const text=(intent.payload.parameters as any)?.text;
      if(signal.aborted||typeof text!=='string'||!text.trim()||text.length>4000)return {status:'failed',evidence:{reason:'表达内容无效'}};
      const requested=(intent.payload.parameters as any)?.meme,pool=await memeSource(id,'whisper');
      const meme=pool.find(m=>m.name===requested)?.name;
      return {status:'completed',evidence:{actionId:intent.id,kind:'self.express',confirmed:true,...(meme?{meme}:{})}};
    });
    const reranker=new LocalReranker(root,lease.signal);
    const commitObservers=createCommitObservers(),dispatchObservers=createCommitObservers();
    unitOfWork.onCommit(commitObservers.notify);dispatcher.onCommit(dispatchObservers.notify);
    const observeCommits=(observer:Parameters<typeof commitObservers.add>[0])=>{commitObservers.add(observer);dispatchObservers.add(observer);};
    const memoryIndex=new MemoryIndex(lease,store),embedding=new MemoryEmbedding(lease,store,modelConfig);
    const scheduleMemory=(draft:Parameters<typeof memoryIndex.schedule>[0])=>{memoryIndex.schedule(draft);embedding.schedule(draft);};
    observeCommits(scheduleMemory);
    const worksiteReviews=createWorksiteReviews(store,lease,unitOfWork,budget,model,(id,expected)=>worksite.act(id,'stop-work',expected),(id,expected)=>worksite.act(id,'resume-work',expected),id=>worksiteWake(id));
    observeCommits(worksiteReviews.observe);
    const initialIndexState=await store.loadEnvelope(petId);if(initialIndexState){scheduleMemory(initialIndexState);worksiteReviews.observe(initialIndexState);}
    const waitForWorksiteStep=createWorksiteChatWait(store,[unitOfWork,dispatcher]);
    const resumeWorkAfterChat=(id:string)=>{void store.loadEnvelope(id).then(current=>{const pet=current?.legacy as any;if(pet?.worksite?.inside&&(pet.worksite.workState!=='stopped'||pet.worksite.forced===true)&&pet.labor?.contracts?.some((c:any)=>['working','queued'].includes(c.status)&&c.done<c.trips))worksiteWake(id);}).catch(()=>{});};
    const retrieval=new CanonicalMemoryRetrieval(lease,desktopIdle,reranker,memoryIndex,embedding), chat=new CanonicalChat(store,lease,unitOfWork,budget,model,(id,q,snapshot)=>retrieval.search(id,q,12,snapshot),(id,key,input)=>domain.laborAction(id,key,input),(id,input)=>service(id,input),id=>worksiteWake(id),grounding,waitForWorksiteStep,resumeWorkAfterChat);
    let requestShutdown=()=>{};
    let companionManagement:ReturnType<typeof createCompanionManagement>;
    const loadCommitted=(id:string)=>store.loadCommittedEnvelope(id);
    const lifeApi=createLifeApi({authorize:()=>true,petId:()=>petId,getState:async(id,view)=>{
      const envelope=await loadCommitted(id);
      if(!envelope)throw Error('生命状态不存在');
      const state=store.projectReadState(envelope);
      if(view!=='archive')return state;
      const diaries=(envelope.legacy.diaries??{}) as Record<string,{deleted?:boolean;canonicalMemoryId?:string}>;
      const diaryDates=Object.fromEntries(Object.entries(diaries).filter(([,entry])=>entry&&!entry.deleted)
        .map(([day,entry])=>[entry.canonicalMemoryId||'legacy:diary:'+day,day]));
      return {...state,diaryDates};
    },getLifeSettings:id=>store.loadLifeSettings(id),shutdown:()=>requestShutdown(),openWorksite:id=>helper.requestWorksiteOpen(id),farm,attachments,finance:createFinanceManagement({loadEnvelope:loadCommitted},lease,domain),
      companion:{read:(id,signal)=>companionManagement.read(id,signal),write:(id,input,signal)=>companionManagement.write(id,input,signal)},
      model:{read:async()=>model!.getSettings(),write:async(id,input)=>{
        if(input.operation==='save'){const {operation,...settings}=input;return model!.saveSettings(settings);}
        if(input.operation==='test')return budget.runAs(id,'interactive',()=>model!.testConnection());
        if(input.operation==='balance')return budget.runAs(id,'interactive',async()=>{const release=await budget.reserve('balance','balance',lease.signal);try{return await model!.queryBalance();}finally{await release();}});
        if(input.operation==='models')return model!.discoverModels();
        throw Error('模型操作无效');
      }},
      manage:createLifeManagement(store,lease,unitOfWork,projectBody,id=>dispatcher.interrupt(id),blocked=>qq?.setGroupBlocked(blocked)),
      searchMemories:async(id,q)=>retrieval.search(id,q,12,await kernel.getState(id)),memoryGraph:async(id,q)=>({...memoryGraph(await kernel.getState(id),q),reranker:reranker.status(),embedding:embedding.status()}),links:{play:`/dsh-pet-7340/humanity?pet=${encodeURIComponent(petId)}`}});
    const chatApi=createChatHttp(chat,()=>true,()=>petId);
    const meteredBalance=()=>budget.runAs(petId,'interactive',async()=>{const release=await budget.reserve('balance','balance',lease.signal);try{return await model!.queryBalance();}finally{await release();}});
    const api=async(request:Request)=>{const url=new URL(request.url);if(url.pathname==='/dsh-pet-7340/attachment'){const raw=url.searchParams.get('id')||'',id=raw.startsWith('sha256:')?'image:'+raw.slice(7):raw;try{const image=await attachments.resolve({petId,id},request.signal);return new Response(image.data as BodyInit,{headers:{'content-type':image.mediaType,'cache-control':'no-store','x-content-type-options':'nosniff'}});}catch{return new Response('附件不存在',{status:404});}}return await chatApi(request) ?? await lifeApi(request);};
    const coordinator=new CognitiveResultCoordinator(store,unitOfWork,lease,projectBody,actions,dispatcher);
    const development=createDevelopment(store,lease,unitOfWork,budget,model);
    const responses=createLegacyResponses(store,lease,unitOfWork,budget,model,persona,grounding,rememberMeme);
    semanticResponse=async(id,requestId,detail)=>{const d=detail as any;const descriptions:Record<string,string>={'drag-start':'爸爸开始拖动我','drag-end':'爸爸松开了我','flight-start':'我开始飞行，尚不知道是否发生碰撞','flight-end':'飞行结束','prop-take':'爸爸拿起我的饭碗','prop-release':'爸爸放下我的饭碗','menu-anim':'爸爸选择了一个动画','go-home':'爸爸选择回家','open-chat':'爸爸打开聊天','open-care':'爸爸打开照料面板','open-todo':'爸爸打开待办','show-balance':'爸爸查看余额'};const description=descriptions[d?.action];if(!description)throw Error('互动类型无效');const event:any=await domain.record(id,requestId,'interaction',description,requestId,{},observerAuthority);if(!event?.id)throw Error('互动来源未保存');const text=await responses(id,'physical',AbortSignal.any([lease.signal,AbortSignal.timeout(30000)]),{eventId:`legacy:event:${encodeURIComponent(event.id)}`,description}).catch(()=> '【系统反馈】这次互动已记录，她暂时未能生成回应。请检查模型连接。');return {ok:true,reaction:{text}};};
    let waitCareResponse:((eventId:string)=>Promise<string|undefined>)|undefined;
    const adapter=createLegacyRequestAdapter({store,gate:lease,domain,humanity,service,development,responses,waitCareResponse:eventId=>waitCareResponse?.(eventId)??Promise.resolve(undefined),interrupt:id=>dispatcher.interrupt(id),tokenSnapshot:id=>tokens.snapshot(id),providers:{search:true,fetch:true,bili:true,image:true,model:true},view:id=>commandChannel.view(id),resolvePet:url=>{
      const selected=url.searchParams.get('pet')||petId;if(selected!==petId)throw Error('宠物不存在');return {petId,name:'大肥鱼'};}});
    companionManagement=createCompanionManagement(adapter,domain,id=>dispatcher.interrupt(id),loadCommitted);
    const cognitionSpeech={async *stream(options:any){const pool=await memeSource(petId,'whisper');yield* model!.llm.stream({...options,system:options.system+(pool.length?'\n若决定 self.express，可按当前语境自选一张表情，把名称放在 parameters.meme；可以不选，不用图推断实际行动完成。可用名称和画面描述：'+JSON.stringify(pool):'')});}};
    const cognition=new Cognition(createCognitiveModel(cognitionSpeech,()=>model!.agentDefaultModel.currentSelection()),budget,retrieval);
    let publishWhisper:((text:string,image?:string,surface?:string)=>void)|undefined;
    let resolveWhisperImage:((name:string,surface?:string)=>Promise<string>)|undefined;
    let validateWhisperSurface:((surface?:string)=>void)|undefined;
    let configuredPetIds:(()=>Set<string>)|undefined;
    const reactionBaseline=await store.loadEnvelope(petId);if(!reactionBaseline)throw Error('生命状态不可用');
    const todos=createCanonicalTodos(store,lease,unitOfWork),todoRoute=createTodoRoute(todos,petId);
    const deterministic=createDeterministicLife(humanity,store,service,lease,unitOfWork,actions,dispatcher,id=>budget.refresh(id),id=>tokens.held(id),state=>lease.detach(()=>worksiteReviews.waiting(state)));
    worksiteWake=id=>{void (async()=>{
      if(!await deterministic.runWorksite(id,lease.signal,true))await deterministic.run(id,lease.signal,{allowAutonomous:true});
    })().catch(()=>{});};
    const pickupRuns=new Set<string>();
    wakeTokenPickup=id=>{if(pickupRuns.has(id)||lease.signal.aborted)return;pickupRuns.add(id);
      void (async()=>{try{
        // The helper's release observation may arrive just after the token event.
        for(let retries=0;!lease.signal.aborted;){
          const complete=await deterministic.pickup(id,lease.signal);
          if(complete){retries=0;continue;}
          const state=await store.loadEnvelope(id),human=await humanity.get(id);
          if(!state || state.life.constraints.paused || human.sleeping || !(state.legacy as any).tokens?.coins?.some((c:any)=>c.status==='floor'&&c.surface==='desktop') || ++retries>10)break;
          await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);lease.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,500);lease.signal.addEventListener('abort',done,{once:true});if(lease.signal.aborted)done();});
        }
      }catch(error){console.error('[tokens] pickup:',error);}finally{pickupRuns.delete(id);}})();
    };
    const needs=createAutonomousNeeds(store,lease,unitOfWork,budget,model,text=>{if(!publishWhisper)throw Error('桌宠显示尚未就绪');publishWhisper(text);});
    wakeNeeds=id=>{void needs.run(id,lease.signal).catch(error=>console.error('[rice-cooker] 煮饭判断暂不可用',error));};
    scheduler=new LifeScheduler(kernel,cognition,{connectionString:connectionUri(dbConfig.connection),petId,intervalSeconds:60,cognitiveIntervalSeconds:300,idle:desktopIdle,signal:lease.signal,development,
      groupConversation:{run:async(id,signal)=>{await groupConversation?.run(id,signal);}},
      reminders:{run:(id,signal)=>todos.remind(id,signal,t=>{if(!publishWhisper)throw Error('桌宠显示尚未就绪');publishWhisper('提醒：'+t.text);})},
      whisper:{settings:()=>model!.getSettings(),run:async(id,signal)=>{if(!publishWhisper)throw Error('桌宠显示尚未就绪');const text=await responses(id,'whisper',signal,undefined,{autonomous:true});if(!signal.aborted)publishWhisper(text);}},
      wakeCoordinator:wakes,deterministic,resultCoordinator:coordinator,farm,cooker,needs,
      assertExclusive:async()=>lease.assertHeld()});
    app=await startStandalone({root,llm:model.llm,ai:{...model,queryBalance:meteredBalance,testConnection:(input:Record<string,unknown>)=>budget.runAs(petId,'interactive',()=>model!.testConnection(input))},agentDefaultModel:model.agentDefaultModel,helperChannel:helper,api,
      hostReady:(deps,helpers)=>{
        memeSource=async(id,mode)=>{const who=deps.requirePet(new URLSearchParams({pet:id}),()=>helpers.readAllConfig(deps.configPaths));return who.ok?readMemeChoices(who.conf,deps.memeDirsFor(who.entry),mode):[];};
        configuredPetIds=()=>{const cfg=helpers.readAllConfig(deps.configPaths),ids=new Set<string>([petId]);if(!cfg||typeof cfg!=='object'||!Object.keys(cfg).length)throw Error('宠物配置不可用');for(const conf of Object.values(cfg) as any[]){if(!Array.isArray(conf?.pets))throw Error('宠物配置结构无效');for(const pet of conf.pets){if(typeof pet?.id!=='string'||!pet.id)throw Error('宠物配置标识无效');ids.add(pet.id);}}return ids;};
        publishWhisper=(text:string,image?:string,surface?:string)=>{const cfg=helpers.readAllConfig(deps.configPaths);const voiceTo=cfg.main?.voiceEnabled===true&&(surface==='web'||surface==='desktop')?surface:undefined;deps.state.writePet(petId,'say',{text,companionWhisper:true,...((image??replyMemes.get(text))?{image:image??replyMemes.get(text)}:{}),...(voiceTo?{voiceTo}:{})});};
        const immediateFeedback=createImmediateFeedback(reactionBaseline,createFeedbackLeafPublisher(leaf=>deps.state.writePet(petId,'say',leaf)));
        observeCommits(immediateFeedback);
        const reactToInteraction=createInteractionReactions(reactionBaseline,(id,event,signal)=>responses(id,'interaction',signal,event),text=>deps.state.writePet(petId,'say',{...careReactionLeaf(text,helpers.readAllConfig(deps.configPaths).main?.voiceEnabled===true),...(replyMemes.has(text)?{image:replyMemes.get(text)}:{})}),lease.signal);
        observeCommits(reactToInteraction);
        const notifyCompletion=createLaborCompletionNotices(store,petId,(id,event,signal)=>responses(id,'completion',signal,event,{autonomous:true}),
          text=>deps.state.writePet(petId,'say',{...careReactionLeaf(text,helpers.readAllConfig(deps.configPaths).main?.voiceEnabled===true),...(replyMemes.has(text)?{image:replyMemes.get(text)}:{})}),lease.signal);
        observeCommits(notifyCompletion);notifyCompletion(reactionBaseline);
        const reactToCare=createCareReactions(reactionBaseline,(id,event,signal)=>responses(id,'care',AbortSignal.any([lease.signal,signal]),event),text=>deps.state.writePet(petId,'say',{...careReactionLeaf(text,helpers.readAllConfig(deps.configPaths).main?.voiceEnabled===true),...(replyMemes.has(text)?{image:replyMemes.get(text)}:{})}));
        waitCareResponse=eventId=>reactToCare.wait(eventId);
        observeCommits(reactToCare);
        const reactToWorksite=createWorksiteReactions(reactionBaseline,(id,event,signal)=>responses(id,'worksite',AbortSignal.any([lease.signal,signal]),event),async(id,event,text,fallback)=>{
          const published=await lease.run(id,async()=>{const current=await store.loadEnvelope(id);if(!current)return false;let valid=false;
            await unitOfWork.apply(id,current.version,draft=>{const transitions=draft.life.events.filter(e=>e.type==='interaction.worksite'&&['enter-forced','enter-voluntary','release','leave-voluntary','force-work','touch','drag'].includes((e.payload as any)?.action));
              const site=(draft.legacy as any).worksite;if(transitions.at(-1)?.eventId!==event.eventId||!site||(event.action==='release'?site.inside:!site.inside))return {};
              site.speech={eventId:event.eventId,action:event.action,text,at:Date.now()};valid=true;
              if(fallback){const at=new Date().toISOString();draft.life.events.push({eventId:'worksite-reply:'+event.eventId,petId:id,type:'interaction.feedback',source:'host',occurredAt:at,receivedAt:at,evidenceLevel:'observed',causationId:event.eventId,payload:{text,sourceIds:[event.eventId],fallback:true}});}return {};
            });return valid;});
          // These two manually requested reactions speak even if general chat voice is off.
          if(published&&!lease.signal.aborted)deps.state.writePet(id,'say',{...careReactionLeaf(text,false),...(replyMemes.has(text)?{image:replyMemes.get(text)}:{}),worksiteReaction:true});
        });
        observeCommits(reactToWorksite);
        validateWhisperSurface=(surface?:string)=>{const params=new URLSearchParams({pet:petId,...(surface?{surface}:{})});if(!deps.requirePet(params,()=>helpers.readAllConfig(deps.configPaths),{surface:true}).ok)throw Error('当前显示端不可用');};
        resolveWhisperImage=async(name:string,surface?:string)=>{const key=name.trim();if(!key||key.length>120||/[\/\\:\x00-\x1f]/.test(key)||key==='.'||key==='..')throw Error('表情名称无效');const params=new URLSearchParams({pet:petId,...(surface?{surface}:{})});const who=deps.requirePet(params,()=>helpers.readAllConfig(deps.configPaths),{surface:true});if(!who.ok)throw Error('当前显示端不可用');const memes=who.conf?.memes;if(!memes||!Object.hasOwn(memes,key)||typeof memes[key]!=='string'||!memes[key].trim())throw Error('表情不在当前素材池');for(const dir of deps.memeDirsFor(who.entry)){try{const base=await realpath(dir),file=await realpath(join(dir,key+'.png')),rel=relative(base,file);if(!rel||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))continue;const info=await stat(file);if(info.isFile())return key;}catch{}}throw Error('表情图片不可用');};
        const sync=(state:any)=>{if(state.petId!==petId)return;const sleeping=projectBody(state).body.sleeping;
          if(sleeping && !deps.sleep.sleeping(petId)) {
            const who=deps.requirePet(new URLSearchParams({pet:petId}),()=>helpers.readAllConfig(deps.configPaths));
            const names=who.ok?helpers.pickSleepNames(who.conf.animations):null;
            if(names)deps.sleep.enter(petId,names);
          } else if(!sleeping && deps.sleep.sleeping(petId))deps.sleep.wake(petId);
        };
        observeCommits(sync);
        const expressed=new Set<string>((reactionBaseline.life.events||[]).filter(e=>e.eventId.startsWith('self-expression:')).map(e=>e.eventId));
        dispatchObservers.add(draft=>{for(const e of draft.life.events){if(e.eventId.startsWith('self-expression:') && !expressed.has(e.eventId)){expressed.add(e.eventId);const text=(e.payload as any)?.text;if(typeof text==='string')publishWhisper?.(text,(e.payload as any)?.meme);}}});
        void store.loadEnvelope(petId).then(state=>{if(state)sync(state);}).catch(()=>{});
      },route:(original)=>async(url,method,body,signal)=>{
        const pathname=new URL(url,'http://127.0.0.1').pathname;
        const staticHumanity=method==='GET' && /\/humanity(?:\/(?:style\.css|panel\.js|companion\.js|[a-z-]+\.png))?$/.test(pathname);
        if(staticHumanity)return original(url,method,body,signal);
        if(pathname.includes('/humanity/'))return adapter(url,method,body,signal);
        if(/\/chat$/.test(pathname) && ['GET','POST','DELETE'].includes(method)) {try {
          const requested=new URL(url,'http://127.0.0.1').searchParams.get('pet');if(requested && requested!==petId)throw Error('宠物不存在');
          if(method==='DELETE'){const query=new URL(url,'http://127.0.0.1'),raw=query.searchParams.getAll('ts');if(raw.some(v=>!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v))))throw Error('删除时间无效');const selected=new Set(raw.map(Number));const removed=await lease.run(petId,async()=>{const current=await store.loadEnvelope(petId);if(!current)throw Error('状态不存在');let count=0;await unitOfWork.apply(petId,current.version,draft=>{const events=draft.life.events.filter(e=>['conversation.user','conversation.assistant'].includes(e.type)&&isOwnerPrivateConversation(e) && (!selected.size || selected.has(Date.parse(e.occurredAt))) && !Object.hasOwn(draft.life.invalidSources,e.eventId));for(const e of events){draft.life.invalidSources[e.eventId]='用户删除聊天';count++;if(e.type==='conversation.assistant'&&e.causationId){const user=draft.life.events.find(x=>x.eventId===e.causationId && x.type==='conversation.user' && isOwnerPrivateConversation(x));if(user && !Object.hasOwn(draft.life.invalidSources,user.eventId)){draft.life.invalidSources[user.eventId]='用户删除聊天';count++;}}}invalidateDependents(draft.life as unknown as LifeState);return {};});return count;});return {kind:'json',status:200,obj:{ok:true,removed},headers:{'cache-control':'no-store'}};}
          if(method==='GET'){const state=await store.loadEnvelope(petId);if(!state)throw Error('状态不存在');const messages=state.life.events.filter(e=>['conversation.user','conversation.assistant'].includes(e.type)&&isOwnerPrivateConversation(e)&&!Object.hasOwn(state.life.invalidSources,e.eventId)).slice(-40).map(e=>({role:e.type==='conversation.user'?'user':'assistant',content:String((e.payload as any)?.text||''),...((e.payload as any)?.meme?{meme:(e.payload as any).meme}:{}),ts:Date.parse(e.occurredAt)}));return {kind:'json',status:200,obj:{ok:true,messages,rounds:20},headers:{'cache-control':'no-store'}};}
          const input=JSON.parse(body||'{}');if(typeof input.text!=='string'||!input.text.trim()||input.text.length>2000)throw Error('消息无效');const requestId=typeof input.requestId==='string'?input.requestId:'legacy-chat:'+randomUUID();let refs:Awaited<ReturnType<typeof attachments.put>>[]=[];
          if(input.attachment){const a=input.attachment;if(typeof a.data!=='string'||a.data.length>900000||typeof a.mediaType!=='string')throw Error('图片无效');const bytes=Buffer.from(a.data,'base64');if(bytes.toString('base64')!==a.data)throw Error('图片无效');refs=[await attachments.put(petId,'chat-image:'+createHash('sha256').update(requestId).digest('hex'),{mediaType:a.mediaType,data:bytes})];}
          let meme:string|undefined;const text=await chat.turn({requestId,petId,channel:'desktop',actorId:'dad',text:input.text,attachments:refs,onMeme:value=>{meme=value;}},signal??lease.signal);return {kind:'json',status:200,obj:{ok:true,text,...(meme?{image:meme}:{})},headers:{'cache-control':'no-store'}};
        }catch{return {kind:'json',status:400,obj:{ok:false,message:'聊天未完成'},headers:{'cache-control':'no-store'}};}}

        if(/\/todos(?:\/[^/]+)?$/.test(pathname)){const result=await todoRoute(url,method,body);if(result)return result;}
        if(/\/chat\/memory$/.test(pathname) && ['GET','DELETE'].includes(method)){try{if(!configuredPetIds)throw Error('宠物配置尚未就绪');const known=configuredPetIds(),list=await pool.query('SELECT pet_id FROM silicon_genesis.life_state ORDER BY pet_id');const orphans=[] as Array<{entry:string;petId:string;messages:number;lastTs:number}>;let deletedPets=0,deletedMessages=0;for(const row of list.rows){const id=String(row.pet_id);if(known.has(id)||id===petId)continue;const inspect=async()=>{if(configuredPetIds!().has(id)||id===petId)return;const current=await store.loadEnvelope(id);if(!current)return;const messages=current.life.events.filter(e=>['conversation.user','conversation.assistant'].includes(e.type)&&['legacy','desktop'].includes(e.source)&&!Object.hasOwn(current.life.invalidSources,e.eventId));if(!messages.length)return;if(method==='GET'){orphans.push({entry:'canonical',petId:id,messages:messages.length,lastTs:messages.reduce((last,e)=>Math.max(last,Number.isFinite(Date.parse(e.occurredAt))?Date.parse(e.occurredAt):0),0)});return;}let count=0;await unitOfWork.apply(id,current.version,draft=>{if(configuredPetIds!().has(id)||id===petId)throw Error('宠物配置已变化');for(const event of draft.life.events)if(['conversation.user','conversation.assistant'].includes(event.type)&&['legacy','desktop'].includes(event.source)&&!Object.hasOwn(draft.life.invalidSources,event.eventId)){draft.life.invalidSources[event.eventId]='用户删除孤儿聊天';count++;}const projected={...draft.life,petId:id,version:draft.version,...projectBody(draft)} as LifeState;invalidateDependents(projected);draft.life.relationships=projected.relationships;return {};});if(count){deletedPets++;deletedMessages+=count;}};if(method==='DELETE')await lease.run(id,inspect);else await inspect();}return {kind:'json',status:200,obj:method==='GET'?{ok:true,orphans}:{ok:true,pets:deletedPets,messages:deletedMessages},headers:{'cache-control':'no-store'}};}catch(error){return {kind:'json',status:400,obj:{ok:false,message:error instanceof Error?error.message:'孤儿聊天处理失败'},headers:{'cache-control':'no-store'}};}}
        if(/\/quit$/.test(pathname) && ['GET','POST'].includes(method)){if(method==='POST')setImmediate(()=>requestShutdown());return {kind:'json',status:200,obj:method==='GET'?{canQuit:true}:{ok:true},headers:{'cache-control':'no-store'}};}
        if(method==='POST' && /\/(sleep|wake)$/.test(pathname)){try{const query=new URL(url,'http://127.0.0.1');if(query.searchParams.get('pet')&&query.searchParams.get('pet')!==petId)throw Error('宠物不存在');const before=await store.loadEnvelope(petId);if(!before)throw Error('身体状态不可用');const sleeping=projectBody(before).body.sleeping,want=pathname.endsWith('/sleep');if(sleeping===want)return {kind:'json',status:200,obj:{ok:true,sleeping,changed:false},headers:{'cache-control':'no-store'}};const result=await service(petId,{key:'manual-rest:'+randomUUID(),command:want?'/休息':'/醒来'});const after=await store.loadEnvelope(petId);if(!after)throw Error('身体状态不可用');const actual=projectBody(after).body.sleeping;return {kind:'json',status:result.ok?200:400,obj:{ok:result.ok,sleeping:actual,changed:actual!==sleeping,pending:result.status==='pending',message:result.message},headers:{'cache-control':'no-store'}};}catch(error){return {kind:'json',status:400,obj:{ok:false,message:error instanceof Error?error.message:'休息操作未完成'},headers:{'cache-control':'no-store'}};}}
        if(method==='POST' && /\/whisper$/.test(pathname)){try{const requestUrl=new URL(url,'http://127.0.0.1');if(requestUrl.searchParams.get('pet')&&requestUrl.searchParams.get('pet')!==petId)throw Error('宠物不存在');const surface=requestUrl.searchParams.get('surface')||undefined;if(surface&&!['web','desktop','both','any'].includes(surface))throw Error('显示端无效');const requested=requestUrl.searchParams.get('image');if(!publishWhisper||!resolveWhisperImage||!validateWhisperSurface)throw Error('桌宠显示尚未就绪');validateWhisperSurface(surface);let image=requested===null?undefined:await resolveWhisperImage(requested,surface);const text=await responses(petId,'whisper',signal??lease.signal,undefined,{image,surface});validateWhisperSurface(surface);image??=replyMemes.get(text);if(image)await resolveWhisperImage(image,surface);publishWhisper(text,image,surface);return {kind:'json',status:200,obj:{ok:true,text,...(image?{image}:{})},headers:{'cache-control':'no-store'}};}catch(error){return {kind:'json',status:400,obj:{ok:false,message:error instanceof Error?error.message:'碎碎念未完成'},headers:{'cache-control':'no-store'}};}}
        if(method==='POST' && /\/voice\/(speak|hear)$/.test(pathname))return budget.runAs(petId,'interactive',async()=>{const release=await budget.reserve('voice','voice',signal??lease.signal);try{return await original(url,method,body,signal);}finally{await release();}});
        if(method==='POST' && /\/balance$/.test(pathname)){const result=await meteredBalance();return {kind:'json',status:result.ok?200:503,obj:result,headers:{'cache-control':'no-store'}};}
        // Non-domain visual/config routes remain in the original helper host.
        if(isPresentationRoute(pathname,method) || method==='GET' && !/\/(?:chat|whisper)(?:\/|$)/.test(pathname) || method==='POST' && /\/pose\/report$/.test(pathname))return original(url,method,body,signal);
        return {kind:'json',status:503,obj:{ok:false,message:'该操作尚未接入'},headers:{'cache-control':'no-store'}};
      }});
    await scheduler.start();
    const targetHome=join(root,'data','dsh');
    let freshQQ=false;
    try {await stat(join(targetHome,'dsh-pet','qq-fresh-config.json'));freshQQ=true;} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(process.env.SILICON_DISABLE_QQ!=='1' && (freshQQ || await verifyQQCutoverProof(targetHome))) {
      const ingressAuthority={};
      const canonical=new CanonicalQQ(store,unitOfWork,lease,projectBody,ingressAuthority);
      const shared={canonical,ingressAuthority,signal:lease.signal,onTurn:chat.qqTurn.bind(chat),dispatch:(id:string)=>dispatcher.dispatch(id),diagnosticPath:join(targetHome,'dsh-pet','qq-fresh-status.json')};
      const takeover=freshQQ ? await prepareFreshQQ({...shared,home:targetHome,petId}) :
        await prepareQQTakeover({...shared,legacyHome:targetHome,stopHook:{stopAndVerify:async()=>await verifyOldQQAbsent(root)?'absent':'unknown'}});
      if(takeover.status==='ready') {
        qq=takeover.gateway;qq.setGroupBlocked(await canonical.groupBlocked(petId));executors.set('qq.send',takeover.executor);await qq.start();
        groupConversation=createGroupProactive({canonical,authority:ingressAuthority,dispatch:id=>dispatcher.dispatch(id),generate:(snapshot,signal)=>budget.runAs(petId,'autonomous',()=>generateGroupOpener(snapshot,model!.llm,model!.agentDefaultModel.currentSelection(),signal,persona),'QQ群主动表达')});
        await canonical.enableRelay(petId);
        let signature='',running=false,dirty=false,timer:ReturnType<typeof setTimeout>|undefined;
        const run=async()=>{timer=undefined;if(running){dirty=true;return;}running=true;
          try {await canonical.enableRelay(petId);do {dirty=false;while(!lease.signal.aborted){const id=await canonical.enqueueNextRelay(petId,ingressAuthority);if(!id)break;await dispatcher.dispatch(id);}}while(dirty&&!lease.signal.aborted);}
          catch(error){console.error('QQ 消息转发暂未完成：'+(error instanceof Error?error.message:'未知错误'));}
          finally {running=false;}};
        const wake=(state:any)=>{if(state.petId!==petId||lease.signal.aborted)return;const events=state.life.events,actions=state.life.actions;const next=events.length+':'+(events.at(-1)?.eventId||'')+':'+actions.length;
          if(next===signature)return;signature=next;if(running){dirty=true;return;}if(!timer)lease.detach(()=>{timer=setTimeout(()=>void run(),100);timer.unref();});};
        observeCommits(wake);
        lease.signal.addEventListener('abort',()=>{if(timer)clearTimeout(timer);},{once:true});
        const current=await store.loadEnvelope(petId);if(current)wake(current);
      }
    }
    let closing=false;
    const close=async()=>{if(closing)return;closing=true;worksiteWake=()=>{};qq?.stop();model?.dispose();bili?.close();tokens.close();commandChannel.cancelPet(petId);
      // Keep the writer lease alive until an interrupted helper receipt has
      // actually committed; otherwise a normal restart turns it into UNKNOWN.
      const schedulerResult=await Promise.allSettled([scheduler!.stop()]);
      const deadline=Date.now()+5000;
      while(!lease.signal.aborted&&Date.now()<deadline){
        const pending=await lease.query("SELECT 1 FROM silicon_genesis.outbox WHERE pet_id=$1 AND state='dispatched' LIMIT 1",[petId]).catch(()=>null);
        if(!pending||pending.rowCount===0)break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      commandChannel.close();
      const results=await Promise.allSettled([app!.close(),lease.close()]);
      if(results[1].status==='fulfilled')await pool.end();
      if([...schedulerResult,...results].some(result=>result.status==='rejected'))console.error('部分组件未能正常关闭，请检查本次运行状态。');};
    requestShutdown=()=>{void close();};
    app.setShutdown(()=>{void close();});
    process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
    console.log('生命空间已准备好。');
    console.log('生命空间链接（关闭网页后可用此链接重新打开）：'+app.lifeUrl);
    if(process.platform==='win32'&&process.env.SILICON_NO_OPEN_BROWSER!=='1') {
      const browser=spawn('rundll32.exe',['url.dll,FileProtocolHandler',app.lifeUrl],{windowsHide:true,stdio:'ignore'});
      browser.on('error',()=>console.error('无法打开生命空间，请从桌宠菜单重新打开。'));
      browser.unref();
    }
  } catch(error) {
    qq?.stop();await scheduler?.stop().catch(()=>{});model?.dispose();bili?.close();await app?.close().catch(()=>{});await stores?.lease.close().catch(()=>{});await pool.end();throw error;
  }
}

main().catch(error=>{console.error('启动失败：'+(error instanceof Error?error.message:'未知错误'));process.exitCode=1;});
