const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capture', {
  getSourceId:    ()         => ipcRenderer.invoke('get-source-id'),
  saveRecording:  (buf, ext) => ipcRenderer.invoke('save-recording', buf, ext),
  reportReady:    ()         => ipcRenderer.send('capture-ready'),
  reportError:    (msg)      => ipcRenderer.send('capture-error', msg),
  onStop: (fn) => { ipcRenderer.on('stop-capture', fn); },
});
