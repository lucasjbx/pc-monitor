'use strict';

// ── Stato ────────────────────────────────────────────────────────────────────
let pcs             = [];
let positions       = {};
let selectedHost    = null;
let wolStatus       = {};     // hostname → null | 'sending' | 'sent' | 'error'
let shutdownStatus  = {};     // hostname → null | 'confirm' | 'sending' | 'ok' | 'error'
let fetching        = false;

// Stato editor
let editorPos            = {};
let editorSelected       = null;
let editingMode          = false;
let _drag                = null;   // { hostname, el } durante il trascinamento di un marker sulla mappa
let _sidebarDrag         = null;   // { hostname, ghostEl, startX, startY, moved } durante drag dalla lista
let _editorClickHandler  = null;   // listener click-to-place, aggiunto/rimosso con openEditor/closeEditor

// Stato impostazioni
let settingsConfig      = {};          // copia locale della config durante editing
let settingsEditIdx     = null;        // indice PC in modifica (-1 = nuovo)
let settingsSelectedPcs = new Set();   // hostname selezionati nella tabella impostazioni

// Stato zoom mappa
let zoom = 1.0;
let panX = 0;
let panY = 0;
let _pan = null;   // { startX, startY, startPanX, startPanY }

// Stato zoom editor (indipendente dalla mappa normale)
let editorZoom  = 1.0;
let editorPanX  = 0;
let editorPanY  = 0;
let _editorPan  = null;   // { startX, startY, startPanX, startPanY }
let editorSearchQuery = '';

// Stato pannello PC list
let selectedPCs   = new Set();
let listCollapsed = localStorage.getItem('pcListCollapsed') === '1';
let listSortKey   = localStorage.getItem('pcListSort')    || 'hostname';
let listSortDir   = localStorage.getItem('pcListSortDir') || 'asc';

// Stato vista (grid / map).
// Se l'utente ha già scelto manualmente → rispetta la sua preferenza (localStorage).
// Altrimenti: mappa se ci sono posizioni configurate, griglia se no.
// Il valore viene raffinato in initViewMode() dopo il caricamento delle posizioni.
let viewMode = localStorage.getItem('viewMode') || null;

// Stato autenticazione
let authToken = localStorage.getItem('pcMonitorToken') || '';

// ── Auth ──────────────────────────────────────────────────────────────────────
/**
 * Wrapper fetch che aggiunge X-Api-Key e gestisce automaticamente 401 → login overlay.
 */
async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authToken) headers['X-Api-Key'] = authToken;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    authToken = '';
    localStorage.removeItem('pcMonitorToken');
    showLoginOverlay();
    throw new Error('401');
  }
  return res;
}

async function initAuth() {
  try {
    const res  = await fetch('/api/auth/status');
    const data = await res.json();
    if (!data.auth_enabled) return true;   // nessuna auth richiesta
  } catch { return true; }                  // se non raggiunge l'endpoint, procede

  if (authToken) {
    try {
      const vres = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token: authToken }),
      });
      if (vres.ok) return true;   // token valido
    } catch {}
    // token non valido o scaduto — cancella e mostra login
    authToken = '';
    localStorage.removeItem('pcMonitorToken');
  }
  showLoginOverlay();
  return false;
}

function showLoginOverlay() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('login-token').value = '';
  document.getElementById('login-error').classList.add('hidden');
  setTimeout(() => document.getElementById('login-token').focus(), 50);
}

function hideLoginOverlay() {
  document.getElementById('login-overlay').classList.add('hidden');
}

