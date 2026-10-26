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

  // Screenshots
  getScreenshots:      ()      => ipcRenderer.invoke('get-screenshots'),
  onScreenshotsUpdated: (fn)  => {
    const handler = (_, data) => fn(data);
    ipcRenderer.on('screenshots-updated', handler);
    return () => ipcRenderer.removeListener('screenshots-updated', handler);
  },

  // Recordings
  getRecordings:      ()      => ipcRenderer.invoke('get-recordings'),
  startAreaSelect:    ()      => ipcRenderer.invoke('start-area-select'),
  startRecording:     (bounds) => ipcRenderer.invoke('start-recording', bounds),
  stopRecording:      ()      => ipcRenderer.invoke('stop-recording'),
  onRecordingsUpdated: (fn)  => {
    const handler = (_, data) => fn(data);
    ipcRenderer.on('recordings-updated', handler);
    return () => ipcRenderer.removeListener('recordings-updated', handler);
  },
  onRecordingState: (fn) => {
    const handler = (_, state) => fn(state);
    ipcRenderer.on('recording-state', handler);
    return () => ipcRenderer.removeListener('recording-state', handler);
  },

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
