const MUTABLE_STATUSES = new Set(['uploaded', 'queued', 'scheduled', 'failed', 'cancelled', 'sent']);
const EDITABLE_COLS = ['row_id', 'message_text', 'group', 'scheduled_at'];

const state = {
  jobs: [],
  groups: [],
  statusFilter: '',
  search: '',
  editingCell: null,
  focusedCell: null,
  selectionRange: null,
  clipboardData: null,
  cutMode: false
};

const el = {
  waStatus: document.getElementById('wa-status'),
  waInfo: document.getElementById('wa-info'),
  randomDelayMax: document.getElementById('random-delay-max'),
  csvFile: document.getElementById('csv-file'),
  csvPreviewOutput: document.getElementById('csv-preview-output'),
  pasteInput: document.getElementById('paste-input'),
  jobsTableBody: document.getElementById('jobs-table-body'),
  statusFilter: document.getElementById('status-filter'),
  searchInput: document.getElementById('search-input'),
  selectAll: document.getElementById('select-all')
};

function rowToLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocalDate(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (trimmed.includes('T')) return trimmed;
  return trimmed.replace(' ', 'T');
}

function nextDefaultScheduledAt() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || 'Request failed');
  return data;
}

async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function selectedIds() {
  return Array.from(document.querySelectorAll('input[data-job-select="1"]:checked'))
    .map((item) => Number(item.value))
    .filter(Number.isFinite);
}

async function loadSettings() {
  const data = await api('/api/posting/settings');
  el.randomDelayMax.value = String(data.settings?.randomDelayMaxMinutes || 0);
}

async function loadWhatsappStatus() {
  const data = await api('/api/whatsapp/status');
  el.waStatus.textContent = `Status: ${data.status}`;
  el.waInfo.textContent = data.phoneNumber ? `Connected as ${data.phoneNumber}` : 'Not connected';
}

