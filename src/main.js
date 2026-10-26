const {
  app, BrowserWindow, Tray, nativeImage,
  ipcMain, clipboard, screen, desktopCapturer, systemPreferences, shell
} = require('electron');
const path = require('path');
const fs   = require('fs');
const zlib = require('zlib');

// ── Data directory ─────────────────────────────────────────────────────────
const DATA_DIR  = path.join(app.getPath('userData'), 'vault-data');
const CLIPS_FILE = path.join(DATA_DIR, 'clips.json');
const SHOTS_FILE = path.join(DATA_DIR, 'screenshots.json');
const RECS_FILE  = path.join(DATA_DIR, 'recordings.json');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const SHOTS_DIR  = path.join(DATA_DIR, 'screenshots');
const RECS_DIR   = path.join(DATA_DIR, 'recordings');

function ensureDataDir() {
  for (const d of [DATA_DIR, SHOTS_DIR, RECS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── Sensitive data detection ───────────────────────────────────────────────
const SENSITIVE_PATTERNS = [
  { regex: /sk-[a-zA-Z0-9_-]{20,}/,           label: 'OpenAI Key'    },
  { regex: /ghp_[a-zA-Z0-9]{36}/,              label: 'GitHub Token'  },
  { regex: /AKIA[0-9A-Z]{16}/,                 label: 'AWS Key'       },
  { regex: /Bearer\s+[a-zA-Z0-9\._\-]{20,}/,  label: 'Bearer Token'  },
  { regex: /[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}/i, label: 'UUID/Token' },
  { regex: /(?:password|passwd|pwd)\s*[:=]\s*\S+/i, label: 'Password' },
  { regex: /(?:secret|api[_-]?key)\s*[:=]\s*\S+/i,  label: 'Secret'  },
  { regex: /[a-zA-Z0-9+/]{40,}={0,2}/,         label: 'Base64 Token' },
];
function detectSensitive(text) {
  for (const { regex, label } of SENSITIVE_PATTERNS) { if (regex.test(text)) return label; }
  return null;
}
function maskText(text) { return text.slice(0, 6) + '••••••••••••••••'; }

// ── Prefs ──────────────────────────────────────────────────────────────────
const DEFAULT_PREFS = {
  accent: '#00FF87', retention: '30d',
  autoDetectSensitive: true, blurScreenshots: true,
  quality: 'high', format: 'mp4',
};
let prefs = {};
function loadPrefs() { prefs = { ...DEFAULT_PREFS, ...readJSON(PREFS_FILE, {}) }; }
function savePrefs() { writeJSON(PREFS_FILE, prefs); }

function retentionMs(val) {
  return { '1d': 864e5, '7d': 6048e5, '30d': 2592e6, '90d': 7776e6, inf: Infinity }[val] ?? 2592e6;
}
function pruneOld(items) {
  const cutoff = Date.now() - retentionMs(prefs.retention);
  return items.filter(i => i.ts > cutoff);
}

// ── Clipboard watcher ──────────────────────────────────────────────────────
let lastClip = '', clips = [];

function detectKind(text) {
  if (/^https?:\/\/\S+$/.test(text.trim())) return 'url';
  try { JSON.parse(text); return 'json'; } catch {}
  return text.length > 200 ? 'long' : 'text';
}
function safeClips() {
  return clips.map(c => ({ id: c.id, ts: c.ts, display: c.display, sensitive: c.sensitive, kind: c.kind }));
}

function startClipboardWatcher() {
  clips = pruneOld(readJSON(CLIPS_FILE, []));
  setInterval(() => {
    const text = clipboard.readText();
    if (!text || text === lastClip) return;
    lastClip = text;
    const sensitiveLabel = prefs.autoDetectSensitive ? detectSensitive(text) : null;
    clips.unshift({
      id: Date.now().toString(), ts: Date.now(),
      raw: sensitiveLabel ? null : text,
      display: sensitiveLabel ? maskText(text) : text,
      sensitive: sensitiveLabel,
      kind: detectKind(text),
    });
    clips = pruneOld(clips.slice(0, 500));
    writeJSON(CLIPS_FILE, clips);
    win?.webContents.send('clips-updated', safeClips());
  }, 500);
}

// ── Tray icon (programmatic PNG) ───────────────────────────────────────────
function createTrayIcon() {
  const W = 16, H = 16;
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const tl = (x < 4 && y < 2) || (x < 2 && y >= 2 && y < 5);
      const tr = (x >= 12 && y < 2) || (x >= 14 && y >= 2 && y < 5);
      const bl = (x < 4 && y >= 14) || (x < 2 && y >= 11 && y < 14);
      const br = (x >= 12 && y >= 14) || (x >= 14 && y >= 11 && y < 14);
      const dot = x >= 7 && x <= 8 && y >= 7 && y <= 8;
      const on = tl || tr || bl || br || dot;
      const off = y * (W * 4 + 1) + 1 + x * 4;
      raw[off] = 0; raw[off+1] = 0; raw[off+2] = 0; raw[off+3] = on ? 255 : 0;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const img = nativeImage.createFromBuffer(png);
  img.setTemplateImage(true);
  return img;
}

// ── Windows ────────────────────────────────────────────────────────────────
let tray = null, win = null, overlayWin = null, captureWin = null;

function createWindow() {
  win = new BrowserWindow({
    width: 380, height: 580,
    show: false, frame: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('blur', () => { if (!win.webContents.isDevToolsFocused() && !recordingActive) win.hide(); });
}

function positionWindow() {
  const tb = tray.getBounds(), wb = win.getBounds();
  const d  = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
  let x = Math.round(tb.x + tb.width / 2 - wb.width / 2);
  let y = tb.y < d.height / 2 ? tb.y + tb.height + 4 : tb.y - wb.height - 4;
  x = Math.max(d.x + 8, Math.min(x, d.x + d.width - wb.width - 8));
  win.setPosition(x, y);
}

function toggleWindow() {
  if (win.isVisible()) { win.hide(); }
  else { positionWindow(); win.show(); win.focus(); }
}

// ── Screenshots ────────────────────────────────────────────────────────────
let screenshots = [];

async function takeScreenshot() {
  // macOS Screen Recording permission check
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      win?.webContents.send('screenshot-error', 'Screen Recording permission required.\nPlease grant Vault access in\nSystem Preferences → Privacy → Screen Recording,\nthen restart Vault.');
      return;
    }
  }
  screenshots = readJSON(SHOTS_FILE, []);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1440, height: 900 },
  });
  if (!sources.length) {
    win?.webContents.send('screenshot-error', 'No screen sources found. Try restarting Vault.');
    return;
  }
  const thumb = sources[0].thumbnail;
  const ts    = Date.now();
  const file  = path.join(SHOTS_DIR, `shot-${ts}.png`);
  fs.writeFileSync(file, thumb.toPNG());

  const item = {
    id: ts.toString(), ts,
    file,
    thumb: thumb.resize({ width: 240 }).toDataURL(),
  };
  screenshots.unshift(item);
  screenshots = pruneOld(screenshots.slice(0, 200));
  writeJSON(SHOTS_FILE, screenshots);
  win?.webContents.send('screenshots-updated', screenshots);
}

