const express = require('express');
const http = require('http');
const path = require('path');
const EventEmitter = require('events');
const cookieParser = require('cookie-parser');
const logger = require('./utils/logger');
const authRoutes = require('./routes/auth');
const { authenticate } = require('./middleware/auth');

class GUIServer extends EventEmitter {
  constructor() {
    super();
    this.app = express();
    this.server = http.createServer(this.app);
    this.port = process.env.GUI_PORT || 3002;
    this.clients = [];
    this.logs = [];
    this.maxLogs = 100;
    this.currentQR = null;
    this.status = 'initializing';
    this.scraperStats = {
      groupsChecked: 0,
      messagesProcessed: 0,
      errorsCount: 0
    };

    this.setupRoutes();
  }

  setupRoutes() {
    // Middleware
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(cookieParser());

    // Auth routes
    this.app.use('/api/auth', authRoutes);

    // Serve static files
    this.app.use(express.static(path.join(__dirname, '../public')));

    // SSE endpoint for real-time updates (protected)
    this.app.get('/events', authenticate, (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Add client to list
      this.clients.push(res);

      // Send initial state
      this.sendEvent(res, 'status', { status: this.status });
      if (this.currentQR) {
        this.sendEvent(res, 'qr', { qr: this.currentQR });
      }
      this.sendEvent(res, 'stats', this.scraperStats);
      this.sendEvent(res, 'logs', { logs: this.logs });

      // Remove client on disconnect
      req.on('close', () => {
        this.clients = this.clients.filter(client => client !== res);
      });
    });

    // API endpoints (protected)
    this.app.get('/api/status', authenticate, (req, res) => {
      res.json({
        status: this.status,
        stats: this.scraperStats,
        hasQR: !!this.currentQR
      });
    });

    // Health check
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok' });
    });
  }

  sendEvent(client, event, data) {
    client.write(`event: ${event}\n`);
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event, data) {
    this.clients.forEach(client => {
      try {
        this.sendEvent(client, event, data);
      } catch (error) {
        logger.error('Failed to send event to client', { error: error.message });
      }
    });
  }

  addLog(level, message, meta = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      meta
    };

    this.logs.push(logEntry);

    // Keep only last N logs
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Broadcast to all connected clients
    this.broadcast('log', logEntry);
  }

  updateQR(qrData) {
    this.currentQR = qrData;
    this.broadcast('qr', { qr: qrData });
  }

  updateStatus(status) {
    this.status = status;
    this.broadcast('status', { status });
    this.addLog('info', `Status changed to: ${status}`);
  }

  updateStats(stats) {
    this.scraperStats = { ...this.scraperStats, ...stats };
    this.broadcast('stats', this.scraperStats);
  }

  clearQR() {
    this.currentQR = null;
    this.broadcast('qr', { qr: null });
  }

  start() {
    return new Promise((resolve, reject) => {
      try {
        this.server.listen(this.port, () => {
          logger.info(`GUI Server started at http://localhost:${this.port}`);
          this.addLog('info', `GUI Server started on port ${this.port}`);
          resolve();
        });

        this.server.on('error', (error) => {
          logger.error('GUI Server error', { error: error.message });
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.clients.forEach(client => {
        try {
          client.end();
        } catch (error) {
          // Ignore errors when closing clients
        }
      });
      this.clients = [];

      this.server.close(() => {
        logger.info('GUI Server stopped');
        resolve();
      });
    });
  }
}

// Export singleton instance
const guiServer = new GUIServer();
module.exports = guiServer;
