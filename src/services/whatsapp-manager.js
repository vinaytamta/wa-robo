const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs').promises;
const EventEmitter = require('events');
const logger = require('../utils/logger');
const { pool } = require('../config/database');

class WhatsAppSessionManager extends EventEmitter {
  constructor() {
    super();
    // Store client instances keyed by user_id
    this.clients = new Map();
    // Store QR codes keyed by user_id
    this.qrCodes = new Map();
    // Store connection status keyed by user_id
    this.status = new Map();
    // Session storage directory
    this.sessionsDir = path.join(__dirname, '../../.wwebjs_sessions');
  }

  /**
   * Initialize session storage directory
   */
  async init() {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      logger.info('WhatsApp Session Manager initialized', {
        sessionsDir: this.sessionsDir
      });
    } catch (error) {
      logger.error('Failed to initialize session directory', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Create and initialize a WhatsApp client for a specific user
   * @param {number} userId - User ID
   * @returns {Promise<void>}
   */
  async createClient(userId) {
    if (this.clients.has(userId)) {
      logger.warn('Client already exists for user', { userId });
      return;
    }

    try {
      logger.info('Creating WhatsApp client for user', { userId });

      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: `user_${userId}`,
          dataPath: this.sessionsDir
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
          ]
        }
      });

      // Set up event handlers
      this.setupClientHandlers(userId, client);

      // Store client
      this.clients.set(userId, client);
      this.status.set(userId, 'initializing');

      // Initialize the client
      await client.initialize();