async function attemptLogin() {
  const token = document.getElementById('login-token').value.trim();
  if (!token) return;
  const btn = document.getElementById('btn-login');
  btn.textContent = '⟳ Verifica…';
  btn.disabled    = true;
  document.getElementById('login-error').classList.add('hidden');
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token }),
    });
    if (res.ok) {
      authToken = token;
      localStorage.setItem('pcMonitorToken', token);
      hideLoginOverlay();
      startApp();
    } else {
      document.getElementById('login-error').classList.remove('hidden');
    }
  } catch {
    document.getElementById('login-error').textContent = 'Errore di connessione';
    document.getElementById('login-error').classList.remove('hidden');
  } finally {
    btn.textContent = 'Accedi';
    btn.disabled    = false;
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Login overlay
  document.getElementById('btn-login').addEventListener('click', attemptLogin);
  document.getElementById('btn-toggle-login-pass').addEventListener('click', () => {
    const inp = document.getElementById('login-token');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('login-token').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin();
  });

  // Header
  document.getElementById('btn-refresh').addEventListener('click', () => loadPcs(true));
  document.getElementById('btn-editor').addEventListener('click', openEditor);
  document.getElementById('btn-configure').addEventListener('click', openEditor);
  document.getElementById('btn-settings').addEventListener('click', openSettings);

  // Panel PC
  document.getElementById('btn-panel-close').addEventListener('click', closePanel);

  // Editor posizioni (full-screen)
  document.getElementById('btn-editor-cancel').addEventListener('click', closeEditor);
  document.getElementById('btn-editor-cancel-2').addEventListener('click', closeEditor);
  document.getElementById('btn-editor-save').addEventListener('click', savePositions);
  document.getElementById('btn-editor-save-2').addEventListener('click', savePositions);
  document.getElementById('editor-search').addEventListener('input', e => {
    editorSearchQuery = e.target.value.toLowerCase();
    renderEditorSidebar();
  });
  document.getElementById('editor-pc-list').addEventListener('click', handleEditorListClick);
  document.getElementById('editor-pc-list').addEventListener('mousedown', handleEditorListMousedown);

  // Zoom editor
  document.getElementById('btn-editor-zoom-in').addEventListener('click',    () => changeEditorZoom(1.25));
  document.getElementById('btn-editor-zoom-out').addEventListener('click',   () => changeEditorZoom(0.8));
  document.getElementById('btn-editor-zoom-reset').addEventListener('click', resetEditorZoom);

  document.getElementById('editor-floorplan-scaler').addEventListener('wheel', e => {
    e.preventDefault();
    const factor  = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.5, Math.min(4, editorZoom * factor));
    const wrapper = document.getElementById('editor-floorplan-wrapper');
    const rect    = wrapper.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const px = (mx - editorPanX) / editorZoom;
    const py = (my - editorPanY) / editorZoom;
    editorPanX = mx - px * newZoom;
    editorPanY = my - py * newZoom;
    editorZoom = newZoom;
    applyEditorTransform();
  }, { passive: false });

  // Pan editor — drag sulla piantina editor (mousedown+move=pan, click=piazza PC)
  document.getElementById('editor-floorplan-wrapper').addEventListener('mousedown', e => {
    if (e.target.closest('.editor-mk') || e.target.closest('.zoom-btn') || e.target.closest('.zoom-badge')) return;
    e.preventDefault();
    const edScaler = document.getElementById('editor-floorplan-scaler');
    _editorPan = { startX: e.clientX, startY: e.clientY, startPanX: editorPanX, startPanY: editorPanY };
    edScaler.classList.add('panning');
  });

  // Escape chiude l'editor
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && editingMode) closeEditor();
  });

  // Drag editor + pan mappa — mousemove/mouseup globali
  document.addEventListener('mousemove', e => {
    if (_sidebarDrag) {
      // Drag dalla lista sidebar: mostra ghost dopo 5px di movimento
      const dx = e.clientX - _sidebarDrag.startX;
      const dy = e.clientY - _sidebarDrag.startY;
      if (!_sidebarDrag.moved && Math.hypot(dx, dy) > 5) {
        _sidebarDrag.moved = true;
        const ghost = document.createElement('div');
        ghost.className   = 'editor-drag-ghost';
        ghost.textContent = _sidebarDrag.hostname;
        document.body.appendChild(ghost);
        _sidebarDrag.ghostEl = ghost;
      }
      if (_sidebarDrag.ghostEl) {
        _sidebarDrag.ghostEl.style.left = `${e.clientX}px`;
        _sidebarDrag.ghostEl.style.top  = `${e.clientY}px`;
        // In editor: usa l'immagine editor; in normale: usa floorplan-img
        const imgId = editingMode ? 'editor-floorplan-img' : 'floorplan-img';
        const img   = document.getElementById(imgId);
        const rect  = img.getBoundingClientRect();
        const over  = e.clientX >= rect.left && e.clientX <= rect.right &&
                      e.clientY >= rect.top  && e.clientY <= rect.bottom;
        img.classList.toggle('drop-target', over);
      }
    } else if (_drag) {
      // Drag marker: usa l'immagine editor in editingMode
      const imgId = editingMode ? 'editor-floorplan-img' : 'floorplan-img';
      const img   = document.getElementById(imgId);
      const rect  = img.getBoundingClientRect();
      const cx    = (e.clientX - rect.left) / rect.width;
      const cy    = (e.clientY - rect.top)  / rect.height;
      const x     = Math.max(0, Math.min(1, cx - _drag.offsetX));
      const y     = Math.max(0, Math.min(1, cy - _drag.offsetY));
      _drag.el.style.left = `${x * 100}%`;
      _drag.el.style.top  = `${y * 100}%`;
      editorPos[_drag.hostname] = { x, y };
    } else if (_editorPan) {
      editorPanX = _editorPan.startPanX + (e.clientX - _editorPan.startX);
      editorPanY = _editorPan.startPanY + (e.clientY - _editorPan.startY);
      applyEditorTransform();
    } else if (_pan) {
      panX = _pan.startPanX + (e.clientX - _pan.startX);
      panY = _pan.startPanY + (e.clientY - _pan.startY);
      applyTransform();
    }
  });
  document.addEventListener('mouseup', e => {
    if (_sidebarDrag) {
      // In editor: usa immagine editor; in normale: usa floorplan-img
      const imgId = editingMode ? 'editor-floorplan-img' : 'floorplan-img';
      const img   = document.getElementById(imgId);
      img.classList.remove('drop-target');
      if (_sidebarDrag.ghostEl) {
        // Rilascio dopo drag effettivo
        _sidebarDrag.ghostEl.remove();
        const rect = img.getBoundingClientRect();
        const over = e.clientX >= rect.left && e.clientX <= rect.right &&
                     e.clientY >= rect.top  && e.clientY <= rect.bottom;
        if (over) {
          const x = (e.clientX - rect.left) / rect.width;
          const y = (e.clientY - rect.top)  / rect.height;
          editorPos[_sidebarDrag.hostname] = { x, y };
          editorSelected = null;
          renderEditorSidebar();
          renderEditorMarkers();
          updateEditorInstruction();
        }
      } else {
        // Nessun movimento → trattato come click: seleziona il PC
        editorSelected = _sidebarDrag.hostname;
        renderEditorSidebar();
        renderEditorMarkers();
        updateEditorInstruction();
      }
      _sidebarDrag = null;
      return;
    }
    if (_drag) {
      _drag.el.classList.remove('dragging');
      _drag = null;
      renderEditorMarkers();
      renderEditorSidebar();
    }
    if (_editorPan) {
      _editorPan = null;
      document.getElementById('editor-floorplan-scaler').classList.remove('panning');
    }
    if (_pan) {
      _pan = null;
      document.getElementById('floorplan-scaler').classList.remove('panning');
    }
  });

  // Zoom mappa
  document.getElementById('btn-zoom-in').addEventListener('click',    () => changeZoom(1.25));
  document.getElementById('btn-zoom-out').addEventListener('click',   () => changeZoom(0.8));
  document.getElementById('btn-zoom-reset').addEventListener('click', resetZoom);

  const scaler = document.getElementById('floorplan-scaler');
  scaler.addEventListener('wheel', e => {
    e.preventDefault();
    if (editingMode) return;
    const factor  = e.deltaY < 0 ? 1.1 : 0.9;
    const newZoom = Math.max(0.5, Math.min(4, zoom * factor));
    const wrapper = document.getElementById('floorplan-wrapper');
    const rect    = wrapper.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const px = (mx - panX) / zoom;
    const py = (my - panY) / zoom;
    panX = mx - px * newZoom;
    panY = my - py * newZoom;
    zoom = newZoom;
    applyTransform();
  }, { passive: false });

  // Pan con mouse — drag sulla piantina (funziona anche in edit mode: mousedown+move=pan, click=piazza PC)
  document.getElementById('floorplan-wrapper').addEventListener('mousedown', e => {
    if (e.target.closest('.marker') || e.target.closest('.zoom-btn') || e.target.closest('.zoom-badge')) return;
    e.preventDefault();
    _pan = { startX: e.clientX, startY: e.clientY, startPanX: panX, startPanY: panY };
    scaler.classList.add('panning');
  });

  // Impostazioni
  document.getElementById('btn-settings-close').addEventListener('click', closeSettings);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-toggle-pass').addEventListener('click', togglePassVisibility);
  document.getElementById('btn-toggle-auth-token').addEventListener('click', () => {
    const inp = document.getElementById('cfg-auth-token');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('btn-test-wmi').addEventListener('click', testWmiConnection);
  document.getElementById('btn-add-pc').addEventListener('click', showAddPcForm);
  document.getElementById('btn-pc-form-ok').addEventListener('click', confirmPcForm);
  document.getElementById('btn-pc-form-cancel').addEventListener('click', hidePcForm);
  document.getElementById('btn-delete-selected')?.addEventListener('click', deleteSelectedPcs);
  document.getElementById('settings-chk-all')?.addEventListener('change', e => {
    settingsSelectedPcs.clear();
    if (e.target.checked)
      (settingsConfig.pcs || []).forEach(p => settingsSelectedPcs.add(p.hostname));
    renderPcsTable();
  });
  document.getElementById('btn-upload-floorplan').addEventListener('click', uploadFloorplan);
  document.getElementById('floorplan-file-input').addEventListener('change', () => {
    const f = document.getElementById('floorplan-file-input').files[0];
    document.getElementById('btn-upload-floorplan').textContent = f ? `Carica "${f.name}"` : 'Carica';
  });

  // Tabs impostazioni — event delegation
  document.querySelector('.settings-tabs').addEventListener('click', e => {
    const tab = e.target.closest('.settings-tab');
    if (!tab) return;
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });

  // Update
  document.getElementById('update-badge').addEventListener('click', openUpdatePopover);
  document.getElementById('btn-apply-update').addEventListener('click', applyUpdate);
  document.addEventListener('click', e => {
    const popover = document.getElementById('update-popover');
    if (!popover.classList.contains('hidden') &&
        !popover.contains(e.target) &&
        !document.getElementById('update-badge').contains(e.target)) {
      popover.classList.add('hidden');
    }
  });

  // Pannello PC list
  document.getElementById('pc-list-toggle').addEventListener('click', togglePcListPanel);
  document.getElementById('chk-select-all').addEventListener('change', e => selectAllPcs(e.target.checked));
  document.getElementById('pc-list-sort-key').addEventListener('change', e => {
    listSortKey = e.target.value;
    localStorage.setItem('pcListSort', listSortKey);
    renderPcList();
  });
  document.getElementById('pc-list-sort-dir').addEventListener('click', () => {
    listSortDir = listSortDir === 'asc' ? 'desc' : 'asc';
    localStorage.setItem('pcListSortDir', listSortDir);
    document.getElementById('pc-list-sort-dir').textContent = listSortDir === 'asc' ? '↑' : '↓';
    renderPcList();
  });
  document.getElementById('btn-bulk-wol').addEventListener('click', bulkWol);
  document.getElementById('btn-bulk-shutdown').addEventListener('click', bulkShutdown);

  // Applica stato iniziale
  document.getElementById('pc-list-sort-key').value = listSortKey;
  document.getElementById('pc-list-sort-dir').textContent = listSortDir === 'asc' ? '↑' : '↓';
  if (listCollapsed) {
    document.getElementById('pc-list-panel').classList.add('collapsed');
    document.getElementById('pc-list-toggle').textContent = '❯';
  }

  // Toggle mappa / griglia
  document.getElementById('btn-view-toggle')?.addEventListener('click', () => {
    viewMode = viewMode === 'grid' ? 'map' : 'grid';
    localStorage.setItem('viewMode', viewMode);
    renderMarkers();  // renderMarkers chiama applyViewMode internamente
  });

  // AD import modal
  document.getElementById('btn-ad-import')?.addEventListener('click', openAdImport);
  document.getElementById('btn-ad-import-close')?.addEventListener('click', () =>
    document.getElementById('ad-import-modal').classList.add('hidden'));
  document.getElementById('btn-ad-import-cancel')?.addEventListener('click', () =>
    document.getElementById('ad-import-modal').classList.add('hidden'));
  document.getElementById('btn-ad-import-confirm')?.addEventListener('click', confirmAdImport);
  document.getElementById('ad-import-selectall')?.addEventListener('change', e => {
    document.querySelectorAll('#ad-import-list .ad-chk').forEach(c => c.checked = e.target.checked);
    updateAdImportConfirmBtn();
  });
  document.getElementById('ad-import-filter')?.addEventListener('input', e =>
    renderAdImportList(e.target.value));

  // Avvia autenticazione — se ok chiama startApp()
  const authed = await initAuth();
  if (authed) startApp();
});

