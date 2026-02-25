const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const http = require('http');

const electronConstants = require('./constants');

// When packaged, logs, data, and WhatsApp session must go to userData (not inside app.asar)
if (app.isPackaged) {
  const userData = app.getPath('userData');
  if (!process.env.LOGS_DIR) process.env.LOGS_DIR = path.join(userData, 'logs');
  if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(userData, 'data');
  if (!process.env.WWEBJS_AUTH_PATH) process.env.WWEBJS_AUTH_PATH = path.join(userData, 'wwebjs_auth');
  // Use system Chrome on Windows so Puppeteer doesn't fail (packaged app often can't find bundled Chromium)
  if (process.platform === 'win32' && !process.env.WA_CHROME_PATH) {
    const chromePaths = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe')
    ];
    for (const p of chromePaths) {
      if (fs.existsSync(p)) {
        process.env.WA_CHROME_PATH = p;
        break;
      }
    }
  }
}

const whatsappManager = require('./whatsapp-manager');
const ScraperService = require('./scraper-service');
const EngagementTrackingService = require('./engagement-tracking-service');
const localDataStore = require('./local-data-store');
const PostQueueService = require('./post-queue-service');

// Environment detection
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow = null;
let tray = null;
let localServer = null;
let localPort = 3100;
let whatsappProcess = null;
let sseClients = [];
let trackingService = null;
let postQueueService = null;
let rendererNetworkLoggingAttached = false;

// VPS auth token: stored when user logs in or sends token (e.g. scraper run); used for analytics proxy
let storedVpsToken = null;
let vpsTokenPathCached = null;
function getVpsTokenPath() {
  if (!vpsTokenPathCached) vpsTokenPathCached = path.join(app.getPath('userData'), 'vps-token.json');
  return vpsTokenPathCached;
}
function loadStoredVpsToken() {
  try {
    const p = getVpsTokenPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && data.token) {
        storedVpsToken = data.token;
      }
    }
  } catch (e) {
    // ignore
  }
}
function saveVpsToken(token) {
  if (!token) return;
  storedVpsToken = token;
  try {
    fs.writeFileSync(getVpsTokenPath(), JSON.stringify({ token }), 'utf8');
  } catch (e) {
    console.error('Could not persist VPS token:', e.message);
  }
}
loadStoredVpsToken();

