'use strict';

const {app,BrowserWindow,ipcMain,screen}=require('electron');
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
if(process.platform==='win32'){
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('force-device-scale-factor','1');
}
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
  const area=screen.getPrimaryDisplay().workArea;
  const zoom=Number(process.env.SILICON_COOKER_SMOKE_ZOOM)||1;
  win=new BrowserWindow({width:420,height:360,show:false,frame:false,transparent:true,
    webPreferences:{preload:path.join(helper,'preload.js'),backgroundThrottling:false}});
  // Keep the fixture window offscreen while testing the visible-desktop ACK path.
  win.isVisible=()=>true;
  const windows=new Map([['main',win]]);
  let pointer={x:area.x,y:area.y};
  require(path.join(helper,'main/rice-cooker.js')).register({
    ipcMain,BrowserWindow,screen,petWindows:{state:{windows},keepOffTaskbar:window=>window.setSkipTaskbar(true)},
    dpi:{currentPointer:()=>pointer},
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
  const documentPath=path.join(profile,'pet.html');
  fs.writeFileSync(documentPath,`<!doctype html><meta charset="utf-8">
    <base href="${pathToFileURL(helper+path.sep).href}">
    <script>
      class PetSprite {}
      const VIEW={x:${area.x/zoom},y:${area.y/zoom},w:${area.width/zoom},h:${area.height/zoom}};
      const AREAS=[VIEW], toLocal=value=>value/${zoom}, toScreen=value=>value*${zoom};
      const S={FEET_Y:330,CANVAS_H:360,clampPointToRegion:(_areas,x,y)=>({x,y}),pick:pool=>pool[0]};
    </script>
    <script src="sprite/motion.js"></script>
    <script src="sprite/cooker-visit.js"></script>
    <script>
      const pet=Object.assign(new PetSprite(),{ac:new AbortController(),size:220,height:124,halfW:110,
        halfH:62,bottomPad:10,hitRect:{x:65,y:26,w:90,h:98},pos:{x:140,y:160},pet:{},
        dragState:{active:false},throwRef:null,moveRef:null,posFollow:null,moveToken:0,posFollowToken:0,
        animations:{baifan:['front','side-run'],idle:['idle']},
        stopThrow(){},sendBounds(x,y){this.pos={x,y};},switchTo(anim){this.anim=anim;this.playedRun=anim==='side-run';},
        playOnce(anim){this.anim=anim;},showCareReaction(text){window.lastReply=text;}});
    </script>`);
  await win.loadFile(documentPath);
  win.webContents.setZoomFactor(zoom);
  const petJs=source=>win.webContents.executeJavaScript(source);
  await petJs('pet.attachRiceCooker(); window.petBridge.openRiceCooker();');
  const pot=BrowserWindow.getAllWindows().find(window=>window!==win);
  assert(pot, 'expected a separate cooker window');
  const js=source=>pot.webContents.executeJavaScript(source);
  const until=async source=>{
    for(let i=0;i<125;i++){
      if(await js(source))return;
      await delay(40);
    }
    throw Error('等待桌面锅况超时 '+source);
  };
  await until('cooker.connected && cooker.expanded');
  await until('cooker.image.complete && cooker.image.naturalWidth===384');
  assert.equal(pot.isAlwaysOnTop(),true);
  assert.equal(pot.webContents.getZoomFactor(),zoom);
  assert(Math.abs(await js('cooker.art.offsetHeight*.94')-98)<1);
  assert.equal(await js('document.activeElement===cooker.closeButton'),true);
  const click=async(selector, atEdge=false)=>{
    const rect=await js(`document.querySelector('${selector}').getBoundingClientRect().toJSON()`);
    const x=Math.round((rect.x+(atEdge?3:rect.width/2))*zoom);
    const y=Math.round((rect.y+rect.height/2)*zoom);
    const bounds=pot.getContentBounds();
    pointer={x:bounds.x+x,y:bounds.y+y};
    pot.webContents.sendInputEvent({type:'mouseMove',x,y});
    pot.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x,y});
    pot.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y});
  };
  await click('.rice-cooker-close',true);
  await until('cooker.panel.hidden');
  await petJs('window.petBridge.openRiceCooker()');
  await until('!cooker.panel.hidden');
  await js('cooker.closeButton.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert.equal(await js('cooker.launcher.hidden'),true);
  await petJs('window.petBridge.openRiceCooker()');
  await until('!cooker.panel.hidden');
  const artPosition=async()=>{
    const {x,y}=pot.getContentBounds();
    const art=await js('cooker.art.getBoundingClientRect().toJSON()');
    return {x:x+art.x*zoom,y:y+art.y*zoom};
  };
  const beforeDrag=await artPosition();
  const ownerPosition=win.getPosition();
  await js(`(() => {
    // Keep Chromium's capture tied to a real pressed pointer, then move by a screen delta.
    cooker.launcher.addEventListener('pointerdown', event => {
      const init={pointerId:event.pointerId,screenX:event.screenX-160,screenY:event.screenY-200};
      cooker.launcher.dispatchEvent(new PointerEvent('pointermove',init));
    },{once:true});
  })()`);
  await click('.rice-cooker-art');
  await until('cooker.panelBelow && !cooker.drag');
  const afterDrag=await artPosition();
  assert(afterDrag.y<beforeDrag.y-60, JSON.stringify({beforeDrag,afterDrag}));
  assert.deepEqual(win.getPosition(),ownerPosition);
  assert.equal(await js('cooker.expanded'),true);
  const pinned=pot.getContentBounds();
  win.setPosition(area.x+25,area.y+40);
  assert.deepEqual(pot.getContentBounds(),pinned);
  // Near the screen edge, the details flip below the pot and remain fully clickable.
  assert.equal(await js('cooker.panelBelow'),true);
  await click('.rice-cooker-close');
  await until('cooker.launcher.hidden');

  startCooking(state,'desktop-smoke',6,now);
  await until('cooker.caption.textContent.startsWith("煮 6 碗 ·")');
  await until('cooker.image.naturalWidth===384 && cooker.image.src.endsWith("closed.png")');
  for(let i=0;i<100&&!await petJs('pet.cookerBatch==="desktop-smoke" && pet.posFollow===null');i++)await delay(40);
  const approach=await petJs('({batch:pet.cookerBatch,finished:pet.posFollow===null,ran:pet.playedRun,center:toScreen(pet.pos.x+pet.halfW+VIEW.x)})');
  assert.equal(approach.batch,'desktop-smoke');
  assert(approach.finished&&approach.ran);
  const potArt=await js('cooker.art.getBoundingClientRect().toJSON()');
  const potCenter=pot.getContentBounds().x+(potArt.x+potArt.width/2)*zoom;
  assert(Math.abs(potCenter-approach.center)>40*zoom&&Math.abs(potCenter-approach.center)<105*zoom);
  const arrived=await petJs('pet.pos');
  now+=COOKING_MS;
  await until('cooker.caption.textContent==="锅里还有 6 碗"');
  await until('cooker.image.naturalWidth===384 && cooker.image.src.endsWith("empty.png") && !cooker.fill.hidden && cooker.mound.naturalWidth>0');
  const riceHeight='cooker.mound.getBoundingClientRect().height/cooker.fill.getBoundingClientRect().height';
  const fullHeight=await js(riceHeight);
  await js('cooker.launcher.click()');
  await until('!cooker.panel.hidden && cooker.root.offsetWidth <= innerWidth+1 && cooker.root.offsetHeight <= innerHeight+1');
  const geometry=await js(`({width:innerWidth,height:innerHeight,
    bounds:[cooker.launcher,cooker.panel].map(el=>el.getBoundingClientRect().toJSON())})`);
  assert(geometry.bounds.every(rect=>rect.left>=0&&rect.top>=0&&
    rect.right<=geometry.width+1&&rect.bottom<=geometry.height+1),JSON.stringify({zoom,...geometry}));
  assert.deepEqual(await petJs('pet.pos'),arrived);
  if(process.env.SILICON_COOKER_SMOKE_IMAGE){
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(process.env.SILICON_COOKER_SMOKE_IMAGE,(await win.webContents.capturePage()).toPNG());
  }
  await js('for(let i=0;i<4;i++)cooker.plus.click()');
  assert.equal(await js('cooker.submit.textContent'),'盛走 5 碗');
  assert(Math.abs(await js(riceHeight)-fullHeight)<.01);
  await js('cooker.submit.click();cooker.submit.click();');
  await until('cooker.caption.textContent==="锅里还有 1 碗"');
  await until(`${riceHeight} < ${fullHeight*.4}`);
  for(let i=0;i<100&&!await petJs('window.lastReply?.includes("爸盛走了5碗")');i++)await delay(40);
  assert.equal(await petJs('window.lastReply?.includes("爸盛走了5碗")'),true);
  assert.equal(state.life.events.filter(event=>event.type==='rice.taken').length,1);
  await js('cooker.submit.click()');
  await until('cooker.launcher.hidden && cooker.panel.hidden');
  assert.equal(state.life.events.filter(event=>event.type==='rice.taken').length,2);
  console.log(`PASS (${zoom}×): independent always-on-top cooker, sizing, drag, close, edge layout, running, countdown and serving`);
}).then(()=>{clearTimeout(timeout);win?.destroy();app.exit(0);}).catch(error=>{
  console.error(error);
  clearTimeout(timeout);
  win?.destroy();
  app.exit(1);
});
