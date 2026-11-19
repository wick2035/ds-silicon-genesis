'use strict';

const {app,BrowserWindow,ipcMain,shell}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {setTimeout:delay}=require('node:timers/promises');

const root=path.resolve(__dirname,'..');
const helper=path.join(root,'vendor/dsh-pet/runtime/electron-helper');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'silicon-rice-cooker-'));
app.setPath('userData',profile);
process.env.SILICON_HELPER_EPOCH='b'.repeat(32);
const timeout=setTimeout(()=>{console.error('Rice cooker Electron smoke timed out');app.exit(1);},20000);
let win;

app.whenReady().then(async()=>{
  const moduleUrl=pathToFileURL(path.join(root,'dist/host/rice-cooker.js'));
  const {createRiceCooker,startCooking,COOKING_MS}=await import(moduleUrl);
  let now=Date.now(), state={petId:'main',version:0,legacy:{farm:{rawBowls:6}},
    life:{constraints:{paused:false},actions:[],events:[],memories:[],invalidSources:{}},
    humanity:{helperReady:true,restrained:false,sleeping:false}};
  const gate={run:async(_id,operation)=>operation(),signal:new AbortController().signal};
  const uow={apply:async(_id,version,apply)=>{
    assert.equal(version,state.version);
    const draft=structuredClone(state);
    apply(draft);
    draft.version++;
    state=draft;
    return structuredClone(state);
  }};
  const cooker=createRiceCooker({loadEnvelope:async()=>structuredClone(state)},gate,uow,()=>now);
  win=new BrowserWindow({width:420,height:360,show:false,frame:false,transparent:true,
    webPreferences:{preload:path.join(helper,'preload.js'),backgroundThrottling:false}});
  // Keep the fixture window offscreen while testing the visible-desktop ACK path.
  win.isVisible=()=>true;
  const windows=new Map([['main',win]]);
  require(path.join(helper,'main/ipc.js')).registerIpc({
    ipcMain,shell,petWindows:{state:{windows}},
    hostRequest:async(_method,url,body)=>{
      if(url!=='/__silicon/cooker')return {status:200,body:'{}'};
      const input=JSON.parse(body);
      try {
        return {status:200,body:JSON.stringify(await cooker.helper(input.petId,input))};
      } catch (error) {
        return {status:409,body:JSON.stringify({ok:false,message:error.message})};
      }
    }
  });
  const documentPath=path.join(profile,'cooker.html');
  fs.writeFileSync(documentPath,`<!doctype html><meta charset="utf-8">
    <base href="${pathToFileURL(helper+path.sep).href}">
    <link rel="stylesheet" href="sprite/rice-cooker.css">
    <style>html,body{margin:0;background:transparent;overflow:hidden}#pet{position:absolute;width:220px;height:125px;pointer-events:none}</style>
    <div id="pet"></div>
    <script src="sprite/rice-cooker.js"></script>
    <script>
      const S={FEET_Y:330,CANVAS_H:360};
      const el=document.getElementById('pet');
      const pet={el,ac:new AbortController(),size:220,height:124,bottomPad:10,hitRect:{x:65,w:94},winOffset:{x:0,y:0},
        visibleClampRect:()=>({x:0,y:0,w:innerWidth,h:innerHeight}),syncInputRegions(){},
        showCareReaction(text){window.lastReply=text;}};
      window.movePet=(x,y)=>{pet.winOffset={x,y};el.style.left=x+'px';el.style.top=y+'px';window.cooker.layout();};
      window.cooker=new DesktopRiceCooker(pet);
      window.movePet(174,233);
    </script>`);
  await win.loadFile(documentPath);
  const js=source=>win.webContents.executeJavaScript(source);
  const until=async source=>{
    for(let i=0;i<125;i++){
      if(await js(source))return;
      await delay(40);
    }
    throw Error('等待桌面锅况超时 '+source);
  };
  await until('window.cooker.connected===true');
  assert.equal(await js('cooker.launcher.hidden'),true);
  await js('cooker.open()');
  await until('cooker.image.complete && cooker.image.naturalWidth===384');
  assert.equal(await js('document.activeElement===cooker.closeButton'),true);
  await js('cooker.closeButton.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert.equal(await js('cooker.launcher.hidden'),true);

  startCooking(state,'desktop-smoke',3,now);
  await until('cooker.caption.textContent.startsWith("煮 3 碗 ·")');
  await until('cooker.image.naturalWidth===384 && cooker.image.src.endsWith("closed.png")');
  now+=COOKING_MS;
  await until('cooker.caption.textContent==="锅里还有 3 碗"');
  await until('cooker.image.naturalWidth===280 && cooker.image.src.endsWith("ready.gif")');
  await until('cooker.image.naturalWidth===384 && cooker.image.src.endsWith("full.png")');
  await js('cooker.launcher.click()');
  await until('!cooker.panel.hidden && cooker.panel.offsetHeight>0');
  for(const zoom of [1,1.45]){
    const originalWidth=await js('innerWidth');
    win.webContents.setZoomFactor(zoom);
    if(zoom!==1)await until(`innerWidth!==${originalWidth}`);
    await js('movePet(innerWidth-60,innerHeight-50)');
    const geometry=await js(`({width:innerWidth,height:innerHeight,
      bounds:[cooker.launcher,cooker.panel].map(el=>el.getBoundingClientRect().toJSON())})`);
    assert(geometry.bounds.every(rect=>rect.left>=0&&rect.top>=0&&
      rect.right<=geometry.width+1&&rect.bottom<=geometry.height+1),JSON.stringify({zoom,...geometry}));
  }
  if(process.env.SILICON_COOKER_SMOKE_IMAGE){
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(process.env.SILICON_COOKER_SMOKE_IMAGE,(await win.webContents.capturePage()).toPNG());
  }
  await js('cooker.plus.click()');
  assert.equal(await js('cooker.submit.textContent'),'盛走 2 碗');
  await js('cooker.submit.click();cooker.submit.click();');
  await until('cooker.caption.textContent==="锅里还有 1 碗"');
  await until('window.lastReply?.includes("爸盛走了2碗")');
  assert.equal(state.life.events.filter(event=>event.type==='rice.taken').length,1);
  await js('cooker.submit.click()');
  await until('cooker.launcher.hidden && cooker.panel.hidden');
  assert.equal(state.life.events.filter(event=>event.type==='rice.taken').length,2);
  console.log('PASS: transparent cooker, countdown, GIF, keyboard, zoom, edge clamp, taking and reply');
}).then(()=>{clearTimeout(timeout);win?.destroy();app.exit(0);}).catch(error=>{
  console.error(error);
  clearTimeout(timeout);
  win?.destroy();
  app.exit(1);
});