async function loadJobs() {
  const params = new URLSearchParams();
  if (state.statusFilter) params.set('status', state.statusFilter);
  if (state.search) params.set('search', state.search);
  const data = await api(`/api/posting/jobs?${params.toString()}`);
  state.jobs = data.jobs || [];
  renderJobs();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isJobEditable(job) {
  return MUTABLE_STATUSES.has(job.status);
}

function getGroupDisplayValue(job) {
  return [job.groupJid, job.groupName || job.resolvedGroup?.name].filter(Boolean).join(' / ');
}

function getCellValue(job, col) {
  switch (col) {
    case 'row_id': return job.rowId || '';
    case 'message_text': return job.messageText || '';
    case 'group': return getGroupDisplayValue(job);
    case 'scheduled_at': return rowToLocalInputValue(job.scheduledAt);
    default: return '';
  }
}

function parseGroupInput(value) {
  const v = String(value || '').trim();
  if (v.includes('@')) return { groupJid: v, groupName: '' };
  return { groupJid: '', groupName: v };
}

function renderJobs() {
  const rows = state.jobs.map((job, rowIndex) => {
    const editable = isJobEditable(job);
    const editing = state.editingCell?.jobId === job.id && state.editingCell?.col;

    const cell = (col, displayValue, extraClass = '') => {
      const isEditable = editable && EDITABLE_COLS.includes(col);
      const isEditing = editing === col;
      const cellContent = isEditing
        ? (col === 'message_text'
          ? `<textarea class="cell-edit" data-col="${col}" data-job-id="${job.id}" rows="2">${escapeHtml(getCellValue(job, col))}</textarea>`
          : `<input class="cell-edit" type="text" data-col="${col}" data-job-id="${job.id}" value="${escapeHtml(getCellValue(job, col))}" />`)
        : `<span class="cell-value" data-col="${col}" data-job-id="${job.id}" data-row-index="${rowIndex}" tabindex="${isEditable ? 0 : -1}">${escapeHtml(displayValue)}</span>`;

      const cls = ['editable-cell', extraClass].filter(Boolean).join(' ');
      const focusCls = state.focusedCell?.jobId === job.id && state.focusedCell?.col === col ? ' cell-focused' : '';
      const selectCls = isCellInSelection(job.id, col) ? ' cell-selected' : '';

      return `<td class="${cls}${focusCls}${selectCls}" data-col="${col}" data-job-id="${job.id}" data-row-index="${rowIndex}">${cellContent}</td>`;
    };

    const msgDisplay = (job.messageText || '').slice(0, 90);
    return `
      <tr data-job-id="${job.id}" data-row-index="${rowIndex}">
        <td><input type="checkbox" data-job-select="1" value="${job.id}" /></td>
        <td>${job.id}</td>
        ${cell('row_id', job.rowId || '')}
        ${cell('message_text', msgDisplay)}
        ${cell('group', getGroupDisplayValue(job))}
        ${cell('scheduled_at', rowToLocalInputValue(job.scheduledAt))}
        <td>${job.randomDelayAppliedMs || 0}</td>
        <td>${escapeHtml(rowToLocalInputValue(job.actualSendAt))}</td>
        <td><span class="status">${escapeHtml(job.status)}</span></td>
        <td>${escapeHtml(job.statusReason || '')}</td>
        <td>${(job.revisions || []).length}</td>
        <td>
          <button class="secondary" data-revisions="${job.id}">History</button>
        </td>
      </tr>
    `;
  }).join('');

  el.jobsTableBody.innerHTML = rows || '<tr><td colspan="12">No rows found.</td></tr>';

  if (state.editingCell) {
    requestAnimationFrame(() => {
      const inp = el.jobsTableBody.querySelector(`.cell-edit[data-job-id="${state.editingCell.jobId}"][data-col="${state.editingCell.col}"]`);
      if (inp) {
        inp.focus();
        inp.select?.();
      }
    });
  }
}

function isCellInSelection(jobId, col) {
  if (!state.selectionRange) return false;
  const { start, end } = state.selectionRange;
  const rows = state.jobs;
  const startRow = Math.min(start.row, end.row);
  const endRow = Math.max(start.row, end.row);
  const startColIdx = Math.min(EDITABLE_COLS.indexOf(start.col), EDITABLE_COLS.indexOf(end.col));
  const endColIdx = Math.max(EDITABLE_COLS.indexOf(start.col), EDITABLE_COLS.indexOf(end.col));
  const colIdx = EDITABLE_COLS.indexOf(col);
  const job = state.jobs.find(j => j.id === jobId);
  if (!job) return false;
  const rowIdx = state.jobs.findIndex(j => j.id === jobId);
  return rowIdx >= startRow && rowIdx <= endRow && colIdx >= startColIdx && colIdx <= endColIdx;
}

function getEditableCells() {
  return Array.from(el.jobsTableBody.querySelectorAll('.editable-cell[data-job-id][data-col]'));
}

function getCellInfo(td) {
  if (!td) return null;
  const jobId = Number(td.getAttribute('data-job-id'));
  const col = td.getAttribute('data-col');
  const rowIndex = Number(td.getAttribute('data-row-index'));
  if (!jobId || !col) return null;
  return { jobId, col, rowIndex };
}

function findCellAt(rowIndex, colIndex) {
  const col = EDITABLE_COLS[colIndex];
  if (!col) return null;
  const row = el.jobsTableBody.querySelector(`tr[data-row-index="${rowIndex}"]`);
  if (!row) return null;
  return row.querySelector(`td[data-col="${col}"]`);
}

function commitCellEdit(jobId, col, value) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job || !isJobEditable(job)) return;

  const updates = {};
  switch (col) {
    case 'row_id': updates.rowId = String(value || '').trim(); break;
    case 'message_text': updates.messageText = String(value || '').trim(); break;
    case 'group': {
      const { groupJid, groupName } = parseGroupInput(value);
      updates.groupJid = groupJid;
      updates.groupName = groupName;
      break;
    }
    case 'scheduled_at': updates.scheduledAt = parseLocalDate(value); break;
    default: return;
  }

  api(`/api/posting/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates)
  }).then(() => loadJobs()).catch((err) => alert(err.message));
}

function startEditCell(jobId, col) {
  const job = state.jobs.find(j => j.id === jobId);
  if (!job || !isJobEditable(job)) return;
  state.editingCell = { jobId, col };
  state.focusedCell = { jobId, col };
  renderJobs();
}

function stopEditCell() {
  state.editingCell = null;
  renderJobs();
}

function setupCellEditing() {
  el.jobsTableBody.addEventListener('click', (e) => {
    const revisionsBtn = e.target?.closest('[data-revisions]');
    if (revisionsBtn) {
      const id = revisionsBtn.getAttribute('data-revisions');
      api(`/api/posting/jobs/${id}/revisions`).then((data) => {
        alert(JSON.stringify(data.revisions || [], null, 2));
      });
      return;
    }

    const td = e.target?.closest('.editable-cell');
    const cellInfo = getCellInfo(td);
    if (cellInfo && isJobEditable(state.jobs.find(j => j.id === cellInfo.jobId))) {
      if (!state.editingCell || state.editingCell.jobId !== cellInfo.jobId || state.editingCell.col !== cellInfo.col) {
        startEditCell(cellInfo.jobId, cellInfo.col);
      }
    }
  });

  el.jobsTableBody.addEventListener('blur', (e) => {
    const inp = e.target?.closest('.cell-edit');
    if (!inp) return;
    if (e.relatedTarget?.closest?.('.cell-edit')) return;
    const jobId = Number(inp.getAttribute('data-job-id'));
    const col = inp.getAttribute('data-col');
    const value = inp.value;
    commitCellEdit(jobId, col, value);
    stopEditCell();
  }, true);

  el.jobsTableBody.addEventListener('keydown', (e) => {
    const inp = e.target?.closest('.cell-edit');
    if (inp) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const jobId = Number(inp.getAttribute('data-job-id'));
        const col = inp.getAttribute('data-col');
        commitCellEdit(jobId, col, inp.value);
        stopEditCell();
        moveFocus(e.shiftKey ? -1 : 1, 0);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        stopEditCell();
      }
      return;
    }

    const td = e.target?.closest('.editable-cell');
    const cellInfo = getCellInfo(td);
    if (!cellInfo) return;

    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEditCell(cellInfo.jobId, cellInfo.col);
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      moveFocus(e.shiftKey ? -1 : 1, 0);
      return;
    }

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      moveFocus(dx, dy);
      return;
    }

    if (!e.ctrlKey && !e.metaKey && /^[\x20-\x7E]$/.test(e.key)) {
      e.preventDefault();
      startEditCell(cellInfo.jobId, cellInfo.col);
      const editInp = el.jobsTableBody.querySelector(`.cell-edit[data-job-id="${cellInfo.jobId}"][data-col="${cellInfo.col}"]`);
      if (editInp) {
        editInp.value = e.key;
        editInp.focus();
      }
    }
  });

  el.jobsTableBody.addEventListener('keydown', handleCopyPasteKeydown);
  el.jobsTableBody.addEventListener('paste', handlePaste);
}

function moveFocus(dx, dy) {
  if (!state.focusedCell) {
    const first = el.jobsTableBody.querySelector('.editable-cell');
    if (first) {
      const info = getCellInfo(first);
      if (info) state.focusedCell = { jobId: info.jobId, col: info.col };
    }
    renderJobs();
    return;
  }

  const rowIdx = state.jobs.findIndex(j => j.id === state.focusedCell.jobId);
  let colIdx = EDITABLE_COLS.indexOf(state.focusedCell.col);
  colIdx += dx;
  let newRowIdx = rowIdx + dy;

  if (colIdx >= EDITABLE_COLS.length) {
    colIdx = 0;
    newRowIdx++;
  } else if (colIdx < 0) {
    colIdx = EDITABLE_COLS.length - 1;
    newRowIdx--;
  }

  newRowIdx = Math.max(0, Math.min(state.jobs.length - 1, newRowIdx));
  colIdx = Math.max(0, Math.min(EDITABLE_COLS.length - 1, colIdx));
  const newCol = EDITABLE_COLS[colIdx];
  const newJob = state.jobs[newRowIdx];
  if (newJob && newCol) {
    state.focusedCell = { jobId: newJob.id, col: newCol };
    if (!state.selectionRange) state.selectionRange = { start: { row: newRowIdx, col: newCol }, end: { row: newRowIdx, col: newCol } };
    else state.selectionRange.end = { row: newRowIdx, col: newCol };
    renderJobs();
    requestAnimationFrame(() => {
      const cell = findCellAt(newRowIdx, colIdx);
      cell?.querySelector('.cell-value')?.focus();
    });
  }
}

function handleCopyPasteKeydown(e) {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.key === 'c') {
    e.preventDefault();
    doCopy();
  } else if (e.key === 'v') {
    e.preventDefault();
    doPaste();
  } else if (e.key === 'x') {
    e.preventDefault();
    doCut();
  }
}

function getSelectionOrFocused() {
  if (state.selectionRange) {
    const { start, end } = state.selectionRange;
    const cells = [];
    const cutCells = [];
    const startRow = Math.min(start.row, end.row);
    const endRow = Math.max(start.row, end.row);
    const startColIdx = Math.min(EDITABLE_COLS.indexOf(start.col), EDITABLE_COLS.indexOf(end.col));
    const endColIdx = Math.max(EDITABLE_COLS.indexOf(start.col), EDITABLE_COLS.indexOf(end.col));
    for (let r = startRow; r <= endRow; r++) {
      const row = [];
      const job = state.jobs[r];
      for (let c = startColIdx; c <= endColIdx; c++) {
        const col = EDITABLE_COLS[c];
        if (job) {
          row.push(getCellValue(job, col));
          cutCells.push({ jobId: job.id, col });
        }
      }
      cells.push(row);
    }
    return { cells, jobIds: state.jobs.slice(startRow, endRow + 1).map(j => j.id), cutCells };
  }
  if (state.focusedCell) {
    const job = state.jobs.find(j => j.id === state.focusedCell.jobId);
    if (job) return {
      cells: [[getCellValue(job, state.focusedCell.col)]],
      jobIds: [job.id],
      cutCells: [{ jobId: job.id, col: state.focusedCell.col }]
    };
  }
  return null;
}

function doCopy() {
  const sel = getSelectionOrFocused();
  if (!sel) return;
  const tsv = sel.cells.map(row => row.join('\t')).join('\n');
  state.clipboardData = { tsv, cells: sel.cells, jobIds: sel.jobIds, cutCells: sel.cutCells || [] };
  state.cutMode = false;
  navigator.clipboard?.writeText(tsv).catch(() => {});
}

function doCut() {
  doCopy();
  state.cutMode = true;
}

async function doPaste() {
  let tsv = state.clipboardData?.tsv;
  if (!tsv) {
    try {
      tsv = await navigator.clipboard.readText();
    } catch {
      return;
    }
  }
  if (!tsv?.trim()) return;

  const rows = tsv.split(/\r?\n/).map(line => line.split(/\t/));
  const anchor = state.focusedCell || (state.selectionRange && { jobId: state.jobs[state.selectionRange.start.row]?.id, col: state.selectionRange.start.col });
  if (!anchor) return;

  const anchorJob = state.jobs.find(j => j.id === anchor.jobId);
  const anchorRowIdx = state.jobs.findIndex(j => j.id === anchor.jobId);
  const anchorColIdx = EDITABLE_COLS.indexOf(anchor.col);
  if (anchorRowIdx < 0 || anchorColIdx < 0) return;

  if (rows.length === 1 && rows[0].length === 1) {
    const value = rows[0][0];
    if (isJobEditable(anchorJob)) {
      commitCellEdit(anchor.jobId, anchor.col, value);
    }
    if (state.cutMode && state.clipboardData?.cutCells?.length) {
      for (const { jobId, col } of state.clipboardData.cutCells) {
        if (jobId !== anchor.jobId || col !== anchor.col) {
          const job = state.jobs.find(j => j.id === jobId);
          if (job && isJobEditable(job)) {
            const updates = {};
            switch (col) {
              case 'row_id': updates.rowId = ''; break;
              case 'message_text': updates.messageText = ''; break;
              case 'group': updates.groupJid = ''; updates.groupName = ''; break;
              case 'scheduled_at': updates.scheduledAt = nextDefaultScheduledAt(); break;
            }
            if (Object.keys(updates).length) {
              api(`/api/posting/jobs/${jobId}`, { method: 'PATCH', body: JSON.stringify(updates) }).catch(() => {});
            }
          }
        }
      }
    }
    state.clipboardData = null;
    state.cutMode = false;
    await loadJobs();
    return;
  }

  const newRows = [];
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r];
    const targetRowIdx = anchorRowIdx + r;
    const targetJob = state.jobs[targetRowIdx];

    if (targetJob && isJobEditable(targetJob)) {
      const updates = {};
      for (let c = 0; c < cells.length && anchorColIdx + c < EDITABLE_COLS.length; c++) {
        const col = EDITABLE_COLS[anchorColIdx + c];
        const val = cells[c] ?? '';
        switch (col) {
          case 'row_id': updates.rowId = val; break;
          case 'message_text': updates.messageText = val; break;
          case 'group': Object.assign(updates, parseGroupInput(val)); break;
          case 'scheduled_at': updates.scheduledAt = parseLocalDate(val); break;
        }
      }
      if (Object.keys(updates).length) {
        await api(`/api/posting/jobs/${targetJob.id}`, { method: 'PATCH', body: JSON.stringify(updates) });
      }
    } else if (targetRowIdx >= state.jobs.length) {
      const row = {
        row_id: cells[0] ?? '',
        message_text: cells[1] ?? '(new)',
        group_name: cells[2] ?? '(required)',
        scheduled_at: parseLocalDate(cells[3]) || nextDefaultScheduledAt()
      };
      newRows.push(row);
    }
  }

  if (newRows.length) {
    await api('/api/posting/jobs', { method: 'POST', body: JSON.stringify({ rows: newRows }) });
  }

  if (state.cutMode && state.clipboardData?.cutCells?.length) {
    for (const { jobId, col } of state.clipboardData.cutCells) {
      const job = state.jobs.find(j => j.id === jobId);
      if (job && isJobEditable(job)) {
        const updates = {};
        switch (col) {
          case 'row_id': updates.rowId = ''; break;
          case 'message_text': updates.messageText = ''; break;
          case 'group': updates.groupJid = ''; updates.groupName = ''; break;
          case 'scheduled_at': updates.scheduledAt = nextDefaultScheduledAt(); break;
        }
        if (Object.keys(updates).length) {
          try {
            await api(`/api/posting/jobs/${jobId}`, { method: 'PATCH', body: JSON.stringify(updates) });
          } catch (_) {}
        }
      }
    }
  }

  state.clipboardData = null;
  state.cutMode = false;
  await loadJobs();
}

function handlePaste(e) {
  const inp = e.target?.closest('.cell-edit');
  if (inp) return;
  const td = e.target?.closest('.editable-cell');
  if (td) {
    e.preventDefault();
    doPaste();
  }
}

el.jobsTableBody.addEventListener('mousedown', (e) => {
  const td = e.target?.closest('.editable-cell');
  const info = getCellInfo(td);
  if (info) {
    state.focusedCell = { jobId: info.jobId, col: info.col };
    if (e.shiftKey) {
      if (!state.selectionRange) state.selectionRange = { start: { row: info.rowIndex, col: info.col }, end: { row: info.rowIndex, col: info.col } };
      else state.selectionRange.end = { row: info.rowIndex, col: info.col };
    } else {
      state.selectionRange = { start: { row: info.rowIndex, col: info.col }, end: { row: info.rowIndex, col: info.col } };
    }
    renderJobs();
  }
});

async function enqueueAction(endpoint) {
  const ids = selectedIds();
  if (!ids.length) {
    alert('Select at least one row.');
    return;
  }
  await api(`/api/posting/jobs/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify({ ids })
  });
  await loadJobs();
}

