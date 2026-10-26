const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('frameAPI', {
  stop: () => ipcRenderer.send('stop-from-frame'),
});
