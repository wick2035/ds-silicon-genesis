'use strict';
const path = require('node:path');

function registerFarm({ipcMain, petWindows, BrowserWindow, app, call, showBody}) {
  const farms = new Map();
  const desktopPet = sender => [...petWindows.state.windows].find(([,win])=>win.webContents===sender)?.[0];
  const farmPet = sender => [...farms].find(([,session])=>!session.win.isDestroyed() && session.win.webContents===sender)?.[0];
  let quitting = false;
  app?.on('before-quit',()=>{quitting=true;});

  function open(id, focus) {
    let session = farms.get(id);
    if (session && !session.win.isDestroyed()) {
      if (focus) void session.loaded.then(()=>{if(!session.win.isDestroyed()){session.win.show();session.win.focus();}}).catch(()=>{});
      return session;
    }
    const win = new BrowserWindow({width:1080,height:722,minWidth:470,minHeight:550,show:false,
      title:'大肥鱼的稻田',backgroundColor:'#edf3e9',autoHideMenuBar:true,
      webPreferences:{preload:path.join(__dirname,'..','farm-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    session = {win,closing:false,loaded:win.loadFile(path.join(__dirname,'..','farm.html'))};
    farms.set(id,session);
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());
    void session.loaded.then(()=>{if(!win.isDestroyed()) {if(focus){win.show();win.focus();}else win.showInactive();}}).catch(()=>{if(!win.isDestroyed())win.destroy();});
    win.on('close',event=>{
      if(quitting || session.closing)return;
      event.preventDefault();session.closing=true;
      void call(id,'leave').catch(()=>{}).finally(()=>{if(!win.isDestroyed())win.destroy();});
    });
    win.webContents.on('render-process-gone',()=>{if(!win.isDestroyed())win.destroy();});
    win.on('closed',()=>{
      if(farms.get(id)!==session)return;
      farms.delete(id);
      if(!session.closing && !quitting)void call(id,'leave').catch(()=>{});
    });
    return session;
  }

  ipcMain.on('pet:open-farm',event=>{
    const id=desktopPet(event.sender);
    if(id)void call(id,'open').then(()=>open(id,true)).catch(()=>{});
  });
  ipcMain.handle('farm:action',async(event,input)=>{
    const id=farmPet(event.sender);
    if(!id || farms.get(id).closing || !['snapshot','enter','leave','start','complete','interrupt'].includes(input?.action))throw Error('稻田窗口不可用');
    return call(id,input.action,input.requestId);
  });

  async function sync(id) {
    let state;
    try {state=await call(id,'snapshot');}
    catch {
      if(farms.has(id))showBody(id);
      return;
    }
    if(state.openRequestId) {
      const session=open(id,true);
      await session.loaded;
      if(!session.win.isDestroyed())await call(id,'open-ack',state.openRequestId);
    }
    if(state.command || state.inside)open(id,false);
  }
  return {sync};
}

module.exports={registerFarm};
