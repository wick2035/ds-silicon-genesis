'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
let win;
const profile=require('node:fs').mkdtempSync(path.join(os.tmpdir(),'meal-finance-smoke-'));
app.setPath('userData',profile);
let failed=false;
const watchdog=setTimeout(()=>app.exit(1),25000);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{
  const source=(await fs.readFile(path.join(root,'src/ui/finance.js'),'utf8')).replaceAll('export function','function');
  const css=await fs.readFile(path.join(root,'src/ui/style.css'),'utf8');
  const data={wallet:{balance:500,frozen:false},costs:{feed:200,chat:0,whisper:0,diary:10,explore:0},labor:{history:[],queue:[]},events:[],food:[{id:'rice:old',actionId:'eat:old',name:'大白饭',source:'fridge',status:'unconfirmed'},{id:'rice:new',name:'大白饭',source:'fridge',status:'available'},{id:'cooked:batch:1',actionId:'eat:current',name:'大白饭',source:'cooker',status:'eating'}]};
  const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><main class="content"><div class="page-head"><div><h1>饭钱</h1><p>每一碗饭，都有清楚的来处。</p></div></div><div id="view"></div></main><script>'+source+'\n'+
    'window.calls=[];let failed=false;window.fixture='+JSON.stringify(data)+';const view=document.querySelector("#view");const reload=async()=>{view.innerHTML=renderFinance(window.fixture);};window.lifeApi={updateFinance:async input=>{calls.push(input);if(!failed){failed=true;throw Error("连接暂时中断");}if(input.action==="discard")fixture.food=fixture.food.filter(item=>item.id!==input.itemId);return {message:input.action==="discard"?"这碗饭已作废，没有再次扣钱或补加饱腹。":"尚未找到完成回执。这碗饭暂时保留，也可以选择作废。"};}};reload();installFinance(view,reload,()=>true);</script>';
  const file=path.join(profile,'finance.html');await fs.writeFile(file,html);
  win=new BrowserWindow({width:1280,height:1050,show:false,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  await win.loadFile(file);
  const js=code=>win.webContents.executeJavaScript(code);
  await fs.mkdir(path.join(root,'data/meal-diary-verification'),{recursive:true});
  for(const width of [1280,390]){
    win.setContentSize(width,1050);await new Promise(resolve=>setTimeout(resolve,120));
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true,'horizontal overflow');
    assert.equal(await js('document.querySelectorAll("[data-rice-action]").length'),2);
    const png=await win.webContents.capturePage();await fs.writeFile(path.join(root,'data/meal-diary-verification',`finance-${width}.png`),png.toPNG());
  }
  await js('document.querySelector("[data-rice-action=reconcile]").click()');await new Promise(resolve=>setTimeout(resolve,40));
  assert.match(await js('document.querySelector(".food-feedback").textContent'),/连接暂时中断/);
  assert.equal(await js('document.querySelector("[data-rice-action=reconcile]").disabled'),false);
  await js('document.querySelector("[data-rice-action=reconcile]").click()');await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(await js('calls[0].requestId===calls[1].requestId'),true);
  assert.match(await js('document.querySelector(".food-feedback").textContent'),/尚未找到/);
  await js('document.querySelector("[data-rice-action=discard]").focus();document.activeElement.click()');await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(await js('document.querySelectorAll("[data-rice-action]").length'),0);
  assert.match(await js('document.querySelector(".food-feedback").textContent'),/已作废/);
  console.log('Finance desktop/mobile render, network recovery, stable request IDs and discard UI passed.');
}).catch(error=>{console.error(error);failed=true;}).finally(async()=>{
  clearTimeout(watchdog);win?.destroy();app.exit(failed?1:0);
});