async function startApp() {
  await loadSedeName();
  await loadPositions();
  await loadPcs();
  setInterval(loadPcs, 5000);
  checkForUpdates();
  setInterval(checkForUpdates, 3600000); // ogni ora
}

// ── API ───────────────────────────────────────────────────────────────────────
async function loadPcs(manual = false) {
  if (fetching && !manual) return;
  fetching = true;
  const btn = document.getElementById('btn-refresh');
  if (manual) btn.textContent = '⟳ …';

  try {
    const res = await apiFetch('/api/pcs');
    if (!res.ok) throw new Error();
    pcs = await res.json();
    clearError();
    const now = new Date();
    document.getElementById('last-update').textContent =
      'Aggiornato alle ' + now.toLocaleTimeString('it-IT');
    renderStats();
    renderMarkers();
    if (selectedHost) {
      const pc = pcs.find(p => p.hostname === selectedHost);
      if (pc) updatePanel(pc);
    }
  } catch {
    showError('Impossibile connettersi al backend. Assicurati che Flask sia in esecuzione.');
  } finally {
    fetching = false;
    btn.textContent = '↻ Aggiorna';
    document.getElementById('loading').classList.add('hidden');
  }
}

async function loadSedeName() {
  try {
    const res  = await apiFetch('/api/config');
    const cfg  = await res.json();
    const name = cfg?.sede?.name;
    if (name) {
      document.getElementById('sede-title').textContent = name;
      document.title = name;
    }
  } catch {}
}

async function loadPositions() {
  try {
    const res = await apiFetch('/api/positions');
    positions = await res.json();
  } catch {}
  // Imposta viewMode di default dopo aver caricato le posizioni:
  // mappa se ci sono posizioni configurate, griglia altrimenti.
  // Se l'utente ha già scelto manualmente (localStorage) quella scelta ha priorità.
  if (!viewMode) {
    viewMode = Object.keys(positions).length > 0 ? 'map' : 'grid';
  }
}

// ── Render principale ─────────────────────────────────────────────────────────
function renderStats() {
  const online  = pcs.filter(p => p.online).length;
  const offline = pcs.filter(p => !p.online && p.ip).length;
  const unknown = pcs.filter(p => !p.ip).length;
  document.getElementById('stats').innerHTML =
    `<span class="stat online">${online} online</span>` +
    `<span class="stat offline">${offline} offline</span>` +
    (unknown ? `<span class="stat unknown">${unknown} N/D</span>` : '');
}

function renderMarkers() {
  if (editingMode) return;   // non sovrascrivere i marker editor durante il polling
  const placed = Object.keys(positions);
  const hasPos = placed.length > 0;
  // La visibilità di floorplan-wrapper/floorplan-empty è gestita da applyViewMode()
  // che viene chiamata alla fine di questa funzione.
  const container = document.getElementById('markers');
  container.innerHTML = '';

  for (const hostname of placed) {
    const pos = positions[hostname];
    // Salta posizioni invalide (NaN, undefined, fuori [0,1]) che potrebbero essere
    // state salvate con versioni precedenti dell'editor quando aveva bug di offset
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' ||
        isNaN(pos.x) || isNaN(pos.y) || pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1) continue;
    const pc  = pcs.find(p => p.hostname === hostname) || { hostname, ip: '', online: false, user: '' };
    const cls = pc.ip ? (pc.online ? 'online' : 'offline') : 'unknown';
    const sel = hostname === selectedHost ? ' selected' : '';

    const el = document.createElement('div');
    el.className = `marker ${cls}${sel}`;
    el.style.left = `${pos.x * 100}%`;
    el.style.top  = `${pos.y * 100}%`;
    const sessionTime = pc.since ? elapsed(pc.since) : null;
    el.innerHTML  =
      `<div class="marker-dot"></div>` +
      `<div class="marker-label">` +
        `<span class="marker-hostname">${hostname}</span>` +
        (pc.user ? `<span class="marker-user">${pc.user.slice(0, 13)}</span>` : '') +
        (sessionTime ? `<span class="marker-user">⏱ ${sessionTime}</span>` : '') +
      `</div>`;
    el.addEventListener('click', () => openPanel(pc));
    container.appendChild(el);
  }

  applyViewMode();
  renderPcList();
}

// ── Vista griglia / mappa ─────────────────────────────────────────────────────
function applyViewMode() {
  const placed = Object.keys(positions);
  const hasPos = placed.length > 0;
  const mapWrapper = document.getElementById('floorplan-wrapper');
  const mapEmpty   = document.getElementById('floorplan-empty');
  const gridArea   = document.getElementById('grid-view');
  const toggleBtn  = document.getElementById('btn-view-toggle');

  if (viewMode === 'grid') {
    if (mapWrapper) mapWrapper.classList.add('hidden');
    if (mapEmpty)   mapEmpty.classList.add('hidden');
    if (gridArea)   gridArea.classList.remove('hidden');
    renderGridView();
    if (toggleBtn) { toggleBtn.textContent = '🗺'; toggleBtn.title = 'Mostra mappa'; }
  } else {
    if (gridArea) gridArea.classList.add('hidden');
    if (mapWrapper) mapWrapper.classList.toggle('hidden', !hasPos);
    if (mapEmpty)   mapEmpty.classList.toggle('hidden', hasPos);
    if (toggleBtn) { toggleBtn.textContent = '⊞'; toggleBtn.title = 'Mostra griglia'; }
  }
}

