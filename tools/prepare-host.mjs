#!/usr/bin/env node
// Derive an importable copy of the installed standalone bundle without running
// its CLI. Refuse an unknown bundle rather than silently executing its main().
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'vendor','dsh-pet','lib');
const input=await fs.readFile(path.join(dir,'standalone.js'),'utf8');
const marker='main().then((code) => {';
const start=input.lastIndexOf(marker);
const end=input.lastIndexOf('\n//#endregion');
if (start<0 || end<start || input.indexOf(marker)!==start || !input.slice(start,end).includes('process.exit(1);'))
  throw Error('无法安全抽离独立宿主：入口格式已改变');
const exported=`export { apply, createStandaloneContext, listenStandaloneServer, createRequestSecurity,
  createStandaloneAi, createStandaloneLogger, setDefaultLogger, readAllConfig, flattenPetList, pickSleepNames,
  dshHomeDir, packageRoot, configPathsFor, writeStandaloneRuntime };\n`;
let output=input.slice(0,start)+exported+input.slice(end);
const broken='function createToolResultMessage(input) { return createMessage({role:"tool",source:{kind:"tool",callId:input.callId},toolCallId:input.callId,content:input.content,isError:input.isError}); }';
if(!output.includes(broken)) throw Error('工具结果 shim 格式已改变');
output=output.replace(broken,'function createToolResultMessage(input) { return {role:"tool",source:{kind:"tool",callId:input.callId},toolCallId:input.callId,content:input.content,isError:input.isError}; }');
function replaceOnce(needle,replacement) {
  if(output.split(needle).length!==2) throw Error('独立宿主的桥接点格式已改变');
  output=output.replace(needle,replacement);
}
replaceOnce("    const wallet = globalThis[Symbol.for('dsh.pet.companion.v1')]?.store?.read(id)?.wallet;\n    const walletPainChanged = wallet?.balance === 0 && next.stats.pain !== 100;\n    if (wallet?.balance === 0) next.stats.pain = 100;",'    const walletPainChanged = false;');
replaceOnce('function getHumanityStore() {\n  if (!humanStore)', 'function getHumanityStore() {\n  if (globalThis[Symbol.for("silicon.genesis.enabled")]) throw new Error("旧身心存储已禁用");\n  if (!humanStore)');
replaceOnce('function observeHumanity(id, leaf, data) {\n  const allow', 'function observeHumanity(id, leaf, data) {\n  if (globalThis[Symbol.for("silicon.genesis.enabled")]) return true;\n  const allow');
replaceOnce('"/standalone-ai/icon.png"\n\t].includes(path)', '"/standalone-ai/icon.png",\n        "/life/", "/life/style.css", "/life/bridge.js", "/life/app.js", "/assets/main-character.png"\n\t].includes(path)');
replaceOnce('const siteUrl = ctx.connection.authenticatedUrl(origin);',`let siliconEpoch = "";
    const siteUrl = ctx.connection.authenticatedUrl(origin);`);
replaceOnce('env: helperSpawnEnv(process.pid, this.options.env),','env: helperSpawnEnv(process.pid, {...this.options.env,...this.options.onStart?.()}),');
replaceOnce('DSH_PET_CONFIG_URL: configUrl,','DSH_PET_CONFIG_URL: configUrl,');
replaceOnce('bridgeHandler: async (req) => {\n\t\t\t\tconst result', 'onExit: () => ctx.siliconHelper?.closed?.(siliconEpoch),\n\t\t\tbridgeHandler: async (req) => {\n\t\t\t\tconst result');
replaceOnce('onExit: () => ctx.siliconHelper?.closed?.(siliconEpoch),','onStart: () => { siliconEpoch = randomBytes(16).toString("hex"); ctx.siliconHelper?.opened?.(siliconEpoch); return {SILICON_HELPER_EPOCH:siliconEpoch}; },\n\t\t\tonExit: () => ctx.siliconHelper?.closed?.(siliconEpoch),');
replaceOnce('if (this.child !== child) return;\n\t\t\tthis.child = void 0;', 'if (this.child !== child) return;\n\t\t\tthis.options.onExit?.();\n\t\t\tthis.child = void 0;');
replaceOnce('const httpRoute = createHttpRoute(deps);\n\tregisterHttpRoute(ctx, httpRoute.handlePetRoute);', `const httpRoute = createHttpRoute(deps);
    ctx.siliconHostReady?.(deps);
    if (ctx.siliconRoute) httpRoute.handlePetRoute = ctx.siliconRoute(httpRoute.handlePetRoute, deps);
    registerHttpRoute(ctx, httpRoute.handlePetRoute);`);
replaceOnce('\tregisterLoops({\n\t\tctx,','\tif (!ctx.siliconRoute) registerLoops({\n\t\tctx,');
replaceOnce('\tregisterTodoReminders({\n\t\tctx,','\tif (!ctx.siliconRoute) registerTodoReminders({\n\t\tctx,');
replaceOnce('bridgeHandler: async (req) => {\n\t\t\t\tconst result = await getHandlePetRoute()',`bridgeHandler: async (req) => {
        if(req.url === "/__silicon/worksite" && req.method === "POST") {
          try { const result=await ctx.siliconHelper.worksite(siliconEpoch,JSON.parse(req.body||"null"));
            return {id:req.id,status:200,contentType:"application/json",body:JSON.stringify(result)};
          } catch(e) {return {id:req.id,status:409,contentType:"application/json",body:JSON.stringify({ok:false,message:String(e?.message||e)})};}
        }
        if(req.url === "/__silicon/interaction" && req.method === "POST") {
          try {
            if(!ctx.siliconHelper?.interaction) throw Error("未接入互动通道");
            const result=await ctx.siliconHelper.interaction(siliconEpoch, JSON.parse(req.body || "null"));
            return {id:req.id,status:200,contentType:"application/json",body:JSON.stringify(result)};
          } catch { return {id:req.id,status:409,contentType:"application/json",body:'{"ok":false}'}; }
        }
        if(req.url === "/__silicon/action-receipt" && req.method === "POST") {
          try {
            if(!ctx.siliconHelper?.receipt) throw Error("未接入可信回执通道");
            const result=await ctx.siliconHelper.receipt(siliconEpoch, JSON.parse(req.body || "null"));
            return {id:req.id,status:200,contentType:"application/json",body:JSON.stringify(result)};
          } catch { return {id:req.id,status:409,contentType:"application/json",body:'{"ok":false}'}; }
        }
        if(req.url === "/__silicon/helper-observation" && req.method === "POST") {
          try {
            if(!ctx.siliconHelper?.observe) throw Error("未接入生命观察通道");
            await ctx.siliconHelper.observe(siliconEpoch, JSON.parse(req.body || "null"));
            return {id:req.id,status:200,contentType:"application/json",body:'{"ok":true}'};
          } catch { return {id:req.id,status:409,contentType:"application/json",body:'{"ok":false}'}; }
        }
        const result = await getHandlePetRoute()`);
await fs.writeFile(path.join(dir,'silicon-host.js'),output,'utf8');
