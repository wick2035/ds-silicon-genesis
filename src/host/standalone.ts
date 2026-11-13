import {mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLifeRoutes} from './life-routes.js';

type RouteHandler=(url:string,method:string,body?:string,signal?:AbortSignal)=>Promise<unknown>;
export interface StandaloneOptions {
  root:string;
  llm:unknown;
  ai?:unknown;
  agentDefaultModel:unknown;
  helperChannel:unknown;
  api:(request:Request)=>Promise<Response|undefined>;
  route:(original:RouteHandler,deps:unknown)=>RouteHandler;
  hostReady:(deps:any, helpers:{readAllConfig:(paths:unknown)=>any;pickSleepNames:(animations:unknown)=>any})=>void;
  port?:number;
  onShutdown?:()=>void;
}

/** Starts only the independent host. Every old request enters the supplied
 * canonical route adapter, including requests from the helper process. */
export async function startStandalone(options:StandaloneOptions) {
  const root=resolve(options.root), data=join(root,'data'), home=join(data,'dsh'), runtime=join(data,'runtime');
  if(typeof options.route!=='function'||typeof options.hostReady!=='function'||!options.helperChannel||!options.llm)throw new Error('独立宿主缺少领域装配');
  await Promise.all([home,runtime,join(runtime,'tmp'),join(data,'bili')].map(dir=>mkdir(dir,{recursive:true})));
  Object.assign(process.env,{DSH_HOME:home,SILICON_GENESIS_DATA:runtime,BILI_DUTY_HOME:join(data,'bili'),
    DSH_PET_ELECTRON_PATH:join(root,'runtime','electron','electron.exe'),TEMP:join(runtime,'tmp'),TMP:join(runtime,'tmp'),
    PYTHONHOME:join(root,'runtime','python311'),PYTHONPATH:join(root,'runtime','python311','Lib','site-packages'),PYTHONNOUSERSITE:'1'});
  const host=await import(pathToFileURL(join(root,'vendor','dsh-pet','lib','silicon-host.js')).href);
  const logger=host.createStandaloneLogger();host.setDefaultLogger(logger);
  const security=host.createRequestSecurity(),routes=createLifeRoutes(root,options.api);
  let port=options.port??3080,shutdown=()=>options.onShutdown?.();
  const context=host.createStandaloneContext({port:()=>port,logger,routes,authenticatedUrl:security.authenticatedUrl,shutdown:()=>shutdown()});
  context.ctx.llm=options.llm;context.ctx.agentDefaultModel=options.agentDefaultModel;
  context.ctx.siliconHelper=options.helperChannel;context.ctx.siliconRoute=options.route;
  context.ctx.siliconHostReady=(deps:unknown)=>options.hostReady(deps,{readAllConfig:host.readAllConfig,pickSleepNames:host.pickSleepNames});
  let server:any,releaseRuntime:(()=>void)|undefined,closed=false;
  try {
    server=await host.listenStandaloneServer({routes,logger,port,security,ai:options.ai,
      status:()=>({name:'silicon-genesis',pid:process.pid,port,uptimeSec:Math.round(process.uptime())}),onShutdown:()=>shutdown()});
    port=server.port;
    releaseRuntime=host.writeStandaloneRuntime(home,{port,token:security.token,
      settingsUrl:security.authenticatedUrl(`http://127.0.0.1:${port}`),pluginRoot:host.packageRoot});
    (globalThis as Record<symbol,unknown>)[Symbol.for('silicon.genesis.enabled')]=true;
    host.apply(context.ctx);
    if(context.failures.length)throw new Error('独立宿主初始化未完成');
  }catch(error){await context.dispose();if(server)await server.close();releaseRuntime?.();throw error;}
  return {port,lifeUrl:`http://127.0.0.1:${port}/life/#token=${encodeURIComponent(security.token)}`,
    async close(){if(closed)return;closed=true;try{await context.dispose();}finally{await server.close();releaseRuntime?.();}},
    setShutdown(fn:()=>void){shutdown=fn;}};
}
