'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  chooseFile: () => ipcRenderer.invoke('choose-file'),
  inspectFile: (filePath) => ipcRenderer.invoke('inspect-file', filePath),
  // Resolve the real filesystem path of a dropped File object.
  pathForFile: (file) => webUtils.getPathForFile(file),
  process: (opts) => ipcRenderer.invoke('process', opts),
  revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
  onUpdateStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
});
