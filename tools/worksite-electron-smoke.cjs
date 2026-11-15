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
  constructor(options){super({...options,show:false});this.show=()=>{};this.showInactive=()=>{};this.focus=()=>{};}
}
let server;
const deadline=setTimeout(()=>{console.error('worksite Electron smoke timed out');app.exit(1);},20000);
app.whenReady().then(async()=>{
  const load=rel=>import(pathToFileURL(path.join(root,rel)).href);
  const {createWorksite}=await load('dist/host/worksite.js');
  const {createHelperChannel}=await load('dist/host/helper-channel.js');
  const {createHumanity}=await load('vendor/dsh-pet/src/host/humanity.mjs');
  let state={petId:'main',version:0,legacy:{events:[],labor:{contracts:[]},world:{},wallet:{balance:100},config:{costs:{}}},humanity:createHumanity(),life:{events:[],memories:[],invalidSources:{},constraints:{paused:false}}};
  const store={loadEnvelope:async()=>structuredClone(state)},gate={run:async(_id,fn)=>fn()};
  const uow={apply:async(_id,version,fn)=>{assert.equal(version,state.version);const d=structuredClone(state);fn(d);d.version++;state=d;}};
  let command=null;const receipts=[];
  const site=createWorksite(store,gate,uow,()=>command,()=>{});
  const channel=createHelperChannel({observeRestraint:async()=>{}},{},['main'],{},{},{cancelPet(){}},undefined,undefined,undefined,undefined,(id,action)=>action==='snapshot'?site.snapshot(id):site.act(id,action));
  const epoch='b'.repeat(32);channel.opened(epoch);
  const requests=[];
  server=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    try{if(req.url==='/__silicon/action-receipt'){const receipt=JSON.parse(raw);receipts.push(receipt);if(receipt.status==='completed')command=null;res.writeHead(200,{'content-type':'application/json'});res.end('{}');return;}assert.equal(req.url,'/__silicon/worksite');assert.equal(req.method,'POST');const input=JSON.parse(raw);requests.push(input.action);const result=await channel.worksite(epoch,input);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));}
    catch(error){res.writeHead(409);res.end(JSON.stringify({message:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const hostRequest=async(method,url,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,body});return {status:r.status,body:await r.text()};};
  const desktop=new HiddenWindow({show:false}),windows=new Map([['main',desktop]]);
  let siteWindow;const TrackingWindow=class extends HiddenWindow {constructor(options){super(options);siteWindow=this;}};
  require('../vendor/dsh-pet/runtime/electron-helper/main/worksite.js').register({ipcMain,petWindows:{state:{windows}},hostRequest,BrowserWindow:TrackingWindow,screen,app});
  ipcMain.emit('pet:open-worksite',{sender:desktop.webContents});
  await new Promise((resolve,reject)=>{siteWindow.webContents.once('did-finish-load',resolve);siteWindow.webContents.once('did-fail-load',(_e,code,description)=>reject(Error(code+': '+description)));});
  await siteWindow.webContents.executeJavaScript('document.getElementById("force-work").click()');
  for(let i=0;i<500&&!state.legacy.labor.contracts.length;i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(requests.includes('force-work'),'button must reach the host over the actual IPC/HTTP chain');
  assert.equal(state.legacy.worksite.inside,true);assert.equal(state.legacy.labor.contracts[0].status,'working');
  assert.ok(state.humanity.emotions.fear>6);assert.ok(state.life.memories.some(m=>m.content.includes('强制')));
  // Exercise the real renderer's animation and native receipt path as well.
  // Keep this isolated test window hidden; production uses its visible window.
  await siteWindow.webContents.executeJavaScript('Object.defineProperty(document,"hidden",{get:()=>false,configurable:true});true');
  const before=await siteWindow.webContents.executeJavaScript('document.getElementById("worker").style.left');
  command={id:'forced-animation',source:'labor',forcedLabor:true,surface:'web',status:'queued',index:0,labor:{x:.22}};
  for(let i=0;i<600&&!receipts.some(r=>r.status==='completed');i++)await new Promise(r=>setTimeout(r,10));
  const after=await siteWindow.webContents.executeJavaScript('document.getElementById("worker").style.left');
  assert.ok(receipts.some(r=>r.status==='playing'),'actual renderer must start moving');
  assert.ok(receipts.some(r=>r.status==='completed'&&r.played===true),'actual animation must finish and report its receipt');
  assert.notEqual(after,before,'worker position must actually change');
  await assert.rejects(siteWindow.webContents.executeJavaScript('window.worksite.action("invalid-action")'),/工地操作无效/);
  await siteWindow.webContents.executeJavaScript('window.worksite.action("release")');assert.equal(state.legacy.worksite.inside,false);
  channel.closed(epoch);console.log('PASS: real Electron click → preload → IPC → HTTP → helper channel → canonical worksite → real movement → completed receipt; invalid action rejected; release succeeds');
}).then(()=>{clearTimeout(deadline);server?.close();app.exit(0);}).catch(error=>{console.error(error);clearTimeout(deadline);server?.close();app.exit(1);});
