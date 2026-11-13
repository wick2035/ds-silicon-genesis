import {createCanonicalTodos,createTodoRoute} from './canonical-todos.js';
import {createLegacyResponses} from './legacy-responses.js';
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
import {createDomainExecutors} from './domain-executors.js';
import {CanonicalActionLifecycle} from './action-lifecycle.js';
import {ActionCoordinator} from './action-coordinator.js';
import {CognitiveResultCoordinator} from './cognitive-result.js';
import {DurableCognitiveBudget} from './cognitive-budget.js';
import {createModelFacade} from './model-facade.js';
import {createCognitiveModel} from './cognitive-model.js';
import {CanonicalMemoryRetrieval} from './memory-retrieval.js';
import {createPublicWeb,createBiliReader,createExplorationExecutor} from './network-services.js';
import {createLifeApi,createLifeManagement} from './life-api.js';
import {CanonicalChat,createChatHttp} from './chat-service.js';
import {startStandalone} from './standalone.js';
import {createLegacyServiceActions} from './legacy-service-actions.js';
import {createDeterministicLife} from './deterministic-life.js';
import {createHelperTokens} from './helper-tokens.js';
import {isPresentationRoute} from './visual-routes.js';
import {CanonicalQQ} from './qq-canonical.js';
import {prepareQQTakeover,verifyQQCutoverProof} from './qq-takeover.js';
import {verifyOldQQAbsent} from './qq-process-inventory.js';
import type {CanonicalQQGateway} from './qq-gateway.js';
import {createDevelopment} from './development.js';
import {createAttachmentStore} from './attachment-store.js';
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
  const persona=configuredPet?.whisperPrompt;
  if(typeof persona!=='string'||!persona.trim())throw Error('当前角色描述不可用');
  const modelConfig=await readJson(join(root,'data','model-config.json'));
  const pool=new Pool({...dbConfig.connection,application_name:'silicon-genesis'});
  let stores:Awaited<ReturnType<typeof openLifeStores>>|undefined,app:Awaited<ReturnType<typeof startStandalone>>|undefined,scheduler:LifeScheduler|undefined;
  let model:ReturnType<typeof createModelFacade>|undefined,bili:ReturnType<typeof createBiliReader>|undefined;
  let qq:CanonicalQQGateway|undefined;
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
        if(old && ['queued','running'].includes(old.status)){(legacy.world.commandHistory||=[]).push({...structuredClone(old),status:'interrupted',interruptedReason:'host-restarted'});legacy.world.commandHistory=legacy.world.commandHistory.slice(-50);old.status='interrupted';old.interruptedReason='host-restarted';}
        return {};
      });});
    const authority={},observerAuthority={},helperAuthority={};
    const humanity=new CanonicalHumanityAdapter(store,unitOfWork,lease,authority,observerAuthority);
    const domain=new LegacyDomain(store,unitOfWork,lease,observerAuthority);
    const tokens=createHelperTokens(store,domain,observerAuthority);
    const commandChannel=createDesktopCommandChannel(store,helperAuthority);
    let semanticResponse:((id:string,requestId:string,detail:unknown)=>Promise<unknown>)|undefined;
    const helper=createHelperChannel(humanity,commandChannel.bridge,[petId],observerAuthority,helperAuthority,commandChannel,
      (id,requestId,detail)=>domain.observeSpace(id,requestId,detail,observerAuthority),
      (id,requestId,detail)=>tokens.handle(id,requestId,detail),
      async(id,requestId,detail)=>{const d=detail as any;if(!d||typeof d.id!=='string'||typeof d.key!=='string'||![d.fromX,d.toX].every((n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1))throw Error('搬砖拖动观察无效');await domain.laborAction(id,requestId,{action:'disturb',id:d.id,key:d.key,surface:'desktop',fromX:d.fromX,toX:d.toX},observerAuthority);const state=await store.loadEnvelope(id);if(!state)throw Error('状态不可用');return projectLegacySnapshot(state).labor;},
      (id,requestId,detail)=>{if(!semanticResponse)throw Error('互动服务尚未就绪');return semanticResponse(id,requestId,detail);});
    bili=createBiliReader(root);
    const executors=new Map(createDomainExecutors(commandChannel.bridge));
    executors.set('learning.observe',createExplorationExecutor(createPublicWeb(),bili));
    const dispatcher=new OutboxDispatcher(lease,executors,lease,new CanonicalActionLifecycle(projectBody),new Map());
    await dispatcher.recoverInterrupted();
    const kernel=new LifeKernel(store,authority), budget=new DurableCognitiveBudget(store,unitOfWork,lease);
    const attachments=createAttachmentStore(store,lease,unitOfWork);
    model=createModelFacade(modelConfig,{leaseSignal:lease.signal,budget,resolveImage:attachments.resolve,persist:async value=>{const file=join(root,'data','model-config.json'),temporary=file+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600});await rename(temporary,file);}});
    executors.set('image.observe',createImageObserver(store,budget,model));
    const retrieval=new CanonicalMemoryRetrieval(lease), chat=new CanonicalChat(store,lease,unitOfWork,budget,model,(id,q)=>retrieval.search(id,q),(id,key,input)=>domain.laborAction(id,key,input),(id,input)=>service(id,input));
    let requestShutdown=()=>{};
    const lifeApi=createLifeApi({authorize:()=>true,petId:()=>petId,getState:id=>kernel.getState(id),shutdown:()=>requestShutdown(),attachments,
      manage:createLifeManagement(store,lease,unitOfWork,projectBody,id=>dispatcher.interrupt(id)),
      searchMemories:(id,q)=>retrieval.search(id,q),links:{play:`/dsh-pet-7340/humanity?pet=${encodeURIComponent(petId)}`}});
    const chatApi=createChatHttp(chat,()=>true,()=>petId);
    const meteredBalance=()=>budget.runAs(petId,'interactive',async()=>{const release=await budget.reserve('balance','balance',lease.signal);try{return await model!.queryBalance();}finally{await release();}});
    const api=async(request:Request)=>{const url=new URL(request.url);if(url.pathname==='/dsh-pet-7340/attachment'){const raw=url.searchParams.get('id')||'',id=raw.startsWith('sha256:')?'image:'+raw.slice(7):raw;try{const image=await attachments.resolve({petId,id},request.signal);return new Response(image.data as BodyInit,{headers:{'content-type':image.mediaType,'cache-control':'no-store','x-content-type-options':'nosniff'}});}catch{return new Response('附件不存在',{status:404});}}return await chatApi(request) ?? await lifeApi(request);};
    const actions=new ActionCoordinator(unitOfWork,projectBody), coordinator=new CognitiveResultCoordinator(store,unitOfWork,lease,projectBody,actions,dispatcher);
    const service=createLegacyServiceActions(store,lease,unitOfWork,actions,dispatcher);
    const development=createDevelopment(store,lease,unitOfWork,budget,model);
    const responses=createLegacyResponses(store,lease,unitOfWork,budget,model,persona);
    semanticResponse=async(id,requestId,detail)=>{const d=detail as any;const descriptions:Record<string,string>={'drag-start':'爸爸开始拖动我','drag-end':'爸爸松开了我','flight-start':'我开始飞行，尚不知道是否发生碰撞','flight-end':'飞行结束','prop-take':'爸爸拿起我的饭碗','prop-release':'爸爸放下我的饭碗','menu-anim':'爸爸选择了一个动画','go-home':'爸爸选择回家','open-chat':'爸爸打开聊天','open-care':'爸爸打开照料面板','open-todo':'爸爸打开待办','show-balance':'爸爸查看余额'};const description=descriptions[d?.action];if(!description)throw Error('互动类型无效');const event:any=await domain.record(id,requestId,'interaction',description,requestId,{},observerAuthority);if(!event?.id)throw Error('互动来源未保存');const text=await responses(id,'physical',lease.signal,{eventId:`legacy:event:${encodeURIComponent(event.id)}`,description});return {ok:true,reaction:{text}};};
    const adapter=createLegacyRequestAdapter({store,gate:lease,domain,humanity,service,development,responses,interrupt:id=>dispatcher.interrupt(id),tokenSnapshot:id=>tokens.snapshot(id),providers:{search:true,fetch:true,bili:true,image:true,model:true},view:id=>commandChannel.view(id),resolvePet:url=>{
      const selected=url.searchParams.get('pet')||petId;if(selected!==petId)throw Error('宠物不存在');return {petId,name:'大肥鱼'};}});
    const cognition=new Cognition(createCognitiveModel(model.llm,()=>model!.agentDefaultModel.currentSelection()),budget,retrieval);
    let publishWhisper:((text:string,image?:string,surface?:string)=>void)|undefined;
    let resolveWhisperImage:((name:string,surface?:string)=>Promise<string>)|undefined;
    let validateWhisperSurface:((surface?:string)=>void)|undefined;
    let configuredPetIds:(()=>Set<string>)|undefined;
    const todos=createCanonicalTodos(store,lease,unitOfWork),todoRoute=createTodoRoute(todos,petId);
    scheduler=new LifeScheduler(kernel,cognition,{connectionString:connectionUri(dbConfig.connection),petId,intervalSeconds:60,signal:lease.signal,development,
      reminders:{run:(id,signal)=>todos.remind(id,signal,t=>{if(!publishWhisper)throw Error('桌宠显示尚未就绪');publishWhisper('提醒：'+t.text);})},
      whisper:{settings:()=>model!.getSettings(),run:async(id,signal)=>{if(!publishWhisper)throw Error('桌宠显示尚未就绪');const text=await responses(id,'whisper',signal,undefined,{autonomous:true});if(!signal.aborted)publishWhisper(text);}},
      wakeCoordinator:wakes,deterministic:createDeterministicLife(humanity,store,service,lease,unitOfWork,actions,dispatcher,id=>budget.refresh(id)),resultCoordinator:coordinator,
      assertExclusive:async()=>lease.assertHeld()});
    app=await startStandalone({root,llm:model.llm,ai:{...model,queryBalance:meteredBalance,testConnection:(input:Record<string,unknown>)=>budget.runAs(petId,'interactive',()=>model!.testConnection(input))},agentDefaultModel:model.agentDefaultModel,helperChannel:helper,api,
      hostReady:(deps,helpers)=>{
        configuredPetIds=()=>{const cfg=helpers.readAllConfig(deps.configPaths),ids=new Set<string>([petId]);if(!cfg||typeof cfg!=='object'||!Object.keys(cfg).length)throw Error('宠物配置不可用');for(const conf of Object.values(cfg) as any[]){if(!Array.isArray(conf?.pets))throw Error('宠物配置结构无效');for(const pet of conf.pets){if(typeof pet?.id!=='string'||!pet.id)throw Error('宠物配置标识无效');ids.add(pet.id);}}return ids;};
        publishWhisper=(text:string,image?:string,surface?:string)=>{const cfg=helpers.readAllConfig(deps.configPaths);const voiceTo=cfg.main?.voiceEnabled===true&&(surface==='web'||surface==='desktop')?surface:undefined;deps.state.writePet(petId,'say',{text,companionWhisper:true,...(image?{image}:{}),...(voiceTo?{voiceTo}:{})});};
        validateWhisperSurface=(surface?:string)=>{const params=new URLSearchParams({pet:petId,...(surface?{surface}:{})});if(!deps.requirePet(params,()=>helpers.readAllConfig(deps.configPaths),{surface:true}).ok)throw Error('当前显示端不可用');};
        resolveWhisperImage=async(name:string,surface?:string)=>{const key=name.trim();if(!key||key.length>120||/[\/\\:\x00-\x1f]/.test(key)||key==='.'||key==='..')throw Error('表情名称无效');const params=new URLSearchParams({pet:petId,...(surface?{surface}:{})});const who=deps.requirePet(params,()=>helpers.readAllConfig(deps.configPaths),{surface:true});if(!who.ok)throw Error('当前显示端不可用');const memes=who.conf?.memes;if(!memes||!Object.hasOwn(memes,key)||typeof memes[key]!=='string'||!memes[key].trim())throw Error('表情不在当前素材池');for(const dir of deps.memeDirsFor(who.entry)){try{const base=await realpath(dir),file=await realpath(join(dir,key+'.png')),rel=relative(base,file);if(!rel||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))continue;const info=await stat(file);if(info.isFile())return key;}catch{}}throw Error('表情图片不可用');};
        const sync=(state:any)=>{if(state.petId!==petId)return;const sleeping=projectBody(state).body.sleeping;
          if(sleeping && !deps.sleep.sleeping(petId)) {
            const who=deps.requirePet(new URLSearchParams({pet:petId}),()=>helpers.readAllConfig(deps.configPaths));
            const names=who.ok?helpers.pickSleepNames(who.conf.animations):null;
            if(names)deps.sleep.enter(petId,names);
          } else if(!sleeping && deps.sleep.sleeping(petId))deps.sleep.wake(petId);
        };
        unitOfWork.onCommit(sync);dispatcher.onCommit(sync);
        void store.loadEnvelope(petId).then(state=>{if(state)sync(state);}).catch(()=>{});
      },route:(original)=>async(url,method,body,signal)=>{
        const pathname=new URL(url,'http://127.0.0.1').pathname;
        const staticHumanity=method==='GET' && /\/humanity(?:\/(?:style\.css|panel\.js|companion\.js|[a-z-]+\.png))?$/.test(pathname);
        if(staticHumanity)return original(url,method,body,signal);
        if(pathname.includes('/humanity/'))return adapter(url,method,body,signal);
        if(/\/chat$/.test(pathname) && ['GET','POST','DELETE'].includes(method)) {try {
          const requested=new URL(url,'http://127.0.0.1').searchParams.get('pet');if(requested && requested!==petId)throw Error('宠物不存在');
          if(method==='DELETE'){const query=new URL(url,'http://127.0.0.1'),raw=query.searchParams.getAll('ts');if(raw.some(v=>!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v))))throw Error('删除时间无效');const selected=new Set(raw.map(Number));const removed=await lease.run(petId,async()=>{const current=await store.loadEnvelope(petId);if(!current)throw Error('状态不存在');let count=0;await unitOfWork.apply(petId,current.version,draft=>{const events=draft.life.events.filter(e=>['conversation.user','conversation.assistant'].includes(e.type)&&['desktop','legacy'].includes(e.source) && (!selected.size || selected.has(Date.parse(e.occurredAt))) && !Object.hasOwn(draft.life.invalidSources,e.eventId));for(const e of events){draft.life.invalidSources[e.eventId]='用户删除聊天';count++;if(e.type==='conversation.assistant'&&e.causationId){const user=draft.life.events.find(x=>x.eventId===e.causationId && x.type==='conversation.user' && ['desktop','legacy'].includes(x.source));if(user && !Object.hasOwn(draft.life.invalidSources,user.eventId)){draft.life.invalidSources[user.eventId]='用户删除聊天';count++;}}}invalidateDependents(draft.life as unknown as LifeState);return {};});return count;});return {kind:'json',status:200,obj:{ok:true,removed},headers:{'cache-control':'no-store'}};}
          if(method==='GET'){const state=await store.loadEnvelope(petId);if(!state)throw Error('状态不存在');const messages=state.life.events.filter(e=>['conversation.user','conversation.assistant'].includes(e.type)&&['desktop','legacy'].includes(e.source)&&!Object.hasOwn(state.life.invalidSources,e.eventId)).slice(-40).map(e=>({role:e.type==='conversation.user'?'user':'assistant',content:String((e.payload as any)?.text||''),ts:Date.parse(e.occurredAt)}));return {kind:'json',status:200,obj:{ok:true,messages,rounds:20},headers:{'cache-control':'no-store'}};}
          const input=JSON.parse(body||'{}');if(typeof input.text!=='string'||!input.text.trim()||input.text.length>2000)throw Error('消息无效');const requestId=typeof input.requestId==='string'?input.requestId:'legacy-chat:'+randomUUID();let refs:Awaited<ReturnType<typeof attachments.put>>[]=[];
          if(input.attachment){const a=input.attachment;if(typeof a.data!=='string'||a.data.length>900000||typeof a.mediaType!=='string')throw Error('图片无效');const bytes=Buffer.from(a.data,'base64');if(bytes.toString('base64')!==a.data)throw Error('图片无效');refs=[await attachments.put(petId,'chat-image:'+createHash('sha256').update(requestId).digest('hex'),{mediaType:a.mediaType,data:bytes})];}
          const text=await chat.turn({requestId,petId,channel:'desktop',actorId:'dad',text:input.text,attachments:refs},signal??lease.signal);return {kind:'json',status:200,obj:{ok:true,text},headers:{'cache-control':'no-store'}};
        }catch{return {kind:'json',status:400,obj:{ok:false,message:'聊天未完成'},headers:{'cache-control':'no-store'}};}}

        if(/\/todos(?:\/[^/]+)?$/.test(pathname)){const result=await todoRoute(url,method,body);if(result)return result;}
        if(/\/chat\/memory$/.test(pathname) && ['GET','DELETE'].includes(method)){try{if(!configuredPetIds)throw Error('宠物配置尚未就绪');const known=configuredPetIds(),list=await pool.query('SELECT pet_id FROM silicon_genesis.life_state ORDER BY pet_id');const orphans=[] as Array<{entry:string;petId:string;messages:number;lastTs:number}>;let deletedPets=0,deletedMessages=0;for(const row of list.rows){const id=String(row.pet_id);if(known.has(id)||id===petId)continue;const inspect=async()=>{if(configuredPetIds!().has(id)||id===petId)return;const current=await store.loadEnvelope(id);if(!current)return;const messages=current.life.events.filter(e=>['conversation.user','conversation.assistant'].includes(e.type)&&['legacy','desktop'].includes(e.source)&&!Object.hasOwn(current.life.invalidSources,e.eventId));if(!messages.length)return;if(method==='GET'){orphans.push({entry:'canonical',petId:id,messages:messages.length,lastTs:messages.reduce((last,e)=>Math.max(last,Number.isFinite(Date.parse(e.occurredAt))?Date.parse(e.occurredAt):0),0)});return;}let count=0;await unitOfWork.apply(id,current.version,draft=>{if(configuredPetIds!().has(id)||id===petId)throw Error('宠物配置已变化');for(const event of draft.life.events)if(['conversation.user','conversation.assistant'].includes(event.type)&&['legacy','desktop'].includes(event.source)&&!Object.hasOwn(draft.life.invalidSources,event.eventId)){draft.life.invalidSources[event.eventId]='用户删除孤儿聊天';count++;}const projected={...draft.life,petId:id,version:draft.version,...projectBody(draft)} as LifeState;invalidateDependents(projected);draft.life.relationships=projected.relationships;return {};});if(count){deletedPets++;deletedMessages+=count;}};if(method==='DELETE')await lease.run(id,inspect);else await inspect();}return {kind:'json',status:200,obj:method==='GET'?{ok:true,orphans}:{ok:true,pets:deletedPets,messages:deletedMessages},headers:{'cache-control':'no-store'}};}catch(error){return {kind:'json',status:400,obj:{ok:false,message:error instanceof Error?error.message:'孤儿聊天处理失败'},headers:{'cache-control':'no-store'}};}}
        if(/\/quit$/.test(pathname) && ['GET','POST'].includes(method)){if(method==='POST')setImmediate(()=>requestShutdown());return {kind:'json',status:200,obj:method==='GET'?{canQuit:true}:{ok:true},headers:{'cache-control':'no-store'}};}
        if(method==='POST' && /\/(sleep|wake)$/.test(pathname)){try{const query=new URL(url,'http://127.0.0.1');if(query.searchParams.get('pet')&&query.searchParams.get('pet')!==petId)throw Error('宠物不存在');const before=await store.loadEnvelope(petId);if(!before)throw Error('身体状态不可用');const sleeping=projectBody(before).body.sleeping,want=pathname.endsWith('/sleep');if(sleeping===want)return {kind:'json',status:200,obj:{ok:true,sleeping,changed:false},headers:{'cache-control':'no-store'}};const result=await service(petId,{key:'manual-rest:'+randomUUID(),command:want?'/休息':'/醒来'});const after=await store.loadEnvelope(petId);if(!after)throw Error('身体状态不可用');const actual=projectBody(after).body.sleeping;return {kind:'json',status:result.ok?200:400,obj:{ok:result.ok,sleeping:actual,changed:actual!==sleeping,pending:result.status==='pending',message:result.message},headers:{'cache-control':'no-store'}};}catch(error){return {kind:'json',status:400,obj:{ok:false,message:error instanceof Error?error.message:'休息操作未完成'},headers:{'cache-control':'no-store'}};}}
        if(method==='POST' && /\/whisper$/.test(pathname)){try{const requestUrl=new URL(url,'http://127.0.0.1');if(requestUrl.searchParams.get('pet')&&requestUrl.searchParams.get('pet')!==petId)throw Error('宠物不存在');const surface=requestUrl.searchParams.get('surface')||undefined;if(surface&&!['web','desktop','both','any'].includes(surface))throw Error('显示端无效');const requested=requestUrl.searchParams.get('image');if(!publishWhisper||!resolveWhisperImage||!validateWhisperSurface)throw Error('桌宠显示尚未就绪');validateWhisperSurface(surface);const image=requested===null?undefined:await resolveWhisperImage(requested,surface);const text=await responses(petId,'whisper',signal??lease.signal,undefined,{image,surface});validateWhisperSurface(surface);if(image)await resolveWhisperImage(image,surface);publishWhisper(text,image,surface);return {kind:'json',status:200,obj:{ok:true,text,...(image?{image}:{})},headers:{'cache-control':'no-store'}};}catch(error){return {kind:'json',status:400,obj:{ok:false,message:error instanceof Error?error.message:'碎碎念未完成'},headers:{'cache-control':'no-store'}};}}
        if(method==='POST' && /\/voice\/(speak|hear)$/.test(pathname))return budget.runAs(petId,'interactive',async()=>{const release=await budget.reserve('voice','voice',signal??lease.signal);try{return await original(url,method,body,signal);}finally{await release();}});
        if(method==='POST' && /\/balance$/.test(pathname)){const result=await meteredBalance();return {kind:'json',status:result.ok?200:503,obj:result,headers:{'cache-control':'no-store'}};}
        // Non-domain visual/config routes remain in the original helper host.
        if(isPresentationRoute(pathname,method) || method==='GET' && !/\/(?:chat|whisper)(?:\/|$)/.test(pathname) || method==='POST' && /\/pose\/report$/.test(pathname))return original(url,method,body,signal);
        return {kind:'json',status:503,obj:{ok:false,message:'该操作尚未接入'},headers:{'cache-control':'no-store'}};
      }});
    await scheduler.start();
    const targetHome=join(root,'data','dsh');
    if(await verifyQQCutoverProof(targetHome)) {
      const ingressAuthority={};
      const canonical=new CanonicalQQ(store,unitOfWork,lease,projectBody,ingressAuthority);
      const takeover=await prepareQQTakeover({legacyHome:targetHome,canonical,ingressAuthority,signal:lease.signal,
        stopHook:{stopAndVerify:async()=>await verifyOldQQAbsent(root)?'absent':'unknown'},onTurn:chat.qqTurn.bind(chat),dispatch:id=>dispatcher.dispatch(id)});
      if(takeover.status==='ready') {qq=takeover.gateway;executors.set('qq.send',takeover.executor);await qq.start();}
    }
    let closing=false;
    const close=async()=>{if(closing)return;closing=true;qq?.stop();model?.dispose();bili?.close();tokens.close();commandChannel.cancelPet(petId);commandChannel.close();
      const results=await Promise.allSettled([scheduler!.stop(),app!.close(),lease.close()]);
      if(results[2].status==='fulfilled')await pool.end();
      if(results.some(result=>result.status==='rejected'))console.error('部分组件未能正常关闭，请检查本次运行状态。');};
    requestShutdown=()=>{void close();};
    app.setShutdown(()=>{void close();});
    process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
    console.log('生命空间已准备好。');
    if(process.platform==='win32') {
      const browser=spawn('rundll32.exe',['url.dll,FileProtocolHandler',app.lifeUrl],{windowsHide:true,stdio:'ignore'});
      browser.on('error',()=>console.error('无法打开生命空间，请从桌宠菜单重新打开。'));
      browser.unref();
    }
  } catch(error) {
    qq?.stop();await scheduler?.stop().catch(()=>{});model?.dispose();bili?.close();await app?.close().catch(()=>{});await stores?.lease.close().catch(()=>{});await pool.end();throw error;
  }
}

main().catch(error=>{console.error('启动失败：'+(error instanceof Error?error.message:'未知错误'));process.exitCode=1;});