// Create local Express server to serve the dashboard
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const expressApp = express();
    // When packaged, use app.getAppPath() to get the correct path to app.asar
    // When dev, __dirname is electron/, so ../public is correct
    const publicDir = app.isPackaged 
      ? path.join(app.getAppPath(), 'public')
      : path.join(__dirname, '../public');
    
    // Log for debugging
    console.log('[Server] publicDir resolved to:', publicDir);
    console.log('[Server] publicDir exists:', fs.existsSync(publicDir));
    console.log('[Server] index.html exists:', fs.existsSync(path.join(publicDir, 'index.html')));
    
    // Default to full dashboard (React UI with Compose, Send Messages). Set POSTING_FOCUSED_MODE=true for autopost at /
    const postingFocusedMode = process.env.POSTING_FOCUSED_MODE === 'true';

    function parseDelimitedRows(inputText, explicitDelimiter = null) {
      const text = String(inputText || '').replace(/\r\n/g, '\n').trim();
      if (!text) return { delimiter: explicitDelimiter || ',', headers: [], rows: [] };
      const lines = text.split('\n').filter(Boolean);
      if (lines.length === 0) return { delimiter: explicitDelimiter || ',', headers: [], rows: [] };

      const delimiter = explicitDelimiter || (lines[0].includes('\t') ? '\t' : ',');
      const parseLine = (line) => {
        const cells = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
              current += '"';
              i += 1;
            } else {
              inQuotes = !inQuotes;
            }
            continue;
          }
          if (ch === delimiter && !inQuotes) {
            cells.push(current.trim());
            current = '';
            continue;
          }
          current += ch;
        }
        cells.push(current.trim());
        return cells;
      };

      const headers = parseLine(lines[0]).map(h => h.trim());
      const rows = lines.slice(1).map(parseLine).map((cells, rowIndex) => {
        const obj = {};
        headers.forEach((header, idx) => {
          obj[header] = cells[idx] || '';
        });
        obj.__rowNumber = rowIndex + 2;
        return obj;
      });
      return { delimiter, headers, rows };
    }

    // Helper to serve HTML files (works with asar paths)
    function serveHtmlFile(filename) {
      return (req, res) => {
        try {
          const filePath = path.join(publicDir, filename);
          if (!fs.existsSync(filePath)) {
            console.error(`[Server] File not found: ${filePath}`);
            return res.status(404).send('File not found');
          }
          const content = fs.readFileSync(filePath, 'utf8');
          res.setHeader('Content-Type', 'text/html');
          res.send(content);
        } catch (error) {
          console.error(`[Server] Error serving ${filename}:`, error);
          res.status(500).send('Internal server error');
        }
      };
    }

    // Make posting-focused mode the default landing page without removing full UI.
    // Dashboard (with Send Messages + Compose) and autopost are both in public/.
    expressApp.get('/', (req, res) => {
      if (postingFocusedMode) {
        serveHtmlFile('autopost.html')(req, res);
      } else {
        serveHtmlFile('simple.html')(req, res);
      }
    });
    expressApp.get('/full-ui', serveHtmlFile('index.html'));
    expressApp.get('/posting-ui', serveHtmlFile('autopost.html'));
    expressApp.get('/bulk', serveHtmlFile('bulk.html'));

    expressApp.use(express.static(publicDir, { index: false }));

    // API proxy to VPS
    expressApp.use('/api', express.json());

    // Mark requests as coming from Electron
    expressApp.use((req, res, next) => {
      req.headers['x-client-type'] = 'electron';
      next();
    });

    // Remember VPS token when client sends Authorization (so analytics can use it without frontend sending it every time)
    expressApp.use('/api', (req, res, next) => {
      const auth = req.headers.authorization;
      if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
        const token = auth.slice(7).trim();
        if (token) saveVpsToken(token);
      }
      next();
    });

    const VPS_BASE_URL = process.env.VPS_BASE_URL || 'https://group-iq.com';
    const allowInsecureSSL = process.env.ALLOW_INSECURE_SSL === 'true' || !app.isPackaged;
    let nodeFetch = null;
    async function getFetch() {
      if (!nodeFetch) nodeFetch = (await import('node-fetch')).default;
      return nodeFetch;
    }
    const httpsAgent = new https.Agent({ rejectUnauthorized: !allowInsecureSSL });

    function sendError(res, status, message, extra = {}) {
      res.status(status).json({ success: status < 500, error: message, ...extra });
    }

    function getGroupsConfigPath() {
      return electronConstants.GROUPS_CONFIG_PATH;
    }
    function readGroupsConfig() {
      try {
        return JSON.parse(fs.readFileSync(getGroupsConfigPath(), 'utf8'));
      } catch (e) {
        return { groups: [], config: {} };
      }
    }
    function writeGroupsConfig(config) {
      fs.writeFileSync(getGroupsConfigPath(), JSON.stringify(config, null, 2));
    }

    function transformMessageForFrontend(msg) {
      return { ...msg, id: msg.message_id, message_member_count: msg.total_members };
    }

    // Shared ScraperService instance (used by scraper/run, scraper/test, messages/refresh, tracking-service)
    let sharedScraperService = null;
    function getSharedScraperService() {
      if (!sharedScraperService) {
        sharedScraperService = new ScraperService(whatsappManager);
      }
      return sharedScraperService;
    }

    // Local WhatsApp endpoints (not proxied to VPS)
    expressApp.get('/api/whatsapp/status', (req, res) => {
      try {
        const status = whatsappManager.getStatus();
        res.json({
          success: true,
          ...status
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/whatsapp/qr', (req, res) => {
      try {
        const qr = whatsappManager.getQRCode();
        const status = whatsappManager.getStatus();

        if (!qr) {
          return res.json({
            success: false,
            message: 'No QR code available',
            status: status.status
          });
        }

        res.json({
          success: true,
          qr,
          status: status.status
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/whatsapp/events', (req, res) => {
      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send initial status
      const initialStatus = whatsappManager.getStatus();
      res.write(`data: ${JSON.stringify(initialStatus)}\n\n`);

      // Add client to list
      sseClients.push(res);

      // Setup event listeners
      const onQR = (data) => {
        if (!res.writableEnded) {
          res.write(`event: qr\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const onReady = (data) => {
        if (!res.writableEnded) {
          res.write(`event: ready\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const onDisconnected = (data) => {
        if (!res.writableEnded) {
          res.write(`event: disconnected\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const onError = (data) => {
        if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const onStatus = (data) => {
        if (!res.writableEnded) {
          res.write(`event: status\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      // Register listeners
      whatsappManager.on('qr', onQR);
      whatsappManager.on('ready', onReady);
      whatsappManager.on('disconnected', onDisconnected);
      whatsappManager.on('error', onError);
      whatsappManager.on('status', onStatus);

      // Keep connection alive with heartbeat
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(':heartbeat\n\n');
        }
      }, electronConstants.SSE_HEARTBEAT_MS);

      // Clean up on client disconnect
      req.on('close', () => {
        clearInterval(heartbeat);
        whatsappManager.off('qr', onQR);
        whatsappManager.off('ready', onReady);
        whatsappManager.off('disconnected', onDisconnected);
        whatsappManager.off('error', onError);
        whatsappManager.off('status', onStatus);

        // Remove from clients list
        const index = sseClients.indexOf(res);
        if (index > -1) {
          sseClients.splice(index, 1);
        }
      });
    });

    expressApp.post('/api/whatsapp/connect', async (req, res) => {
      try {
        if (whatsappManager.hasClient()) {
          return res.json({
            success: false,
            message: 'WhatsApp client already exists',
            status: whatsappManager.getStatus()
          });
        }

        const result = await whatsappManager.initialize();
        const status = whatsappManager.getStatus();

        res.json({
          success: true,
          message: 'WhatsApp client initializing. Please scan QR code.',
          status: status.status
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.post('/api/whatsapp/disconnect', async (req, res) => {
      try {
        if (!whatsappManager.hasClient()) {
          return res.json({
            success: false,
            message: 'No active WhatsApp client'
          });
        }

        await whatsappManager.disconnect();

        res.json({
          success: true,
          message: 'WhatsApp client disconnected'
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.post('/api/whatsapp/logout', async (req, res) => {
      try {
        if (!whatsappManager.hasClient()) {
          return res.json({
            success: false,
            message: 'No active WhatsApp client'
          });
        }

        await whatsappManager.logout();

        res.json({
          success: true,
          message: 'WhatsApp logged out successfully'
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/whatsapp/groups', async (req, res) => {
      try {
        const status = whatsappManager.getStatus();

        if (status.status !== 'ready') {
          return res.status(400).json({
            success: false,
            message: 'WhatsApp not connected',
            status: status.status
          });
        }

        const groups = await whatsappManager.getChats();

        res.json({
          success: true,
          groups,
          count: groups.length
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/posting/settings', (req, res) => {
      try {
        res.json({
          success: true,
          settings: postQueueService.getSettings()
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.patch('/api/posting/settings', (req, res) => {
      try {
        const settings = postQueueService.updateSettings(req.body || {});
        res.json({ success: true, settings });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    expressApp.post('/api/posting/import/csv-preview', (req, res) => {
      try {
        const csvText = req.body?.csvText;
        if (!csvText || typeof csvText !== 'string') {
          return sendError(res, 400, 'csvText is required');
        }
        const parsed = parseDelimitedRows(csvText, ',');
        const validation = parsed.rows.map((row) => {
          try {
            postQueueService.normalizeRow(row);
            return { rowNumber: row.__rowNumber, valid: true, error: '' };
          } catch (err) {
            return { rowNumber: row.__rowNumber, valid: false, error: err.message };
          }
        });
        res.json({
          success: true,
          headers: parsed.headers,
          rows: parsed.rows,
          validation
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.post('/api/posting/import/csv', (req, res) => {
      try {
        const csvText = req.body?.csvText;
        if (!csvText || typeof csvText !== 'string') {
          return sendError(res, 400, 'csvText is required');
        }
        const parsed = parseDelimitedRows(csvText, ',');
        const validRows = [];
        const errors = [];
        parsed.rows.forEach((row) => {
          try {
            postQueueService.normalizeRow(row);
            validRows.push(row);
          } catch (err) {
            errors.push({ rowNumber: row.__rowNumber, rowId: row.row_id || row.rowId || '', error: err.message });
          }
        });
        const created = postQueueService.createJobs(validRows, 'csv_upload');
        res.json({
          success: true,
          createdCount: created.length,
          created,
          errors
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.post('/api/posting/import/paste', (req, res) => {
      try {
        const text = req.body?.text;
        if (!text || typeof text !== 'string') {
          return sendError(res, 400, 'text is required');
        }
        const parsed = parseDelimitedRows(text);
        const validRows = [];
        const errors = [];
        parsed.rows.forEach((row) => {
          try {
            postQueueService.normalizeRow(row);
            validRows.push(row);
          } catch (err) {
            errors.push({ rowNumber: row.__rowNumber, rowId: row.row_id || row.rowId || '', error: err.message });
          }
        });
        const created = postQueueService.createJobs(validRows, 'bulk_paste');
        res.json({
          success: true,
          delimiter: parsed.delimiter === '\t' ? 'tsv' : 'csv',
          createdCount: created.length,
          created,
          errors
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.post('/api/posting/jobs', (req, res) => {
      try {
        const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body];
        const created = postQueueService.createJobs(rows, 'manual_entry');
        res.json({ success: true, created });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    expressApp.get('/api/posting/jobs', (req, res) => {
      try {
        const statusFilter = String(req.query.status || '').trim();
        const search = String(req.query.search || '').trim().toLowerCase();
        let jobs = postQueueService.listJobs();
        if (statusFilter) {
          jobs = jobs.filter(job => job.status === statusFilter);
        }
        if (search) {
          jobs = jobs.filter(job =>
            String(job.rowId || '').toLowerCase().includes(search) ||
            String(job.messageText || '').toLowerCase().includes(search) ||
            String(job.groupJid || '').toLowerCase().includes(search) ||
            String(job.groupName || '').toLowerCase().includes(search) ||
            String(job.resolvedGroup?.name || '').toLowerCase().includes(search)
          );
        }
        res.json({ success: true, jobs });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/posting/jobs/:id/revisions', (req, res) => {
      try {
        const job = postQueueService.getJobById(req.params.id);
        if (!job) return sendError(res, 404, 'Job not found');
        res.json({ success: true, revisions: job.revisions || [] });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.patch('/api/posting/jobs/:id', (req, res) => {
      try {
        const updated = postQueueService.updateJob(req.params.id, req.body || {}, 'manual_edit');
        res.json({ success: true, job: updated });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    expressApp.delete('/api/posting/jobs/:id', (req, res) => {
      try {
        postQueueService.deleteJob(req.params.id);
        res.json({ success: true });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    expressApp.post('/api/posting/jobs/delete', (req, res) => {
      try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const deleted = postQueueService.deleteJobs(ids);
        res.json({ success: true, deleted });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    expressApp.post('/api/posting/jobs/enqueue', (req, res) => {
      try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const jobs = postQueueService.enqueueJobs(ids);
        res.json({ success: true, jobs });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    expressApp.post('/api/posting/jobs/pause', (req, res) => {
      try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const jobs = postQueueService.pauseJobs(ids);
        res.json({ success: true, jobs });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    expressApp.post('/api/posting/jobs/resume', (req, res) => {
      try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const jobs = postQueueService.enqueueJobs(ids);
        res.json({ success: true, jobs });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    expressApp.post('/api/posting/jobs/cancel', (req, res) => {
      try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const jobs = postQueueService.cancelJobs(ids);
        res.json({ success: true, jobs });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    expressApp.post('/api/posting/jobs/randomize-times', (req, res) => {
      try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const startAt = req.body?.startAt;
        const endAt = req.body?.endAt;
        const jobs = postQueueService.randomizeJobTimes(ids, startAt, endAt);
        res.json({ success: true, jobs });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    });

    // ── Send Report ──────────────────────────────────────────────────────────
    function buildReportCSV(jobs) {
      const headers = ['ID', 'Group Name', 'Message', 'Scheduled At', 'Actual Send At', 'Status', 'Status Reason', 'Created At'];
      const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const rows = jobs.map(j => [
        j.id,
        (j.resolvedGroup && j.resolvedGroup.name) || j.groupName || '',
        j.messageText || '',
        j.scheduledAt || '',
        j.actualSendAt || '',
        j.status || '',
        j.statusReason || '',
        j.createdAt || '',
      ].map(esc).join(','));
      return [headers.join(','), ...rows].join('\n');
    }

    expressApp.get('/api/posting/report/download', async (req, res) => {
      try {
        const jobs = postQueueService.listJobs();
        const csv = buildReportCSV(jobs);
        const defaultPath = path.join(
          app.getPath('downloads'),
          `send-report-${new Date().toISOString().slice(0, 10)}.csv`
        );
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Save Send Report',
          defaultPath,
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (canceled || !filePath) return res.json({ cancelled: true });
        fs.writeFileSync(filePath, csv, 'utf8');
        res.json({ success: true, path: filePath, count: jobs.length });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Use disk storage for multipart uploads to avoid base64 (33% size inflation); temp file deleted after send
    const sendNowTempDir = path.join(os.tmpdir(), 'groupiq-send-now');
    if (!fs.existsSync(sendNowTempDir)) fs.mkdirSync(sendNowTempDir, { recursive: true });
    const sendNowUpload = multer({
      storage: multer.diskStorage({
        destination: sendNowTempDir,
        filename: (_, file, cb) => cb(null, `img-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname || '') || '.bin'}`)
      })
    });
    expressApp.post('/api/posting/send-now', sendNowUpload.single('image'), async (req, res) => {
      const tempFilePath = req.file && req.file.path;
      try {
        const body = req.body || {};
        const messageText = body.messageText != null ? String(body.messageText) : '';
        const groupName = body.groupName != null ? String(body.groupName) : '';
        const groupJid = body.groupJid != null ? String(body.groupJid) : '';
        const imageData = body.imageData;
        const imageMimetype = body.imageMimetype;

        if (!groupName && !groupJid) {
          return sendError(res, 400, 'groupName or groupJid is required');
        }

        const hasText = messageText.trim().length > 0;
        const hasImageFile = req.file && req.file.path && fs.existsSync(req.file.path);
        const hasImageBase64 = imageData && imageMimetype;

        if (!hasText && !hasImageFile && !hasImageBase64) {
          return sendError(res, 400, 'messageText or image is required');
        }

        let image = null;
        if (hasImageFile) {
          image = { filePath: req.file.path };
        } else if (hasImageBase64) {
          image = {
            data: String(imageData),
            mimetype: String(imageMimetype)
          };
        }

        const result = await whatsappManager.sendMessageToGroup({
          groupJid: groupJid.trim(),
          groupName: groupName.trim(),
          messageText: messageText.trim(),
          image
        });
        if (result.success) {
          const displayText = messageText.trim() || '(Image)';
          postQueueService.recordComposeSent({
            messageText: displayText,
            groupName: groupName.trim(),
            groupJid: result.group?.id,
            resolvedGroup: result.group,
            messageId: result.messageId
          });
          res.json({ success: true, messageId: result.messageId, group: result.group });
        } else {
          res.status(400).json({ success: false, error: result.error });
        }
      } catch (error) {
        sendError(res, 500, error.message);
      } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try { fs.unlinkSync(tempFilePath); } catch (e) { /* ignore */ }
        }
      }
    });

    expressApp.get('/api/posting/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`event: init\ndata: ${JSON.stringify({ jobs: postQueueService.listJobs(), settings: postQueueService.getSettings() })}\n\n`);

      const onUpdate = (payload) => {
        if (!res.writableEnded) {
          res.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      };
      postQueueService.on('update', onUpdate);

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(':heartbeat\n\n');
      }, electronConstants.SSE_HEARTBEAT_MS);

      req.on('close', () => {
        clearInterval(heartbeat);
        postQueueService.off('update', onUpdate);
      });
    });

    expressApp.post('/api/scraper/run', async (req, res) => {
      try {
        const status = whatsappManager.getStatus();

        if (status.status !== 'ready') {
          return res.status(400).json({
            success: false,
            message: 'WhatsApp not connected',
            status: status.status
          });
        }

        // Get auth token from request
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
          return res.status(401).json({
            success: false,
            message: 'Authentication required'
          });
        }

        const lookbackDays = parseInt(req.body?.lookbackDays || 7);
        const syncToVPS = req.body?.syncToVPS !== false; // Default true for compatibility

        const result = await getSharedScraperService().runScraping(token, lookbackDays, syncToVPS);

        res.json(result);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    // Scrape / refresh a single group only (e.g. FIG) without running full scraper on all groups
    expressApp.post('/api/scraper/run-group', async (req, res) => {
      try {
        const status = whatsappManager.getStatus();
        if (status.status !== 'ready') {
          return res.status(400).json({
            success: false,
            message: 'WhatsApp not connected',
            status: status.status
          });
        }

        const groupName = req.body?.groupName;
        if (!groupName || typeof groupName !== 'string') {
          return res.status(400).json({
            success: false,
            message: 'groupName is required (e.g. "FIG")'
          });
        }

        const lookbackDays = parseInt(req.body?.lookbackDays || 30);
        const syncToVPS = req.body?.syncToVPS === true;
        const token = req.headers.authorization?.replace('Bearer ', '') || null;
        if (syncToVPS && !token) {
          return res.status(401).json({
            success: false,
            message: 'Authentication required when syncToVPS is true'
          });
        }

        const result = await getSharedScraperService().runScrapingForGroup(
          groupName.trim(),
          lookbackDays,
          syncToVPS,
          token
        );
        res.json(result);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    // Engagement tracking service status endpoint
    expressApp.get('/api/tracking-service/status', (req, res) => {
      try {
        if (!trackingService) {
          return res.json({
            isRunning: false,
            message: 'Engagement tracking service not initialized'
          });
        }

        const status = trackingService.getStatus();
        res.json(status);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    // Start/stop engagement tracking service endpoints
    expressApp.post('/api/tracking-service/start', (req, res) => {
      try {
        if (!trackingService) {
          trackingService = new EngagementTrackingService(getSharedScraperService(), localDataStore);
        }

        trackingService.start();
        res.json({
          success: true,
          status: trackingService.getStatus()
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.post('/api/tracking-service/stop', (req, res) => {
      try {
        if (!trackingService) {
          return res.json({
            success: false,
            message: 'Engagement tracking service not initialized'
          });
        }

        trackingService.stop();
        res.json({
          success: true,
          status: trackingService.getStatus()
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    // Legacy endpoint for backwards compatibility
    expressApp.get('/api/retry-service/status', (req, res) => {
      res.redirect('/api/tracking-service/status');
    });

    expressApp.post('/api/scraper/test', async (req, res) => {
      try {
        const groupName = req.body?.groupName;
        if (!groupName) {
          return res.status(400).json({
            success: false,
            message: 'groupName is required'
          });
        }

        const lookbackDays = parseInt(req.body?.lookbackDays || 30);

        // Get messages from LOCAL DATABASE (instant, no API calls!)
        const allMessages = localDataStore.getRecentMessages(1000);
        const groupMessages = allMessages.filter(m => m.group_name === groupName);

        // Filter by lookback days
        const cutoffDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
        const filteredMessages = groupMessages.filter(m =>
          new Date(m.message_timestamp) >= cutoffDate
        );

        console.log('Test scrape from local DB:', {
          group: groupName,
          lookbackDays,
          messagesFound: filteredMessages.length
        });

        if (filteredMessages.length === 0) {
          return res.json({
            success: false,
            message: `No messages found for "${groupName}" in the last ${lookbackDays} days.\n\nTip: Click "Run Scraper" first to fetch messages, then try again.`
          });
        }

        res.json({
          success: true,
          group: {
            name: groupName,
            participants: filteredMessages[0]?.total_members || 0
          },
          stats: {
            yourMessages: filteredMessages.length,
            lookbackDays
          },
          allMessages: filteredMessages
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    // Local API endpoints (served from local data store)
    expressApp.get('/api/messages/recent', (req, res) => {
      try {
        const limit = parseInt(req.query.limit || 50);
        const messages = localDataStore.getRecentMessages(limit);
        res.json(messages.map(transformMessageForFrontend));
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/messages/:id', (req, res) => {
      try {
        const message = localDataStore.getMessageById(req.params.id);
        if (!message) {
          return res.status(404).json({ error: 'Message not found' });
        }
        res.json(transformMessageForFrontend(message));
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.post('/api/messages/:id/refresh', async (req, res) => {
      try {
        const requestedMessageId = req.params.id;
        const resolvedMessageId = localDataStore.resolveMessageId(requestedMessageId) || requestedMessageId;
        const message = localDataStore.getMessageById(resolvedMessageId);

        if (!message) {
          // Return 200 with success=false so UI loaders can always settle gracefully.
          return res.json({
            success: false,
            error: 'Message not found',
            requestedMessageId
          });
        }

        // Check if WhatsApp is connected
        const status = whatsappManager.getStatus();
        if (status.status !== 'ready') {
          return res.json({
            success: false,
            message: 'WhatsApp not connected',
            status: status.status,
            requestedMessageId,
            resolvedMessageId
          });
        }

        const result = await getSharedScraperService().refreshMessageStats(resolvedMessageId, message.group_name);

        if (result.success) {
          const updatedMessage = localDataStore.getMessageById(resolvedMessageId);
          res.json({
            success: true,
            message: 'Stats refreshed successfully',
            data: transformMessageForFrontend(updatedMessage),
            requestedMessageId,
            resolvedMessageId
          });
        } else {
          res.json({
            success: false,
            requestedMessageId,
            resolvedMessageId,
            ...result
          });
        }
      } catch (error) {
        res.json({
          success: false,
          error: error.message
        });
      }
    });

    // Update message tracking status
    expressApp.put('/api/messages/:id/tracking', (req, res) => {
      try {
        const messageId = req.params.id;
        const { is_tracked } = req.body;

        if (typeof is_tracked !== 'boolean') {
          return res.status(400).json({ error: 'is_tracked must be a boolean' });
        }

        const success = localDataStore.updateMessageTracking(messageId, is_tracked);

        if (success) {
          res.json({ success: true, message: 'Tracking status updated' });
        } else {
          res.status(404).json({ error: 'Message not found' });
        }
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    // Bulk update message tracking status
    expressApp.post('/api/messages/bulk-update-tracking', (req, res) => {
      try {
        const { message_ids, is_tracked } = req.body;

        if (!Array.isArray(message_ids)) {
          return res.status(400).json({ error: 'message_ids must be an array' });
        }

        if (typeof is_tracked !== 'boolean') {
          return res.status(400).json({ error: 'is_tracked must be a boolean' });
        }

        let successCount = 0;
        let failCount = 0;

        message_ids.forEach(messageId => {
          const success = localDataStore.updateMessageTracking(messageId, is_tracked);
          if (success) successCount++;
          else failCount++;
        });

        res.json({
          success: true,
          message: `Updated ${successCount} messages, ${failCount} failed`,
          updated: successCount,
          failed: failCount
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/dashboard/stats', (req, res) => {
      try {
        const stats = localDataStore.getDashboardStats();
        const runs = localDataStore.getRuns(20);

        // Count runs in last 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * electronConstants.MS_PER_DAY);
        const runsLast7Days = runs.filter(r =>
          new Date(r.timestamp) >= sevenDaysAgo
        ).length;

        // Transform to match frontend expectations
        res.json({
          active_groups: stats.totalGroups,
          messages_last_7_days: stats.messagesLast7Days,
          runs_last_7_days: runsLast7Days,
          avg_engagement_rate: stats.averageEngagement
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/dashboard/trends', (req, res) => {
      try {
        const days = parseInt(req.query.days || 7);
        const trends = localDataStore.getEngagementTrends(days);

        // Transform to match frontend expectations
        const transformed = trends.map(t => ({
          date: t.date,
          message_count: t.messages,
          avg_engagement_rate: t.avgEngagement
        }));

        res.json(transformed);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/groups', (req, res) => {
      try {
        const groups = localDataStore.getGroups();
        const messages = localDataStore.getRecentMessages(1000);

        // Transform groups to match frontend expectations
        const transformed = groups.map((group, index) => {
          // Get messages for this group to calculate average engagement
          const groupMessages = messages.filter(m => m.group_name === group.name);
          const avgEngagement = groupMessages.length > 0
            ? groupMessages.reduce((sum, m) => sum + m.engagement_rate, 0) / groupMessages.length
            : 0;

          return {
            id: index + 1,
            group_name: group.name,
            total_members: group.total_members || 0,
            message_count: group.message_count || 0,
            avg_engagement_rate: avgEngagement,
            is_active: true, // All groups are active by default
            last_scraped: group.last_scraped
          };
        });

        res.json(transformed);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/groups/:id/messages', (req, res) => {
      try {
        const groupName = decodeURIComponent(req.params.id);
        const limit = parseInt(req.query.limit || 50);
        const offset = parseInt(req.query.offset || 0);
        const messages = localDataStore.getGroupMessages(groupName, limit, offset);
        res.json(messages);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    function getAnalyticsAuthHeader(req) {
      return req.headers.authorization || (storedVpsToken ? `Bearer ${storedVpsToken}` : '');
    }

    async function proxyToVPS(req, res, options = {}) {
      const authHeader = options.authHeader !== undefined ? options.authHeader : (req.headers.authorization || (storedVpsToken ? `Bearer ${storedVpsToken}` : ''));
      const baseUrl = options.baseUrl || VPS_BASE_URL;
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      const url = `${baseUrl}${req.path}${qs}`;
      try {
        const fetch = await getFetch();
        const response = await fetch(url, {
          method: req.method,
          headers: {
            'Content-Type': 'application/json',
            'x-client-type': 'electron',
            'Authorization': authHeader,
            ...req.headers
          },
          body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
          agent: httpsAgent
        });
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await response.json();
          res.status(response.status).json(data);
        } else {
          const text = await response.text();
          res.status(response.status).send(text);
        }
      } catch (error) {
        console.error('VPS proxy error:', error);
        sendError(res, 500, 'Failed to fetch from VPS', { details: error.message });
      }
    }

    expressApp.get('/api/analytics/top-groups', async (req, res) => {
      if (getAnalyticsAuthHeader(req)) {
        return proxyToVPS(req, res, { authHeader: getAnalyticsAuthHeader(req) });
      }
      try {
        const days = parseInt(req.query.days || 7);
        const topGroups = localDataStore.getTopGroups(days);
        const transformed = topGroups.map(g => ({
          group_id: g.name,
          group_name: g.name,
          current_group_size: g.totalMembers,
          message_count: g.messages,
          avg_engagement_rate: g.avgEngagement
        }));
        res.json(transformed);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/analytics/engagement-trends', async (req, res) => {
      if (getAnalyticsAuthHeader(req)) {
        return proxyToVPS(req, res, { authHeader: getAnalyticsAuthHeader(req) });
      }
      try {
        const days = parseInt(req.query.days || 7);
        const messages = localDataStore.getRecentMessages(electronConstants.DEFAULT_ANALYTICS_MESSAGE_LIMIT);
        const cutoffDate = new Date(Date.now() - days * electronConstants.MS_PER_DAY);

        // Group messages by date and group name
        const trendsByDateAndGroup = [];
        const groups = new Set();

        messages.forEach(msg => {
          const msgDate = new Date(msg.message_timestamp);
          if (msgDate >= cutoffDate) {
            const dateStr = msgDate.toISOString().split('T')[0];
            groups.add(msg.group_name);

            trendsByDateAndGroup.push({
              date: dateStr,
              group_name: msg.group_name,
              avg_engagement: msg.engagement_rate,
              message_count: 1
            });
          }
        });

        // Sort by date ascending (oldest to newest)
        trendsByDateAndGroup.sort((a, b) => new Date(a.date) - new Date(b.date));

        res.json(trendsByDateAndGroup);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/runs', (req, res) => {
      try {
        const limit = parseInt(req.query.limit || 20);
        const runs = localDataStore.getRuns(limit);

        // Transform to match frontend expectations
        const transformed = runs.map(run => ({
          id: run.id,
          started_at: run.timestamp,
          completed_at: run.timestamp, // Same as started since runs complete quickly
          groups_checked: run.groups_processed,
          messages_processed: run.messages_found,
          errors_count: 0,
          status: run.status
        }));

        res.json(transformed);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/errors', (req, res) => res.json([]));

    expressApp.get('/api/analytics/weekly-comparison', async (req, res) => {
      if (getAnalyticsAuthHeader(req)) {
        return proxyToVPS(req, res, { authHeader: getAnalyticsAuthHeader(req) });
      }
      try {
        const now = new Date();
        const thisWeekStart = new Date(now.getTime() - 7 * electronConstants.MS_PER_DAY);
        const lastWeekStart = new Date(now.getTime() - 14 * electronConstants.MS_PER_DAY);

        const messages = localDataStore.getRecentMessages(electronConstants.DEFAULT_ANALYTICS_MESSAGE_LIMIT);

        const thisWeekMessages = messages.filter(m =>
          new Date(m.message_timestamp) >= thisWeekStart
        );
        const lastWeekMessages = messages.filter(m => {
          const msgDate = new Date(m.message_timestamp);
          return msgDate >= lastWeekStart && msgDate < thisWeekStart;
        });

        const thisWeekAvg = thisWeekMessages.length > 0
          ? thisWeekMessages.reduce((sum, m) => sum + m.engagement_rate, 0) / thisWeekMessages.length
          : 0;
        const lastWeekAvg = lastWeekMessages.length > 0
          ? lastWeekMessages.reduce((sum, m) => sum + m.engagement_rate, 0) / lastWeekMessages.length
          : 0;

        const thisWeekGroups = new Set(thisWeekMessages.map(m => m.group_name)).size;
        const lastWeekGroups = new Set(lastWeekMessages.map(m => m.group_name)).size;

        res.json({
          messages_this_week: thisWeekMessages.length,
          messages_last_week: lastWeekMessages.length,
          engagement_this_week: parseFloat(thisWeekAvg.toFixed(2)),
          engagement_last_week: parseFloat(lastWeekAvg.toFixed(2)),
          active_groups_this_week: thisWeekGroups,
          active_groups_last_week: lastWeekGroups
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/analytics/engagement-by-day', async (req, res) => {
      if (getAnalyticsAuthHeader(req)) {
        return proxyToVPS(req, res, { authHeader: getAnalyticsAuthHeader(req) });
      }
      try {
        const days = parseInt(req.query.days || 7);
        const messages = localDataStore.getRecentMessages(electronConstants.DEFAULT_ANALYTICS_MESSAGE_LIMIT);
        const cutoffDate = new Date(Date.now() - days * electronConstants.MS_PER_DAY);

        // Group messages by day of week
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayStats = {};

        messages.forEach(msg => {
          const msgDate = new Date(msg.message_timestamp);
          if (msgDate >= cutoffDate) {
            const dayNum = msgDate.getDay();
            const dayName = dayNames[dayNum];

            if (!dayStats[dayNum]) {
              dayStats[dayNum] = {
                day_name: dayName,
                day_number: dayNum,
                message_count: 0,
                total_engagement: 0
              };
            }

            dayStats[dayNum].message_count++;
            dayStats[dayNum].total_engagement += msg.engagement_rate;
          }
        });

        // Calculate averages and format response
        const result = Object.values(dayStats).map((day) => ({
          day_name: day.day_name,
          day_number: day.day_number,
          message_count: day.message_count,
          avg_engagement: parseFloat((day.total_engagement / day.message_count).toFixed(2))
        }));

        // Sort by day number
        result.sort((a, b) => a.day_number - b.day_number);

        res.json(result);
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.get('/api/config/groups', (req, res) => {
      try {
        const config = readGroupsConfig();
        res.json({
          groups: config.groups || [],
          config: {
            autoDiscover: config.config?.autoDiscoverNewGroups || false,
            defaultMatchStrategy: config.config?.matchStrategy || 'exact'
          }
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.post('/api/config/groups/add', (req, res) => {
      try {
        const config = readGroupsConfig();
        const { name, enabled, notes } = req.body;
        const existingGroup = config.groups.find(g => g.name === name);
        if (existingGroup) {
          return sendError(res, 400, 'Group already exists');
        }
        config.groups.push({ name, enabled, notes: notes || '' });
        writeGroupsConfig(config);
        res.json({ success: true, message: 'Group added successfully' });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.patch('/api/config/groups/:name', (req, res) => {
      try {
        const config = readGroupsConfig();
        const groupName = decodeURIComponent(req.params.name);
        const updates = req.body;
        const group = config.groups.find(g => g.name === groupName);
        if (!group) {
          return sendError(res, 404, 'Group not found');
        }
        if (updates.enabled !== undefined) group.enabled = updates.enabled;
        if (updates.notes !== undefined) group.notes = updates.notes;
        writeGroupsConfig(config);
        res.json({ success: true, message: 'Group updated successfully' });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    expressApp.delete('/api/config/groups/:name', (req, res) => {
      try {
        const config = readGroupsConfig();
        const groupName = decodeURIComponent(req.params.name);
        const initialLength = config.groups.length;
        config.groups = config.groups.filter(g => g.name !== groupName);
        if (config.groups.length === initialLength) {
          return sendError(res, 404, 'Group not found');
        }
        writeGroupsConfig(config);
        res.json({ success: true, message: 'Group removed successfully' });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    });

    // Allow frontend to set VPS token (e.g. after login from localStorage) so analytics can use it
    expressApp.post('/api/auth/vps-token', (req, res) => {
      const token = req.body && (req.body.token || req.body.accessToken);
      if (token && typeof token === 'string') {
        saveVpsToken(token.trim());
        return res.json({ success: true, message: 'VPS token stored' });
      }
      res.status(400).json({ success: false, error: 'Missing token' });
    });

    // Proxy API calls to VPS (catch-all for routes not handled above)
    expressApp.all('/api/*', async (req, res) => {
      const apiUrl = `${VPS_BASE_URL}${req.path}`;
      try {
        const fetch = await getFetch();
        const response = await fetch(apiUrl, {
          method: req.method,
          headers: {
            'Content-Type': 'application/json',
            'x-client-type': 'electron',
            'Cookie': req.headers.cookie || '',
            ...req.headers
          },
          body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
          agent: httpsAgent
        });

        const contentType = response.headers.get('content-type');
        let data;
        if (contentType && contentType.includes('application/json')) {
          try {
            data = await response.json();
          } catch (jsonError) {
            console.error('Failed to parse JSON response:', jsonError);
            data = { error: 'Invalid JSON response from server' };
          }
        } else {
          const text = await response.text();
          console.error('Non-JSON response from VPS:', text.substring(0, 200));
          data = {
            error: 'Server returned non-JSON response',
            status: response.status,
            statusText: response.statusText
          };
        }

        if (req.method === 'POST' && req.path === '/api/auth/login' && response.ok && data) {
          const token = data.token || data.accessToken;
          if (token) saveVpsToken(token);
        }

        const setCookie = response.headers.get('set-cookie');
        if (setCookie) res.setHeader('Set-Cookie', setCookie);
        res.status(response.status).json(data);
      } catch (error) {
        console.error('API proxy error:', error);
        sendError(res, 500, 'Failed to connect to server', { details: error.message });
      }
    });

    localServer = http.createServer(expressApp);

    // Initialize and start engagement tracking service (shared ScraperService used by routes)
    try {
      postQueueService = new PostQueueService(whatsappManager, console);
      postQueueService.start();
      sharedScraperService = new ScraperService(whatsappManager);
      trackingService = new EngagementTrackingService(sharedScraperService, localDataStore);
      trackingService.start();
      console.log('Engagement tracking service initialized and started');
      console.log('→ Tracking messages for 30 days with progressive delays');
      console.log('→ Old messages (7-30 days) get 15s delay for accurate data capture');
      console.log('Post queue service initialized and started');
    } catch (error) {
      console.error('Failed to start engagement tracking service:', error.message);
    }

    localServer.listen(localPort, () => {
      console.log(`Local server started at http://localhost:${localPort}`);
      resolve();
    });

    localServer.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        localPort++;
        localServer.listen(localPort);
      } else {
        reject(error);
      }
    });
  });
}

// Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'GroupIQ',
    backgroundColor: '#002060',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
    show: false
  });

  Menu.setApplicationMenu(null);

  // Load the local dashboard
  mainWindow.loadURL(`http://localhost:${localPort}`);

  // Mirror renderer (browser console) logs to main process output
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelMap = { 0: 'INFO', 1: 'WARN', 2: 'ERROR', 3: 'DEBUG' };
    const tag = levelMap[level] || 'LOG';
    const source = sourceId || 'renderer';
    console.log(`[RENDERER:${tag}] ${source}:${line} ${message}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[RENDERER:CRASH]', details);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL && validatedURL.includes('localhost')) {
      console.error('[RENDERER:LOAD_FAILED]', errorCode, errorDescription, validatedURL);
    }
  });

  if (!rendererNetworkLoggingAttached) {
    const ses = mainWindow.webContents.session;
    rendererNetworkLoggingAttached = true;

    ses.webRequest.onCompleted((details) => {
      const url = details.url || '';
      const statusCode = details.statusCode || 0;
      const isApiRequest = url.includes('/api/') || url.includes('group-iq.com/api/');
      if (isApiRequest && statusCode >= 400) {
        console.warn(`[RENDERER:API:${statusCode}] ${details.method} ${url}`);
      }
    });

    ses.webRequest.onErrorOccurred((details) => {
      const url = details.url || '';
      const isApiRequest = url.includes('/api/') || url.includes('group-iq.com/api/');
      if (isApiRequest) {
        console.error(`[RENDERER:API:NETWORK_ERROR] ${details.method} ${url} :: ${details.error}`);
      }
    });
  }

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle window close
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();

      if (Notification.isSupported()) {
        new Notification({
          title: 'GroupIQ',
          body: 'App minimized to system tray'
        }).show();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

}

// Create system tray
function createTray() {
  const iconPath = path.join(__dirname, '../build/tray-icon.png');

  if (fs.existsSync(iconPath)) {
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Dashboard',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          } else {
            createWindow();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setToolTip('GroupIQ');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
      }
    });
  }
}

// Start WhatsApp scraper process
function startWhatsAppScraper(userData) {
  if (whatsappProcess) {
    return { success: false, error: 'WhatsApp is already running' };
  }

  const scraperPath = isDev
    ? path.join(__dirname, '../src/scraper-client.js')
    : path.join(process.resourcesPath, 'app.asar.unpacked/src/scraper-client.js');

  whatsappProcess = spawn('node', [scraperPath], {
    env: {
      ...process.env,
      USER_DATA: JSON.stringify(userData),
      ELECTRON_APP: 'true'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  whatsappProcess.stdout.on('data', (data) => {
    console.log(`WhatsApp: ${data}`);
    if (mainWindow) {
      mainWindow.webContents.send('whatsapp-log', data.toString());
    }
  });

  whatsappProcess.stderr.on('data', (data) => {
    console.error(`WhatsApp Error: ${data}`);
    if (mainWindow) {
      mainWindow.webContents.send('whatsapp-error', data.toString());
    }
  });

  whatsappProcess.on('close', (code) => {
    console.log(`WhatsApp process closed with code ${code}`);
    whatsappProcess = null;
    if (mainWindow) {
      mainWindow.webContents.send('whatsapp-stopped', code);
    }
  });

  return { success: true };
}

// Stop WhatsApp scraper
function stopWhatsAppScraper() {
  if (whatsappProcess) {
    whatsappProcess.kill();
    whatsappProcess = null;
    return { success: true };
  }
  return { success: false, error: 'WhatsApp is not running' };
}

// App ready
app.whenReady().then(async () => {
  try {
    // Start local server
    await startLocalServer();

    // Create window and tray
    createWindow();
    createTray();
  } catch (error) {
    console.error('Failed to start app:', error);
    dialog.showErrorBox('Startup Error', 'Failed to start the application. Please try again.');
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup on quit
app.on('before-quit', () => {
  app.isQuitting = true;

  if (whatsappProcess) {
    whatsappProcess.kill();
  }

  if (localServer) {
    localServer.close();
  }

  if (postQueueService) {
    postQueueService.stop();
  }
});

// IPC Handlers
ipcMain.handle('start-whatsapp', async (event, userData) => {
  return startWhatsAppScraper(userData);
});

ipcMain.handle('stop-whatsapp', async () => {
  return stopWhatsAppScraper();
});

ipcMain.handle('get-whatsapp-status', async () => {
  return {
    running: whatsappProcess !== null
  };
});

ipcMain.handle('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

ipcMain.handle('set-vps-token', (event, token) => {
  if (token && typeof token === 'string') {
    saveVpsToken(token.trim());
    return true;
  }
  return false;
});

// Handle uncaught exceptions — log to file when packaged so we can inspect after crash
function writeCrashLog(prefix, value) {
  try {
    const os = require('os');
    const logDir = process.env.LOGS_DIR || path.join(os.tmpdir(), 'groupiq-logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'crash.log');
    const line = `${new Date().toISOString()} ${prefix} ${typeof value === 'object' ? (value.stack || JSON.stringify(value)) : value}\n`;
    fs.appendFileSync(file, line);
  } catch (_) {}
  console.error(prefix, value);
}

process.on('uncaughtException', (error) => {
  writeCrashLog('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  writeCrashLog('Unhandled rejection:', reason);
});