function renderGridView() {
  const container = document.getElementById('grid-view');
  if (!container) return;
  if (!pcs || pcs.length === 0) {
    container.innerHTML =
      '<div class="grid-empty">Nessun PC configurato.<br><br>' +
      'Aggiungi PC dalle <b>Impostazioni → PC</b>.</div>';
    return;
  }
  const sorted = [...pcs].sort((a, b) => a.hostname.localeCompare(b.hostname));
  container.innerHTML = sorted.map(pc => {
    const cls      = pc.ip ? (pc.online ? 'online' : 'offline') : 'unknown';
    const user     = pc.user ? escHtml(pc.user) : '<span class="muted">—</span>';
    const ip       = pc.ip   ? escHtml(pc.ip)   : '<span class="muted">—</span>';
    const cpuColor = pc.cpu > 85 ? '#ef4444' : pc.cpu > 60 ? '#f59e0b' : '#22c55e';
    const ramColor = pc.ram_pct > 90 ? '#ef4444' : pc.ram_pct > 75 ? '#f59e0b' : '#3b82f6';
    const cpu      = pc.cpu     != null ? barHtml(pc.cpu,     cpuColor) : '<span class="muted">—</span>';
    const ram      = pc.ram_pct != null ? barHtml(pc.ram_pct, ramColor) : '<span class="muted">—</span>';
    return `<div class="pc-card ${cls}" data-hostname="${escHtml(pc.hostname)}">
      <div class="pc-card-header">
        <span class="pc-card-dot ${cls}"></span>
        <span class="pc-card-name">${escHtml(pc.hostname)}</span>
      </div>
      <div class="pc-card-body">
        <div class="pc-card-row"><span>Utente</span><span>${user}</span></div>
        <div class="pc-card-row"><span>IP</span><span>${ip}</span></div>
        <div class="pc-card-row"><span>CPU</span><span>${cpu}</span></div>
        <div class="pc-card-row"><span>RAM</span><span>${ram}</span></div>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.pc-card').forEach(card => {
    card.addEventListener('click', () => {
      const hn = card.dataset.hostname;
      const pc = pcs.find(p => p.hostname === hn);
      if (pc) openPanel(pc);
    });
  });
}

// ── Pannello PC ───────────────────────────────────────────────────────────────
function openPanel(pc) {
  selectedHost = pc.hostname;
  renderMarkers();
  updatePanel(pc);
  document.getElementById('panel').classList.remove('hidden');
}

function updatePanel(pc) {
  const statusCls   = pc.online ? 'online' : pc.ip ? 'offline' : 'unknown';
  const statusLabel = pc.online ? 'Online' : pc.ip ? 'Offline' : 'N/D';

  document.getElementById('panel-dot').className        = `panel-dot ${statusCls}`;
  document.getElementById('panel-hostname').textContent = pc.hostname;

  document.getElementById('panel-badges').innerHTML =
    `<span class="badge badge-${statusCls}">${statusLabel}</span>` +
    (pc.manufacturer ? `<span class="badge badge-neutral">${pc.manufacturer}</span>` : '');

  let rows =
    `<tr><td class="panel-label">IP</td><td class="panel-value">${pc.ip || '—'}</td></tr>` +
    `<tr><td class="panel-label">MAC</td><td class="panel-value panel-mono">${pc.mac || '—'}</td></tr>`;

  if (pc.wmi_error) {
    rows += `<tr><td class="panel-label" style="color:#ef4444">⚠ WMI</td>` +
            `<td class="panel-value" style="color:#ef4444;font-size:11px;word-break:break-all">${escHtml(pc.wmi_error)}</td></tr>`;
  }

  if (pc.model) {
    rows += `<tr><td class="panel-label">Modello</td><td class="panel-value">${pc.model}</td></tr>`;
  }
  if (pc.os) {
    rows += `<tr><td class="panel-label">OS</td><td class="panel-value">${pc.os}</td></tr>`;
  }
  if (pc.net_speed) {
    rows += `<tr><td class="panel-label">Rete</td><td class="panel-value">${fmtSpeed(pc.net_speed)}</td></tr>`;
  }

  if (pc.user) {
    rows += `<tr><td class="panel-label">Username</td><td class="panel-value panel-mono">${pc.user}</td></tr>`;
    const nameVal = pc.fullname
      ? `<strong>${pc.fullname}</strong>`
      : `<span class="muted">—</span>`;
    rows += `<tr><td class="panel-label">Nome</td><td class="panel-value">${nameVal}</td></tr>`;
  } else if (pc.online) {
    rows += `<tr><td class="panel-label">Utente</td><td class="panel-value"><span class="muted">Nessun utente loggato</span></td></tr>`;
  }

  if (pc.since) {
    rows += `<tr><td class="panel-label">Sessione</td><td class="panel-value">${elapsed(pc.since, true)}</td></tr>`;
  }
  if (pc.cpu != null) {
    const cpuColor = pc.cpu > 85 ? '#ef4444' : pc.cpu > 60 ? '#f59e0b' : '#22c55e';
    rows += `<tr><td class="panel-label">CPU</td><td class="panel-value">${barHtml(pc.cpu, cpuColor)}</td></tr>`;
  }
  if (pc.ram_pct != null) {
    const ramColor = pc.ram_pct > 90 ? '#ef4444' : pc.ram_pct > 75 ? '#f59e0b' : '#3b82f6';
    const ramLabel = pc.ram_gb
      ? `${Math.round(pc.ram_pct / 100 * pc.ram_gb)}/${pc.ram_gb} GB`
      : `${pc.ram_pct}%`;
    rows += `<tr><td class="panel-label">RAM</td><td class="panel-value">${barHtml(pc.ram_pct, ramColor, ramLabel)}</td></tr>`;
  }
  if (pc.disk_total != null && pc.disk_free != null) {
    const diskUsed = pc.disk_total - pc.disk_free;
    const diskPct  = Math.round(diskUsed / pc.disk_total * 100);
    const diskColor = diskPct > 90 ? '#ef4444' : diskPct > 75 ? '#f59e0b' : '#22c55e';
    const gbUsed  = (diskUsed  / 1073741824).toFixed(0);
    const gbTotal = (pc.disk_total / 1073741824).toFixed(0);
    const diskLabel = pc.disk_type
      ? `${gbUsed}/${gbTotal} GB · ${pc.disk_type}`
      : `${gbUsed}/${gbTotal} GB`;
    rows += `<tr><td class="panel-label">Disco C:</td><td class="panel-value">${barHtml(diskPct, diskColor, diskLabel)}</td></tr>`;
  }
  if (pc.uptime) {
    rows += `<tr><td class="panel-label">Acceso da</td><td class="panel-value">${elapsed(pc.uptime, true)}</td></tr>`;
  }

  document.getElementById('panel-table').innerHTML = rows;
  renderPanelActions(pc);
}

function renderPanelActions(pc) {
  const container = document.getElementById('panel-actions');
  container.innerHTML = '';

  // Wake on LAN (solo se offline e ha MAC)
  if (!pc.online && pc.mac) {
    const wol = wolStatus[pc.hostname];
    const btn = document.createElement('button');
    btn.className = `btn-action wol${wol === 'sent' ? ' sent' : ''}`;
    btn.disabled  = wol === 'sending';
    btn.textContent =
      wol === 'sending' ? '⟳ Invio in corso…' :
      wol === 'sent'    ? '✓ Pacchetto inviato' :
      wol === 'error'   ? '✕ Errore — riprova' :
                          '⚡ Accendi (Wake on LAN)';
    btn.addEventListener('click', () => doWol(pc.hostname));
    container.appendChild(btn);
  }

  // Spegnimento (solo se online e ha IP)
  if (pc.online && pc.ip) {
    const sd = shutdownStatus[pc.hostname];

    if (sd === 'confirm') {
      const box = document.createElement('div');
      box.className = 'shutdown-confirm';
      box.innerHTML =
        `<p class="shutdown-warning">Spegnere <strong>${pc.hostname}</strong>?` +
        (pc.user ? ` L'utente <strong>${pc.user}</strong> potrebbe perdere dati non salvati.` : '') +
        `</p><div class="shutdown-buttons">` +
        `<button class="btn-shutdown-yes">Sì, spegni</button>` +
        `<button class="btn-shutdown-no">Annulla</button></div>`;
      box.querySelector('.btn-shutdown-yes').addEventListener('click', () => doShutdown(pc.hostname));
      box.querySelector('.btn-shutdown-no').addEventListener('click', () => {
        shutdownStatus[pc.hostname] = null;
        renderPanelActions(pc);
      });
      container.appendChild(box);
    } else {
      const btn = document.createElement('button');
      btn.className = `btn-action shutdown${sd === 'ok' ? ' ok' : ''}`;
      btn.disabled  = sd === 'sending';
      btn.textContent =
        sd === 'sending' ? '⟳ Spegnimento…' :
        sd === 'ok'      ? '✓ Comando inviato' :
        sd === 'error'   ? '✕ Errore — riprova' :
                           '⏻ Spegni PC';
      btn.addEventListener('click', () => {
        shutdownStatus[pc.hostname] = 'confirm';
        renderPanelActions(pc);
      });
      container.appendChild(btn);
    }
  }

  // Remote Desktop (solo se online e ha IP) — scarica file .rdp
  if (pc.online && pc.ip) {
    const btn = document.createElement('button');
    btn.className   = 'btn-action rdp';
    btn.textContent = '🖥 Remote Desktop';
    btn.addEventListener('click', () => doRdp(pc.hostname));
    container.appendChild(btn);
  }

  if (!pc.ip) {
    const note = document.createElement('p');
    note.className   = 'panel-note';
    note.textContent = 'MAC non disponibile — WOL non supportato.';
    container.appendChild(note);
  }
}

function closePanel() {
  selectedHost = null;
  document.getElementById('panel').classList.add('hidden');
  renderMarkers();
}

// ── WOL ───────────────────────────────────────────────────────────────────────
async function doWol(hostname) {
  wolStatus[hostname] = 'sending';
  refreshPanelIfOpen(hostname);
  try {
    const res  = await apiFetch(`/api/wol/${hostname}`, { method: 'POST' });
    const data = await res.json();
    wolStatus[hostname] = data.ok ? 'sent' : 'error';
    if (data.ok) setTimeout(() => { wolStatus[hostname] = null; refreshPanelIfOpen(hostname); }, 5000);
  } catch {
    wolStatus[hostname] = 'error';
  }
  refreshPanelIfOpen(hostname);
}

