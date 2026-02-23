const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DEFAULT_STATE = {
  nextId: 1,
  settings: {
    randomDelayMaxMinutes: 0
  },
  jobs: []
};

const MUTABLE_STATUSES = new Set(['uploaded', 'queued', 'scheduled', 'failed', 'cancelled']);

class PostQueueService extends EventEmitter {
  constructor(whatsappManager, logger) {
    super();
    this.whatsappManager = whatsappManager;
    this.logger = logger;
    this.timers = new Map();
    this.state = { ...DEFAULT_STATE };
    this.dataDir = process.env.DATA_DIR || path.join(__dirname, '../data');
    this.statePath = path.join(this.dataDir, 'post-queue.json');
    this.started = false;
    this.loadState();
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadState() {
    this.ensureDataDir();
    try {
      if (!fs.existsSync(this.statePath)) {
        this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.state = {
        nextId: Number(parsed.nextId) || 1,
        settings: {
          randomDelayMaxMinutes: Number(parsed?.settings?.randomDelayMaxMinutes) || 0
        },
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
      };
      for (const job of this.state.jobs) {
        job.revisions = Array.isArray(job.revisions) ? job.revisions : [];
        job.statusHistory = Array.isArray(job.statusHistory) ? job.statusHistory : [];
        if (job.deliveryType == null) job.deliveryType = 'scheduled';
      }
    } catch (error) {
      this.logger.error('Failed to load post queue state', { error: error.message });
      this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
  }

  saveState() {
    this.ensureDataDir();
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (const job of this.state.jobs) {
      if (job.status === 'scheduled' || job.status === 'queued') {
        this.scheduleJob(job.id);
      }
    }
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.started = false;
  }

  getSettings() {
    return { ...this.state.settings };
  }

  updateSettings(settings = {}) {
    if (settings.randomDelayMaxMinutes !== undefined) {
      const value = Number(settings.randomDelayMaxMinutes);
      if (Number.isNaN(value) || value < 0 || value > 180) {
        throw new Error('randomDelayMaxMinutes must be a number between 0 and 180');
      }
      this.state.settings.randomDelayMaxMinutes = value;
    }
    this.saveState();
    this.emit('update', { type: 'settings', settings: this.getSettings() });
    return this.getSettings();
  }

  listJobs() {
    return this.state.jobs
      .slice()
      .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
  }

  getJobById(jobId) {
    return this.state.jobs.find(job => String(job.id) === String(jobId));
  }

  recordComposeSent({ messageText, groupName, groupJid, resolvedGroup, messageId }) {
    const now = new Date().toISOString();
    const id = this.state.nextId++;
    const job = {
      id,
      rowId: `compose-${id}`,
      messageText: messageText || '(Image)',
      scheduledAt: now,
      groupJid: groupJid || '',
      groupName: groupName || '',
      enabled: true,
      status: 'sent',
      statusReason: 'Sent via Compose',
      randomDelayAppliedMs: 0,
      actualSendAt: now,
      resolvedGroup: resolvedGroup ? { id: resolvedGroup.id || '', name: resolvedGroup.name || '' } : null,
      deliveryType: 'compose',
      createdAt: now,
      updatedAt: now,
      revisions: [{ revisionId: 1, timestamp: now, source: 'compose', data: { messageText: messageText || '(Image)', groupName, groupJid } }],
      statusHistory: [{ status: 'sent', timestamp: now, reason: 'Sent via Compose' }]
    };
    this.state.jobs.push(job);
    this.saveState();
    this.emit('update', { type: 'jobs', jobs: [job] });
    return job;
  }

  createJobs(rows, source = 'csv_upload') {
    const created = [];
    for (const row of rows) {
      const normalized = this.normalizeRow(row);
      const now = new Date().toISOString();
      const id = this.state.nextId++;
      const revision = {
        revisionId: 1,
        timestamp: now,
        source,
        data: normalized
      };
      const job = {
        id,
        rowId: normalized.rowId || `row-${id}`,
        messageText: normalized.messageText,
        scheduledAt: normalized.scheduledAt,
        groupJid: normalized.groupJid || '',
        groupName: normalized.groupName || '',
        enabled: normalized.enabled !== false,
        status: 'uploaded',
        statusReason: '',
        randomDelayAppliedMs: 0,
        actualSendAt: null,
        resolvedGroup: null,
        deliveryType: 'scheduled',
        createdAt: now,
        updatedAt: now,
        revisions: [revision],
        statusHistory: [{ status: 'uploaded', timestamp: now, reason: 'Created' }]
      };
      this.state.jobs.push(job);
      created.push(job);
    }
    this.saveState();
    this.emit('update', { type: 'jobs', jobs: created });
    return created;
  }

  updateJob(jobId, updates, source = 'manual_edit') {
    const job = this.getJobById(jobId);
    if (!job) throw new Error('Job not found');

    if (!MUTABLE_STATUSES.has(job.status) && job.status !== 'sent') {
      throw new Error(`Cannot edit job in status: ${job.status}`);
    }

    const merged = this.normalizeRow({
      rowId: updates.rowId !== undefined ? updates.rowId : job.rowId,
      messageText: updates.messageText !== undefined ? updates.messageText : job.messageText,
      scheduledAt: updates.scheduledAt !== undefined ? updates.scheduledAt : job.scheduledAt,
      groupJid: updates.groupJid !== undefined ? updates.groupJid : job.groupJid,
      groupName: updates.groupName !== undefined ? updates.groupName : job.groupName,
      enabled: updates.enabled !== undefined ? updates.enabled : job.enabled
    });

    const now = new Date().toISOString();
    const nextRevision = {
      revisionId: job.revisions.length + 1,
      timestamp: now,
      source,
      data: merged
    };

    job.rowId = merged.rowId || job.rowId;
    job.messageText = merged.messageText;
    job.scheduledAt = merged.scheduledAt;
    job.groupJid = merged.groupJid || '';
    job.groupName = merged.groupName || '';
    job.enabled = merged.enabled !== false;
    job.updatedAt = now;
    job.revisions.push(nextRevision);

    if (job.status === 'sent') {
      this.setStatus(job, 'uploaded', 'Edited after send; re-queued workflow required');
      job.actualSendAt = null;
      job.randomDelayAppliedMs = 0;
      job.statusReason = '';
    } else if (job.status === 'scheduled' || job.status === 'queued') {
      this.scheduleJob(job.id);
    }

    this.saveState();
    this.emit('update', { type: 'jobs', jobs: [job] });
    return job;
  }

  deleteJob(jobId) {
    const job = this.getJobById(jobId);
    if (!job) throw new Error('Job not found');
    this.clearTimer(job.id);
    this.state.jobs = this.state.jobs.filter(item => String(item.id) !== String(jobId));
    this.saveState();
    this.emit('update', { type: 'jobs_deleted', ids: [Number(jobId)] });
  }

  deleteJobs(ids = []) {
    const deleted = [];
    for (const id of ids) {
      const job = this.getJobById(id);
      if (!job) continue;
      this.clearTimer(job.id);
      deleted.push(Number(id));
    }
    this.state.jobs = this.state.jobs.filter(item => !deleted.includes(Number(item.id)));
    this.saveState();
    this.emit('update', { type: 'jobs_deleted', ids: deleted });
    return deleted;
  }

  enqueueJobs(ids = []) {
    const updated = [];
    for (const id of ids) {
      const job = this.getJobById(id);
      if (!job) continue;
      if (!job.enabled) {
        this.setStatus(job, 'failed', 'Job disabled');
        updated.push(job);
        continue;
      }
      this.setStatus(job, 'queued', 'Queued for scheduling');
      this.setStatus(job, 'scheduled', 'Waiting for scheduled_at');
      this.scheduleJob(job.id);
      updated.push(job);
    }
    this.saveState();
    this.emit('update', { type: 'jobs', jobs: updated });
    return updated;
  }

  pauseJobs(ids = []) {
    const updated = [];
    for (const id of ids) {
      const job = this.getJobById(id);
      if (!job) continue;
      this.clearTimer(job.id);
      this.setStatus(job, 'uploaded', 'Paused');
      updated.push(job);
    }
    this.saveState();
    this.emit('update', { type: 'jobs', jobs: updated });
    return updated;
  }

  cancelJobs(ids = []) {
    const updated = [];
    for (const id of ids) {
      const job = this.getJobById(id);
      if (!job) continue;
      this.clearTimer(job.id);
      this.setStatus(job, 'cancelled', 'Cancelled by user');
      updated.push(job);
    }
    this.saveState();
    this.emit('update', { type: 'jobs', jobs: updated });
    return updated;
  }

  randomizeJobTimes(ids = [], startAt, endAt) {
    if (!startAt || !endAt) throw new Error('startAt and endAt are required');
    const startMs = new Date(startAt).getTime();
    const endMs = new Date(endAt).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new Error('Invalid startAt or endAt');
    if (startMs >= endMs) throw new Error('startAt must be before endAt');

    const updated = [];
    for (const id of ids) {
      const job = this.getJobById(id);
      if (!job || !MUTABLE_STATUSES.has(job.status)) continue;
      const randomMs = startMs + Math.floor(Math.random() * (endMs - startMs + 1));
      const randomAt = new Date(randomMs).toISOString();
      this.updateJob(id, { scheduledAt: randomAt }, 'randomize_times');
      updated.push(this.getJobById(id));
    }
    return updated;
  }

  scheduleJob(jobId) {
    const job = this.getJobById(jobId);
    if (!job) return;
    this.clearTimer(jobId);

    const scheduledTs = new Date(job.scheduledAt).getTime();
    const delayMs = Math.max(0, scheduledTs - Date.now());
    const timer = setTimeout(() => {
      this.executeJob(jobId).catch((error) => {
        const failedJob = this.getJobById(jobId);
        if (!failedJob) return;
        this.setStatus(failedJob, 'failed', error.message);
        this.saveState();
        this.emit('update', { type: 'jobs', jobs: [failedJob] });
      });
    }, delayMs);

    this.timers.set(String(jobId), timer);
  }

  clearTimer(jobId) {
    const timer = this.timers.get(String(jobId));
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(String(jobId));
    }
  }

  async executeJob(jobId) {
    const job = this.getJobById(jobId);
    if (!job) return;
    if (job.status === 'cancelled') return;
    if (!job.enabled) {
      this.setStatus(job, 'failed', 'Job disabled');
      this.saveState();
      this.emit('update', { type: 'jobs', jobs: [job] });
      return;
    }

    const maxMinutes = Number(this.state.settings.randomDelayMaxMinutes) || 0;
    const maxMs = Math.max(0, Math.floor(maxMinutes * 60 * 1000));
    const jitterMs = maxMs > 0 ? Math.floor(Math.random() * (maxMs + 1)) : 0;

    job.randomDelayAppliedMs = jitterMs;
    this.setStatus(job, 'queued', 'Applying random delay before send');
    this.saveState();
    this.emit('update', { type: 'jobs', jobs: [job] });

    if (jitterMs > 0) {
      await new Promise(resolve => setTimeout(resolve, jitterMs));
    }

    const result = await this.whatsappManager.sendMessageToGroup({
      groupJid: job.groupJid,
      groupName: job.groupName,
      messageText: job.messageText
    });

    const now = new Date().toISOString();
    if (result.success) {
      job.actualSendAt = now;
      job.resolvedGroup = {
        id: result.group?.id || '',
        name: result.group?.name || ''
      };
      this.setStatus(job, 'sent', 'Message sent successfully');
    } else {
      this.setStatus(job, 'failed', result.error || 'Failed to send message');
    }

    job.updatedAt = now;
    this.saveState();
    this.emit('update', { type: 'jobs', jobs: [job] });
  }

  setStatus(job, status, reason = '') {
    const now = new Date().toISOString();
    job.status = status;
    job.statusReason = reason;
    job.updatedAt = now;
    job.statusHistory.push({ status, timestamp: now, reason });
  }

  normalizeRow(row = {}) {
    const messageText = String(row.messageText || row.message_text || '').trim();
    const scheduledAtRaw = row.scheduledAt || row.scheduled_at;
    const scheduledDate = this.parseScheduledAt(scheduledAtRaw);
    const groupJid = String(row.groupJid || row.group_jid || '').trim();
    const groupName = String(row.groupName || row.group_name || '').trim();
    const rowId = row.rowId || row.row_id || '';
    const enabled = row.enabled === undefined ? true : !(String(row.enabled).toLowerCase() === 'false' || row.enabled === false || row.enabled === 0 || row.enabled === '0');

    if (!messageText) {
      throw new Error('message_text is required');
    }
    if (!scheduledAtRaw) {
      throw new Error('scheduled_at is required');
    }
    if (!scheduledDate || Number.isNaN(scheduledDate.getTime())) {
      throw new Error('scheduled_at must be a valid local datetime (YYYY-MM-DD HH:mm or ISO)');
    }
    if (scheduledDate.getTime() < Date.now() - 1000) {
      throw new Error('scheduled_at must be in the future');
    }
    if (!groupJid && !groupName) {
      throw new Error('group_jid or group_name is required');
    }

    return {
      rowId,
      messageText,
      scheduledAt: scheduledDate.toISOString(),
      groupJid,
      groupName,
      enabled
    };
  }

  parseScheduledAt(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    const str = String(value).trim();
    if (!str) return null;

    // Normalize "YYYY-MM-DD HH:mm" -> local datetime "YYYY-MM-DDTHH:mm"
    const normalized = /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(str)
      ? str.replace(' ', 'T')
      : str;

    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) return parsed;

    // Accept "YYYY/MM/DD HH:mm" as a convenience local input.
    const slash = /^(\d{4})\/(\d{2})\/(\d{2})\s(\d{2}):(\d{2})$/.exec(str);
    if (slash) {
      const local = new Date(
        Number(slash[1]),
        Number(slash[2]) - 1,
        Number(slash[3]),
        Number(slash[4]),
        Number(slash[5]),
        0,
        0
      );
      if (!Number.isNaN(local.getTime())) return local;
    }
    return null;
  }
}

module.exports = PostQueueService;
