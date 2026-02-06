const whatsappClient = require('../src/config/whatsapp');
const logger = require('../src/utils/logger');
const EventEmitter = require('events');

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
  }

  /**
   * Clean up any existing Chrome processes using the session
   */
  async cleanupExistingProcesses() {
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
        const sessionPath = '.wwebjs_auth/session-wa-robo-session';
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

      // Create and setup client
      this.client = whatsappClient.createClient();
      this.setupEventHandlers();

      // Initialize (don't wait for ready - let events handle it)
      this.client.initialize();

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
   * Get the underlying client (for advanced operations)
   */
  getClient() {
    return this.client;
  }
}

// Export singleton instance
const whatsappManager = new WhatsAppManager();
module.exports = whatsappManager;