async function setupEventStream() {
  const events = new EventSource('/api/posting/events');
  events.addEventListener('update', async () => {
    await loadJobs();
  });
}

async function setupListeners() {
  document.getElementById('refresh-all').addEventListener('click', async () => {
    await Promise.all([loadWhatsappStatus(), loadJobs(), loadSettings()]);
  });

  document.getElementById('wa-connect').addEventListener('click', async () => {
    await api('/api/whatsapp/connect', { method: 'POST', body: JSON.stringify({}) });
    await loadWhatsappStatus();
  });

  document.getElementById('wa-disconnect').addEventListener('click', async () => {
    await api('/api/whatsapp/disconnect', { method: 'POST', body: JSON.stringify({}) });
    await loadWhatsappStatus();
  });

  document.getElementById('wa-groups').addEventListener('click', async () => {
    const data = await api('/api/whatsapp/groups');
    state.groups = data.groups || [];
    el.waInfo.textContent = `Loaded ${state.groups.length} groups`;
  });

  document.getElementById('save-settings').addEventListener('click', async () => {
    await api('/api/posting/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        randomDelayMaxMinutes: Number(el.randomDelayMax.value || 0)
      })
    });
    alert('Settings saved');
  });

  document.getElementById('csv-preview').addEventListener('click', async () => {
    const file = el.csvFile.files?.[0];
    if (!file) return alert('Choose a CSV file first.');
    const csvText = await readFileAsText(file);
    const data = await api('/api/posting/import/csv-preview', {
      method: 'POST',
      body: JSON.stringify({ csvText })
    });
    const total = (data.rows || []).length;
    const invalid = (data.validation || []).filter(v => !v.valid);
    el.csvPreviewOutput.textContent = JSON.stringify({
      totalRows: total,
      invalidRows: invalid
    }, null, 2);
  });

  document.getElementById('csv-import').addEventListener('click', async () => {
    const file = el.csvFile.files?.[0];
    if (!file) return alert('Choose a CSV file first.');
    const csvText = await readFileAsText(file);
    const data = await api('/api/posting/import/csv', {
      method: 'POST',
      body: JSON.stringify({ csvText })
    });
    alert(`Imported ${data.createdCount} rows`);
    await loadJobs();
  });

  document.getElementById('manual-add').addEventListener('click', async () => {
    const row = {
      row_id: document.getElementById('manual-row-id').value.trim(),
      group_jid: document.getElementById('manual-group-jid').value.trim(),
      group_name: document.getElementById('manual-group-name').value.trim(),
      scheduled_at: parseLocalDate(document.getElementById('manual-scheduled-at').value),
      message_text: document.getElementById('manual-message').value
    };
    await api('/api/posting/jobs', {
      method: 'POST',
      body: JSON.stringify({ rows: [row] })
    });
    await loadJobs();
  });

  document.getElementById('paste-import').addEventListener('click', async () => {
    const text = el.pasteInput.value;
    if (!text.trim()) return alert('Paste rows first');
    const data = await api('/api/posting/import/paste', {
      method: 'POST',
      body: JSON.stringify({ text })
    });
    alert(`Imported ${data.createdCount} rows. Invalid rows: ${data.errors.length}`);
    await loadJobs();
  });

  document.getElementById('apply-filters').addEventListener('click', async () => {
    state.statusFilter = el.statusFilter.value;
    state.search = el.searchInput.value.trim();
    await loadJobs();
  });

  document.getElementById('add-row').addEventListener('click', async () => {
    const row = {
      row_id: '',
      message_text: '(edit me)',
      group_name: '(required)',
      scheduled_at: nextDefaultScheduledAt()
    };
    await api('/api/posting/jobs', {
      method: 'POST',
      body: JSON.stringify({ rows: [row] })
    });
    await loadJobs();
  });

  document.getElementById('delete-selected').addEventListener('click', async () => {
    const ids = selectedIds();
    if (!ids.length) {
      alert('Select at least one row to delete.');
      return;
    }
    await api('/api/posting/jobs/delete', {
      method: 'POST',
      body: JSON.stringify({ ids })
    });
    await loadJobs();
  });

  document.getElementById('action-enqueue').addEventListener('click', async () => enqueueAction('enqueue'));
  document.getElementById('action-pause').addEventListener('click', async () => enqueueAction('pause'));
  document.getElementById('action-resume').addEventListener('click', async () => enqueueAction('resume'));
  document.getElementById('action-cancel').addEventListener('click', async () => enqueueAction('cancel'));

  el.selectAll.addEventListener('change', () => {
    const checked = el.selectAll.checked;
    document.querySelectorAll('input[data-job-select="1"]').forEach((item) => {
      item.checked = checked;
    });
  });

  setupCellEditing();
}

async function bootstrap() {
  try {
    await setupListeners();
    await Promise.all([loadWhatsappStatus(), loadSettings(), loadJobs()]);
    await setupEventStream();
  } catch (error) {
    alert(error.message);
  }
}

bootstrap();
