'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cookerBridge', {
  request(input) { return ipcRenderer.invoke('pet:rice-cooker', input); },
  layout(layout) { ipcRenderer.send('cooker:layout', layout); },
  pointer() { ipcRenderer.send('cooker:pointer'); },
  focus() { ipcRenderer.send('cooker:focus'); },
  drag(phase, x, y) { ipcRenderer.send('cooker:drag', { phase, x, y }); },
  onOpen(callback) { ipcRenderer.on('cooker:open', () => callback()); },
  onPanelSide(callback) { ipcRenderer.on('cooker:panel-side', (_event, below) => callback(below)); },
});
