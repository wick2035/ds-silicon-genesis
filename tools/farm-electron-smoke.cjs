'use strict';
const {app,BrowserWindow,ipcMain,screen}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {setTimeout:wait}=require('node:timers/promises');

const root=path.resolve(__dirname,'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'silicon-farm-smoke-'));
app.setPath('userData',profile);
const deadline=setTimeout(()=>{console.error('Farm Electron smoke timed out');app.exit(1);},22000);

async function until(check) {
  for(let attempts=0;attempts<160;attempts++) {
    const result=await check();if(result)return result;
    await wait(50);
  }
  throw Error('Farm state did not settle');
}

app.whenReady().then(async()=>{
  const load=rel=>import(pathToFileURL(path.join(root,rel)).href);
  const {createFarmScene,checkFarmReceipt}=await load('dist/host/farm-scene.js');
  const {createWorksite}=await load('dist/host/worksite.js');
  const {farmFacts,farmVisit}=await load('dist/host/farm.js');
  const {projectOutcome}=await load('dist/host/outcome-projector.js');
  let state={petId:'main',version:0,legacy:{events:[],labor:{contracts:[]},world:{},wallet:{balance:100},config:{costs:{}}},
    humanity:{helperReady:true,restrained:false,sleeping:false,restingUntil:0},life:{events:[],memories:[],invalidSources:{},actions:[],constraints:{paused:false}}};
  const store={loadEnvelope:async()=>structuredClone(state)},gate={run:async(_id,fn)=>fn(),signal:new AbortController().signal};
  const save=async(_id,fn)=>{const d=structuredClone(state);fn(d);d.version++;state=d;return d;};
  const uow={applyCurrent:save,apply:async(id,version,fn)=>{assert.equal(state.version,version);return save(id,fn);}};
  const worksite=createWorksite(store,gate,uow,()=>null,()=>{});
  let clockOffset=0;
  const farmNow=()=>Date.now()+clockOffset;
  const farm=createFarmScene(store,gate,uow,farmNow);
  const epoch='a'.repeat(32);farm.opened(epoch);
  const request=async(_method,url,body)=>{
    const input=JSON.parse(body);
    try {
      const value=url.endsWith('/farm')?await farm.helper(input.petId,epoch,input):input.action==='snapshot'?{...await worksite.snapshot(input.petId),farmPending:farm.pending(input.petId)}:await worksite.act(input.petId,input.action);
      return {status:200,body:JSON.stringify(value)};
    } catch(error) {return {status:409,body:JSON.stringify({message:error.message})};}
  };
  class HiddenWindow extends BrowserWindow {
    constructor(options){super({...options,show:false});this.visible=false;}
    show(){this.visible=true;}
    showInactive(){this.visible=true;}
    hide(){this.visible=false;}
    isVisible(){return this.visible;}
    focus(){}
  }
  const desktop=new HiddenWindow({show:false}),windows=new Map([['main',desktop]]);
  const farmWindows=[];
  class TrackingWindow extends HiddenWindow {
    constructor(options){super(options);if(options.title.includes('稻田'))farmWindows.push(this);}
  }
  require('../vendor/dsh-pet/runtime/electron-helper/main/worksite.js').register({ipcMain,petWindows:{state:{windows}},hostRequest:request,BrowserWindow:TrackingWindow,screen,app});
  const expectOpen=farm.requestOpen('main');
  await expectOpen;
  const win=farmWindows[0], render=source=>win.webContents.executeJavaScript(source);
  await until(()=>render('document.getElementById("rice").textContent === "0"'));
  assert.equal(await render('document.querySelector(".landscape").naturalWidth'),1600);
  assert.equal(await render('!!window.farmBridge'),true);
  await farm.weather('main','sunny');
  await until(()=>render('!document.getElementById("visit").disabled'));
  await render('document.getElementById("visit").click()');
  await until(()=>farmVisit(state) && !desktop.isVisible());
  await assert.rejects(worksite.act('main','enter-forced'),/她在稻田/);
  await until(()=>render('document.getElementById("visit").textContent === "接她回来"'));
  await render('document.getElementById("visit").click()');
  await until(()=>!farmVisit(state) && desktop.isVisible());

  await farm.weather('main','light-rain');
  assert.deepEqual(await farm.requestEntry('main',gate.signal),{status:'COMPLETED',inside:true});
  await until(()=>farmVisit(state) && !desktop.isVisible());
  await until(()=>render('!document.getElementById("farmer").hidden && document.getElementById("visit").textContent === "接她回来"'));
  assert.equal(farmFacts(state).stage,'empty');
  assert.equal(state.legacy.wallet.balance,100);
  await render('document.getElementById("visit").click()');
  await until(()=>!farmVisit(state) && desktop.isVisible());

  const plant={id:'electron-sow',type:'farm.tend',payload:{parameters:{operation:'plant',seedPurchase:farmFacts(state).seedPurchase}}};
  const animate=farm.execute('main',plant,gate.signal);
  await until(()=>render('document.getElementById("farmer").src.includes("plant.gif")'));
  const completed=checkFarmReceipt(state,plant,await animate,Date.now());
  assert.equal(completed.status,'completed');
  projectOutcome(state,plant,completed,new Date().toISOString(),'action-result:electron-sow');
  await until(()=>render('document.querySelectorAll(".crop img").length === 24'));
  assert.equal(farmFacts(state).stage,'seedling');
  assert.equal(state.legacy.wallet.balance,76);
  assert.equal(await render('document.getElementById("seed-stock").textContent'),'0 / 72 束');
  assert.equal(await render('document.getElementById("care-progress").textContent'),'1 / 2 次');
  assert.equal(await render('document.getElementById("care-detail").textContent'),'现在可以施肥');
  assert.equal(await render('document.getElementById("rain-detail").textContent'),'人工 0 次 · 雨水 1 次');
  assert.match(await render('document.querySelector(".care-status").textContent'),/截至23:59 · 零点结算/);
  await until(()=>desktop.isVisible());
  if(process.env.SILICON_FARM_SMOKE_IMAGE) {
    await until(()=>render('document.getElementById("visit").textContent === "带她进田" && !document.getElementById("visit").disabled'));
    await render('document.getElementById("visit").click()');
    await until(()=>render('!document.getElementById("farmer").hidden && document.getElementById("farmer").src.includes("idle.webp") && document.getElementById("farmer").complete && !document.getElementById("visit").disabled'));
    await render('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const image=await win.webContents.capturePage();
    fs.writeFileSync(process.env.SILICON_FARM_SMOKE_IMAGE,image.toPNG());
    await render('document.getElementById("visit").click()');
    await until(()=>!farmVisit(state) && desktop.isVisible());
  }

  await farm.weather('main','heavy-typhoon');
  await until(()=>render('document.getElementById("scene").dataset.weather === "heavy-typhoon"'));
  win.setContentSize(490,575);
  await until(()=>render('window.innerWidth <= 500'));
  assert.equal(await render('document.documentElement.scrollWidth === document.documentElement.clientWidth'),true);
  assert.equal(await render('document.querySelector(".field-notes").getBoundingClientRect().top > document.querySelector(".scene").getBoundingClientRect().bottom'),true);
  await win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await render('document.getElementById("visit").disabled'),true);
  assert.equal(await render('document.getElementById("care-detail").textContent'),'天气恶劣 · 暂停进田');
  await assert.rejects(farm.requestEntry('main',gate.signal),/暂停进田/);
  assert.equal(await render('getComputedStyle(document.querySelector(".drop")).animationName'), 'none');
  assert.equal(await render('window.farmBridge.action("weather").then(()=>false,()=>true)'),true);

  await farm.weather('main','heavy-rain');
  await until(()=>render('document.getElementById("scene").dataset.weather === "heavy-rain" && document.getElementById("rain-detail").textContent === "人工 0 次 · 雨水 2 次"'));
  assert.equal(await render('document.getElementById("care-progress").textContent'),'2 / 2 次');
  assert.equal(await render('document.getElementById("care-detail").textContent'),'今日已达标');
  if(process.env.SILICON_FARM_SMOKE_NARROW_IMAGE) {
    await render('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const image=await win.webContents.capturePage();
    fs.writeFileSync(process.env.SILICON_FARM_SMOKE_NARROW_IMAGE,image.toPNG());
  }
  clockOffset=24*60*60_000;
  await farm.weather('main','light-rain');
  const fertilizer={id:'electron-fertilizer',type:'farm.tend',payload:{parameters:{operation:'fertilize'}}};
  const fertilizing=farm.execute('main',fertilizer,gate.signal);
  await until(()=>render('document.getElementById("farmer").dataset.pose === "fertilize"'));
  assert.equal(await render('getComputedStyle(document.querySelector(".fertilizer i")).animationName'),'none');
  assert.equal(await render('document.getElementById("scene-caption").textContent'),'大肥鱼正在施肥');
  const fertilized=checkFarmReceipt(state,fertilizer,await fertilizing,farmNow());
  assert.equal(fertilized.status,'completed');
  projectOutcome(state,fertilizer,fertilized,new Date(farmNow()).toISOString(),'action-result:electron-fertilizer');
  await until(()=>render('document.getElementById("care-progress").textContent === "2 / 2 次"'));
  assert.equal(farmFacts(state,farmNow()).careCompleted,1);
  assert.equal(farmFacts(state,farmNow()).careProgress,2);

  clockOffset=48*60*60_000;
  await farm.weather('main','light-rain');
  const interrupted={id:'electron-fertilizer-interrupt',type:'farm.tend',payload:{parameters:{operation:'fertilize'}}};
  const interrupting=farm.execute('main',interrupted,gate.signal);
  await until(()=>render('document.getElementById("farmer").dataset.pose === "fertilize"'));
  const beforeClose=farmFacts(state,farmNow()).careCompleted;
  win.close();
  assert.equal((await interrupting).status,'cancelled');
  assert.equal(farmFacts(state,farmNow()).careCompleted,beforeClose);
  await until(()=>win.isDestroyed() && !farmVisit(state) && desktop.isVisible());
  console.log('PASS: farm Electron open, confirmed entry, shared body, GIF receipt, weather, narrow layout, reduced motion and close');
}).then(()=>{clearTimeout(deadline);app.exit(0);}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