// ── Shutdown ──────────────────────────────────────────────────────────────────
// ── Remote Desktop ────────────────────────────────────────────────────────────
async function doRdp(hostname) {
  // Scarica il file .rdp tramite apiFetch (gestisce X-Api-Key)
  try {
    const res = await apiFetch(`/api/rdp/${hostname}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${hostname}.rdp`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {}
}

async function doShutdown(hostname) {
  shutdownStatus[hostname] = 'sending';
  refreshPanelIfOpen(hostname);
  try {
    const res  = await apiFetch(`/api/shutdown/${hostname}`, { method: 'POST' });
    const data = await res.json();
    shutdownStatus[hostname] = data.ok ? 'ok' : 'error';
    if (data.ok) setTimeout(() => { shutdownStatus[hostname] = null; refreshPanelIfOpen(hostname); }, 5000);
  } catch {
    shutdownStatus[hostname] = 'error';
  }
  refreshPanelIfOpen(hostname);
}

function refreshPanelIfOpen(hostname) {
  if (selectedHost !== hostname) return;
  const pc = pcs.find(p => p.hostname === hostname);
  if (pc) renderPanelActions(pc);
}

// ── Editor posizioni ──────────────────────────────────────────────────────────

function openEditor() {
  editorPos         = { ...positions };
  editorSelected    = null;
  editingMode       = true;
  editorSearchQuery = '';

  // Chiudi pannello PC se aperto
  closePanel();

  // Resetta zoom/pan dell'editor
  resetEditorZoom();

  // Mostra overlay full-screen
  document.getElementById('editor-overlay').classList.remove('hidden');

  // Resetta search
  document.getElementById('editor-search').value = '';

  // Resetta bottoni salva
  const s1 = document.getElementById('btn-editor-save');
  const s2 = document.getElementById('btn-editor-save-2');
  if (s1) { s1.disabled = false; s1.textContent = 'Salva'; }
  if (s2) { s2.disabled = false; }

  // Registra listener click-to-place sul container della mappa editor
  _editorClickHandler = handleEditorClick;
  document.getElementById('editor-floorplan-container').addEventListener('click', _editorClickHandler);

  renderEditorMarkers();
  renderEditorSidebar();
  updateEditorInstruction();
}

function closeEditor() {
  if (_drag) { if (_drag.el) _drag.el.classList.remove('dragging'); _drag = null; }
  if (_sidebarDrag) { if (_sidebarDrag.ghostEl) _sidebarDrag.ghostEl.remove(); _sidebarDrag = null; }
  if (_editorPan) { _editorPan = null; }

  editingMode = false;
  document.getElementById('editor-overlay').classList.add('hidden');

  // Rimuovi listener click-to-place dall'editor
  if (_editorClickHandler) {
    const cont = document.getElementById('editor-floorplan-container');
    if (cont) cont.removeEventListener('click', _editorClickHandler);
    _editorClickHandler = null;
  }

  // Ripristina marker normali
  renderMarkers();
}

function handleEditorClick(e) {
  if (!editingMode || !editorSelected) return;
  // Click su marker editor → selezione (gestita dal listener del marker stesso), non piazzamento
  if (e.target.closest('.editor-mk')) return;

  const img  = document.getElementById('editor-floorplan-img');
  const rect = img.getBoundingClientRect();
  const x    = (e.clientX - rect.left) / rect.width;
  const y    = (e.clientY - rect.top)  / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;   // fuori dall'immagine

  editorPos[editorSelected] = { x, y };

  // Auto-seleziona il prossimo PC non posizionato
  const unplaced = pcs.map(p => p.hostname).filter(h => !editorPos[h] && h !== editorSelected);
  editorSelected = unplaced[0] || null;

  renderEditorSidebar();
  renderEditorMarkers();
  updateEditorInstruction();
}

function handleEditorListClick(e) {
  // La rimozione tramite il bottone × usa il click normale
  const removeBtn = e.target.closest('.editor-remove');
  if (removeBtn) {
    const h = removeBtn.dataset.hostname;
    delete editorPos[h];
    if (editorSelected === h) editorSelected = null;
    renderEditorSidebar();
    renderEditorMarkers();
    updateEditorInstruction();
    return;
  }
  // I click sugli item sono gestiti dal mouseup di _sidebarDrag (e.preventDefault nel mousedown
  // previene questo evento per i non-removeBtn), quindi non fare nulla qui.
}

function handleEditorListMousedown(e) {
  const item = e.target.closest('.editor-pc-item');
  if (!item) return;
  // Lascia passare il click sul bottone rimozione
  if (e.target.closest('.editor-remove')) return;
  // Blocca selezione testo e l'evento click successivo; gestisce tutto in mouseup
  e.preventDefault();
  const hostname = item.dataset.hostname;
  _sidebarDrag = { hostname, ghostEl: null, startX: e.clientX, startY: e.clientY, moved: false };
}

function updateEditorInstruction() {
  const bar     = document.getElementById('editor-instruction-bar');
  const wrapper = document.getElementById('editor-floorplan-wrapper');
  if (!bar) return;

  if (editorSelected && !editorPos[editorSelected]) {
    bar.textContent = `Clicca sulla mappa per posizionare ${editorSelected}`;
    bar.classList.add('active');
    if (wrapper) wrapper.classList.add('placing');
  } else {
    bar.textContent = 'Seleziona un PC dalla lista, poi clicca sulla mappa — oppure trascinalo direttamente';
    bar.classList.remove('active');
    if (wrapper) wrapper.classList.remove('placing');
  }
}

function renderEditorSidebar() {
  const allHosts   = pcs.map(p => p.hostname);
  const query      = editorSearchQuery.trim().toLowerCase();
  const filtered   = query ? allHosts.filter(h => h.toLowerCase().includes(query)) : allHosts;
  const placedAll  = allHosts.filter(h => editorPos[h]).length;   // contatore totale (non filtrato)
  const unplaced   = filtered.filter(h => !editorPos[h]);
  const placed     = filtered.filter(h =>  editorPos[h]);

  let html = '';
  for (const h of unplaced) {
    const isActive = editorSelected === h;
    html += `<div class="editor-pc-item${isActive ? ' active' : ''}" data-hostname="${escHtml(h)}">
      <div class="editor-pc-status unplaced"></div>
      <span class="editor-pc-name">${escHtml(h)}</span>
    </div>`;
  }
  for (const h of placed) {
    const isActive = editorSelected === h;
    html += `<div class="editor-pc-item placed${isActive ? ' active' : ''}" data-hostname="${escHtml(h)}">
      <div class="editor-pc-status placed">✓</div>
      <span class="editor-pc-name">${escHtml(h)}</span>
      <button class="editor-remove" data-hostname="${escHtml(h)}">×</button>
    </div>`;
  }

  document.getElementById('editor-pc-list').innerHTML = html;

  // Aggiorna contatore nella toolbar
  const counter = document.getElementById('editor-counter');
  if (counter) {
    counter.innerHTML = `<span class="count-placed">${placedAll}</span> / ${allHosts.length} posizionati`;
  }

  // Aggiorna testo bottoni salva
  const s2 = document.getElementById('btn-editor-save-2');
  if (s2 && !s2.disabled) s2.textContent = `Salva (${placedAll} PC)`;
}

function renderEditorMarkers() {
  // Usa #editor-markers e #editor-floorplan-img — DOM completamente separato dalla vista normale.
  // Coordinate in percentuale (0-1) → offset impossibile per costruzione.
  const container = document.getElementById('editor-markers');
  if (!container) return;
  container.innerHTML = '';

  const entries = Object.entries(editorPos);
  entries.forEach(([hostname, pos]) => {
    const sel = editorSelected === hostname;
    const el  = document.createElement('div');
    el.className        = `editor-mk${sel ? ' edit-selected' : ''}`;
    el.style.left       = `${pos.x * 100}%`;
    el.style.top        = `${pos.y * 100}%`;
    el.dataset.hostname = hostname;

    // Cerchio numerato
    const dot = document.createElement('div');
    dot.className   = 'editor-mk-dot';

    // Etichetta hostname
    const lbl = document.createElement('div');
    lbl.className   = 'editor-mk-label';
    lbl.textContent = hostname;

    // Bottone × per rimozione diretta dalla mappa
    const removeBtn = document.createElement('button');
    removeBtn.className   = 'editor-mk-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      delete editorPos[hostname];
      if (editorSelected === hostname) editorSelected = null;
      renderEditorSidebar();
      renderEditorMarkers();
      updateEditorInstruction();
    });

    el.appendChild(dot);
    el.appendChild(lbl);
    el.appendChild(removeBtn);

    // Click per selezionare (solo se non si stava trascinando)
    el.addEventListener('click', e => {
      if (_drag) return;
      e.stopPropagation();
      editorSelected = hostname;
      renderEditorSidebar();
      renderEditorMarkers();
      updateEditorInstruction();
    });

    // Drag start — salva offset cursore/centro per evitare "salto"
    el.addEventListener('mousedown', e => {
      if (e.target.closest('.editor-mk-remove')) return;
      e.preventDefault();
      e.stopPropagation();
      const img  = document.getElementById('editor-floorplan-img');
      const rect = img.getBoundingClientRect();
      const cx   = (e.clientX - rect.left) / rect.width;
      const cy   = (e.clientY - rect.top)  / rect.height;
      _drag = { hostname, el, offsetX: cx - pos.x, offsetY: cy - pos.y };
      editorSelected = hostname;
      el.classList.add('dragging');
      renderEditorSidebar();
      updateEditorInstruction();
    });

    container.appendChild(el);
  });
}

