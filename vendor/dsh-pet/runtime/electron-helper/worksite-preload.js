'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('worksite',{
  snapshot:()=>ipcRenderer.invoke('worksite:snapshot'),
  action:action=>ipcRenderer.invoke('worksite:action',action),
  receipt:receipt=>ipcRenderer.invoke('worksite:receipt',receipt),
  notice:callback=>ipcRenderer.on('worksite:notice',(_event,text)=>callback(text))
});
