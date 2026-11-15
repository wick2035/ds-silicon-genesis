import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createDesktopCommandChannel} from '../dist/host/desktop-command-channel.js';
import {budgetView} from '../dist/host/budget-view.js';

test('80 daily calls preserves usage and reserves two calls for records',()=>{
 const pet={config:{learning:{dailyModelCalls:80}},usage:{'2026-11-15':{totalCalls:18,interactiveCalls:236}}};
 assert.equal(budgetView(pet,new Date('2026-11-15T12:00:00Z')).remainingBudget,60);
 assert.equal(budgetView(pet,new Date('2026-11-15T16:00:00Z')).remainingBudget,78);
});

for(const kind of ['body.sleep','body.wake','care.feed','care.water'])test(`trusted interruption settles ${kind} without an unknown result`,async()=>{
 const channel=createDesktopCommandChannel({loadEnvelope:async()=>({legacy:{}})},{});
 try{
  const result=channel.bridge.execute('main',{id:'action',type:kind,payload:{petId:'main',actionId:'action',parameters:{}}},new AbortController().signal);
  await new Promise(setImmediate);
  assert.ok(channel.view('main'));
  channel.cancelPet('main','爸爸按住了身体');
  assert.equal((await result).status,'cancelled');
  assert.equal(channel.view('main'),undefined);
 }finally{channel.close();}
});

test('rest commands report an interruption when busy or unavailable instead of silently disappearing',async()=>{
 const source=await fs.readFile(new URL('../vendor/dsh-pet/runtime/electron-helper/sprite/desktop-body.js',import.meta.url),'utf8');
 for(const scenario of ['busy','dragging','frozen','missing-assets','already-asleep','ready']){
  const receipts=[],calls=[];
  class Sprite{}
  const command={id:'sleep-action',source:'silicon-rest',restKind:'sleep'};
  const context={PetSprite:Sprite,window:{petBridge:{reportActionReceipt:async r=>receipts.push(r)}},
   fetch:async()=>({ok:true,json:async()=>({ok:true,world:{command,body:{phase:'well'}}})}),
   BASE:"http://localhost",AbortSignal,Date,console,setTimeout,clearTimeout,setInterval,clearInterval};
  vm.runInNewContext(source,context);
  const sprite=new Sprite();
  Object.assign(sprite,{ac:new AbortController(),pet:{id:'main'},syncPhoneBody(){},syncAffectBody(){},postSleepAction:kind=>calls.push(kind),
   animations:{sleep:scenario==='missing-assets'?[]:[{start:['start'],loop:['loop'],end:['end']}]},
   dragState:{active:scenario==='dragging'},bodyExecuting:scenario==='busy',frozen:scenario==='frozen',sleeping:scenario==='already-asleep'});
  await sprite.pollBody();await sprite.pollBody();
  if(scenario==='ready'){assert.deepEqual(calls,['sleep']);assert.equal(receipts.length,0);}
  else{assert.equal(receipts.length,1,scenario);assert.equal(receipts[0].status,'interrupted');assert.equal(receipts[0].played,false);assert.equal(calls.length,0);}
 }
});
