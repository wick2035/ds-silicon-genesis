'use strict';
const path=require('node:path');

// The native helper owns both windows and is the only source of worksite
// transitions and animation receipts. Closing the page cannot release a pet.
function register({ipcMain,petWindows,hostRequest,BrowserWindow,screen,app}) {
  const sites=new Map(), last=new Map(), locations=new Map(), busy=new Set(), queues=new Map();
  let shuttingDown=false;app?.on('before-quit',()=>{shuttingDown=true;});
  const petFor=sender=>[...petWindows.state.windows].find(([,win])=>win.webContents===sender)?.[0];
  const siteFor=sender=>[...sites].find(([,win])=>!win.isDestroyed()&&win.webContents===sender)?.[0];
  function enqueue(petId,operation){
    const next=(queues.get(petId)||Promise.resolve()).catch(()=>{}).then(operation);
    queues.set(petId,next);return next;
  }
  async function request(petId,surface,action,details){
    const res=await hostRequest('POST',`/__silicon/${surface}`,JSON.stringify({petId,action,...details}));
    let body;try{body=JSON.parse(res.body||'{}');}catch{throw Error('场景状态不可用');}
    if(res.status!==200)throw Error(body.message||'场景状态未保存');
    return body;
  }
  function call(petId,action,requestId){
    return enqueue(petId,async()=>{
      const body=await request(petId,'worksite',action,{requestId});
      if(body.location){
        last.set(petId,body);locations.set(petId,{work:body.location.inside===true,farm:body.farmInside===true});showBody(petId);
        const win=sites.get(petId);
        if(win&&!win.isDestroyed())win.webContents.send('worksite:state',body);
      }
      return body;
    });
  }
  function showBody(petId, disconnected=false){const win=petWindows.state.windows.get(petId);if(!win||win.isDestroyed())return;const location=locations.get(petId);if(location?.work||(!disconnected&&location?.farm)){if(win.isVisible())win.hide();}else if(!win.isVisible())win.showInactive();}
  const farm=require('./farm.js').registerFarm({ipcMain,petWindows,BrowserWindow,app,showBody:id=>showBody(id,true),call:(id,action,requestId)=>enqueue(id,async()=>{
    const body=await request(id,'farm',action,{requestId});
    if(typeof body.inside==='boolean'){locations.set(id,{work:body.worksiteInside===true,farm:body.inside});showBody(id);}
    return body;
  })});
  async function watchDispatch(petId,win){
    let after=-1;
    while(!shuttingDown&&sites.get(petId)===win&&!win.isDestroyed()){
      try{
        // Keep this wait outside the scene's request queue so actions and
        // receipts can reach the host while no new step is ready.
        const {revision}=await request(petId,'worksite','watch',{after});
        if(win.isDestroyed()||sites.get(petId)!==win)return;
        if(!Number.isSafeInteger(revision)||revision<0)throw Error('工地通知无效');
        if(revision!==after){await call(petId,'snapshot');after=revision;}
      }catch{
        await new Promise(resolve=>setTimeout(resolve,1000).unref());
      }
    }
  }
  function open(petId,focus=true){
    let win=sites.get(petId);
    if(win&&!win.isDestroyed()){if(focus){win.show();win.focus();}return win;}
    win=new BrowserWindow({width:1020,height:760,minWidth:520,minHeight:560,show:false,title:'大肥鱼 · 搬砖工地',backgroundColor:'#f4f7fb',autoHideMenuBar:true,
      webPreferences:{preload:path.join(__dirname,'..','worksite-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
    sites.set(petId,win);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',e=>e.preventDefault());
    win.on('close',e=>{if(!shuttingDown&&last.get(petId)?.location?.inside){e.preventDefault();win.show();win.webContents.send('worksite:notice','请先把大肥鱼接出去，再关闭工地。');}});
    win.webContents.on('render-process-gone',()=>{if(!win.isDestroyed())win.destroy();});
    win.on('closed',()=>{if(sites.get(petId)===win)sites.delete(petId);});
    win.once('ready-to-show',()=>{if(!win.isDestroyed())win.show();});
    win.webContents.once('did-finish-load',()=>{setTimeout(()=>{if(!win.isDestroyed()&&!win.isVisible())win.show();},400);});
    win.loadFile(path.join(__dirname,'..','worksite.html')).catch(()=>{if(!win.isDestroyed())win.destroy();});
    void watchDispatch(petId,win);
    return win;
  }
  ipcMain.on('pet:open-worksite',event=>{const id=petFor(event.sender);if(id)open(id);});
  ipcMain.handle('pet:drop-worksite',async event=>{
    const id=petFor(event.sender),win=id&&sites.get(id);if(!id||!win||win.isDestroyed()||!win.isVisible()||win.isMinimized())return {entered:false};
    const p=screen.getCursorScreenPoint(),r=win.getContentBounds();
    if(p.x<r.x||p.y<r.y||p.x>=r.x+r.width||p.y>=r.y+r.height)return {entered:false};
    const state=await call(id,'enter-forced');win.show();win.focus();return {entered:true,state};
  });
  ipcMain.handle('worksite:snapshot',async event=>{const id=siteFor(event.sender);if(!id)throw Error('工地窗口不可用');return call(id,'snapshot');});
  ipcMain.handle('worksite:action',async(event,action)=>{
    const id=siteFor(event.sender);if(!id||!['release','touch','drag','force-work','resume-work','retry-unconfirmed'].includes(action))throw Error('工地操作无效');
    return call(id,action);
  });
  ipcMain.handle('worksite:receipt',async(event,receipt)=>{
    const id=siteFor(event.sender),state=id&&last.get(id);
    if(!id||receipt?.surface!=='web'||!['playing','completed','interrupted'].includes(receipt.status)||typeof receipt.id!=='string'||!Number.isSafeInteger(receipt.index)||(receipt.status==='playing'&&!state?.location?.inside))throw Error('工地回执无效');
    const response=await hostRequest('POST','/__silicon/action-receipt',JSON.stringify({...receipt,petId:id,processEpoch:process.env.SILICON_HELPER_EPOCH||''}));
    if(response.status!==200)throw Error('工地动作未保存');return JSON.parse(response.body||'{}');
  });
  async function sync(id){
    if(busy.has(id))return;busy.add(id);
    let state;
    try{
      state=await call(id,'snapshot');
      if(state.openRequestId){
        const win=open(id,true);
        if(win.webContents.isLoading())await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('工地窗口加载超时')),6000);win.webContents.once('did-finish-load',()=>{clearTimeout(timer);resolve();});win.webContents.once('did-fail-load',()=>{clearTimeout(timer);reject(Error('工地窗口加载失败'));});});
        if(win.isDestroyed())throw Error('工地窗口已关闭');win.show();win.focus();await call(id,'open-ack',state.openRequestId);
      }
      if(state.location?.requested&&!state.location?.inside){
        const win=open(id,false);
        if(!win.webContents.isLoading()&&!win.isDestroyed()){state=await call(id,'enter-voluntary');}
      }
      if(state.location?.inside)open(id,false);
    }catch(e){/* Keep the last confirmed body location on a disconnected host. */}
    finally{try{if(!state||state.farmInside||state.farmPending)await farm.sync(id);}catch{}busy.delete(id);}
  }
  const timer=setInterval(()=>{for(const id of petWindows.state.windows.keys())void sync(id);},1000);timer.unref?.();
}
module.exports={register};
