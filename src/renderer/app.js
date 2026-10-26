/* ── Vault renderer ── */

const api = window.vault;

// ── State ──────────────────────────────────────────────────────────────────────
let state = {
  tab: 'clip',
  clips: [],
  screenshots: [],
  recordings: [],
  prefs: {},
  search: '',
  isRecording: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(ms) {
  const d = new Date(ms);
  const now = new Date();
  const diff = now - d;
  if (diff < 60e3) return 'just now';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + 'm ago';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + 'h ago';
  return d.toLocaleDateString();
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Apply accent across CSS vars ──────────────────────────────────────────────
function applyAccent(color) {
  document.documentElement.style.setProperty('--ac', color);
}

// ── Flash feedback on a row ──────────────────────────────────────────────────
function flashRow(el, msg) {
  const original = el.dataset.flashOrig ?? el.querySelector('.clip-time')?.textContent ?? '';
  const timeEl = el.querySelector('.clip-time');
  if (!timeEl) return;
  el.dataset.flashOrig = original;
  timeEl.textContent = msg;
  timeEl.style.color = 'var(--ac)';
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => {
    timeEl.textContent = original;
    timeEl.style.color = '';
    delete el.dataset.flashOrig;
  }, 1200);
}

// ── Render clipboard ──────────────────────────────────────────────────────────
// ── Toast helper ──────────────────────────────────────────────────────────────
function showToast(msg, isError = false) {
  let toast = document.getElementById('vault-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'vault-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = 'vault-toast' + (isError ? ' vault-toast-error' : '');
  toast.removeAttribute('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.setAttribute('hidden', ''), 4000);
}

function renderClips() {
  const list = document.getElementById('clip-list');
  const q = state.search.toLowerCase();

  let items = state.clips;
  if (q) items = items.filter(c =>
    c.display.toLowerCase().includes(q) ||
    (c.sensitive || '').toLowerCase().includes(q)
  );

  document.getElementById('badge-clip').textContent = state.clips.length;

  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><p>${q ? 'No matches.' : 'Nothing copied yet.'}</p>${q ? '' : '<p class="sub">Copy anything and it\'ll appear here.</p>'}</div>`;
    return;
  }

  list.innerHTML = items.map(c => {
    const isSens = !!c.sensitive;
    const kindLabel = isSens ? c.sensitive : c.kind.toUpperCase();
    const kindClass = isSens ? 'sens' : c.kind;
    const textClass = isSens ? 'clip-text masked' : 'clip-text';
    return `<div class="clip-item${isSens ? ' sens' : ''}" data-id="${esc(c.id)}" role="button" tabindex="0" title="Click to copy">
      <div class="clip-meta">
        <div class="clip-kind ${kindClass}">
          ${isSens ? `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 1a2 2 0 0 0-2 2v1H2v5h6V4H7V3a2 2 0 0 0-2-2zm0 1a1 1 0 0 1 1 1v1H4V3a1 1 0 0 1 1-1zm0 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" fill="currentColor"/></svg>` : ''}
          ${esc(kindLabel)}
        </div>
        <div class="${textClass}">${esc(c.display.slice(0, 80))}${c.display.length > 80 ? '…' : ''}</div>
        <div class="clip-time">${fmt(c.ts)}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Render screenshots ────────────────────────────────────────────────────────
function renderScreenshots() {
  const grid = document.getElementById('shot-grid');
  const items = state.screenshots;
  document.getElementById('badge-shots').textContent = items.length;

  if (!items.length) {
    grid.innerHTML = `<div class="empty-state"><p>No screenshots yet.</p><p class="sub">Take a screenshot with your Mac shortcuts — it'll appear here automatically.</p></div>`;
    return;
  }

  grid.innerHTML = items.map(s => {
    const thumb = s.thumb || s.thumbnail || '';
    return `<div class="shot-item" data-path="${esc(s.path || '')}" title="${fmt(s.ts)}">
      ${thumb
        ? `<img class="shot-thumb" src="${esc(thumb)}" alt="Screenshot">`
        : `<div class="shot-thumb-placeholder"></div>`}
      <div class="shot-meta">${fmt(s.ts)}</div>
    </div>`;
  }).join('');
}

// ── Render recordings ─────────────────────────────────────────────────────────
function renderRecordings() {
  const list = document.getElementById('rec-list');
  const items = state.recordings;
  document.getElementById('badge-recs').textContent = items.length;

  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><p>No recordings yet.</p><p class="sub">Use the record button below to capture an area.</p></div>`;
    return;
  }

  list.innerHTML = items.map(r => {
    const dur = r.duration ? fmtDuration(r.duration) : '';
    const name = (r.path || '').split('/').pop() || 'recording';
    return `<div class="rec-item" data-path="${esc(r.path || '')}">
      <div class="rec-item-icon">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="1" y="3" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.4"/>
          <circle cx="14.5" cy="7" r="2.5" fill="#FF4444" opacity="0.85"/>
          <path d="M5 9l3-2v4L5 9z" fill="currentColor"/>
        </svg>
      </div>
      <div class="rec-item-body">
        <div class="rec-item-name">${esc(name)}</div>
        <div class="rec-item-meta">${fmt(r.ts)}${dur ? ' · ' + dur : ''}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Render settings ───────────────────────────────────────────────────────────
function renderSettings() {
  const p = state.prefs;
  applyAccent(p.accent || '#00FF87');

  document.querySelectorAll('.swatch').forEach(el => {
    el.classList.toggle('sel', el.dataset.color === p.accent);
  });
  document.querySelectorAll('#retention-seg .seg-opt').forEach(el => {
    el.classList.toggle('on', el.dataset.val === p.retention);
  });
  document.getElementById('toggle-sens1').classList.toggle('on', !!p.autoDetectSensitive);
  document.getElementById('toggle-sens2').classList.toggle('on', !!p.blurScreenshots);
  document.querySelectorAll('#quality-chips .chip').forEach(el => {
    el.classList.toggle('on', el.dataset.val === p.quality);
  });
  document.querySelectorAll('#format-chips .chip').forEach(el => {
    el.classList.toggle('on', el.dataset.val === p.format);
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('on', el.dataset.tab === tab);
    el.setAttribute('aria-selected', el.dataset.tab === tab);
  });
  document.getElementById('pane-clip').hidden  = tab !== 'clip';
  document.getElementById('pane-shots').hidden = tab !== 'shots';
  document.getElementById('pane-recs').hidden  = tab !== 'recs';
  document.getElementById('pane-clip').classList.toggle('active', tab === 'clip');
}

// ── Navigation (main ↔ settings) ──────────────────────────────────────────────
function showPage(page) {
  document.getElementById('app-main').hidden     = page === 'settings';
  document.getElementById('app-settings').hidden = page !== 'settings';
  if (page === 'settings') renderSettings();
}

// ── Recording UI state ────────────────────────────────────────────────────────
function setRecordingUI(active) {
  const btn = document.getElementById('btn-record');
  const dot = document.getElementById('rec-dot');
  const lbl = document.getElementById('rec-label');
  state.isRecording = active;
  if (active) {
    btn.classList.add('recording');
    btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor"/></svg> Stop`;
    dot.classList.add('live');
    lbl.textContent = 'Recording…';
  } else {
    btn.classList.remove('recording');
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="currentColor"/></svg> Record area`;
    dot.classList.remove('live');
    lbl.textContent = 'Ready';
  }
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  // Tab clicks
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Search toggle
  document.getElementById('btn-search').addEventListener('click', () => {
    const bar = document.getElementById('search-bar');
    bar.hidden = !bar.hidden;
    if (!bar.hidden) document.getElementById('search-input').focus();
    else { state.search = ''; document.getElementById('search-input').value = ''; renderClips(); }
  });
  document.getElementById('btn-search-close').addEventListener('click', () => {
    document.getElementById('search-bar').hidden = true;
    state.search = ''; document.getElementById('search-input').value = '';
    renderClips();
  });
  document.getElementById('search-input').addEventListener('input', e => {
    state.search = e.target.value;
    renderClips();
  });

  // Settings nav
  document.getElementById('btn-settings').addEventListener('click', () => showPage('settings'));
  document.getElementById('btn-back').addEventListener('click', () => showPage('main'));

  // ── Clip list: whole-row click to copy ──────────────────────────────────────
  document.getElementById('clip-list').addEventListener('click', async e => {
    const row = e.target.closest('.clip-item');
    if (!row) return;
    await api.copyClip(row.dataset.id);
    flashRow(row, '✓ Copied');
  });
  document.getElementById('clip-list').addEventListener('keydown', async e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.clip-item');
    if (!row) return;
    e.preventDefault();
    await api.copyClip(row.dataset.id);
    flashRow(row, '✓ Copied');
  });

  // ── Screenshot grid: click to copy to clipboard ──────────────────────────────
  document.getElementById('shot-grid').addEventListener('click', async e => {
    const item = e.target.closest('.shot-item');
    if (!item || !item.dataset.path) return;
    const ok = await api.copyScreenshot(item.dataset.path);
    showToast(ok ? 'Screenshot copied to clipboard' : 'Could not copy screenshot', !ok);
  });

  // ── Record button ────────────────────────────────────────────────────────────
  document.getElementById('btn-record').addEventListener('click', async () => {
    if (state.isRecording) {
      // Stop recording
      await api.stopRecording();
      setRecordingUI(false);
    } else {
      // Start area selection → recording
      const btn = document.getElementById('btn-record');
      btn.disabled = true;
      try {
        const perm = await api.checkScreenPermission();
        if (perm !== 'granted') {
          showToast('Screen Recording permission needed.\nGo to System Settings → Privacy → Screen Recording and enable Vault.', true);
          btn.disabled = false;
          return;
        }
        const bounds = await api.startAreaSelect();
        if (bounds) {
          await api.startRecording(bounds);
          setRecordingUI(true);
        }
      } catch (err) {
        console.error('Area select/record error:', err);
      } finally {
        btn.disabled = false;
      }
    }
  });

  // ── Settings events ──
  document.getElementById('swatches').addEventListener('click', async e => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    state.prefs = await api.setPrefs({ accent: sw.dataset.color });
    renderSettings();
  });

  document.getElementById('retention-seg').addEventListener('click', async e => {
    const opt = e.target.closest('.seg-opt');
    if (!opt) return;
    state.prefs = await api.setPrefs({ retention: opt.dataset.val });
    renderSettings();
  });

  document.getElementById('toggle-sens1').addEventListener('click', async () => {
    state.prefs = await api.setPrefs({ autoDetectSensitive: !state.prefs.autoDetectSensitive });
    renderSettings();
  });
  document.getElementById('toggle-sens2').addEventListener('click', async () => {
    state.prefs = await api.setPrefs({ blurScreenshots: !state.prefs.blurScreenshots });
    renderSettings();
  });

  document.getElementById('quality-chips').addEventListener('click', async e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.prefs = await api.setPrefs({ quality: chip.dataset.val });
    renderSettings();
  });
  document.getElementById('format-chips').addEventListener('click', async e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.prefs = await api.setPrefs({ format: chip.dataset.val });
    renderSettings();
  });

  document.getElementById('btn-reset').addEventListener('click', async () => {
    state.prefs = await api.setPrefs({
      accent: '#00FF87', retention: '30d',
      autoDetectSensitive: true, blurScreenshots: true,
      quality: 'high', format: 'mp4',
    });
    renderSettings();
  });

  // ── IPC live updates ────────────────────────────────────────────────────────
  api.onClipsUpdated(clips => {
    state.clips = clips;
    renderClips();
  });

  api.onScreenshotsUpdated(shots => {
    state.screenshots = shots;
    renderScreenshots();
    document.getElementById('badge-shots').textContent = shots.length;
  });

  api.onRecordingsUpdated(recs => {
    state.recordings = recs;
    renderRecordings();
    document.getElementById('badge-recs').textContent = recs.length;
    // Auto-stop recording UI when a new recording lands
    setRecordingUI(false);
    // Switch to recordings tab
    if (state.tab !== 'recs') switchTab('recs');
  });

  api.onRecordingState(active => {
    setRecordingUI(!!active);
  });


  // IPC: navigate (from main process)
  api.onNavigate(page => showPage(page));
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  [state.clips, state.screenshots, state.recordings, state.prefs] = await Promise.all([
    api.getClips(), api.getScreenshots(), api.getRecordings(), api.getPrefs(),
  ]);

  applyAccent(state.prefs.accent || '#00FF87');
  renderClips();
  renderScreenshots();
  renderRecordings();
  renderSettings();
  bindEvents();
}

init();
