'use strict';
const path=require('node:path');

// The native helper owns both windows and is the only source of worksite
// transitions and animation receipts. Closing the page cannot release a pet.
function register({ipcMain,petWindows,hostRequest,BrowserWindow,screen,app}) {
  const sites=new Map(), last=new Map(), busy=new Set(), queues=new Map();
  let shuttingDown=false;app?.on('before-quit',()=>{shuttingDown=true;});
  const petFor=sender=>[...petWindows.state.windows].find(([,win])=>win.webContents===sender)?.[0];
  const siteFor=sender=>[...sites].find(([,win])=>!win.isDestroyed()&&win.webContents===sender)?.[0];
  function call(petId,action){
    const next=(queues.get(petId)||Promise.resolve()).catch(()=>{}).then(async()=>{
      const res=await hostRequest('POST','/__silicon/worksite',JSON.stringify({petId,action}));
      let body;try{body=JSON.parse(res.body||'{}');}catch{throw Error('工地状态不可用');}
      if(res.status!==200)throw Error(body.message||'工地状态未保存');
      last.set(petId,body);return body;
    });
    queues.set(petId,next);return next;
  }
  function showBody(petId,inside){const win=petWindows.state.windows.get(petId);if(!win||win.isDestroyed())return;if(inside){if(win.isVisible())win.hide();}else if(!win.isVisible())win.showInactive();}
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
    return win;
  }
  ipcMain.on('pet:open-worksite',event=>{const id=petFor(event.sender);if(id)open(id);});
  ipcMain.handle('pet:drop-worksite',async event=>{
    const id=petFor(event.sender),win=id&&sites.get(id);if(!id||!win||win.isDestroyed()||!win.isVisible()||win.isMinimized())return {entered:false};
    const p=screen.getCursorScreenPoint(),r=win.getContentBounds();
    if(p.x<r.x||p.y<r.y||p.x>=r.x+r.width||p.y>=r.y+r.height)return {entered:false};
    const state=await call(id,'enter-forced');showBody(id,true);win.show();win.focus();return {entered:true,state};
  });
  ipcMain.handle('worksite:snapshot',async event=>{const id=siteFor(event.sender);if(!id)throw Error('工地窗口不可用');return call(id,'snapshot');});
  ipcMain.handle('worksite:action',async(event,action)=>{
    const id=siteFor(event.sender);if(!id||!['release','touch','drag'].includes(action))throw Error('工地操作无效');
    const state=await call(id,action);if(action==='release')showBody(id,false);return state;
  });
  ipcMain.handle('worksite:receipt',async(event,receipt)=>{
    const id=siteFor(event.sender),state=id&&last.get(id);
    if(!id||!state?.location?.inside||receipt?.surface!=='web'||!['playing','completed','interrupted'].includes(receipt.status)||typeof receipt.id!=='string'||!Number.isSafeInteger(receipt.index))throw Error('工地回执无效');
    const response=await hostRequest('POST','/__silicon/action-receipt',JSON.stringify({...receipt,petId:id,processEpoch:process.env.SILICON_HELPER_EPOCH||''}));
    if(response.status!==200)throw Error('工地动作未保存');return JSON.parse(response.body||'{}');
  });
  async function sync(id){
    if(busy.has(id))return;busy.add(id);
    try{
      let state=await call(id,'snapshot');
      if(state.location?.requested&&!state.location?.inside){
        const win=open(id,false);
        if(!win.webContents.isLoading()&&!win.isDestroyed()){state=await call(id,'enter-voluntary');}
      }
      if(state.location?.inside){open(id,false);showBody(id,true);
        if(!state.location.forced&&!['working','paused'].includes(state.labor?.current?.status)){
          state=await call(id,'leave-voluntary');showBody(id,false);
        }
      }else showBody(id,last.get(id)?.location?.inside===true);
    }catch(e){/* Keep the last confirmed body location on a disconnected host. */}
    finally{busy.delete(id);}
  }
  const timer=setInterval(()=>{for(const id of petWindows.state.windows.keys())void sync(id);},1000);timer.unref?.();
}
module.exports={register};
