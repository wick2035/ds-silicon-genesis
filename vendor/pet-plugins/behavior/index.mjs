import { startQQBridge } from './qq-bridge.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { CompanionStore, SLOT } from './core.mjs';
import { CompanionRuntime } from './runtime.mjs';
import { openCompanionStore } from './postgres-store.mjs';
import { consolidateGroupHistory, importGroupArchive } from './group-history.mjs';
export const name='pet-local-behavior';
export const inject=['petApi7340','llm','agentDefaultModel'];
export async function apply(ctx){
  const home=process.env.DSH_HOME || path.join(os.homedir(),'.dsh');
  const store=await openCompanionStore(path.join(home,'dsh-pet','companion'),{onError:e=>ctx.logger?.warn?.(e.message)});
  store.load();for(const id of Object.keys(store.data.pets))store.update(id,p=>consolidateGroupHistory(p,store.clock()));
  const archive=path.join(home,'dsh-pet','memory.json');
  if(fs.existsSync(archive)){const data=JSON.parse(fs.readFileSync(archive,'utf8'));for(const id of Object.keys(store.data.pets))importGroupArchive(store,id,data);}
  const runtime=new CompanionRuntime(store,{ctx,seedKnowledge:true});
  ctx.provide('petCompanion',runtime);globalThis[SLOT]=runtime;
  runtime.timer=setInterval(()=>void runtime.tick().catch(e=>ctx.logger?.warn?.('[大肥鱼养成] '+e.message)),60000);runtime.timer.unref?.();
  const qqBridge = startQQBridge(ctx, home);
  ctx.effect(()=>async()=>{qqBridge?.stop();await runtime.dispose();await store.close?.();},'pet-companion lifecycle');
}
