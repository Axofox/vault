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

function esc(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Apply accent across CSS vars ──────────────────────────────────────────────
function applyAccent(color) {
  document.documentElement.style.setProperty('--ac', color);
}

// ── Render clipboard ──────────────────────────────────────────────────────────
function renderClips() {
  const list = document.getElementById('clip-list');
  const q = state.search.toLowerCase();

  let items = state.clips;
  if (q) items = items.filter(c => c.display.toLowerCase().includes(q) || (c.sensitive||'').toLowerCase().includes(q));

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
    return `<div class="clip-item${isSens ? ' sens' : ''}" data-id="${esc(c.id)}">
      <div class="clip-meta">
        <div class="clip-kind ${kindClass}">
          ${isSens ? `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 1a2 2 0 0 0-2 2v1H2v5h6V4H7V3a2 2 0 0 0-2-2zm0 1a1 1 0 0 1 1 1v1H4V3a1 1 0 0 1 1-1zm0 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" fill="currentColor"/></svg>` : ''}
          ${esc(kindLabel)}
        </div>
        <div class="${textClass}">${esc(c.display.slice(0, 80))}${c.display.length > 80 ? '…' : ''}</div>
        <div class="clip-time">${fmt(c.ts)}</div>
      </div>
      <div class="clip-actions">
        ${isSens ? `<button class="clip-action-btn reveal-btn" data-id="${esc(c.id)}">Reveal</button>` : ''}
        <button class="clip-action-btn copy-btn" data-id="${esc(c.id)}">Copy</button>
      </div>
    </div>`;
  }).join('');
}

// ── Render settings ───────────────────────────────────────────────────────────
function renderSettings() {
  const p = state.prefs;
  applyAccent(p.accent || '#00FF87');

  // Swatches
  document.querySelectorAll('.swatch').forEach(el => {
    el.classList.toggle('sel', el.dataset.color === p.accent);
  });

  // Retention
  document.querySelectorAll('#retention-seg .seg-opt').forEach(el => {
    el.classList.toggle('on', el.dataset.val === p.retention);
  });

  // Toggles
  document.getElementById('toggle-sens1').classList.toggle('on', !!p.autoDetectSensitive);
  document.getElementById('toggle-sens2').classList.toggle('on', !!p.blurScreenshots);

  // Chips
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

  // Clip list delegation
  document.getElementById('clip-list').addEventListener('click', async e => {
    const copyBtn = e.target.closest('.copy-btn');
    const revealBtn = e.target.closest('.reveal-btn');
    if (copyBtn) {
      await api.copyClip(copyBtn.dataset.id);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
    }
    if (revealBtn) {
      // TODO: reveal flow (confirm re-copy)
      const item = state.clips.find(c => c.id === revealBtn.dataset.id);
      if (item) alert('Sensitive item — copy from the Copy button to use it.');
    }
  });

  // Record button
  document.getElementById('btn-record').addEventListener('click', () => {
    const btn = document.getElementById('btn-record');
    const dot = document.getElementById('rec-dot');
    const lbl = document.getElementById('rec-label');
    if (btn.classList.contains('recording')) {
      btn.classList.remove('recording');
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="currentColor"/></svg> Record area`;
      dot.classList.remove('live');
      lbl.textContent = 'Ready';
    } else {
      btn.classList.add('recording');
      btn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor"/></svg> Stop`;
      dot.classList.add('live');
      lbl.textContent = 'Recording…';
    }
  });

  // ── Settings events ──
  // Swatches
  document.getElementById('swatches').addEventListener('click', async e => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    state.prefs = await api.setPrefs({ accent: sw.dataset.color });
    renderSettings();
  });

  // Retention
  document.getElementById('retention-seg').addEventListener('click', async e => {
    const opt = e.target.closest('.seg-opt');
    if (!opt) return;
    state.prefs = await api.setPrefs({ retention: opt.dataset.val });
    renderSettings();
  });

  // Toggles
  document.getElementById('toggle-sens1').addEventListener('click', async () => {
    state.prefs = await api.setPrefs({ autoDetectSensitive: !state.prefs.autoDetectSensitive });
    renderSettings();
  });
  document.getElementById('toggle-sens2').addEventListener('click', async () => {
    state.prefs = await api.setPrefs({ blurScreenshots: !state.prefs.blurScreenshots });
    renderSettings();
  });

  // Chips
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

  // Reset
  document.getElementById('btn-reset').addEventListener('click', async () => {
    state.prefs = await api.setPrefs({
      accent: '#00FF87', retention: '30d',
      autoDetectSensitive: true, blurScreenshots: true,
      quality: 'high', format: 'mp4',
    });
    renderSettings();
  });

  // IPC: live clip updates
  api.onClipsUpdated(clips => {
    state.clips = clips;
    renderClips();
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
  renderSettings(); // preload settings state
  bindEvents();
}

init();
