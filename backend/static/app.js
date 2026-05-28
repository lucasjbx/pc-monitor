'use strict';

// ── Stato ────────────────────────────────────────────────────────────────────
let pcs             = [];
let positions       = {};
let selectedHost    = null;
let wolStatus       = {};     // hostname → null | 'sending' | 'sent' | 'error'
let shutdownStatus  = {};     // hostname → null | 'confirm' | 'sending' | 'ok' | 'error'
let fetching        = false;

// Stato editor
let editorPos       = {};
let editorSelected  = null;
let _drag           = null;   // { hostname, el } durante il trascinamento di un marker sulla mappa
let _sidebarDrag    = null;   // { hostname, ghostEl, startX, startY, moved } durante drag dalla lista

// Stato impostazioni
let settingsConfig  = {};          // copia locale della config durante editing
let settingsEditIdx = null;        // indice PC in modifica (-1 = nuovo)

// Stato zoom mappa
let zoom = 1.0;
let panX = 0;
let panY = 0;
let _pan = null;   // { startX, startY, startPanX, startPanY }

// Stato pannello PC list
let selectedPCs   = new Set();
let listCollapsed = localStorage.getItem('pcListCollapsed') === '1';
let listSortKey   = localStorage.getItem('pcListSort')    || 'hostname';
let listSortDir   = localStorage.getItem('pcListSortDir') || 'asc';

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

  // Editor posizioni
  document.getElementById('btn-editor-close').addEventListener('click', closeEditor);
  document.getElementById('btn-save-positions').addEventListener('click', savePositions);
  document.getElementById('editor-img').addEventListener('click', handleEditorClick);
  document.getElementById('editor-pc-list').addEventListener('click', handleEditorListClick);
  document.getElementById('editor-pc-list').addEventListener('mousedown', handleEditorListMousedown);

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
        const img  = document.getElementById('editor-img');
        const rect = img.getBoundingClientRect();
        const over = e.clientX >= rect.left && e.clientX <= rect.right &&
                     e.clientY >= rect.top  && e.clientY <= rect.bottom;
        img.classList.toggle('drop-target', over);
      }
    } else if (_drag) {
      const img  = document.getElementById('editor-img');
      const rect = img.getBoundingClientRect();
      const cx   = (e.clientX - rect.left) / rect.width;
      const cy   = (e.clientY - rect.top)  / rect.height;
      const x    = Math.max(0, Math.min(1, cx - _drag.offsetX));
      const y    = Math.max(0, Math.min(1, cy - _drag.offsetY));
      _drag.el.style.left = `${x * img.offsetWidth}px`;
      _drag.el.style.top  = `${y * img.offsetHeight}px`;
      editorPos[_drag.hostname] = { x, y };
    } else if (_pan) {
      panX = _pan.startPanX + (e.clientX - _pan.startX);
      panY = _pan.startPanY + (e.clientY - _pan.startY);
      applyTransform();
    }
  });
  document.addEventListener('mouseup', e => {
    if (_sidebarDrag) {
      const img = document.getElementById('editor-img');
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

  // Pan con mouse — drag sulla piantina (sempre attivo)
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

  // Modal setup Remote Desktop
  document.getElementById('btn-rdp-download').addEventListener('click', downloadRdpSetup);
  document.getElementById('btn-rdp-open').addEventListener('click', () => {
    localStorage.setItem('rdpSetupDone', '1');
    if (_rdpPendingIp) openRdpLink(_rdpPendingIp);
    closeRdpModal();
  });
  document.getElementById('btn-rdp-cancel').addEventListener('click', closeRdpModal);

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
    if (name) document.getElementById('sede-title').textContent = name;
  } catch {}
}

async function loadPositions() {
  try {
    const res = await apiFetch('/api/positions');
    positions = await res.json();
  } catch {}
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
  const placed = Object.keys(positions);
  const hasPos = placed.length > 0;
  document.getElementById('floorplan-wrapper').classList.toggle('hidden', !hasPos);
  document.getElementById('floorplan-empty').classList.toggle('hidden', hasPos);
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

  renderPcList();
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

  // Remote Desktop (solo se online e ha IP)
  if (pc.online && pc.ip) {
    const btn = document.createElement('button');
    btn.className   = 'btn-action rdp';
    btn.textContent = '🖥 Remote Desktop';
    btn.addEventListener('click', () => {
      if (localStorage.getItem('rdpSetupDone')) {
        openRdpLink(pc.ip);
      } else {
        showRdpModal(pc.ip);
      }
    });
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
function openRdpLink(ip) {
  // window.location.href non accetta protocolli custom → usiamo <a> cliccato
  // programmaticamente nel contesto di un gesto utente
  const a = document.createElement('a');
  a.href = `rdp://full%20address=s:${ip}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Modal setup Remote Desktop ────────────────────────────────────────────────
let _rdpPendingIp = null;

function showRdpModal(ip) {
  _rdpPendingIp = ip;
  document.getElementById('rdp-modal').classList.remove('hidden');
}

function closeRdpModal() {
  document.getElementById('rdp-modal').classList.add('hidden');
  _rdpPendingIp = null;
}

async function downloadRdpSetup() {
  // Scarica il file .reg tramite apiFetch (gestisce X-Api-Key)
  try {
    const res = await apiFetch('/api/rdp-setup.reg');
    if (!res.ok) return;
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'rdp-setup.reg';
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
let _editorResizeHandler = null;

function openEditor() {
  editorPos      = { ...positions };
  editorSelected = null;
  // Resetta stato del bottone salva (potrebbe essere rimasto disabled dal salvataggio precedente)
  const saveBtn = document.getElementById('btn-save-positions');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Salva';
  renderEditorSidebar();
  updateEditorInstruction();
  // PRIMA mostra l'overlay, POI renderizza i marker in pixel.
  // Con display:none il browser non esegue il layout → img.offsetWidth = 0.
  document.getElementById('editor-overlay').classList.remove('hidden');
  requestAnimationFrame(() => renderEditorMarkers());
  // Ricalcola i marker in pixel se la finestra viene ridimensionata
  if (_editorResizeHandler) window.removeEventListener('resize', _editorResizeHandler);
  _editorResizeHandler = () => renderEditorMarkers();
  window.addEventListener('resize', _editorResizeHandler);
}

function closeEditor() {
  if (_drag) { _drag.el.classList.remove('dragging'); _drag = null; }
  if (_editorResizeHandler) {
    window.removeEventListener('resize', _editorResizeHandler);
    _editorResizeHandler = null;
  }
  document.getElementById('editor-overlay').classList.add('hidden');
}

function handleEditorClick(e) {
  if (!editorSelected) return;
  const img  = document.getElementById('editor-img');
  const rect = img.getBoundingClientRect();
  const x    = (e.clientX - rect.left) / rect.width;
  const y    = (e.clientY - rect.top)  / rect.height;

  editorPos[editorSelected] = { x, y };

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
  const el  = document.getElementById('editor-instruction');
  const img = document.getElementById('editor-img');
  img.classList.remove('crosshair');
  el.textContent = 'Trascina un PC dalla lista sulla mappa per posizionarlo';
  el.className   = 'editor-instruction';
}

function renderEditorSidebar() {
  const allHosts = pcs.map(p => p.hostname);
  const placed   = allHosts.filter(h =>  editorPos[h]);
  const unplaced = allHosts.filter(h => !editorPos[h]);

  let html = '';
  if (unplaced.length > 0) {
    html += `<div class="editor-section-title">Da posizionare <span class="editor-count">${unplaced.length}</span></div>`;
    for (const h of unplaced) {
      html += `<div class="editor-pc-item${editorSelected === h ? ' active' : ''}" data-hostname="${h}">${h}</div>`;
    }
  }
  if (placed.length > 0) {
    html += `<div class="editor-section-title" style="margin-top:8px">Posizionati <span class="editor-count ok">${placed.length}</span></div>`;
    for (const h of placed) {
      html += `<div class="editor-pc-item placed${editorSelected === h ? ' active' : ''}" data-hostname="${h}">
                 <span>${h}</span>
                 <button class="editor-remove" data-hostname="${h}">×</button>
               </div>`;
    }
  }

  document.getElementById('editor-pc-list').innerHTML = html;
  document.getElementById('btn-save-positions').textContent = `Salva (${placed.length} PC)`;
}

function renderEditorMarkers() {
  const container = document.getElementById('editor-markers');
  const img       = document.getElementById('editor-img');
  container.innerHTML = '';

  // Usa i pixel REALI dell'immagine, non le percentuali del container CSS.
  // Questo elimina qualsiasi dipendenza dalle dimensioni del contenitore flex/wrapper.
  const iw = img.offsetWidth;
  const ih = img.offsetHeight;
  if (!iw || !ih) {
    // Immagine non ancora caricata: riprova al load
    img.addEventListener('load', renderEditorMarkers, { once: true });
    return;
  }

  for (const [hostname, pos] of Object.entries(editorPos)) {
    const el = document.createElement('div');
    el.className  = `editor-marker${editorSelected === hostname ? ' active' : ''}`;
    el.style.left = `${pos.x * iw}px`;
    el.style.top  = `${pos.y * ih}px`;
    el.dataset.hostname = hostname;

    const label = document.createElement('span');
    label.textContent = hostname;
    el.appendChild(label);

    // Bottone × per rimozione diretta dalla mappa
    const removeBtn = document.createElement('button');
    removeBtn.className   = 'editor-marker-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      delete editorPos[hostname];
      if (editorSelected === hostname) editorSelected = null;
      renderEditorSidebar();
      renderEditorMarkers();
      updateEditorInstruction();
    });
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
      if (e.target.closest('.editor-marker-remove')) return;
      e.preventDefault();
      e.stopPropagation();
      const img  = document.getElementById('editor-img');
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
  }
}

async function savePositions() {
  const btn = document.getElementById('btn-save-positions');
  btn.textContent = 'Salvataggio…';
  btn.disabled    = true;
  try {
    await apiFetch('/api/positions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(editorPos),
    });
    positions = { ...editorPos };
    renderMarkers();
    closeEditor();
  } catch {
    btn.textContent = '✕ Errore — riprova';
    btn.disabled    = false;
  }
}

// ── Impostazioni ──────────────────────────────────────────────────────────────
async function openSettings() {
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
  const tbody = document.getElementById('pcs-tbody');
  const pcsArr = settingsConfig.pcs || [];
  tbody.innerHTML = pcsArr.map((pc, i) =>
    `<tr>
      <td class="settings-cell">${escHtml(pc.hostname)}</td>
      <td class="settings-cell">${escHtml(pc.ip)}</td>
      <td class="settings-cell settings-mono">${escHtml(pc.mac)}</td>
      <td class="settings-cell">${escHtml(pc.manufacturer)}</td>
      <td class="settings-cell settings-cell-actions">
        <button class="settings-row-btn" onclick="showEditPcForm(${i})">✎</button>
        <button class="settings-row-btn settings-row-btn-del" onclick="deletePc(${i})">✕</button>
      </td>
    </tr>`
  ).join('');
}

function showAddPcForm() {
  settingsEditIdx = -1;
  document.getElementById('pc-form-hostname').value     = '';
  document.getElementById('pc-form-ip').value           = '';
  document.getElementById('pc-form-mac').value          = '';
  document.getElementById('pc-form-manufacturer').value = '';
  document.getElementById('btn-pc-form-ok').textContent = 'Aggiungi';
  document.getElementById('pc-form').classList.remove('hidden');
  document.getElementById('pc-form-hostname').focus();
}

function showEditPcForm(idx) {
  settingsEditIdx = idx;
  const pc = (settingsConfig.pcs || [])[idx];
  if (!pc) return;
  document.getElementById('pc-form-hostname').value     = pc.hostname     || '';
  document.getElementById('pc-form-ip').value           = pc.ip           || '';
  document.getElementById('pc-form-mac').value          = pc.mac          || '';
  document.getElementById('pc-form-manufacturer').value = pc.manufacturer || '';
  document.getElementById('btn-pc-form-ok').textContent = 'Aggiorna';
  document.getElementById('pc-form').classList.remove('hidden');
  document.getElementById('pc-form-hostname').focus();
}

function hidePcForm() {
  document.getElementById('pc-form').classList.add('hidden');
  settingsEditIdx = null;
}

function confirmPcForm() {
  const pc = {
    hostname:     document.getElementById('pc-form-hostname').value.trim(),
    ip:           document.getElementById('pc-form-ip').value.trim(),
    mac:          document.getElementById('pc-form-mac').value.trim(),
    manufacturer: document.getElementById('pc-form-manufacturer').value.trim(),
  };
  if (!pc.hostname) {
    document.getElementById('pc-form-hostname').focus();
    return;
  }
  if (!settingsConfig.pcs) settingsConfig.pcs = [];

  if (settingsEditIdx === -1) {
    // Verifica hostname duplicato
    if (settingsConfig.pcs.some(p => p.hostname === pc.hostname)) {
      alert(`Hostname "${pc.hostname}" già presente.`);
      return;
    }
    settingsConfig.pcs.push(pc);
  } else {
    settingsConfig.pcs[settingsEditIdx] = pc;
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
      document.getElementById('editor-img').src                 = `/api/floorplan?t=${ts}`;
      document.getElementById('floorplan-img').src              = `/api/floorplan?t=${ts}`;
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
