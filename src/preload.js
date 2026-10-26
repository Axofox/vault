const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  // Clipboard
  getClips:    ()     => ipcRenderer.invoke('get-clips'),
  copyClip:    (id)   => ipcRenderer.invoke('copy-clip', id),
  deleteClip:  (id)   => ipcRenderer.invoke('delete-clip', id),
  onClipsUpdated: (fn) => {
    const handler = (_, data) => fn(data);
    ipcRenderer.on('clips-updated', handler);
    return () => ipcRenderer.removeListener('clips-updated', handler);
  },

  // Screenshots / Recordings
  getScreenshots: () => ipcRenderer.invoke('get-screenshots'),
  getRecordings:  () => ipcRenderer.invoke('get-recordings'),

  // Prefs
  getPrefs:  ()      => ipcRenderer.invoke('get-prefs'),
  setPrefs:  (patch) => ipcRenderer.invoke('set-prefs', patch),

  // Navigation
  onNavigate: (fn) => {
    const handler = (_, page) => fn(page);
    ipcRenderer.on('navigate', handler);
    return () => ipcRenderer.removeListener('navigate', handler);
  },
  closeWindow: () => ipcRenderer.invoke('close-window'),
});