async function savePositions() {
  const s1 = document.getElementById('btn-editor-save');
  const s2 = document.getElementById('btn-editor-save-2');
  if (s1) { s1.textContent = 'Salvataggio…'; s1.disabled = true; }
  if (s2) { s2.textContent = 'Salvataggio…'; s2.disabled = true; }
  try {
    await apiFetch('/api/positions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(editorPos),
    });
    positions = { ...editorPos };
    closeEditor();   // chiama renderMarkers() internamente
  } catch {
    if (s1) { s1.textContent = '✕ Errore'; s1.disabled = false; }
    if (s2) { s2.textContent = '✕ Errore — riprova'; s2.disabled = false; }
  }
}

// ── Impostazioni ──────────────────────────────────────────────────────────────
async function openSettings() {
  settingsSelectedPcs.clear();  // azzera selezione ad ogni apertura
  try {
    const res = await apiFetch('/api/config');
    settingsConfig = await res.json();
  } catch {
    settingsConfig = {};
  }
  populateSettingsForm();
  renderPcsTable();
  hidePcForm();
  // Resetta result WMI e floorplan
  setSettingsResult('wmi-test-result', '', false);
  setSettingsResult('floorplan-upload-result', '', false);
  document.getElementById('floorplan-file-input').value = '';
  document.getElementById('btn-upload-floorplan').textContent = 'Carica';
  // Reload anteprima piantina
  document.getElementById('settings-floorplan-preview').src = '/api/floorplan?' + Date.now();
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

function populateSettingsForm() {
  const s = settingsConfig;
  document.getElementById('cfg-sede-name').value     = s?.sede?.name          ?? '';
  document.getElementById('cfg-poll-interval').value = s?.sede?.poll_interval ?? 10;
  document.getElementById('cfg-wol-broadcast').value = s?.network?.wol_broadcast ?? '';
  document.getElementById('cfg-gateway-ip').value    = s?.network?.gateway_ip    ?? '';
  document.getElementById('cfg-dc-ip').value         = s?.network?.dc_ip         ?? '';
  document.getElementById('cfg-wmi-user').value      = s?.wmi?.user  ?? '';
  document.getElementById('cfg-wmi-pass').value      = s?.wmi?.pass  ?? '';   // backend ritorna ***
  document.getElementById('cfg-auth-token').value    = s?.auth?.token ?? '';  // backend ritorna *** se impostato
}

function collectSettingsForm() {
  return {
    sede: {
      name:          document.getElementById('cfg-sede-name').value.trim(),
      poll_interval: parseInt(document.getElementById('cfg-poll-interval').value, 10) || 10,
    },
    network: {
      wol_broadcast: document.getElementById('cfg-wol-broadcast').value.trim(),
      gateway_ip:    document.getElementById('cfg-gateway-ip').value.trim(),
      dc_ip:         document.getElementById('cfg-dc-ip').value.trim(),
    },
    wmi: {
      user: document.getElementById('cfg-wmi-user').value.trim(),
      pass: document.getElementById('cfg-wmi-pass').value,        // "***" o nuova password
    },
    auth: {
      token: document.getElementById('cfg-auth-token').value,     // "***" o nuova chiave o ""
    },
    pcs: settingsConfig.pcs || [],
  };
}

async function saveSettings() {
  const btn = document.getElementById('btn-save-settings');
  btn.textContent = 'Salvataggio…';
  btn.disabled    = true;
  try {
    const cfg = collectSettingsForm();
    const res = await apiFetch('/api/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(cfg),
    });
    const data = await res.json();
    if (data.ok) {
      // Aggiorna titolo sede nell'header
      if (cfg.sede?.name) {
        document.getElementById('sede-title').textContent = cfg.sede.name;
      }
      // Aggiorna authToken in memoria se l'utente ha cambiato o rimosso la chiave
      const newToken = cfg.auth?.token ?? '';
      if (newToken !== '***') {
        authToken = newToken;
        if (newToken) localStorage.setItem('pcMonitorToken', newToken);
        else          localStorage.removeItem('pcMonitorToken');
      }
      btn.textContent = '✓ Salvato';
      setTimeout(() => {
        btn.textContent = 'Salva impostazioni';
        btn.disabled    = false;
        closeSettings();
        loadPcs(true);  // ricarica subito
      }, 1200);
    } else {
      btn.textContent = '✕ Errore — riprova';
      btn.disabled    = false;
    }
  } catch {
    btn.textContent = '✕ Errore — riprova';
    btn.disabled    = false;
  }
}

function togglePassVisibility() {
  const inp = document.getElementById('cfg-wmi-pass');
  inp.type  = inp.type === 'password' ? 'text' : 'password';
}

async function testWmiConnection() {
  const ip   = document.getElementById('cfg-wmi-test-ip').value.trim();
  const user = document.getElementById('cfg-wmi-user').value.trim();
  const pass = document.getElementById('cfg-wmi-pass').value;
  const btn  = document.getElementById('btn-test-wmi');

  if (!ip) {
    setSettingsResult('wmi-test-result', '⚠ Inserisci un IP di test', false);
    return;
  }

  btn.textContent = '⟳ Test…';
  btn.disabled    = true;
  setSettingsResult('wmi-test-result', '', false);

  try {
    const res  = await apiFetch('/api/config/test-wmi', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ip, user, pass }),
    });
    const data = await res.json();
    if (data.ok) {
      setSettingsResult('wmi-test-result', `✓ Connessione riuscita — hostname: ${data.hostname}`, true);
    } else {
      setSettingsResult('wmi-test-result', `✕ Errore: ${data.error}`, false);
    }
  } catch {
    setSettingsResult('wmi-test-result', '✕ Impossibile contattare il backend', false);
  } finally {
    btn.textContent = 'Testa connessione';
    btn.disabled    = false;
  }
}

function setSettingsResult(id, msg, ok) {
  const el = document.getElementById(id);
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.className   = `settings-hint settings-wmi-result ${ok ? 'ok' : 'err'}`;
  el.classList.remove('hidden');
}

// ── Tabella PC nell'editor impostazioni ────────────────────────────────────────
function renderPcsTable() {
  const tbody  = document.getElementById('pcs-tbody');
  const pcsArr = settingsConfig.pcs || [];
  // Rimuovi dalla selezione hostname che non esistono più
  settingsSelectedPcs = new Set([...settingsSelectedPcs].filter(
    hn => pcsArr.some(p => p.hostname === hn)
  ));
  tbody.innerHTML = pcsArr.map((pc, i) => {
    const checked = settingsSelectedPcs.has(pc.hostname) ? ' checked' : '';
    const selCls  = settingsSelectedPcs.has(pc.hostname) ? ' settings-row-selected' : '';
    return `<tr class="${selCls}">
      <td class="settings-cell" style="width:32px;padding:7px 6px">
        <input type="checkbox" class="settings-pc-chk" data-hostname="${escHtml(pc.hostname)}"${checked}>
      </td>
      <td class="settings-cell">${escHtml(pc.hostname)}</td>
      <td class="settings-cell settings-mono">${escHtml(pc.mac || '')}</td>
      <td class="settings-cell settings-cell-actions">
        <button class="settings-row-btn" onclick="showEditPcForm(${i})">✎</button>
        <button class="settings-row-btn settings-row-btn-del" onclick="deletePc(${i})">✕</button>
      </td>
    </tr>`;
  }).join('');

  // Collega i checkbox dopo aver riscritto il DOM
  tbody.querySelectorAll('.settings-pc-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      if (chk.checked) settingsSelectedPcs.add(chk.dataset.hostname);
      else             settingsSelectedPcs.delete(chk.dataset.hostname);
      _updateSettingsDeleteBtn();
    });
  });
  _updateSettingsDeleteBtn();
}

function _updateSettingsDeleteBtn() {
  const n   = settingsSelectedPcs.size;
  const btn = document.getElementById('btn-delete-selected');
  const cnt = document.getElementById('del-selected-count');
  if (btn) btn.classList.toggle('hidden', n === 0);
  if (cnt) cnt.textContent = n;
  // Select-all: checked se tutti selezionati, indeterminate se parziale
  const all = document.getElementById('settings-chk-all');
  const tot = (settingsConfig.pcs || []).length;
  if (all) {
    all.checked       = tot > 0 && n === tot;
    all.indeterminate = n > 0 && n < tot;
  }
}

function deleteSelectedPcs() {
  const n = settingsSelectedPcs.size;
  if (!n) return;
  if (!confirm(`Eliminare ${n} PC selezionati?`)) return;
  settingsConfig.pcs = (settingsConfig.pcs || []).filter(
    p => !settingsSelectedPcs.has(p.hostname)
  );
  settingsSelectedPcs.clear();
  renderPcsTable();
}

