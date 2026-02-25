(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────
  var state = {
    rows: [],       // [{ id, groupName, scheduledAt, messageText, errors }]
    jobs: [],       // queue jobs from API
    submitting: false,
    nextId: 1,
  };

  // ── Helpers ──────────────────────────────────────────────────────────────
  function uid() { return state.nextId++; }

  function tomorrowAt10() {
    var d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    // Format: YYYY-MM-DDTHH:MM
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T10:00';
  }

  function blankRow() {
    return { id: uid(), groupName: '', scheduledAt: tomorrowAt10(), messageText: '', errors: {} };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d)) return iso;
      return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) { return iso; }
  }

  // ── Sample CSV download ──────────────────────────────────────────────────
  function downloadSampleCsv() {
    var lines = [
      'group_name,scheduled_at,message_text',
      'Marketing Group,2026-03-01 10:00,Hello from GroupIQ!',
      'Sales Team,2026-03-01 11:00,Check out the new offer.',
    ];
    var csv = lines.join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'bulk-schedule-sample.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // ── CSV Upload ───────────────────────────────────────────────────────────
  function exportAnalytics() {
    // Fetch all jobs fresh so analytics covers everything, not just visible queue
    fetch('/api/posting/jobs')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var jobs = Array.isArray(data) ? data : (data.jobs || []);
        var csv = buildAnalyticsCSV(jobs);
        var date = new Date().toISOString().slice(0, 10);
        downloadCSVBlob(csv, 'analytics-' + date + '.csv');
        setReportStatus('Analytics exported (' + jobs.length + ' jobs).', 'success');
      })
      .catch(function (err) { setReportStatus('Export failed: ' + err.message, 'error'); });
  }

  function buildAnalyticsCSV(jobs) {
    var esc = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var lines = [];

    // ── Section 1: Summary ───────────────────────────────────────────────
    var total   = jobs.length;
    var sent    = jobs.filter(function (j) { return j.status === 'sent'; }).length;
    var failed  = jobs.filter(function (j) { return j.status === 'failed'; }).length;
    var pending = jobs.filter(function (j) { return j.status === 'scheduled' || j.status === 'queued' || j.status === 'uploaded'; }).length;
    var cancelled = jobs.filter(function (j) { return j.status === 'cancelled'; }).length;
    var rate    = total > 0 ? (sent / total * 100).toFixed(1) : '0.0';

    lines.push('SUMMARY');
    lines.push(['Metric', 'Value'].map(esc).join(','));
    lines.push([esc('Total Jobs'),    esc(total)].join(','));
    lines.push([esc('Sent'),          esc(sent)].join(','));
    lines.push([esc('Failed'),        esc(failed)].join(','));
    lines.push([esc('Pending'),       esc(pending)].join(','));
    lines.push([esc('Cancelled'),     esc(cancelled)].join(','));
    lines.push([esc('Delivery Rate'), esc(rate + '%')].join(','));
    lines.push('');

    // ── Section 2: By Group ──────────────────────────────────────────────
    var byGroup = {};
    jobs.forEach(function (j) {
      var name = (j.resolvedGroup && j.resolvedGroup.name) || j.groupName || 'Unknown';
      if (!byGroup[name]) byGroup[name] = { sent: 0, failed: 0, pending: 0, cancelled: 0 };
      if (j.status === 'sent')      byGroup[name].sent++;
      else if (j.status === 'failed') byGroup[name].failed++;
      else if (j.status === 'cancelled') byGroup[name].cancelled++;
      else                          byGroup[name].pending++;
    });

    lines.push('BY GROUP');
    lines.push(['Group', 'Sent', 'Failed', 'Pending', 'Cancelled', 'Total'].map(esc).join(','));
    Object.keys(byGroup).sort().forEach(function (name) {
      var g = byGroup[name];
      var t = g.sent + g.failed + g.pending + g.cancelled;
      lines.push([esc(name), esc(g.sent), esc(g.failed), esc(g.pending), esc(g.cancelled), esc(t)].join(','));
    });
    lines.push('');

    // ── Section 3: By Day ────────────────────────────────────────────────
    var byDay = {};
    jobs.forEach(function (j) {
      var dateStr = (j.actualSendAt || j.scheduledAt || j.createdAt || '').slice(0, 10);
      if (!dateStr) return;
      if (!byDay[dateStr]) byDay[dateStr] = { sent: 0, failed: 0, other: 0 };
      if (j.status === 'sent')       byDay[dateStr].sent++;
      else if (j.status === 'failed') byDay[dateStr].failed++;
      else                            byDay[dateStr].other++;
    });

    lines.push('BY DAY');
    lines.push(['Date', 'Sent', 'Failed', 'Other'].map(esc).join(','));
    Object.keys(byDay).sort().forEach(function (day) {
      var d = byDay[day];
      lines.push([esc(day), esc(d.sent), esc(d.failed), esc(d.other)].join(','));
    });

    return lines.join('\n');
  }

  function downloadCSVBlob(csv, filename) {
    var blob = new Blob([csv], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  function setReportStatus(msg, type) {
    var el = document.getElementById('report-status');
    el.textContent = msg;
    el.className = 'upload-status' + (type ? ' ' + type : '');
  }

  function setUploadStatus(msg, type) {
    var el = document.getElementById('upload-status');
    el.textContent = msg;
    el.className = 'upload-status' + (type ? ' ' + type : '');
  }

  function handleCsvUpload(file) {
    if (!file) return;
    setUploadStatus('Uploading…', '');
    var reader = new FileReader();
    reader.onload = function (e) {
      var csvText = e.target.result;
      fetch('/api/posting/import/csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csvText: csvText }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var created = (data.created || []).length || data.createdCount || 0;
          var errs = data.errors || [];
          if (errs.length > 0) {
            var errSummary = errs.slice(0, 2).map(function (e) {
              if (typeof e === 'string') return e;
              return e.message || e.error || e.row || JSON.stringify(e);
            }).join('; ');
            setUploadStatus(
              created + ' scheduled, ' + errs.length + ' error(s): ' + errSummary,
              'error'
            );
          } else {
            setUploadStatus(created + ' job(s) scheduled successfully.', 'success');
          }
          loadJobs();
        })
        .catch(function (err) {
          setUploadStatus('Upload failed: ' + err.message, 'error');
        });
    };
    reader.readAsText(file);
  }

  // ── Table Rendering ──────────────────────────────────────────────────────
  function renderTable() {
    var tbody = document.getElementById('bulk-tbody');
    var badge = document.getElementById('row-count-badge');
    badge.textContent = state.rows.length;

    if (state.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">No rows. Click "+ Add Row" to start.</td></tr>';
      return;
    }

    var html = '';
    state.rows.forEach(function (row, idx) {
      var hasError = Object.keys(row.errors || {}).length > 0;
      html += '<tr class="' + (hasError ? 'row-error' : '') + '" data-idx="' + idx + '">';

      // # col
      html += '<td class="cell-num">' + (idx + 1) + '</td>';

      // Group Name
      html += renderCell(row, idx, 'groupName', row.groupName, 'Group name…', false);

      // Scheduled At
      html += renderCell(row, idx, 'scheduledAt', row.scheduledAt, 'YYYY-MM-DD HH:MM', false);

      // Message
      html += renderCell(row, idx, 'messageText', row.messageText, 'Message text…', true);

      // Delete
      html += '<td><button class="btn-del" data-del="' + idx + '" title="Remove row">×</button></td>';

      html += '</tr>';
    });
    tbody.innerHTML = html;
  }

  function renderCell(row, idx, field, value, placeholder, isTextarea) {
    var err = (row.errors || {})[field];
    var tdClass = err ? 'cell-error-td' : '';
    var displayClass = 'cell-display' + (value ? '' : ' cell-placeholder');
    var displayVal = value || placeholder;

    var html = '<td class="' + tdClass + '" data-idx="' + idx + '" data-field="' + field + '">';
    html += '<span class="' + displayClass + '">' + escapeHtml(displayVal) + '</span>';
    if (err) {
      html += '<div class="cell-error-msg">' + escapeHtml(err) + '</div>';
    }
    html += '</td>';
    return html;
  }

  function startEditing(td, idx, field) {
    var row = state.rows[idx];
    if (!row) return;
    var value = row[field] || '';
    var isTextarea = field === 'messageText';
    var err = (row.errors || {})[field];

    var input;
    if (isTextarea) {
      input = document.createElement('textarea');
      input.rows = 3;
    } else {
      input = document.createElement('input');
      input.type = field === 'scheduledAt' ? 'datetime-local' : 'text';
    }
    input.className = 'cell-edit' + (err ? ' cell-error-input' : '');
    input.value = value;

    // Replace display span with input
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    if (input.select) input.select();

    function commit() {
      commitCell(idx, field, input.value);
    }

    input.addEventListener('blur', commit);

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        // Restore original without committing
        e.preventDefault();
        renderTable();
        return;
      }
      if (e.key === 'Enter' && !isTextarea) {
        e.preventDefault();
        commit();
        // Move to next row same field
        setTimeout(function () {
          var nextTd = document.querySelector('[data-idx="' + (idx + 1) + '"][data-field="' + field + '"]');
          if (nextTd) nextTd.click();
        }, 0);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        commit();
        setTimeout(function () {
          var fields = ['groupName', 'scheduledAt', 'messageText'];
          var fIdx = fields.indexOf(field);
          if (!e.shiftKey) {
            // Forward
            var nextF = fields[fIdx + 1];
            if (nextF) {
              var nextTd = document.querySelector('[data-idx="' + idx + '"][data-field="' + nextF + '"]');
              if (nextTd) { nextTd.click(); return; }
            }
            // Last field of row → go to first field of next row
            var nextRow = idx + 1;
            if (nextRow >= state.rows.length) {
              addRow();
              nextRow = state.rows.length - 1;
            }
            var firstTd = document.querySelector('[data-idx="' + nextRow + '"][data-field="groupName"]');
            if (firstTd) firstTd.click();
          } else {
            // Backward
            var prevF = fields[fIdx - 1];
            if (prevF) {
              var prevTd = document.querySelector('[data-idx="' + idx + '"][data-field="' + prevF + '"]');
              if (prevTd) { prevTd.click(); return; }
            }
            if (idx > 0) {
              var lastTd = document.querySelector('[data-idx="' + (idx - 1) + '"][data-field="messageText"]');
              if (lastTd) lastTd.click();
            }
          }
        }, 0);
      }
    });
  }

  function commitCell(idx, field, value) {
    if (!state.rows[idx]) return;
    state.rows[idx][field] = value.trim();
    // Clear per-field error on edit
    if (state.rows[idx].errors) delete state.rows[idx].errors[field];
    renderTable();
  }

  function addRow() {
    state.rows.push(blankRow());
    renderTable();
  }

  function deleteRow(idx) {
    state.rows.splice(idx, 1);
    renderTable();
  }

  // ── Validation ───────────────────────────────────────────────────────────
  function validateRows() {
    var now = new Date();
    var allValid = true;
    state.rows.forEach(function (row) {
      row.errors = {};
      if (!row.groupName.trim()) row.errors.groupName = 'Group name required';
      if (!row.messageText.trim()) row.errors.messageText = 'Message required';
      if (!row.scheduledAt) {
        row.errors.scheduledAt = 'Date required';
      } else {
        var dt = new Date(row.scheduledAt);
        if (isNaN(dt)) {
          row.errors.scheduledAt = 'Invalid date';
        } else if (dt <= now) {
          row.errors.scheduledAt = 'Must be in the future';
        }
      }
      if (Object.keys(row.errors).length > 0) allValid = false;
    });
    return allValid;
  }

  // ── Schedule All ─────────────────────────────────────────────────────────
  function scheduleAll() {
    if (state.submitting || state.rows.length === 0) return;

    validateRows();
    var validRows = state.rows.filter(function (r) { return Object.keys(r.errors).length === 0; });
    var invalidCount = state.rows.length - validRows.length;

    renderTable(); // Show errors

    if (validRows.length === 0) {
      setSummary(invalidCount + ' row(s) have errors. Please fix them.', 'err');
      return;
    }

    state.submitting = true;
    document.getElementById('btn-schedule-all').disabled = true;
    setSummary('Submitting ' + validRows.length + ' job(s)…', '');

    var payload = validRows.map(function (r) {
      return {
        group_name: r.groupName,
        scheduled_at: r.scheduledAt.replace('T', ' '),
        message_text: r.messageText,
      };
    });

    fetch('/api/posting/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: payload }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.submitting = false;
        document.getElementById('btn-schedule-all').disabled = false;

        var successIds = new Set();
        if (Array.isArray(data.created)) {
          data.created.forEach(function (j) {
            // Match by group_name + message_text heuristic
            validRows.forEach(function (r) {
              if (r.groupName === j.group_name || r.groupName === (j.group && j.group.name)) {
                successIds.add(r.id);
              }
            });
          });
          // If all came back successfully, clear all valid rows
          if (data.created.length === validRows.length) {
            validRows.forEach(function (r) { successIds.add(r.id); });
          }
        } else if (data.job || data.id) {
          // Single job response (batch accepted as one)
          validRows.forEach(function (r) { successIds.add(r.id); });
        }

        // Remove successfully submitted rows
        if (successIds.size > 0) {
          state.rows = state.rows.filter(function (r) { return !successIds.has(r.id); });
        }

        var errMsg = '';
        if (data.errors && data.errors.length > 0) {
          errMsg = ' ' + data.errors.length + ' error(s).';
        }

        var submitted = successIds.size || validRows.length;
        var msg = submitted + ' job(s) scheduled.' + errMsg;
        if (invalidCount > 0) msg += ' ' + invalidCount + ' row(s) skipped (invalid).';
        setSummary(msg, 'ok');

        renderTable();
        loadJobs();
      })
      .catch(function (err) {
        state.submitting = false;
        document.getElementById('btn-schedule-all').disabled = false;
        setSummary('Error: ' + err.message, 'err');
      });
  }

  function setSummary(msg, type) {
    var el = document.getElementById('submit-summary');
    el.textContent = msg;
    el.className = 'submit-summary' + (type ? ' ' + type : '');
  }

  // ── Queue ─────────────────────────────────────────────────────────────────
  function loadJobs() {
    fetch('/api/posting/jobs')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var jobs = Array.isArray(data) ? data : (data.jobs || []);
        state.jobs = jobs;
        renderQueue();
      })
      .catch(function (err) { console.error('loadJobs error:', err); });
  }

  function upsertJob(job) {
    var idx = state.jobs.findIndex(function (j) { return j.id === job.id; });
    if (idx >= 0) {
      state.jobs[idx] = job;
    } else {
      state.jobs.push(job);
    }
    renderQueue();
  }

  var EDITABLE_STATUSES = { uploaded: 1, queued: 1, scheduled: 1, failed: 1, cancelled: 1, sent: 1 };

  function renderQueue() {
    var tbody = document.getElementById('queue-tbody');
    var visible = state.jobs.filter(function (j) {
      return j.status === 'scheduled' || j.status === 'queued' || j.status === 'pending' || j.status === 'uploaded';
    });

    if (visible.length === 0) {
      tbody.innerHTML = '<tr id="queue-empty-row"><td colspan="5" class="empty-cell">No scheduled jobs.</td></tr>';
      return;
    }

    var html = '';
    visible.forEach(function (job) {
      var groupName = (job.resolvedGroup && job.resolvedGroup.name) || job.groupName || job.group_name || '';
      var msg = job.messageText || job.message_text || job.message || '';
      var at = job.scheduledAt || job.scheduled_at || '';
      var status = job.status || 'scheduled';
      var editable = !!EDITABLE_STATUSES[status];

      html += '<tr data-job-id="' + job.id + '">';

      // Group Name
      if (editable) {
        html += '<td class="q-cell" data-job-id="' + job.id + '" data-qfield="groupName">';
        html += '<span class="cell-display' + (groupName ? '' : ' cell-placeholder') + '">' + escapeHtml(groupName || 'Group name…') + '</span></td>';
      } else {
        html += '<td>' + escapeHtml(groupName || '—') + '</td>';
      }

      // Message
      if (editable) {
        html += '<td class="q-cell" data-job-id="' + job.id + '" data-qfield="messageText">';
        html += '<span class="cell-display' + (msg ? '' : ' cell-placeholder') + '">' + escapeHtml(msg.length > 80 ? msg.slice(0, 80) + '…' : msg || 'Message…') + '</span></td>';
      } else {
        html += '<td>' + escapeHtml(msg.length > 80 ? msg.slice(0, 80) + '…' : msg) + '</td>';
      }

      // Scheduled At
      if (editable) {
        html += '<td class="q-cell" data-job-id="' + job.id + '" data-qfield="scheduledAt">';
        html += '<span class="cell-display' + (at ? '' : ' cell-placeholder') + '">' + escapeHtml(formatDateTime(at) || 'Date…') + '</span></td>';
      } else {
        html += '<td>' + escapeHtml(formatDateTime(at)) + '</td>';
      }

      html += '<td><span class="pill pill-' + status + '">' + status + '</span></td>';
      html += '<td style="white-space:nowrap">';
      if (status === 'uploaded' || status === 'failed' || status === 'cancelled') {
        html += '<button class="btn btn-accent btn-sm btn-schedule-job" data-id="' + job.id + '" style="margin-right:4px">Schedule</button>';
      }
      html += '<button class="btn btn-outline btn-sm btn-cancel-job" data-id="' + job.id + '">Cancel</button>';
      html += '</td>';
      html += '</tr>';
    });
    tbody.innerHTML = html;
  }

  function startQueueEditing(td, jobId, field) {
    var job = state.jobs.find(function (j) { return j.id === jobId; });
    if (!job) return;

    var isTextarea = field === 'messageText';
    var rawValue = job[field] || '';

    var input;
    if (isTextarea) {
      input = document.createElement('textarea');
      input.rows = 3;
    } else {
      input = document.createElement('input');
      input.type = field === 'scheduledAt' ? 'datetime-local' : 'text';
    }
    input.className = 'cell-edit';

    // datetime-local needs value in YYYY-MM-DDTHH:MM format
    if (field === 'scheduledAt' && rawValue) {
      var d = new Date(rawValue);
      if (!isNaN(d)) {
        var pad = function (n) { return String(n).padStart(2, '0'); };
        rawValue = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                   'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      }
    }
    input.value = rawValue;

    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    if (input.select) input.select();

    function commit() {
      var newVal = input.value.trim();
      var original = job[field] || '';
      // Normalise datetime back to what the API expects
      if (field === 'scheduledAt' && newVal) newVal = newVal.replace('T', ' ');
      if (newVal === original.replace('T', ' ') || newVal === original) {
        renderQueue(); // no change, just re-render
        return;
      }
      var body = {};
      body[field] = newVal;
      fetch('/api/posting/jobs/' + jobId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.job) upsertJob(data.job);
          else renderQueue();
        })
        .catch(function (err) {
          console.error('updateJob error:', err);
          renderQueue();
        });
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); renderQueue(); return; }
      if (e.key === 'Enter' && !isTextarea) { e.preventDefault(); commit(); }
    });
  }

  function scheduleJob(id) {
    fetch('/api/posting/jobs/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    })
      .then(function (r) { return r.json(); })
      .then(function () { loadJobs(); })
      .catch(function (err) { console.error('scheduleJob error:', err); });
  }

  function cancelJob(id) {
    fetch('/api/posting/jobs/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    })
      .then(function (r) { return r.json(); })
      .then(function () { loadJobs(); })
      .catch(function (err) { console.error('cancelJob error:', err); });
  }

  // ── SSE ──────────────────────────────────────────────────────────────────
  function initSSE() {
    var es = new EventSource('/api/posting/events');
    es.addEventListener('init', function (e) {
      try {
        var data = JSON.parse(e.data);
        var jobs = Array.isArray(data) ? data : (data.jobs || []);
        state.jobs = jobs;
        renderQueue();
      } catch (err) { /* ignore */ }
    });
    es.addEventListener('update', function (e) {
      try {
        var job = JSON.parse(e.data);
        upsertJob(job);
      } catch (err) { /* ignore */ }
    });
    es.addEventListener('message', function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data && data.id) upsertJob(data);
      } catch (err) { /* ignore */ }
    });
    es.onerror = function () {
      // SSE reconnects automatically; silently ignore
    };
  }

  // ── Event wiring ─────────────────────────────────────────────────────────
  function init() {
    // Pre-load one blank row
    state.rows.push(blankRow());
    renderTable();

    // Load existing queue
    loadJobs();
    initSSE();

    // Save Report
    document.getElementById('btn-save-report').addEventListener('click', function () {
      setReportStatus('Saving…', '');
      fetch('/api/posting/report/download')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.cancelled) { setReportStatus('Cancelled.', ''); return; }
          if (data.success) setReportStatus('Saved ' + data.count + ' rows → ' + data.path, 'success');
          else setReportStatus('Error: ' + data.error, 'error');
        })
        .catch(function (err) { setReportStatus('Error: ' + err.message, 'error'); });
    });

    // Export Analytics
    document.getElementById('btn-export-analytics').addEventListener('click', exportAnalytics);

    // Sample CSV
    document.getElementById('btn-sample-csv').addEventListener('click', downloadSampleCsv);

    // CSV file upload
    document.getElementById('csv-file-input').addEventListener('change', function (e) {
      var file = e.target.files[0];
      if (file) handleCsvUpload(file);
      // Reset so same file can be re-uploaded
      e.target.value = '';
    });

    // Add Row
    document.getElementById('btn-add-row').addEventListener('click', function () {
      addRow();
    });

    // Schedule All
    document.getElementById('btn-schedule-all').addEventListener('click', scheduleAll);

    // Table delegation: cell click → edit; delete button
    document.getElementById('bulk-tbody').addEventListener('click', function (e) {
      // Delete button
      var del = e.target.closest('[data-del]');
      if (del) {
        deleteRow(parseInt(del.dataset.del, 10));
        return;
      }

      // Cell click → start editing
      var td = e.target.closest('td[data-field]');
      if (td && !td.querySelector('.cell-edit')) {
        var idx = parseInt(td.dataset.idx, 10);
        var field = td.dataset.field;
        startEditing(td, idx, field);
      }
    });

    // Queue delegation: cancel + inline edit
    document.getElementById('queue-tbody').addEventListener('click', function (e) {
      var schedBtn = e.target.closest('.btn-schedule-job');
      if (schedBtn) {
        scheduleJob(parseInt(schedBtn.dataset.id, 10));
        return;
      }

      var btn = e.target.closest('.btn-cancel-job');
      if (btn) {
        var id = parseInt(btn.dataset.id, 10);
        cancelJob(id);
        return;
      }

      var td = e.target.closest('td.q-cell');
      if (td && !td.querySelector('.cell-edit')) {
        var jobId = parseInt(td.dataset.jobId, 10);
        var field = td.dataset.qfield;
        startQueueEditing(td, jobId, field);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
