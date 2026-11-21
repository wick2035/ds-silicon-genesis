import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {CanonicalEnvelope,Queryable} from '../storage/postgres.js';
import type {PetGate,UnitOfWork} from '../storage/uow.js';
import {createMealManagement} from './meal-recovery.js';

/** Private, explicitly authorized one-shot tasks; never ship a user's IDs in code. */
export async function prepareStartupRepairs(root:string,petId:string,store:{loadEnvelope(id:string):Promise<CanonicalEnvelope|null>},gate:PetGate,uow:UnitOfWork,db:Queryable,reconcile:(id:string)=>Promise<boolean>) {
  const file=join(root,'data/authorized-repairs.json');
  let plan:any;
  try{plan=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {finishDiaries:async(_task:unknown)=>{}};throw error;}
  if(plan.version!==1||plan.petId!==petId||!Array.isArray(plan.tasks))throw Error('授权修复任务无效');
  const save=async()=>{await writeFile(file+'.tmp',JSON.stringify(plan,null,2),{mode:0o600});await rename(file+'.tmp',file);};
  // An interrupted model call is not repeated on the next restart.
  for(const task of plan.tasks)if(task.status==='running'){
    task.status=task.kind==='discard-meal'?'pending':'failed';
    if(task.status==='failed')task.error='上次修复中断，请在界面核对结果后手动重试';
  }
  const pending=plan.tasks.filter((task:any)=>task.status==='pending');
  if(pending.length&&!plan.backup)await gate.run(petId,async()=>{
    const state=await store.loadEnvelope(petId);if(!state)throw Error('生命存档不存在');
    const outbox=await db.query('SELECT * FROM silicon_genesis.outbox WHERE pet_id=$1',[petId]);
    await mkdir(join(root,'data/backups'),{recursive:true});
    const backup=join(root,'data/backups',`meal-diary-before-${Date.now()}.json`);
    await writeFile(backup,JSON.stringify({format:'authorized-repair-backup-v1',state,outbox:outbox.rows}),{flag:'wx',mode:0o600});
    plan.backup=backup;await save();
  });
  const resolve=createMealManagement(store,gate,uow,reconcile);
  for(const task of pending.filter((task:any)=>task.kind==='discard-meal')){
    try{
      task.status='running';await save();
      await resolve(petId,{action:'discard',actionId:task.actionId,itemId:task.itemId,requestId:task.requestId});
      task.status='completed';task.finishedAt=new Date().toISOString();
    }catch(error){task.status='failed';task.error=error instanceof Error?error.message:'旧碗结清失败';}
    await save();
  }
  await save();
  return {async finishDiaries(generate:(date:string)=>Promise<boolean>){
    for(const task of pending.filter((task:any)=>task.kind==='diary')){
      try{
        task.status='running';await save();
        const state=await store.loadEnvelope(petId);
        if(!(state?.legacy as any)?.diaries?.[task.date]&&!await generate(task.date))throw Error('没有可整理的经历或日记已删除，请在界面核对');
        const after=await store.loadEnvelope(petId);
        if(!(after?.legacy as any)?.diaries?.[task.date])throw Error('日记未保存');
        task.status='completed';task.finishedAt=new Date().toISOString();
      }catch(error){task.status='failed';task.error=error instanceof Error?error.message:'日记补写失败';}
      await save();
    }
  }};
}
