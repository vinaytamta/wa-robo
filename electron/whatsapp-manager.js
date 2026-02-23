const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { MessageMedia } = require('whatsapp-web.js');
const whatsappClient = require('../src/config/whatsapp');
const logger = require('../src/utils/logger');
const EventEmitter = require('events');

function getSessionPathFragment() {
  const sessionName = process.env.WA_SESSION_NAME || 'wa-robo-session';
  const basePath = process.env.WWEBJS_AUTH_PATH || path.join(process.cwd(), '.wwebjs_auth');
  return path.join(basePath, `session-${sessionName}`);
}

/**
 * WhatsApp Manager for Electron
 * Manages WhatsApp client lifecycle and emits events to frontend
 */
class WhatsAppManager extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.status = 'not_initialized';
    this.qrCode = null;
    this.phoneNumber = null;
    this.isInitializing = false;
    this.hasTriedAutoBrowserInstall = false;
  }

  isMissingChromeError(errorMessage) {
    const msg = String(errorMessage || '').toLowerCase();
    return msg.includes('could not find chrome');
  }

  getPuppeteerCacheDir() {
    return process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
  }

  getCandidateChromeExecutablePaths(versionDirName) {
    const chromeRoot = path.join(this.getPuppeteerCacheDir(), 'chrome', versionDirName);
    if (process.platform === 'win32') {
      return [path.join(chromeRoot, 'chrome-win64', 'chrome.exe')];
    }
    if (process.platform === 'darwin') {
      return [
        path.join(chromeRoot, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(chromeRoot, 'chrome-mac', 'Google Chrome for Testing')
      ];
    }
    return [path.join(chromeRoot, 'chrome-linux64', 'chrome')];
  }

  findInstalledPuppeteerChrome() {
    try {
      const chromeBase = path.join(this.getPuppeteerCacheDir(), 'chrome');
      if (!fs.existsSync(chromeBase)) return null;

      const entries = fs.readdirSync(chromeBase, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          mtimeMs: fs.statSync(path.join(chromeBase, entry.name)).mtimeMs
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const entry of entries) {
        const candidates = this.getCandidateChromeExecutablePaths(entry.name);
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to scan Puppeteer Chrome cache', { error: error.message });
    }
    return null;
  }

  async installPuppeteerChrome() {
    const cliPath = require.resolve('puppeteer/lib/cjs/puppeteer/node/cli.js');
    logger.info('Installing Puppeteer Chrome (first-run setup)...');

    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, 'browsers', 'install', 'chrome'],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      let stderr = '';
      child.stdout.on('data', (chunk) => {
        const text = String(chunk || '').trim();
        if (text) logger.info('Puppeteer install output', { line: text });
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '');
      });

      const timeout = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        reject(new Error('Timed out installing Puppeteer Chrome'));
      }, 10 * 60 * 1000);

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) return resolve();
        reject(new Error(`Puppeteer Chrome install failed (exit ${code}): ${stderr.trim()}`));
      });
    });
  }

  async ensureChromeExecutable() {
    if (process.env.WA_CHROME_PATH && fs.existsSync(process.env.WA_CHROME_PATH)) {
      return process.env.WA_CHROME_PATH;
    }

    const cached = this.findInstalledPuppeteerChrome();
    if (cached) {
      process.env.WA_CHROME_PATH = cached;
      logger.info('Using cached Puppeteer Chrome', { executablePath: cached });
      return cached;
    }

    await this.installPuppeteerChrome();

    const installed = this.findInstalledPuppeteerChrome();
    if (!installed) {
      throw new Error('Puppeteer Chrome install completed but executable was not found');
    }

    process.env.WA_CHROME_PATH = installed;
    logger.info('Using newly installed Puppeteer Chrome', { executablePath: installed });
    return installed;
  }

  async startClientInitialization() {
    this.client = whatsappClient.createClient();
    this.setupEventHandlers();

    this.client.initialize().catch(async (err) => {
      logger.error('WhatsApp client initialize() failed', { error: err.message, stack: err.stack });

      if (this.isMissingChromeError(err.message) && !this.hasTriedAutoBrowserInstall) {
        this.hasTriedAutoBrowserInstall = true;
        this.status = 'installing_browser';
        this.emit('status', { status: this.status, message: 'Installing browser for first run...' });

        try {
          await this.ensureChromeExecutable();

          // Recreate client with new executable path
          if (this.client) {
            try {
              await this.client.destroy();
            } catch (_) {}
          }
          this.client = null;

          this.status = 'initializing';
          this.emit('status', { status: this.status, message: 'Retrying WhatsApp initialization...' });
          await this.startClientInitialization();
          return;
        } catch (installError) {
          logger.error('Auto-install browser failed', { error: installError.message });
          this.status = 'error';
          this.isInitializing = false;
          this.emit('status', { status: this.status, error: installError.message });
          return;
        }
      }

      this.status = 'error';
      this.isInitializing = false;
      this.emit('status', { status: this.status, error: err.message });
    });
  }

  /**
   * Clean up any existing Chrome processes using the session
   * (Skipped on Windows — pkill/lsof not available; no-op to avoid blocking init)
   */
  async cleanupExistingProcesses() {
    if (process.platform === 'win32') {
      logger.debug('Skipping Chrome cleanup on Windows');
      return;
    }
    try {
      const { execSync } = require('child_process');
      let killedProcesses = false;

      logger.info('Cleaning up existing Chrome/Chromium processes...');

      // Method 1: Use pkill to kill Chrome processes with wwebjs pattern
      try {
        execSync('pkill -9 -f "chrome.*wwebjs"', { timeout: 3000 });
        logger.info('Killed Chrome processes using pkill (chrome pattern)');
        killedProcesses = true;
      } catch (error) {
        // No processes found or command failed - that's fine
        logger.debug('No Chrome processes found with pkill (chrome pattern)');
      }

      // Method 2: Try Google Chrome pattern
      try {
        execSync('pkill -9 -f "Google.*wwebjs"', { timeout: 3000 });
        logger.info('Killed Chrome processes using pkill (Google pattern)');
        killedProcesses = true;
      } catch (error) {
        logger.debug('No Chrome processes found with pkill (Google pattern)');
      }

      // Method 3: Use lsof to find processes locking the session directory
      try {
        const sessionPath = getSessionPathFragment();
        const result = execSync(`lsof | grep "${sessionPath}" | awk '{print $2}' | sort -u`, {
          encoding: 'utf8',
          timeout: 5000
        });

        const pids = result.trim().split('\n').filter(pid => pid && !isNaN(pid));

        if (pids.length > 0) {
          logger.info('Found processes locking session directory', { count: pids.length, pids });

          // Kill each process
          for (const pid of pids) {
            try {
              execSync(`kill -9 ${pid}`, { timeout: 2000 });
              logger.info('Killed process by PID', { pid });
              killedProcesses = true;
            } catch (killError) {
              logger.debug('Could not kill process', { pid, error: killError.message });
            }
          }
        }
      } catch (error) {
        logger.debug('No processes found with lsof');
      }

      // If we killed any processes, wait longer for cleanup
      if (killedProcesses) {
        logger.info('Waiting for processes to fully terminate...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verify cleanup
        try {
          const verifyResult = execSync('ps aux | grep -i chrome | grep -i wwebjs | grep -v grep', {
            encoding: 'utf8',
            timeout: 2000
          });

          if (verifyResult.trim()) {
            logger.warn('Some Chrome processes may still be running', { processes: verifyResult.trim() });
          } else {
            logger.info('All Chrome processes cleaned up successfully');
          }
        } catch (error) {
          // No processes found - this is good
          logger.info('Verified: No Chrome wwebjs processes running');
        }
      } else {
        logger.info('No existing Chrome processes found to clean up');
      }

    } catch (error) {
      logger.warn('Error during cleanup', { error: error.message });
      // Don't throw - cleanup is best effort
    }
  }

  /**
   * Initialize WhatsApp client
   */
  async initialize() {
    if (this.isInitializing) {
      throw new Error('Already initializing');
    }

    if (this.client) {
      throw new Error('Client already initialized');
    }

    this.isInitializing = true;
    this.status = 'initializing';
    this.emit('status', { status: this.status });

    try {
      logger.info('Initializing WhatsApp client in Electron...');

      // Clean up any existing Chrome processes first
      await this.cleanupExistingProcesses();

      // If Chrome is already present in Puppeteer cache, prefer it proactively.
      const cachedChromePath = this.findInstalledPuppeteerChrome();
      if (cachedChromePath) {
        process.env.WA_CHROME_PATH = cachedChromePath;
      }

      // Create and setup client
      await this.startClientInitialization();

      logger.info('WhatsApp client initialization started');
      return { success: true, message: 'WhatsApp client initializing...' };
    } catch (error) {
      logger.error('Failed to initialize WhatsApp client', { error: error.message });
      this.status = 'error';
      this.isInitializing = false;
      this.emit('status', { status: this.status, error: error.message });
      throw error;
    }
  }

  /**
   * Setup event handlers for WhatsApp client
   */
  setupEventHandlers() {
    if (!this.client) return;

    // QR Code event
    this.client.on('qr', async (qr) => {
      logger.info('QR Code received');
      const QRCode = require('qrcode');

      try {
        // Generate QR code as data URL
        const qrDataURL = await QRCode.toDataURL(qr);
        this.qrCode = qrDataURL;
        this.status = 'qr_ready';
        this.isInitializing = false;

        logger.info('QR Code generated, waiting for scan...');

        // Emit to frontend
        this.emit('qr', { qr: qrDataURL });
        this.emit('status', { status: this.status });
      } catch (error) {
        logger.error('Failed to generate QR code', { error: error.message });
      }
    });

    // Authenticated event
    this.client.on('authenticated', () => {
      logger.info('WhatsApp authenticated');
      this.status = 'authenticated';
      this.qrCode = null;
      this.isInitializing = false;
      this.emit('status', { status: this.status });
    });

    // Ready event
    this.client.on('ready', async () => {
      logger.info('WhatsApp client ready');
      this.status = 'ready';
      this.isInitializing = false;

      try {
        // Get phone number
        const info = this.client.info;
        this.phoneNumber = info.wid.user;

        logger.info('WhatsApp ready', { phoneNumber: this.phoneNumber });

        this.emit('ready', { phoneNumber: this.phoneNumber });
        this.emit('status', { status: this.status });
      } catch (error) {
        logger.error('Error getting client info', { error: error.message });
      }
    });

    // Authentication failure event
    this.client.on('auth_failure', (msg) => {
      logger.error('WhatsApp authentication failed', { message: msg });
      this.status = 'auth_failed';
      this.isInitializing = false;
      this.emit('error', { error: 'Authentication failed' });
      this.emit('status', { status: this.status });
    });

    // Disconnected event
    this.client.on('disconnected', (reason) => {
      logger.warn('WhatsApp disconnected', { reason });
      this.status = 'disconnected';
      this.phoneNumber = null;
      this.emit('disconnected', { reason });
      this.emit('status', { status: this.status });
    });

    // Loading screen event
    this.client.on('loading_screen', (percent, message) => {
      logger.debug('WhatsApp loading...', { percent, message });
    });
  }

  /**
   * Disconnect WhatsApp client (keep session)
   */
  async disconnect() {
    if (!this.client) {
      throw new Error('No client to disconnect');
    }

    try {
      logger.info('Disconnecting WhatsApp client...');
      await this.client.destroy();
      this.client = null;
      this.status = 'not_initialized';
      this.phoneNumber = null;
      this.qrCode = null;
      this.emit('status', { status: this.status });
      return { success: true, message: 'Disconnected successfully' };
    } catch (error) {
      logger.error('Error disconnecting WhatsApp', { error: error.message });
      throw error;
    }
  }

  /**
   * Logout WhatsApp (destroy session)
   */
  async logout() {
    if (!this.client) {
      throw new Error('No client to logout');
    }

    try {
      logger.info('Logging out WhatsApp...');
      await this.client.logout();
      await this.client.destroy();
      this.client = null;
      this.status = 'not_initialized';
      this.phoneNumber = null;
      this.qrCode = null;
      this.emit('status', { status: this.status });
      return { success: true, message: 'Logged out successfully' };
    } catch (error) {
      logger.error('Error logging out WhatsApp', { error: error.message });
      throw error;
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      status: this.status,
      hasQR: this.qrCode !== null,
      isReady: this.status === 'ready',
      phoneNumber: this.phoneNumber
    };
  }

  /**
   * Get QR code
   */
  getQRCode() {
    return this.qrCode;
  }

  /**
   * Check if client exists
   */
  hasClient() {
    return this.client !== null;
  }

  /**
   * Get all chats (groups and direct messages)
   */
  async getChats() {
    if (!this.client || this.status !== 'ready') {
      throw new Error('WhatsApp client not ready');
    }

    try {
      const chats = await this.client.getChats();
      logger.info('Fetched chats', { count: chats.length });

      // Filter to only groups
      const groups = chats.filter(chat => chat.isGroup);
      logger.info('Groups found', { count: groups.length });

      return groups.map(group => ({
        id: group.id._serialized,
        name: group.name,
        participants: group.participants?.length || 0,
        isGroup: group.isGroup,
        unreadCount: group.unreadCount
      }));
    } catch (error) {
      logger.error('Error fetching chats', { error: error.message });
      throw error;
    }
  }

  /**
   * Resolve a target group by jid first, then by exact name match.
   */
  async resolveGroupTarget({ groupJid, groupName }) {
    if (!this.client || this.status !== 'ready') {
      throw new Error('WhatsApp client not ready');
    }

    const chats = await this.client.getChats();
    const groups = chats.filter(chat => chat.isGroup);

    if (groupJid) {
      const byId = groups.find(group => group.id?._serialized === groupJid);
      if (byId) {
        return {
          id: byId.id._serialized,
          name: byId.name,
          chat: byId
        };
      }
    }

    if (groupName) {
      const normalizedTarget = String(groupName).trim().toLowerCase();
      const byName = groups.find(group => String(group.name || '').trim().toLowerCase() === normalizedTarget);
      if (byName) {
        return {
          id: byName.id._serialized,
          name: byName.name,
          chat: byName
        };
      }
    }

    throw new Error('Target group not found');
  }

  /**
   * Send a text and/or image message to a target group.
   * @param {Object} opts
   * @param {string} [opts.groupJid]
   * @param {string} [opts.groupName]
   * @param {string} [opts.messageText] - Optional caption when sending image
   * @param {Object} [opts.image] - Optional image: { filePath } or { data, mimetype }
   */
  async sendMessageToGroup({ groupJid, groupName, messageText, image }) {
    const hasText = messageText && String(messageText).trim();
    const hasImage = image && (image.filePath || (image.data && image.mimetype));

    if (!hasText && !hasImage) {
      return { success: false, error: 'messageText or image is required' };
    }

    try {
      const target = await this.resolveGroupTarget({ groupJid, groupName });

      if (hasImage) {
        let media;
        if (image.filePath && fs.existsSync(image.filePath)) {
          media = MessageMedia.fromFilePath(image.filePath);
        } else if (image.data && image.mimetype) {
          media = new MessageMedia(image.mimetype, image.data);
        } else {
          return { success: false, error: 'Invalid image: provide filePath or data+mimetype' };
        }
        const caption = hasText ? String(messageText).trim() : undefined;
        const sendResult = await this.client.sendMessage(target.id, media, { caption });
        return {
          success: true,
          messageId: sendResult?.id?._serialized || '',
          group: {
            id: target.id,
            name: target.name
          }
        };
      }

      const sendResult = await this.client.sendMessage(target.id, String(messageText));
      return {
        success: true,
        messageId: sendResult?.id?._serialized || '',
        group: {
          id: target.id,
          name: target.name
        }
      };
    } catch (error) {
      logger.error('Failed to send message to group', {
        error: error.message,
        groupJid,
        groupName
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get the underlying client (for advanced operations)
   */
  getClient() {
    return this.client;
  }
}

// Export singleton instance
const whatsappManager = new WhatsAppManager();
module.exports = whatsappManager;
