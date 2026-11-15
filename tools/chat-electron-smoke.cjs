'use strict';
const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
app.setPath('userData',require('node:fs').mkdtempSync(path.join(os.tmpdir(),'chat-stream-smoke-')));
let server;const deadline=setTimeout(()=>app.exit(1),15000);
app.whenReady().then(async()=>{
 const root=path.resolve(__dirname,'..');let finish;
 const barrier=new Promise(resolve=>{finish=resolve;});
 server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/life/chat'){
   res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: partial\ndata: {"text":"我在听"}\n\n');await barrier;
   res.write('event: partial\ndata: {"text":"我在听，爸爸。"}\n\n');res.end('event: done\ndata: {"ok":true,"reply":"我在听，爸爸。","usage":{"inputTokens":1200,"outputTokens":8}}\n\n');return;
  }
  if(url.pathname.startsWith('/api/life/')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,value:url.pathname.endsWith('/timeline')?[]:{sources:{},runtime:{paused:false}}}));return;}
  const file=url.pathname==='/life/'?'index.html':url.pathname.startsWith('/life/')?url.pathname.slice(6):null;
  if(!file||!['index.html','app.js','bridge.js','style.css','finance.js','companion.js','model.js'].includes(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});res.end(await fs.readFile(path.join(root,'src/ui',file)));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
 await win.loadURL('http://127.0.0.1:'+server.address().port+'/life/');
 const poll=async(code)=>{for(let i=0;i<300;i++){if(await win.webContents.executeJavaScript(code))return;await new Promise(r=>setTimeout(r,10));}throw Error('UI condition timed out: '+code);};
 await poll('document.querySelector("#connection")?.textContent==="已连接"');await win.webContents.executeJavaScript('document.querySelector("[data-page=chat]").click()');
 await poll('Boolean(document.querySelector("#chat-text"))');
 await win.webContents.executeJavaScript('document.querySelector("#chat-text").value="你好";document.querySelector("#chat-form").requestSubmit()');
 await poll('document.querySelector("[data-streaming] .chat-bubble")?.textContent==="我在听"');
 assert.equal(await win.webContents.executeJavaScript('document.querySelector("#chat-form button[type=submit]").disabled'),true);
 finish();await poll('document.querySelector(".is-assistant .chat-meta")?.textContent.includes("1200")');
 assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".is-assistant").length'),1);
 assert.equal(await win.webContents.executeJavaScript('document.querySelector(".is-assistant .chat-bubble").textContent'),'我在听，爸爸。');
 assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("[data-streaming]").length'),0);
 console.log('PASS: actual chat UI displays partial text before completion, updates bubble, shows actual token usage and removes pending state');win.destroy();
}).then(()=>{clearTimeout(deadline);server?.close();app.exit(0);}).catch(error=>{console.error(error);clearTimeout(deadline);server?.close();app.exit(1);});