function showAddPcForm() {
  settingsEditIdx = -1;
  document.getElementById('pc-form-hostname').value = '';
  document.getElementById('pc-form-mac').value      = '';
  document.getElementById('btn-pc-form-ok').textContent = 'Aggiungi';
  document.getElementById('pc-form').classList.remove('hidden');
  document.getElementById('pc-form-hostname').focus();
}

function showEditPcForm(idx) {
  settingsEditIdx = idx;
  const pc = (settingsConfig.pcs || [])[idx];
  if (!pc) return;
  document.getElementById('pc-form-hostname').value = pc.hostname || '';
  document.getElementById('pc-form-mac').value      = pc.mac      || '';
  document.getElementById('btn-pc-form-ok').textContent = 'Aggiorna';
  document.getElementById('pc-form').classList.remove('hidden');
  document.getElementById('pc-form-hostname').focus();
}

function hidePcForm() {
  document.getElementById('pc-form').classList.add('hidden');
  settingsEditIdx = null;
}

function confirmPcForm() {
  const hostname = document.getElementById('pc-form-hostname').value.trim();
  const mac      = document.getElementById('pc-form-mac').value.trim();
  if (!hostname) {
    document.getElementById('pc-form-hostname').focus();
    return;
  }
  if (!settingsConfig.pcs) settingsConfig.pcs = [];

  if (settingsEditIdx === -1) {
    // Nuovo PC — verifica hostname duplicato
    if (settingsConfig.pcs.some(p => p.hostname === hostname)) {
      alert(`Hostname "${hostname}" già presente.`);
      return;
    }
    settingsConfig.pcs.push({ hostname, mac });
  } else {
    // Modifica PC esistente: preserva tutti i campi non visibili nel form (es. ip da config precedente)
    const existing = settingsConfig.pcs[settingsEditIdx] || {};
    settingsConfig.pcs[settingsEditIdx] = { ...existing, hostname, mac };
  }
  hidePcForm();
  renderPcsTable();
}

function deletePc(idx) {
  const pc = (settingsConfig.pcs || [])[idx];
  if (!pc) return;
  if (!confirm(`Eliminare ${pc.hostname}?`)) return;
  settingsConfig.pcs.splice(idx, 1);
  renderPcsTable();
}

// ── Upload piantina ───────────────────────────────────────────────────────────
async function uploadFloorplan() {
  const input = document.getElementById('floorplan-file-input');
  const file  = input.files[0];
  if (!file) {
    setSettingsResult('floorplan-upload-result', '⚠ Seleziona un file prima', false);
    return;
  }
  const btn = document.getElementById('btn-upload-floorplan');
  btn.textContent = '⟳ Caricamento…';
  btn.disabled    = true;

  const fd = new FormData();
  fd.append('file', file);
  try {
    const res  = await apiFetch('/api/floorplan/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      setSettingsResult('floorplan-upload-result', '✓ Piantina aggiornata', true);
      // Forza reload immagine aggiungendo timestamp al src
      const ts = Date.now();
      document.getElementById('settings-floorplan-preview').src = `/api/floorplan?t=${ts}`;
      document.getElementById('floorplan-img').src              = `/api/floorplan?t=${ts}`;
      document.getElementById('editor-floorplan-img').src       = `/api/floorplan?t=${ts}`;
    } else {
      setSettingsResult('floorplan-upload-result', `✕ ${data.error}`, false);
    }
  } catch {
    setSettingsResult('floorplan-upload-result', '✕ Errore di rete', false);
  } finally {
    btn.textContent = 'Carica';
    btn.disabled    = false;
    input.value     = '';
  }
}

// ── Zoom mappa ────────────────────────────────────────────────────────────────
function applyTransform() {
  const scaler = document.getElementById('floorplan-scaler');
  if (!scaler) return;
  scaler.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  const badge = document.getElementById('zoom-badge');
  if (badge) badge.textContent = `${Math.round(zoom * 100)}%`;
}

function changeZoom(factor) {
  const newZoom = Math.max(0.5, Math.min(4, zoom * factor));
  const wrapper = document.getElementById('floorplan-wrapper');
  const rect    = wrapper.getBoundingClientRect();
  const cx = rect.width  / 2;
  const cy = rect.height / 2;
  const px = (cx - panX) / zoom;
  const py = (cy - panY) / zoom;
  panX = cx - px * newZoom;
  panY = cy - py * newZoom;
  zoom = newZoom;
  applyTransform();
}

function resetZoom() {
  zoom = 1; panX = 0; panY = 0;
  applyTransform();
}

// ── Zoom mappa editor (indipendente) ─────────────────────────────────────────
function applyEditorTransform() {
  const scaler = document.getElementById('editor-floorplan-scaler');
  if (!scaler) return;
  scaler.style.transform = `translate(${editorPanX}px, ${editorPanY}px) scale(${editorZoom})`;
  const badge = document.getElementById('editor-zoom-badge');
  if (badge) badge.textContent = `${Math.round(editorZoom * 100)}%`;
}

function changeEditorZoom(factor) {
  const newZoom = Math.max(0.5, Math.min(4, editorZoom * factor));
  const wrapper = document.getElementById('editor-floorplan-wrapper');
  if (!wrapper) return;
  const rect = wrapper.getBoundingClientRect();
  const cx = rect.width  / 2;
  const cy = rect.height / 2;
  const px = (cx - editorPanX) / editorZoom;
  const py = (cy - editorPanY) / editorZoom;
  editorPanX = cx - px * newZoom;
  editorPanY = cy - py * newZoom;
  editorZoom = newZoom;
  applyEditorTransform();
}

function resetEditorZoom() {
  editorZoom = 1; editorPanX = 0; editorPanY = 0;
  applyEditorTransform();
}

