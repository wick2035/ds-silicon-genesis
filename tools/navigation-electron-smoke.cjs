'use strict';
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
app.setPath('userData',require('node:fs').mkdtempSync(path.join(os.tmpdir(),'life-navigation-')));
let server,win;const deadline=setTimeout(()=>app.exit(1),20000);
app.whenReady().then(async()=>{
 const root=path.resolve(__dirname,'..'),uiRoot=process.env.NAV_UI_ROOT||path.join(root,'src/ui'),delay=350;let failGoals=false,goalRequests=0,snapshotRequests=0;
 server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/life/')){
   const route=url.pathname.split('/').pop();if(route==='goals')goalRequests++;if(route==='snapshot')snapshotRequests++;
   await new Promise(resolve=>setTimeout(resolve,delay));
   if(route==='goals'&&failGoals){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'测试连接失败'}));return;}
   const value=route==='goals'?{version:1,items:[{id:'one',title:'测试目标',status:'active'}]}:route==='timeline'?[]:{version:1,sources:{},runtime:{paused:false}};
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,value}));return;
  }
  const file=url.pathname==='/life/'?'index.html':url.pathname.startsWith('/life/')?url.pathname.slice(6):null;
  if(!file||!['index.html','app.js','bridge.js','style.css','finance.js','companion.js','model.js','memory-graph.js'].includes(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(await fs.readFile(path.join(uiRoot,file)));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,offscreen:true}});await win.loadURL(`http://127.0.0.1:${server.address().port}/life/`);
 const js=code=>win.webContents.executeJavaScript(code);
 const poll=async code=>{for(let i=0;i<400;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,10));}throw Error('UI condition timed out: '+code);};
 await poll('document.querySelector("#connection").textContent === "已连接"');
 if(!process.env.NAV_BASELINE)assert.equal(snapshotRequests,1,'initial session handshake should reuse its snapshot');
 await js('document.querySelector("[data-page=goals]").click()');await poll('document.querySelector("#view").textContent.includes("测试目标")');
 await js('document.querySelector("[data-page=current]").click()');await poll('document.querySelector("#view").textContent.includes("你好")');
 const elapsed=await js(`new Promise(resolve=>{const start=performance.now();document.querySelector('[data-page=goals]').click();const check=()=>document.querySelector('#view').textContent.includes('测试目标')?resolve(performance.now()-start):setTimeout(check,1);check()})`);
 console.log(`Warm navigation DOM update: ${elapsed.toFixed(1)} ms (simulated API delay ${delay} ms)`);
 if(!process.env.NAV_BASELINE){
  assert(elapsed<100,'cached page should appear without waiting for the API');
  assert.equal(await js('document.querySelector("[data-command=goal]").disabled'),true,'cached actions must wait for current data');
  await new Promise(resolve=>setTimeout(resolve,80));
  await fs.writeFile(path.join(os.tmpdir(),'life-navigation-cached.png'),(await win.webContents.capturePage()).toPNG());
  await poll('!document.querySelector("[data-command=goal]").disabled');
  await js('document.querySelector("[data-page=current]").click();document.querySelector("[data-page=goals]").click();document.querySelector("[data-page=current]").click()');
  await new Promise(resolve=>setTimeout(resolve,delay+100));
  assert.equal(await js('document.querySelector("#crumb").textContent'), '当前');
  assert.equal(await js('document.querySelector("#view").textContent.includes("你好")'),true,'late responses must not replace the selected page');
  failGoals=true;await js('document.querySelector("[data-page=current]").click()');await poll('document.querySelector("#view").textContent.includes("你好")');
  await js('document.querySelector("[data-page=goals]").click()');await poll('!document.querySelector("#notice").hidden');
  assert.equal(await js('document.querySelector("#view").textContent.includes("测试目标")'),true,'retain cached content on failure');
  assert.equal(await js('document.querySelector("[data-command=goal]").disabled'),true,'do not permit stale commands on failure');
  assert(goalRequests>=3);
  console.log('PASS: cached navigation, fresh-data gating, refresh and failure handling');
 }
}).then(()=>{clearTimeout(deadline);win?.destroy();server?.close();app.exit(0);}).catch(error=>{console.error(error);clearTimeout(deadline);win?.destroy();server?.close();app.exit(1);});
