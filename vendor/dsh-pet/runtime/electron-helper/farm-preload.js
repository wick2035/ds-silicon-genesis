'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('farmBridge',{
  action:(action,requestId)=>ipcRenderer.invoke('farm:action',{action,requestId}),
});
