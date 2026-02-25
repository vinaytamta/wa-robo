(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────
  const state = {
    groups: [],
    selectedGroups: [],   // array of { jid, name }
    groupSearch: '',
    jobs: [],
    queueFilter: '',
    waStatus: 'unknown',
    qrDataUrl: null,
    imageFile: null,
    sendMode: 'now',      // 'now' | 'schedule'
    submitting: false
  };

  // ── Element refs ───────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = {
    waBadge:       $('wa-badge'),
    waInfo:        $('wa-info'),
    btnConnect:    $('btn-connect'),
    btnDisconnect: $('btn-disconnect'),
    qrWrap:        $('qr-wrap'),
    qrImg:         $('qr-img'),

    msTrigger:    $('ms-trigger'),
    msLabel:      $('ms-label'),
    msDropdown:   $('ms-dropdown'),
    msSearch:     $('ms-search'),
    msList:       $('ms-list'),
    chipsWrap:    $('chips-wrap'),

    msgText:      $('msg-text'),
    msgImage:     $('msg-image'),
    imageName:    $('image-name'),
    btnClearImage:$('btn-clear-image'),

    scheduleField:$('schedule-field'),
    scheduleAt:   $('schedule-at'),

    composeError: $('compose-error'),
    btnSubmit:    $('btn-submit'),
    submitStatus: $('submit-status'),

    queueTabs:    $('queue-tabs'),
    queueBody:    $('queue-body'),
    queueEmptyRow:$('queue-empty-row')
  };

  // ── Utility ────────────────────────────────────────────
  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  async function apiFetch(path, opts = {}) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
    return data;
  }

  function showError(msg) {
    el.composeError.textContent = msg;
    el.composeError.style.display = msg ? 'block' : 'none';
  }

  // ── WhatsApp status ────────────────────────────────────
  async function loadWhatsAppStatus() {
    try {
      const data = await apiFetch('/api/whatsapp/status');
      applyWaStatus(data.status, data.phoneNumber);
    } catch (e) {
      applyWaStatus('unknown');
    }
  }

  function applyWaStatus(status, phoneNumber) {
    state.waStatus = status;

    const connected = status === 'connected' || status === 'ready';
    const connecting = status === 'connecting' || status === 'qr';

    // Badge
    el.waBadge.className = 'pill';
    if (connected) {
      el.waBadge.classList.add('pill-connected');
      el.waBadge.textContent = 'Connected';
    } else if (connecting) {
      el.waBadge.classList.add('pill-connecting');
      el.waBadge.textContent = 'Connecting…';
    } else {
      el.waBadge.classList.add('pill-disconnected');
      el.waBadge.textContent = 'Disconnected';
    }

    // Buttons
    el.btnConnect.style.display = connected ? 'none' : '';
    el.btnDisconnect.style.display = connected ? '' : 'none';

    // Info
    el.waInfo.textContent = phoneNumber ? `Connected as ${phoneNumber}` : '';

    if (connected) {
      el.qrWrap.style.display = 'none';
      loadGroups();
    }
  }

  async function showQr() {
    try {
      const data = await apiFetch('/api/whatsapp/qr');
      if (data.qr) {
        // qr may arrive as a data URI or raw base64
        el.qrImg.src = data.qr.startsWith('data:') ? data.qr : `data:image/png;base64,${data.qr}`;
        el.qrWrap.style.display = 'block';
      }
    } catch (_) {
      // QR not yet available — will arrive via SSE
    }
  }

  function subscribeWhatsAppSSE() {
    const source = new EventSource('/api/whatsapp/events');

    source.addEventListener('qr', (e) => {
      try {
        const payload = JSON.parse(e.data);
        const raw = payload.qr || payload.data || payload;
        el.qrImg.src = typeof raw === 'string' && raw.startsWith('data:')
          ? raw
          : `data:image/png;base64,${raw}`;
        el.qrWrap.style.display = 'block';
        applyWaStatus('connecting');
      } catch (_) {}
    });

    source.addEventListener('ready', (e) => {
      try {
        const payload = JSON.parse(e.data);
        applyWaStatus('connected', payload.phoneNumber);
      } catch (_) {
        applyWaStatus('connected');
      }
      el.qrWrap.style.display = 'none';
    });

    source.addEventListener('connected', (e) => {
      try {
        const payload = JSON.parse(e.data);
        applyWaStatus('connected', payload.phoneNumber);
      } catch (_) {
        applyWaStatus('connected');
      }
      el.qrWrap.style.display = 'none';
    });

    source.addEventListener('disconnected', () => {
      applyWaStatus('disconnected');
      state.groups = [];
      state.selectedGroups = [];
      renderGroupList();
      renderChips();
    });

    source.onerror = () => {};
  }

  // ── Groups multi-select ────────────────────────────────
  async function loadGroups() {
    try {
      const data = await apiFetch('/api/whatsapp/groups');
      state.groups = data.groups || data || [];
      renderGroupList();
    } catch (_) {
      state.groups = [];
    }
  }

  function renderGroupList() {
    const q = state.groupSearch.toLowerCase();
    const filtered = state.groups.filter((g) =>
      (g.name || g.subject || '').toLowerCase().includes(q)
    );

    if (filtered.length === 0) {
      el.msList.innerHTML = `<div class="ms-empty">${state.groups.length === 0 ? 'No groups loaded.' : 'No results.'}</div>`;
      return;
    }

    el.msList.innerHTML = filtered.map((g) => {
      const jid = g.id || g.jid;
      const name = escHtml(g.name || g.subject || jid);
      const checked = state.selectedGroups.some((s) => s.jid === jid) ? 'checked' : '';
      return `<label class="ms-item">
        <input type="checkbox" data-jid="${escHtml(jid)}" data-name="${name}" ${checked} />
        ${name}
      </label>`;
    }).join('');

    el.msList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const jid = cb.dataset.jid;
        const name = cb.dataset.name;
        if (cb.checked) {
          if (!state.selectedGroups.some((s) => s.jid === jid)) {
            state.selectedGroups.push({ jid, name });
          }
        } else {
          state.selectedGroups = state.selectedGroups.filter((s) => s.jid !== jid);
        }
        updateMsLabel();
        renderChips();
      });
    });
  }

  function updateMsLabel() {
    const n = state.selectedGroups.length;
    el.msLabel.textContent = n === 0 ? 'Select groups…' : `${n} group${n > 1 ? 's' : ''} selected`;
  }

  function renderChips() {
    el.chipsWrap.innerHTML = state.selectedGroups.map((g) =>
      `<span class="chip">
        ${escHtml(g.name)}
        <button class="chip-remove" data-jid="${escHtml(g.jid)}" title="Remove" type="button">✕</button>
      </span>`
    ).join('');

    el.chipsWrap.querySelectorAll('.chip-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedGroups = state.selectedGroups.filter((s) => s.jid !== btn.dataset.jid);
        renderGroupList();
        updateMsLabel();
        renderChips();
      });
    });
  }

  function setupMultiselect() {
    el.msTrigger.addEventListener('click', () => toggleDropdown());
    el.msTrigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDropdown(); }
    });

    el.msSearch.addEventListener('input', () => {
      state.groupSearch = el.msSearch.value;
      renderGroupList();
    });

    document.addEventListener('click', (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.includes($('ms-root'))) closeDropdown();
    });
  }

  function toggleDropdown() {
    const open = !el.msDropdown.hidden;
    open ? closeDropdown() : openDropdown();
  }

  function openDropdown() {
    el.msDropdown.hidden = false;
    el.msTrigger.classList.add('open');
    el.msSearch.value = '';
    state.groupSearch = '';
    renderGroupList();
    el.msSearch.focus();
  }

  function closeDropdown() {
    el.msDropdown.hidden = true;
    el.msTrigger.classList.remove('open');
  }

  // ── Send / Schedule ────────────────────────────────────
  function setupSendMode() {
    document.querySelectorAll('input[name="send-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        state.sendMode = radio.value;
        el.scheduleField.style.display = state.sendMode === 'schedule' ? 'block' : 'none';
        el.btnSubmit.textContent = state.sendMode === 'schedule' ? 'Schedule Message' : 'Send Now';
      });
    });
  }

  async function handleSubmit() {
    showError('');
    el.submitStatus.textContent = '';

    if (state.submitting) return;
    if (state.selectedGroups.length === 0) { showError('Select at least one group.'); return; }
    const msgText = el.msgText.value.trim();
    if (!msgText) { showError('Message cannot be empty.'); return; }

    if (state.sendMode === 'schedule') {
      const dtVal = el.scheduleAt.value;
      if (!dtVal) { showError('Please choose a schedule date and time.'); return; }
      const dt = new Date(dtVal);
      if (dt <= new Date()) { showError('Scheduled time must be in the future.'); return; }
      await scheduleMessages(msgText, dt.toISOString());
    } else {
      await sendNowMessages(msgText);
    }
  }

  async function sendNowMessages(msgText) {
    state.submitting = true;
    el.btnSubmit.disabled = true;
    el.submitStatus.textContent = `Sending to ${state.selectedGroups.length} group(s)…`;

    let ok = 0, fail = 0;
    for (const g of state.selectedGroups) {
      try {
        const fd = new FormData();
        fd.append('groupJid', g.jid);
        fd.append('groupName', g.name);
        fd.append('messageText', msgText);
        if (state.imageFile) fd.append('image', state.imageFile);
        await fetch('/api/posting/send-now', { method: 'POST', body: fd });
        ok++;
      } catch (_) {
        fail++;
      }
    }

    state.submitting = false;
    el.btnSubmit.disabled = false;
    el.submitStatus.textContent = fail === 0
      ? `Sent to ${ok} group(s).`
      : `Sent ${ok}, failed ${fail}.`;
    if (fail === 0) {
      el.msgText.value = '';
      clearImage();
    }
  }

  async function scheduleMessages(msgText, scheduledAt) {
    state.submitting = true;
    el.btnSubmit.disabled = true;
    el.submitStatus.textContent = `Scheduling ${state.selectedGroups.length} group(s)…`;

    let ok = 0, fail = 0;
    for (const g of state.selectedGroups) {
      try {
        await apiFetch('/api/posting/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageText: msgText,
            groupJid: g.jid,
            groupName: g.name,
            scheduledAt
          })
        });
        ok++;
      } catch (_) {
        fail++;
      }
    }

    state.submitting = false;
    el.btnSubmit.disabled = false;
    el.submitStatus.textContent = fail === 0
      ? `Scheduled ${ok} group(s).`
      : `Scheduled ${ok}, failed ${fail}.`;
    if (fail === 0) {
      el.msgText.value = '';
      el.scheduleAt.value = '';
      clearImage();
    }
  }

  // ── Image ──────────────────────────────────────────────
  function clearImage() {
    state.imageFile = null;
    el.msgImage.value = '';
    el.imageName.textContent = 'No file chosen';
    el.btnClearImage.style.display = 'none';
  }

  // ── Queue ──────────────────────────────────────────────
  async function loadJobs() {
    try {
      const data = await apiFetch('/api/posting/jobs');
      state.jobs = data.jobs || data || [];
      renderQueue();
    } catch (_) {}
  }

  function upsertJob(job) {
    const idx = state.jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) state.jobs[idx] = job;
    else state.jobs.unshift(job);
    renderQueue();
  }

  function subscribePostingSSE() {
    const source = new EventSource('/api/posting/events');

    source.addEventListener('init', (e) => {
      try {
        const payload = JSON.parse(e.data);
        state.jobs = payload.jobs || payload || [];
        renderQueue();
      } catch (_) {}
    });

    source.addEventListener('update', (e) => {
      try {
        const payload = JSON.parse(e.data);
        const job = payload.job || payload;
        if (job && job.id != null) upsertJob(job);
      } catch (_) {}
    });

    source.onerror = () => {};
  }

  function renderQueue() {
    const filter = state.queueFilter;
    const filtered = state.jobs
      .filter((j) => !filter || j.status === filter)
      .sort((a, b) => new Date(b.createdAt || b.scheduledAt || 0) - new Date(a.createdAt || a.scheduledAt || 0));

    if (filtered.length === 0) {
      el.queueBody.innerHTML = `<tr><td colspan="5" class="empty-cell">No messages${filter ? ` with status "${filter}"` : ''} yet.</td></tr>`;
      return;
    }

    el.queueBody.innerHTML = filtered.map((j) => {
      const status = j.status || 'unknown';
      const groupName = escHtml(j.groupName || j.group_name || j.groupJid || '—');
      const msgPreview = escHtml((j.messageText || j.message_text || '').substring(0, 80));
      const time = fmtDate(j.scheduledAt || j.scheduled_at || j.sentAt || j.sent_at || j.createdAt);
      const canCancel = status === 'scheduled' || status === 'queued' || status === 'uploaded';
      return `<tr>
        <td>${groupName}</td>
        <td class="td-msg" title="${escHtml(j.messageText || j.message_text || '')}">${msgPreview}</td>
        <td style="white-space:nowrap">${time}</td>
        <td><span class="pill pill-${escHtml(status)}">${escHtml(status)}</span></td>
        <td>${canCancel ? `<button class="btn btn-danger btn-sm" data-cancel-id="${j.id}">Cancel</button>` : '—'}</td>
      </tr>`;
    }).join('');

    el.queueBody.querySelectorAll('[data-cancel-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await apiFetch('/api/posting/jobs/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [Number(btn.dataset.cancelId)] })
          });
          // SSE will update — optimistically update local state too
          const job = state.jobs.find((j) => j.id === Number(btn.dataset.cancelId));
          if (job) { job.status = 'cancelled'; renderQueue(); }
        } catch (e) {
          btn.disabled = false;
          alert(`Failed to cancel: ${e.message}`);
        }
      });
    });
  }

  // ── Event listeners ────────────────────────────────────
  function setupEventListeners() {
    el.btnConnect.addEventListener('click', async () => {
      el.btnConnect.disabled = true;
      try {
        await apiFetch('/api/whatsapp/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        applyWaStatus('connecting');
        await showQr();
      } catch (e) {
        alert(`Connect failed: ${e.message}`);
      } finally {
        el.btnConnect.disabled = false;
      }
    });

    el.btnDisconnect.addEventListener('click', async () => {
      el.btnDisconnect.disabled = true;
      try {
        await apiFetch('/api/whatsapp/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        applyWaStatus('disconnected');
      } catch (e) {
        alert(`Disconnect failed: ${e.message}`);
      } finally {
        el.btnDisconnect.disabled = false;
      }
    });

    el.msgImage.addEventListener('change', () => {
      const file = el.msgImage.files[0] || null;
      state.imageFile = file;
      el.imageName.textContent = file ? file.name : 'No file chosen';
      el.btnClearImage.style.display = file ? '' : 'none';
    });

    el.btnClearImage.addEventListener('click', clearImage);

    el.btnSubmit.addEventListener('click', handleSubmit);

    el.queueTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      state.queueFilter = tab.dataset.filter;
      el.queueTabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      renderQueue();
    });
  }

  // ── Init ───────────────────────────────────────────────
  async function init() {
    await loadWhatsAppStatus();
    if (state.waStatus === 'connected' || state.waStatus === 'ready') {
      await loadGroups();
    }
    await loadJobs();
    subscribeWhatsAppSSE();
    subscribePostingSSE();
    setupMultiselect();
    setupSendMode();
    setupEventListeners();
  }

  init();
})();