      logger.info('WhatsApp client created and initializing', { userId });
    } catch (error) {
      logger.error('Failed to create WhatsApp client', {
        userId,
        error: error.message,
        stack: error.stack
      });
      this.status.set(userId, 'error');
      this.emit('error', { userId, error });
      throw error;
    }
  }

  /**
   * Set up event handlers for a client
   * @param {number} userId - User ID
   * @param {Client} client - WhatsApp client
   */
  setupClientHandlers(userId, client) {
    // QR code generation
    client.on('qr', async (qr) => {
      try {
        const qrDataURL = await qrcode.toDataURL(qr);
        this.qrCodes.set(userId, qrDataURL);
        this.status.set(userId, 'qr_ready');

        logger.info('QR code generated for user', { userId });
        this.emit('qr', { userId, qr: qrDataURL });
      } catch (error) {
        logger.error('Failed to generate QR code', { userId, error: error.message });
      }
    });

    // Client ready
    client.on('ready', async () => {
      try {
        this.qrCodes.delete(userId);
        this.status.set(userId, 'ready');

        // Get phone number
        const info = client.info;
        const phoneNumber = info?.wid?.user || 'unknown';

        // Update database
        await pool.query(
          `UPDATE users
           SET whatsapp_connected = true,
               whatsapp_phone_number = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [phoneNumber, userId]
        );

        logger.info('WhatsApp client ready', { userId, phoneNumber });
        this.emit('ready', { userId, phoneNumber });
      } catch (error) {
        logger.error('Error in ready handler', { userId, error: error.message });
      }
    });

    // Authenticated
    client.on('authenticated', () => {
      logger.info('WhatsApp client authenticated', { userId });
      this.status.set(userId, 'authenticated');
      this.emit('authenticated', { userId });
    });

    // Authentication failure
    client.on('auth_failure', async (message) => {
      logger.error('WhatsApp authentication failed', { userId, message });
      this.status.set(userId, 'auth_failed');

      await this.updateConnectionStatus(userId, false);
      this.emit('auth_failure', { userId, message });
    });

    // Disconnected
    client.on('disconnected', async (reason) => {
      logger.warn('WhatsApp client disconnected', { userId, reason });
      this.status.set(userId, 'disconnected');

      await this.updateConnectionStatus(userId, false);
      this.emit('disconnected', { userId, reason });
    });

    // Error
    client.on('error', (error) => {
      logger.error('WhatsApp client error', {
        userId,
        error: error.message,
        stack: error.stack
      });
      this.emit('error', { userId, error });
    });
  }

  /**
   * Update user's WhatsApp connection status in database
   * @param {number} userId - User ID
   * @param {boolean} connected - Connection status
   */
  async updateConnectionStatus(userId, connected) {
    try {
      await pool.query(
        `UPDATE users
         SET whatsapp_connected = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [connected, userId]
      );
    } catch (error) {
      logger.error('Failed to update connection status', {
        userId,
        connected,
        error: error.message
      });
    }
  }

  /**
   * Get WhatsApp client for a user
   * @param {number} userId - User ID
   * @returns {Client|null}
   */
  getClient(userId) {
    return this.clients.get(userId) || null;
  }

  /**
   * Get QR code for a user
   * @param {number} userId - User ID
   * @returns {string|null}
   */
  getQR(userId) {
    return this.qrCodes.get(userId) || null;
  }

  /**
   * Get status for a user
   * @param {number} userId - User ID
   * @returns {string}
   */
  getStatus(userId) {
    return this.status.get(userId) || 'not_initialized';
  }

  /**
   * Check if user has an active client
   * @param {number} userId - User ID
   * @returns {boolean}
   */
  hasClient(userId) {
    return this.clients.has(userId);
  }

  /**
   * Check if user's client is ready
   * @param {number} userId - User ID
   * @returns {boolean}
   */
  isReady(userId) {
    const client = this.clients.get(userId);
    return client && this.status.get(userId) === 'ready';
  }

  /**
   * Disconnect and destroy a user's WhatsApp client
   * @param {number} userId - User ID
   */
  async destroyClient(userId) {
    const client = this.clients.get(userId);
    if (!client) {
      logger.warn('No client to destroy for user', { userId });
      return;
    }

    try {
      logger.info('Destroying WhatsApp client', { userId });

      await client.destroy();
      this.clients.delete(userId);
      this.qrCodes.delete(userId);
      this.status.delete(userId);

      await this.updateConnectionStatus(userId, false);

      logger.info('WhatsApp client destroyed', { userId });
      this.emit('destroyed', { userId });
    } catch (error) {
      logger.error('Failed to destroy client', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Logout a user's WhatsApp session
   * @param {number} userId - User ID
   */
  async logout(userId) {
    const client = this.clients.get(userId);
    if (!client) {
      logger.warn('No client to logout for user', { userId });
      return;
    }

    try {
      logger.info('Logging out WhatsApp client', { userId });

      await client.logout();

      // Clean up session directory
      const sessionPath = path.join(this.sessionsDir, `user_${userId}`);
      try {
        await fs.rm(sessionPath, { recursive: true, force: true });
      } catch (error) {
        logger.warn('Failed to remove session directory', {
          userId,
          sessionPath,
          error: error.message
        });
      }

      await this.destroyClient(userId);

      logger.info('WhatsApp client logged out', { userId });
      this.emit('logout', { userId });
    } catch (error) {
      logger.error('Failed to logout client', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get all active client user IDs
   * @returns {number[]}
   */
  getActiveUserIds() {
    return Array.from(this.clients.keys());
  }

  /**
   * Get connection info for all users
   * @returns {Array<{userId: number, status: string, hasQR: boolean}>}
   */
  getAllStatus() {
    const result = [];
    for (const [userId, status] of this.status.entries()) {
      result.push({
        userId,
        status,
        hasQR: this.qrCodes.has(userId)
      });
    }
    return result;
  }

  /**
   * Clean up all clients (for graceful shutdown)
   */
  async cleanup() {
    logger.info('Cleaning up all WhatsApp clients');

    const userIds = Array.from(this.clients.keys());
    await Promise.all(
      userIds.map(userId => this.destroyClient(userId).catch(err => {
        logger.error('Error destroying client during cleanup', {
          userId,
          error: err.message
        });
      }))
    );

    logger.info('All WhatsApp clients cleaned up');
  }
}

// Export singleton instance
const whatsappManager = new WhatsAppSessionManager();
module.exports = whatsappManager;
