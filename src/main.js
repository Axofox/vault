const { app, BrowserWindow, Tray, nativeImage, ipcMain, clipboard, screen, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Data directory ────────────────────────────────────────────────────────────
const DATA_DIR = path.join(app.getPath('userData'), 'vault-data');
const CLIPS_FILE  = path.join(DATA_DIR, 'clips.json');
const SHOTS_FILE  = path.join(DATA_DIR, 'screenshots.json');
const RECS_FILE   = path.join(DATA_DIR, 'recordings.json');
const PREFS_FILE  = path.join(DATA_DIR, 'prefs.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Sensitive data detection ──────────────────────────────────────────────────
const SENSITIVE_PATTERNS = [
  { regex: /sk-[a-zA-Z0-9_-]{20,}/,          label: 'OpenAI Key'     },
  { regex: /ghp_[a-zA-Z0-9]{36}/,             label: 'GitHub Token'   },
  { regex: /AKIA[0-9A-Z]{16}/,                label: 'AWS Key'        },
  { regex: /Bearer\s+[a-zA-Z0-9\._\-]{20,}/, label: 'Bearer Token'   },
  { regex: /[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}/i, label: 'UUID/Token' },
  { regex: /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,  label: 'Password' },
  { regex: /(?:secret|api[_-]?key)\s*[:=]\s*\S+/i,  label: 'Secret'   },
  { regex: /[a-zA-Z0-9+/]{40,}={0,2}/,        label: 'Base64 Token'  },
];

function detectSensitive(text) {
  for (const { regex, label } of SENSITIVE_PATTERNS) {
    if (regex.test(text)) return label;
  }
  return null;
}

function maskText(text) {
  const visible = text.slice(0, 6);
  return visible + '••••••••••••••••';
}

// ── Prefs ─────────────────────────────────────────────────────────────────────
const DEFAULT_PREFS = {
  accent: '#00FF87',
  retention: '30d',
  autoDetectSensitive: true,
  blurScreenshots: true,
  quality: 'high',
  format: 'mp4',
};

let prefs = {};

function loadPrefs() {
  prefs = { ...DEFAULT_PREFS, ...readJSON(PREFS_FILE, {}) };
}

function savePrefs() {
  writeJSON(PREFS_FILE, prefs);
}

// ── Retention cleanup ─────────────────────────────────────────────────────────
function retentionMs(val) {
  const map = { '1d': 864e5, '7d': 6048e5, '30d': 2592e6, '90d': 7776e6, 'inf': Infinity };
  return map[val] ?? 2592e6;
}

function pruneOld(items) {
  const cutoff = Date.now() - retentionMs(prefs.retention);
  return items.filter(i => i.ts > cutoff);
}

// ── Clipboard monitoring ──────────────────────────────────────────────────────
let lastClip = '';
let clips = [];

function startClipboardWatcher() {
  clips = pruneOld(readJSON(CLIPS_FILE, []));

  setInterval(() => {
    const text = clipboard.readText();
    if (!text || text === lastClip) return;
    lastClip = text;

    const sensitiveLabel = prefs.autoDetectSensitive ? detectSensitive(text) : null;
    const item = {
      id: Date.now().toString(),
      ts: Date.now(),
      raw: sensitiveLabel ? null : text,  // don't store raw sensitive text
      display: sensitiveLabel ? maskText(text) : text,
      sensitive: sensitiveLabel,
      kind: detectKind(text),
    };

    clips.unshift(item);
    clips = pruneOld(clips.slice(0, 500)); // max 500 items
    writeJSON(CLIPS_FILE, clips);
    win?.webContents.send('clips-updated', safeClips());
  }, 500);
}

function detectKind(text) {
  if (/^https?:\/\/\S+$/.test(text.trim())) return 'url';
  try { JSON.parse(text); return 'json'; } catch {}
  if (text.length > 200) return 'long';
  return 'text';
}

function safeClips() {
  return clips.map(c => ({
    id: c.id, ts: c.ts,
    display: c.display,
    sensitive: c.sensitive,
    kind: c.kind,
  }));
}

// ── Tray + Window ─────────────────────────────────────────────────────────────
let tray = null;
let win  = null;

function createTrayIcon() {
  // 16x16 template icon — simple viewfinder corners in black (macOS template = auto light/dark)
  const size = 22;
  const canvas = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 22 22">
    <path fill="black" d="M3 3h5v1.5H4.5V8H3V3zm11 0h5v5h-1.5V4.5H14V3zM3 14h1.5v3.5H8V19H3v-5zm14 3.5H13.5V19H19v-5h-1.5v3.5zM8 8h6v6H8V8z"/>
  </svg>`;
  const img = nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(canvas).toString('base64')
  );
  img.setTemplateImage(true);
  return img;
}

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 580,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('blur', () => {
    if (!win.webContents.isDevToolsOpened()) win.hide();
  });
}

function positionWindow() {
  const trayBounds = tray.getBounds();
  const winBounds  = win.getBounds();
  const display    = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const dBounds    = display.workArea;

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  let y = trayBounds.y < dBounds.height / 2
    ? trayBounds.y + trayBounds.height + 4
    : trayBounds.y - winBounds.height - 4;

  x = Math.max(dBounds.x + 8, Math.min(x, dBounds.x + dBounds.width - winBounds.width - 8));
  win.setPosition(x, y);
}

function toggleWindow() {
  if (win.isVisible()) {
    win.hide();
  } else {
    positionWindow();
    win.show();
    win.focus();
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
function registerIPC() {
  ipcMain.handle('get-clips', () => safeClips());
  ipcMain.handle('copy-clip', (_, id) => {
    const c = clips.find(x => x.id === id);
    if (c?.raw) clipboard.writeText(c.raw);
    else if (c?.display) clipboard.writeText(c.display);
  });
  ipcMain.handle('delete-clip', (_, id) => {
    clips = clips.filter(x => x.id !== id);
    writeJSON(CLIPS_FILE, clips);
    return safeClips();
  });
  ipcMain.handle('get-prefs', () => prefs);
  ipcMain.handle('set-prefs', (_, patch) => {
    prefs = { ...prefs, ...patch };
    savePrefs();
    return prefs;
  });
  ipcMain.handle('get-screenshots', () => pruneOld(readJSON(SHOTS_FILE, [])));
  ipcMain.handle('get-recordings',  () => pruneOld(readJSON(RECS_FILE, [])));
  ipcMain.handle('open-settings', () => {
    win?.webContents.send('navigate', 'settings');
  });
  ipcMain.handle('close-window', () => win?.hide());
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureDataDir();
  loadPrefs();

  app.dock?.hide(); // hide from dock — lives only in menu bar

  tray = new Tray(createTrayIcon());
  tray.setToolTip('Vault');
  tray.on('click', toggleWindow);
  tray.on('right-click', toggleWindow);

  createWindow();
  registerIPC();
  startClipboardWatcher();
});

app.on('window-all-closed', () => {
  // keep running in tray
});