// ── Pannello PC list ──────────────────────────────────────────────────────────
function sortPcList(arr) {
  const key = listSortKey;
  const dir = listSortDir === 'asc' ? 1 : -1;
  return [...arr].sort((a, b) => {
    if (key === 'ip') {
      const toNum = ip => {
        if (!ip) return Infinity;
        return ip.split('.').reduce((acc, o) => acc * 256 + parseInt(o, 10), 0);
      };
      const va = toNum(a.ip), vb = toNum(b.ip);
      if (va === Infinity && vb === Infinity) return 0;
      if (va === Infinity) return 1;
      if (vb === Infinity) return -1;
      return (va - vb) * dir;
    }
    const fieldMap = { hostname: 'hostname', user: 'user', fullname: 'fullname', os: 'os', model: 'model' };
    const field = fieldMap[key] || 'hostname';
    const va = (a[field] || '').toLowerCase();
    const vb = (b[field] || '').toLowerCase();
    if (!va && !vb) return 0;
    if (!va) return 1;
    if (!vb) return -1;
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

function renderPcList() {
  const items   = document.getElementById('pc-list-items');
  const countEl = document.getElementById('pc-list-count');
  if (!items) return;

  const sorted = sortPcList(pcs);
  countEl.textContent = sorted.length;

  items.innerHTML = sorted.map(pc => {
    const cls     = pc.ip ? (pc.online ? 'online' : 'offline') : 'unknown';
    const checked = selectedPCs.has(pc.hostname) ? 'checked' : '';
    const selCls  = selectedPCs.has(pc.hostname) ? ' selected' : '';
    return `<div class="pc-list-item${selCls}" data-hostname="${escHtml(pc.hostname)}">
      <input type="checkbox" ${checked} data-chk="${escHtml(pc.hostname)}">
      <span class="pc-list-dot ${cls}"></span>
      <div class="pc-list-info">
        <div class="pc-list-name">${escHtml(pc.hostname)}</div>
        ${pc.user ? `<div class="pc-list-user">${escHtml(pc.user)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  items.querySelectorAll('.pc-list-item').forEach(el => {
    const hostname = el.dataset.hostname;
    const chk      = el.querySelector('input[type=checkbox]');
    chk.addEventListener('change', e => {
      e.stopPropagation();
      togglePcSelection(hostname, e.target.checked);
    });
    el.addEventListener('click', e => {
      if (e.target.type === 'checkbox') return;
      const pc = pcs.find(p => p.hostname === hostname);
      if (pc) openPanel(pc);
    });
  });

  // Aggiorna select-all checkbox
  const chkAll = document.getElementById('chk-select-all');
  if (chkAll) {
    chkAll.checked       = pcs.length > 0 && selectedPCs.size === pcs.length;
    chkAll.indeterminate = selectedPCs.size > 0 && selectedPCs.size < pcs.length;
  }
  updateBulkBar();
}

function togglePcSelection(hostname, checked) {
  if (checked) selectedPCs.add(hostname);
  else         selectedPCs.delete(hostname);
  // Aggiorna solo l'item senza re-render completo
  const item = items => items && items.querySelector(`.pc-list-item[data-hostname="${CSS.escape(hostname)}"]`);
  const el   = item(document.getElementById('pc-list-items'));
  if (el) el.classList.toggle('selected', checked);
  const chkAll = document.getElementById('chk-select-all');
  if (chkAll) {
    chkAll.checked       = pcs.length > 0 && selectedPCs.size === pcs.length;
    chkAll.indeterminate = selectedPCs.size > 0 && selectedPCs.size < pcs.length;
  }
  updateBulkBar();
}

function selectAllPcs(checked) {
  if (checked) pcs.forEach(pc => selectedPCs.add(pc.hostname));
  else         selectedPCs.clear();
  renderPcList();
}

function updateBulkBar() {
  const bar    = document.getElementById('bulk-bar');
  const btnWol = document.getElementById('btn-bulk-wol');
  const btnSd  = document.getElementById('btn-bulk-shutdown');
  const cntWol = document.getElementById('bulk-wol-count');
  const cntSd  = document.getElementById('bulk-sd-count');
  if (!bar) return;

  if (selectedPCs.size === 0) { bar.classList.add('hidden'); return; }

  const offlineSelected = [...selectedPCs].filter(h => {
    const pc = pcs.find(p => p.hostname === h);
    return pc && !pc.online && pc.mac;
  });
  const onlineSelected = [...selectedPCs].filter(h => {
    const pc = pcs.find(p => p.hostname === h);
    return pc && pc.online && pc.ip;
  });

  bar.classList.remove('hidden');
  cntWol.textContent = offlineSelected.length;
  cntSd.textContent  = onlineSelected.length;
  btnWol.disabled    = offlineSelected.length === 0;
  btnSd.disabled     = onlineSelected.length  === 0;
}

async function bulkWol() {
  const targets = [...selectedPCs].filter(h => {
    const pc = pcs.find(p => p.hostname === h);
    return pc && !pc.online && pc.mac;
  });
  for (const h of targets) await doWol(h);
}

async function bulkShutdown() {
  const targets = [...selectedPCs].filter(h => {
    const pc = pcs.find(p => p.hostname === h);
    return pc && pc.online && pc.ip;
  });
  if (targets.length === 0) return;
  if (!confirm(`Spegnere ${targets.length} PC? Alcuni potrebbero avere utenti loggati.`)) return;
  for (const h of targets) await doShutdown(h);
}

function togglePcListPanel() {
  const panel  = document.getElementById('pc-list-panel');
  const toggle = document.getElementById('pc-list-toggle');
  listCollapsed = !listCollapsed;
  panel.classList.toggle('collapsed', listCollapsed);
  toggle.textContent = listCollapsed ? '❯' : '❮';
  localStorage.setItem('pcListCollapsed', listCollapsed ? '1' : '0');
}

// ── Import da Active Directory ────────────────────────────────────────────────
let _adComputersList = [];

async function openAdImport() {
  const modal = document.getElementById('ad-import-modal');
  modal.classList.remove('hidden');
  document.getElementById('ad-import-list').innerHTML =
    '<div class="modal-loading">Caricamento computer da Active Directory…</div>';
  document.getElementById('btn-ad-import-confirm').disabled = true;
  document.getElementById('ad-import-filter').value = '';
  document.getElementById('ad-import-selectall').checked = false;

  try {
    const res  = await apiFetch('/api/ad/computers');
    const data = await res.json();
    if (data.error && !data.computers.length) {
      document.getElementById('ad-import-list').innerHTML =
        `<div class="modal-error">Errore: ${escHtml(data.error)}</div>`;
      return;
    }
    _adComputersList = data.computers || [];
    renderAdImportList('');
  } catch (e) {
    document.getElementById('ad-import-list').innerHTML =
      `<div class="modal-error">Impossibile contattare il backend.</div>`;
  }
}

function renderAdImportList(filter) {
  const q      = (filter || '').toLowerCase();
  const shown  = q ? _adComputersList.filter(n => n.toLowerCase().includes(q)) : _adComputersList;
  document.getElementById('ad-import-count').textContent = `${shown.length} trovati`;
  const allChecked = document.getElementById('ad-import-selectall').checked;
  document.getElementById('ad-import-list').innerHTML = shown.map(name =>
    `<label class="modal-list-item">
      <input type="checkbox" class="ad-chk" value="${escHtml(name)}"${allChecked ? ' checked' : ''}>
      <span>${escHtml(name)}</span>
    </label>`
  ).join('');
  document.querySelectorAll('#ad-import-list .ad-chk').forEach(chk =>
    chk.addEventListener('change', updateAdImportConfirmBtn));
  updateAdImportConfirmBtn();
}

function updateAdImportConfirmBtn() {
  const n   = document.querySelectorAll('#ad-import-list .ad-chk:checked').length;
  const btn = document.getElementById('btn-ad-import-confirm');
  btn.disabled    = n === 0;
  btn.textContent = n > 0 ? `Importa ${n} PC` : 'Importa selezionati';
}

function confirmAdImport() {
  const checked = [...document.querySelectorAll('#ad-import-list .ad-chk:checked')].map(c => c.value);
  if (!checked.length) return;
  if (!settingsConfig.pcs) settingsConfig.pcs = [];
  const existing = new Set(settingsConfig.pcs.map(p => (p.hostname || '').toUpperCase()));
  const newPcs   = checked
    .filter(hn => !existing.has(hn.toUpperCase()))
    .map(hn => ({ hostname: hn, mac: '' }));
  settingsConfig.pcs.push(...newPcs);
  document.getElementById('ad-import-modal').classList.add('hidden');
  renderPcsTable();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function elapsed(isoStr, showTime = false) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  const ms = Date.now() - d.getTime();
  if (ms < 0) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const dur = h > 0 ? `${h}h ${m}m` : `${m}m`;
  if (!showTime) return dur;
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return `${dur} <span class="muted">· ${time}</span>`;
}

function fmtSpeed(bps) {
  if (!bps) return null;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(0)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(0)} Mbps`;
  return `${bps} bps`;
}

function barHtml(pct, color, label) {
  const safe = Math.max(0, Math.min(100, pct));
  const lbl  = label !== undefined ? label : `${safe}%`;
  return `<div class="pc-bar"><div class="pc-bar-fill" style="width:${safe}%;background:${color}"></div><span class="pc-bar-label">${lbl}</span></div>`;
}

function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError() {
  document.getElementById('error-banner').classList.add('hidden');
}
function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Aggiornamenti ─────────────────────────────────────────────────────────────
async function checkForUpdates() {
  try {
    const res  = await apiFetch('/api/update/check');
    if (!res.ok) return;
    const data = await res.json();
    const badge = document.getElementById('update-badge');
    if (data.update_available) {
      badge.textContent = `↑ v${data.latest}`;
      badge.classList.remove('hidden');
      badge.dataset.current = data.current;
      badge.dataset.latest  = data.latest;
      badge.dataset.notes   = data.release_notes || '';
    } else {
      badge.classList.add('hidden');
    }
  } catch (_) {}
}

function openUpdatePopover() {
  const badge   = document.getElementById('update-badge');
  const popover = document.getElementById('update-popover');
  document.getElementById('update-current').textContent = badge.dataset.current || '';
  document.getElementById('update-latest').textContent  = badge.dataset.latest  || '';
  const notes = badge.dataset.notes || '';
  document.getElementById('update-notes').textContent   = notes ? notes : '';
  document.getElementById('update-notes').style.display = notes ? '' : 'none';
  popover.classList.toggle('hidden');
}

async function applyUpdate() {
  const overlay = document.getElementById('update-overlay');
  const msg     = document.getElementById('update-overlay-msg');
  document.getElementById('update-popover').classList.add('hidden');
  overlay.classList.remove('hidden');
  msg.textContent = 'Aggiornamento in corso…';
  try {
    const res  = await apiFetch('/api/update/apply', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      msg.textContent = `Aggiornato a v${data.version}. Riavvio in corso…`;
      let secs = 15;
      const timer = setInterval(() => {
        secs--;
        msg.textContent = `Aggiornato a v${data.version}. Ricarico tra ${secs}s…`;
        if (secs <= 0) { clearInterval(timer); location.reload(); }
      }, 1000);
    } else {
      msg.textContent = `Errore: ${data.error || 'sconosciuto'}`;
      setTimeout(() => overlay.classList.add('hidden'), 4000);
    }
  } catch (_) {
    msg.textContent = 'Errore di connessione.';
    setTimeout(() => overlay.classList.add('hidden'), 4000);
  }
}
