const {
  app, BrowserWindow, Tray, nativeImage,
  ipcMain, clipboard, screen, desktopCapturer, dialog
} = require('electron');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
const fs   = require('fs');
const zlib = require('zlib');
const { createClipboardImageCapture } = require('./clipboard-image');

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

const clipboardImage = createClipboardImageCapture({
  clipboard, dir: SHOTS_DIR, onSaved: processNewScreenshot,
});

function startClipboardWatcher() {
  clips = pruneOld(readJSON(CLIPS_FILE, []));
  setInterval(() => {
    clipboardImage.capture();
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
let tray = null, win = null, overlayWin = null, captureWin = null, frameWin = null;

function openRecordingFrame(bounds) {
  if (frameWin) { try { frameWin.close(); } catch {} frameWin = null; }
  const STOP_H = 40, PAD = 3;
  frameWin = new BrowserWindow({
    x: Math.round(bounds.x) - PAD,
    y: Math.round(bounds.y) - STOP_H - PAD,
    width: Math.round(bounds.width) + PAD * 2,
    height: Math.round(bounds.height) + STOP_H + PAD * 2,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'frame-preload.js'),
      contextIsolation: true,
    },
  });
  frameWin.loadFile(path.join(__dirname, 'recording-frame.html'));
  frameWin.on('closed', () => { frameWin = null; });
}

function closeRecordingFrame() {
  try { frameWin?.close(); } catch {}
  frameWin = null;
}

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

function getScreenshotDirs() {
  const dirs = new Set([
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Pictures', 'Screenshots'),
  ]);
  if (process.platform === 'darwin') {
    try {
      const loc = execSync('defaults read com.apple.screencapture location 2>/dev/null', { encoding: 'utf8' }).trim();
      if (loc) dirs.add(loc.startsWith('~') ? path.join(os.homedir(), loc.slice(2)) : loc);
    } catch {}
  }
  return [...dirs].filter(d => { try { return fs.existsSync(d); } catch { return false; } });
}

async function processNewScreenshot(filepath) {
  await new Promise(r => setTimeout(r, 800));
  if (!fs.existsSync(filepath)) return;
  const img = nativeImage.createFromPath(filepath);
  if (img.isEmpty()) return;
  const id   = Date.now();
  // Show when the screenshot was taken (file creation), not when the app noticed it
  let ts = id;
  try { const st = fs.statSync(filepath); ts = Math.round(st.birthtimeMs || st.mtimeMs) || id; } catch {}
  const thumb = img.resize({ width: 240 });
  const item  = { id: id.toString(), ts, file: filepath, thumb: thumb.toDataURL() };
  screenshots = readJSON(SHOTS_FILE, []);
  screenshots.unshift(item);
  screenshots = pruneOld(screenshots.slice(0, 200));
  writeJSON(SHOTS_FILE, screenshots);
  win?.webContents.send('screenshots-updated', screenshots);
}

const watchedDirs = new Set();

function watchDir(dir) {
  if (!dir || watchedDirs.has(dir)) return;
  try { if (!fs.existsSync(dir)) return; } catch { return; }
  watchedDirs.add(dir);
  const EXTS = ['.png', '.jpg', '.jpeg', '.heic', '.tiff', '.bmp', '.webp'];
  const TWO_MIN = 2 * 60 * 1000;
  const seen = new Set();

  // On startup: process anything created in the last 2 minutes
  try {
    for (const filename of fs.readdirSync(dir)) {
      seen.add(filename);
      if (!EXTS.some(e => filename.toLowerCase().endsWith(e))) continue;
      try {
        const filepath = path.join(dir, filename);
        const stat = fs.statSync(filepath);
        if (Date.now() - stat.mtimeMs < TWO_MIN) processNewScreenshot(filepath);
      } catch {}
    }
  } catch {}

  // Use fs.watch for instant OS-level notifications (macOS FSEvents)
  try {
    fs.watch(dir, (eventType, filename) => {
      if (!filename || seen.has(filename)) return;
      seen.add(filename);
      if (!EXTS.some(e => filename.toLowerCase().endsWith(e))) return;
      const filepath = path.join(dir, filename);
      processNewScreenshot(filepath);
    });
  } catch {}
}

function watchScreenshotDir() {
  const dirs = getScreenshotDirs();
  if (prefs.screenshotDir) dirs.push(prefs.screenshotDir);
  for (const dir of dirs) watchDir(dir);

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

  ipcMain.removeHandler('area-selected');
  ipcMain.removeHandler('area-cancel');
  ipcMain.handleOnce('area-selected', (_, b) => {
    overlayWin?.close();
    // overlay sends {x,y,w,h} — normalise to {x,y,width,height}
    const bounds = { x: b.x, y: b.y, width: b.w, height: b.h };
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
  if (!sources.length) return { noPermission: true };
  const sourceId = sources[0].id;

  const d = screen.getPrimaryDisplay();
  captureWin = new BrowserWindow({
    x: d.bounds.x + d.bounds.width + 100,
    y: d.bounds.y,
    width: 1, height: 1,
    show: true, frame: false, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'capture-preload.js'),
      contextIsolation: true,
    },
  });
  captureWin.loadFile(path.join(__dirname, 'capture.html'));

  ipcMain.removeHandler('get-source-id');
  ipcMain.removeHandler('save-recording');
  ipcMain.handleOnce('get-source-id', () => sourceId);
  const startedAt = Date.now();
  ipcMain.handleOnce('save-recording', (_, bytes, ext) => {
    const ts   = Date.now();
    const file = path.join(RECS_DIR, `rec-${ts}.${ext}`);
    fs.writeFileSync(file, Buffer.from(bytes));

    recordings = readJSON(RECS_FILE, []);
    recordings.unshift({ id: ts.toString(), ts: startedAt, file, ext, bounds });
    recordings = pruneOld(recordings.slice(0, 100));
    writeJSON(RECS_FILE, recordings);
    win?.webContents.send('recordings-updated', recordings.map(safeRec));
    captureWin?.close(); captureWin = null;
    recordingActive = false;
    closeRecordingFrame();
    win?.webContents.send('recording-state', false);
    // Show vault panel on recordings tab after recording finishes
    if (win) { positionWindow(); win.show(); win.focus(); }
  });
  recordingActive = true;
  win?.webContents.send('recording-state', true);
  openRecordingFrame(bounds);
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

  ipcMain.handle('start-area-select', () => {
    win?.hide();
    return new Promise(resolve => openOverlay(r => resolve(r.ok ? r.bounds : null)));
  });
  ipcMain.handle('start-recording', async (_, bounds) => {
    const result = await startRecording(bounds);
    return result;
  });
  ipcMain.handle('stop-recording', () => stopRecording());
  ipcMain.on('stop-from-frame', () => stopRecording());
  ipcMain.handle('close-window', () => win?.hide());
  ipcMain.on('capture-ready', () => {
    // capture started successfully — nothing to do
  });
  ipcMain.on('capture-error', (_, msg) => {
    recordingActive = false;
    closeRecordingFrame();
    captureWin?.close(); captureWin = null;
    win?.webContents.send('recording-state', false);
    win?.webContents.send('recording-error', msg);
    positionWindow(); win?.show(); win?.focus();
  });
  ipcMain.handle('copy-screenshot', (_, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return false;
    try {
      const img = nativeImage.createFromPath(filePath);
      if (img.isEmpty()) return false;
      clipboardImage.markSeen(img);
      clipboard.writeImage(img);
      return true;
    } catch { return false; }
  });
  // Put the video file itself on the clipboard so it can be pasted into Finder, Slack, mail...
  ipcMain.handle('copy-recording', (_, filePath) => {
    if (!filePath || !fs.existsSync(filePath) || !filePath.startsWith(RECS_DIR)) return false;
    try {
      const esc = filePath.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      clipboard.writeBuffer('public.file-url', Buffer.from(require('url').pathToFileURL(filePath).href));
      clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>' +
        esc + '</string></array></plist>'));
      return true;
    } catch { return false; }
  });
  ipcMain.handle('choose-screenshot-dir', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose screenshot folder to watch',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const dir = result.filePaths[0];
    prefs = { ...prefs, screenshotDir: dir };
    savePrefs();
    watchDir(dir);  // start watching immediately, no restart needed
    return dir;
  });
    ipcMain.handle('check-screen-permission', () => {
    if (process.platform !== 'darwin') return 'granted';
    const { systemPreferences } = require('electron');
    return systemPreferences.getMediaAccessStatus('screen');
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureDataDir();
  loadPrefs();
  watchScreenshotDir();

  // Show in both dock and menu bar
  // Dock click opens/focuses the panel
  if (app.dock) {
    app.dock.show();
    app.on('activate', () => {
      if (!win?.isVisible()) { positionWindow(); win.show(); win.focus(); }
      else win.focus();
    });
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip('Vault');
  tray.on('click', toggleWindow);
  tray.on('right-click', toggleWindow);

  createWindow();
  registerIPC();
  startClipboardWatcher();
});

app.on('window-all-closed', () => {});
