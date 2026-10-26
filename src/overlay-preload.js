const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlay', {
  sendSelection: (b) => ipcRenderer.invoke('area-selected', b),
  cancel: () => ipcRenderer.invoke('area-cancel'),
});
