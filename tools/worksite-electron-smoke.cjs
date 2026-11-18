'use strict';
// Run with runtime/electron/electron.exe. Real preload, renderer, IPC and HTTP;
// only the persistence envelope is isolated from the user's running companion.
const {app,BrowserWindow,ipcMain,screen}=require('electron');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'worksite-ipc-smoke-')));
class HiddenWindow extends BrowserWindow {
  constructor(options){
    super({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});
    this.show=()=>{};this.showInactive=()=>{};this.focus=()=>{};
  }
}
let server;
const deadline=setTimeout(()=>{console.error('worksite Electron smoke timed out');app.exit(1);},25000);
app.whenReady().then(async()=>{
  const load=rel=>import(pathToFileURL(path.join(root,rel)).href);
  const {createWorksite}=await load('dist/host/worksite.js');
  const {createHelperChannel}=await load('dist/host/helper-channel.js');
  const {createDesktopCommandChannel}=await load('dist/host/desktop-command-channel.js');
  const {projectOutcome}=await load('dist/host/outcome-projector.js');
  const {createDeterministicLife}=await load('dist/host/deterministic-life.js');
  const {ActionCoordinator}=await load('dist/host/action-coordinator.js');
  const {CanonicalActionLifecycle}=await load('dist/host/action-lifecycle.js');
  const {projectBody}=await load('dist/host/body-projection.js');
  const {createHumanity}=await load('vendor/dsh-pet/src/host/humanity.mjs');
  let state={petId:'main',version:0,legacy:{events:[],labor:{contracts:[]},world:{},wallet:{balance:100},config:{costs:{}}},humanity:createHumanity(),life:{actions:[],events:[],memories:[],invalidSources:{},constraints:{paused:false}}};
  const store={loadEnvelope:async()=>structuredClone(state)},gate={run:async(_id,fn)=>fn()};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const d=structuredClone(state);fn(d);d.version++;state=d;}};
  const capability={},commands=createDesktopCommandChannel(store,capability),receipts=[];
  const site=createWorksite(store,gate,uow,id=>commands.view(id),id=>commands.cancelPet(id));
  const channel=createHelperChannel({observeRestraint:async()=>{}},commands.bridge,['main'],{},capability,commands,undefined,undefined,undefined,undefined,(id,action)=>action==='snapshot'?site.snapshot(id):site.act(id,action));
  const epoch='b'.repeat(32);process.env.SILICON_HELPER_EPOCH=epoch;channel.opened(epoch);
  const requests=[];
  server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    try{
      assert.equal(req.method,'POST');const input=JSON.parse(raw);
      let result;
      if(req.url==='/__silicon/action-receipt'){receipts.push(input);result=await channel.receipt(epoch,input);}
      else{assert.equal(req.url,'/__silicon/worksite');requests.push(input.action);result=await channel.worksite(epoch,input);}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    }
    catch(error){res.writeHead(409);res.end(JSON.stringify({message:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const hostRequest=async(method,url,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,body});return {status:r.status,body:await r.text()};};
  const desktop=new HiddenWindow({show:false}),windows=new Map([['main',desktop]]);
  let siteWindow;const TrackingWindow=class extends HiddenWindow {constructor(options){super(options);siteWindow=this;}};
  require('../vendor/dsh-pet/runtime/electron-helper/main/worksite.js').register({ipcMain,petWindows:{state:{windows}},hostRequest,BrowserWindow:TrackingWindow,screen,app});
  ipcMain.emit('pet:open-worksite',{sender:desktop.webContents});
  // Remove the desktop from the periodic sync so every step has to arrive via dispatch notification.
  windows.delete('main');
  await new Promise((resolve,reject)=>{siteWindow.webContents.once('did-finish-load',resolve);siteWindow.webContents.once('did-fail-load',(_e,code,description)=>reject(Error(code+': '+description)));});
  await siteWindow.webContents.executeJavaScript('document.getElementById("force-work").click()');
  for(let i=0;i<500&&!state.legacy.labor.contracts.length;i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(requests.includes('force-work'),'button must reach the host over the actual IPC/HTTP chain');
  assert.equal(state.legacy.worksite.inside,true);assert.equal(state.legacy.labor.contracts[0].status,'working');
  assert.ok(state.humanity.emotions.fear>6);assert.ok(state.life.memories.some(m=>m.content.includes('强制')));
  // Exercise the real renderer's animation and native receipt path as well.
  // Keep this isolated test window hidden; production uses its visible window.
  await siteWindow.webContents.executeJavaScript('Object.defineProperty(document,"hidden",{get:()=>false,configurable:true});true');
  const started=performance.now(),contract=state.legacy.labor.contracts[0],actualSeconds=[];
  for(const [leg,x] of [['load',.22],['deliver',.78]]){
    const id=`forced-${leg}`;
    state.legacy.world.command={id,source:'labor',forcedLabor:true,surface:'web',status:'queued',index:0,labor:{id:contract.id,trip:0,leg,x}};
    for(const index of [0,1]){
      const actionId=`${id}:${index}`;
      const intent={id:actionId,type:'labor.step',payload:{petId:'main',actionId,parameters:{commandId:id,contractId:contract.id}}};
      const result=await commands.bridge.execute('main',intent,AbortSignal.timeout(5000));
      assert.equal(result.status,'completed');
      actualSeconds.push(result.evidence.effortSeconds);
      const expected=index===0?1.4:.9;
      assert.ok(result.evidence.effortSeconds>=expected&&result.evidence.effortSeconds<expected+.25,`${actionId} played for ${result.evidence.effortSeconds}s, expected about ${expected}s`);
      if(index===0)assert.ok(Math.abs(result.evidence.travelDistance-(leg==='load'?.28:.56))<.001);
      projectOutcome(state,intent,result,new Date().toISOString(),`receipt:${actionId}`);
    }
  }
  assert.deepEqual(receipts.map(r=>r.status),['playing','completed','playing','completed','playing','completed','playing','completed']);
  assert.equal(contract.done,1);assert.equal(contract.status,'unpaid');
  assert.equal(state.life.memories.filter(m=>m.id.startsWith('forced-labor-memory:')).length,4);
  assert.equal(await siteWindow.webContents.executeJavaScript('document.getElementById("worker").style.left'),'78%');
  const elapsed=Math.round(performance.now()-started);
  await assert.rejects(siteWindow.webContents.executeJavaScript('window.worksite.action("invalid-action")'),/工地操作无效/);
  await siteWindow.webContents.executeJavaScript('window.worksite.action("force-work")');
  const interrupted=state.legacy.labor.contracts[0],id='partial-walk';
  state.legacy.world.command={id,source:'labor',forcedLabor:true,surface:'web',status:'queued',index:0,labor:{id:interrupted.id,trip:0,leg:'load',x:.22}};
  const intent={id,type:'labor.step',payload:{petId:'main',actionId:id,parameters:{commandId:id,contractId:interrupted.id}}};
  const walking=commands.bridge.execute('main',intent,AbortSignal.timeout(5000));
  for(let i=0;i<200;i++){
    const x=await siteWindow.webContents.executeJavaScript('parseFloat(document.getElementById("worker").style.left)');
    if(x<68)break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  await siteWindow.webContents.executeJavaScript('window.worksite.action("release")');assert.equal(state.legacy.worksite.inside,false);
  const partial=await walking;
  assert.equal(partial.status,'cancelled');
  assert.ok(partial.evidence.travelDistance>0&&partial.evidence.travelDistance<.56);
  assert.ok(partial.evidence.effortSeconds>0&&partial.evidence.effortSeconds<1.4);
  projectOutcome(state,intent,partial,new Date().toISOString(),`receipt:${id}`);
  assert.equal(state.legacy.labor.contracts[0].done,0);
  assert.ok(state.life.memories.some(m=>m.id===`forced-labor-memory:${id}`));

  // Let the host build and dispatch an ordinary contract one receipt at a
  // time through the same renderer and transport, with polling still off.
  state.legacy.labor.contracts=[{id:'ordinary',status:'queued',trips:1,done:0,wage:50,paid:0,carrying:false}];
  state.humanity.helperReady=true;state.humanity.restrained=false;
  state.life.actions=[];state.life.receipts=[];
  Object.assign(state.life,{beliefs:[],observations:[],relationships:[],goals:[],commitments:[]});
  state.life.constraints={paused:false,permissions:[],capabilities:[{name:'labor.step',enabled:true,physical:true}]};
  await site.act('main','request-entry');
  await site.act('main','enter-voluntary');
  await siteWindow.webContents.executeJavaScript('window.worksite.snapshot()');
  const actionCoordinator=new ActionCoordinator(uow,projectBody),lifecycle=new CanonicalActionLifecycle(projectBody);
  const normal=new AbortController(),forcedCount=state.life.memories.length;
  const normalStart=performance.now(),beforeVersion=state.version;
  const dispatcher={async dispatch(actionId){
    const action=state.life.actions.find(a=>a.id===actionId);
    const step={id:actionId,type:action.actionType,payload:{actionId,petId:'main',actionType:action.actionType,parameters:action.parameters}};
    await uow.apply('main',state.version,draft=>assert.equal(lifecycle.prepare(draft,step).allowed,true));
    const receipt=await commands.bridge.execute('main',step,AbortSignal.any([normal.signal,AbortSignal.timeout(5000)]));
    await uow.apply('main',state.version,draft=>lifecycle.complete(draft,step,lifecycle.validateReceipt(draft,step,receipt)));
    return receipt;
  }};
  const life=createDeterministicLife({},store,async()=>{},gate,uow,actionCoordinator,dispatcher,async()=>{throw Error('工地衔接不应刷新通用预算');});
  try{
    await life.runWorksite('main',normal.signal,true);
    for(let i=0;i<650&&state.life.receipts.length<4;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(state.life.receipts.length,4);
    assert.ok(state.life.receipts.every(r=>r.status==='COMPLETED'));
    assert.equal(state.version-beforeVersion,12,'one enqueue, one dispatch and one settlement per step');
    assert.equal(state.legacy.labor.contracts[0].done,1);
    assert.equal(state.legacy.labor.contracts[0].status,'unpaid');
    assert.equal(state.legacy.labor.contracts[0].wage,50);
    assert.equal(state.legacy.worksite.completedInSession,1);
    assert.equal(state.life.memories.length,forcedCount);
    console.log(`PASS: ordinary host progression completed four confirmed steps in ${Math.round(performance.now()-normalStart)} ms with durable-step boundaries simulated`);
  }finally{normal.abort();}
  channel.closed(epoch);commands.close();
  console.log(`PASS: dispatch notifications alone ran the four steps in ${elapsed} ms; measured animation ${actualSeconds.map(s=>s.toFixed(3)).join(', ')} s, and an interrupted route preserved partial effort`);
}).then(()=>{clearTimeout(deadline);server?.close();app.exit(0);}).catch(error=>{console.error(error);clearTimeout(deadline);server?.close();app.exit(1);});