// ── Area selection overlay ─────────────────────────────────────────────────
function openOverlay(resolve) {
  const d = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y,
    width: d.bounds.width, height: d.bounds.height,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
    },
  });
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });

  ipcMain.handleOnce('area-selected', (_, bounds) => {
    overlayWin?.close();
    resolve({ ok: true, bounds });
  });
  ipcMain.handleOnce('area-cancel', () => {
    overlayWin?.close();
    resolve({ ok: false });
  });
}

// ── Recording ──────────────────────────────────────────────────────────────
let recordings = [], recordingActive = false;

async function startRecording(bounds) {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  if (!sources.length) return false;
  const sourceId = sources[0].id;

  captureWin = new BrowserWindow({
    width: 1, height: 1, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'capture-preload.js'),
      contextIsolation: true,
    },
  });
  captureWin.loadFile(path.join(__dirname, 'capture.html'));

  ipcMain.handleOnce('get-source-id', () => sourceId);
  ipcMain.handleOnce('save-recording', (_, bytes, ext) => {
    const ts   = Date.now();
    const file = path.join(RECS_DIR, `rec-${ts}.${ext}`);
    fs.writeFileSync(file, Buffer.from(bytes));

    recordings = readJSON(RECS_FILE, []);
    recordings.unshift({ id: ts.toString(), ts, file, ext, bounds });
    recordings = pruneOld(recordings.slice(0, 100));
    writeJSON(RECS_FILE, recordings);
    win?.webContents.send('recordings-updated', recordings.map(safeRec));
    captureWin?.close(); captureWin = null;
    recordingActive = false;
    win?.webContents.send('recording-state', false);
  });
  recordingActive = true;
  win?.webContents.send('recording-state', true);
  return true;
}

function stopRecording() {
  if (!captureWin || !recordingActive) return;
  captureWin.webContents.send('stop-capture');
}

function safeRec(r) {
  return { id: r.id, ts: r.ts, ext: r.ext, bounds: r.bounds, path: r.file, name: path.basename(r.file) };
}

// ── IPC handlers ──────────────────────────────────────────────────────────
function registerIPC() {
  ipcMain.handle('get-clips',       () => safeClips());
  ipcMain.handle('copy-clip',       (_, id) => {
    const c = clips.find(x => x.id === id);
    if (c?.raw) clipboard.writeText(c.raw);
    else if (c?.display) clipboard.writeText(c.display);
  });
  ipcMain.handle('delete-clip', (_, id) => {
    clips = clips.filter(x => x.id !== id);
    writeJSON(CLIPS_FILE, clips);
    return safeClips();
  });
  ipcMain.handle('get-prefs',    () => prefs);
  ipcMain.handle('set-prefs', (_, patch) => {
    prefs = { ...prefs, ...patch }; savePrefs(); return prefs;
  });
  ipcMain.handle('get-screenshots', () => {
    screenshots = pruneOld(readJSON(SHOTS_FILE, []));
    return screenshots;
  });
  ipcMain.handle('get-recordings', () => {
    recordings = pruneOld(readJSON(RECS_FILE, []));
    return recordings.map(safeRec);
  });
  ipcMain.handle('take-screenshot', async () => {
    win?.hide();
    await new Promise(r => setTimeout(r, 150)); // brief pause so panel disappears
    await takeScreenshot();
    win?.show(); win?.focus();
  });
  ipcMain.handle('start-area-select', () => {
    win?.hide();
    return new Promise(resolve => openOverlay(resolve));
  });
  ipcMain.handle('start-recording', async (_, bounds) => {
    const result = await startRecording(bounds);
    // Show the panel again so the Stop button is accessible during recording
    win?.show(); win?.focus();
    return result;
  });
  ipcMain.handle('stop-recording', () => stopRecording());
  ipcMain.handle('close-window', () => win?.hide());
}

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureDataDir();
  loadPrefs();
  app.dock?.hide();

  tray = new Tray(createTrayIcon());
  tray.setToolTip('Vault');
  tray.on('click', toggleWindow);
  tray.on('right-click', toggleWindow);

  createWindow();
  registerIPC();
  startClipboardWatcher();
});

app.on('window-all-closed', () => {});
