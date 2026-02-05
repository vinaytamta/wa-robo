const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const logger = require('../utils/logger');
const { WhatsAppError } = require('../utils/error-handler');
require('dotenv').config();

class WhatsAppClient {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.guiServer = null;
  }

  /**
   * Set GUI server for emitting events
   * @param {Object} guiServer - GUI server instance
   */
  setGUIServer(guiServer) {
    this.guiServer = guiServer;
  }

  /**
   * Initialize WhatsApp client with configuration
   * @returns {Client}
   */
  createClient() {
    const sessionName = process.env.WA_SESSION_NAME || 'wa-robo-session';
    const headless = process.env.WA_HEADLESS === 'true';

    logger.info('Creating WhatsApp client', { sessionName, headless });

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionName,
        dataPath: './.wwebjs_auth'
      }),
      puppeteer: {
        headless: headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
      }
    });

    this.setupEventHandlers();
    return this.client;
  }

  /**
   * Setup event handlers for WhatsApp client
   */
  setupEventHandlers() {
    // QR Code event
    this.client.on('qr', async (qr) => {
      logger.info('QR Code received - scan with your WhatsApp mobile app');

      // Show in terminal if no GUI server
      if (!this.guiServer) {
        console.log('\n');
        qrcode.generate(qr, { small: true });
        console.log('\n');
      }

      // Send to GUI server if available
      if (this.guiServer) {
        try {
          const qrDataURL = await QRCode.toDataURL(qr);
          this.guiServer.updateQR(qrDataURL);
          this.guiServer.updateStatus('waiting_for_qr');
        } catch (error) {
          logger.error('Failed to generate QR code image', { error: error.message });
        }
      }

      logger.info('Waiting for QR code scan...');
    });

    // Ready event
    this.client.on('ready', () => {
      this.isReady = true;
      logger.info('WhatsApp client is ready!');
      if (this.guiServer) {
        this.guiServer.clearQR();
        this.guiServer.updateStatus('ready');
      }
    });

    // Authenticated event
    this.client.on('authenticated', () => {
      logger.info('WhatsApp client authenticated successfully');
      if (this.guiServer) {
        this.guiServer.updateStatus('authenticating');
      }
    });

    // Authentication failure event
    this.client.on('auth_failure', (msg) => {
      logger.error('WhatsApp authentication failed', { message: msg });
      throw new WhatsAppError('Authentication failed');
    });

    // Disconnected event
    this.client.on('disconnected', (reason) => {
      this.isReady = false;
      logger.warn('WhatsApp client disconnected', { reason });
    });

    // Loading screen event
    this.client.on('loading_screen', (percent, message) => {
      logger.debug('WhatsApp loading...', { percent, message });
    });

    // Message event (optional - for debugging)
    this.client.on('message_create', (msg) => {
      logger.debug('New message detected', {
        from: msg.from,
        hasMedia: msg.hasMedia,
        type: msg.type
      });
    });
  }

  /**
   * Initialize and start the WhatsApp client
   * @returns {Promise<Client>}
   */
  async initialize() {
    try {
      if (!this.client) {
        this.createClient();
      }

      logger.info('Initializing WhatsApp client...');
      await this.client.initialize();

      // Wait for client to be ready
      if (!this.isReady) {
        await this.waitForReady(60000); // 60 second timeout
      }

      logger.info('WhatsApp client initialized and ready');
      return this.client;
    } catch (error) {
      logger.error('Failed to initialize WhatsApp client', {
        error: error.message,
        stack: error.stack
      });
      throw new WhatsAppError(`WhatsApp initialization failed: ${error.message}`);
    }
  }

  /**
   * Wait for client to be ready with timeout
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForReady(timeout = 60000) {
    const startTime = Date.now();

    while (!this.isReady) {
      if (Date.now() - startTime > timeout) {
        throw new WhatsAppError('Timeout waiting for WhatsApp client to be ready');
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Get the WhatsApp client instance
   * @returns {Client}
   */
  getClient() {
    if (!this.client) {
      throw new WhatsAppError('WhatsApp client not initialized');
    }
    return this.client;
  }

  /**
   * Check if client is ready
   * @returns {boolean}
   */
  isClientReady() {
    return this.isReady;
  }

  /**
   * Gracefully shutdown the WhatsApp client
   * @returns {Promise<void>}
   */
  async shutdown() {
    try {
      if (this.client) {
        logger.info('Shutting down WhatsApp client...');
        await this.client.destroy();
        this.isReady = false;
        logger.info('WhatsApp client shutdown complete');
      }
    } catch (error) {
      logger.error('Error shutting down WhatsApp client', {
        error: error.message
      });
      throw new WhatsAppError(`Failed to shutdown WhatsApp client: ${error.message}`);
    }
  }

  /**
   * Get client info (phone number, name, etc.)
   * @returns {Promise<Object>}
   */
  async getClientInfo() {
    try {
      const client = this.getClient();
      const info = client.info;

      logger.info('WhatsApp client info retrieved', {
        pushname: info.pushname,
        platform: info.platform
      });

      return info;
    } catch (error) {
      logger.error('Error getting client info', { error: error.message });
      throw new WhatsAppError(`Failed to get client info: ${error.message}`);
    }
  }
}

// Export singleton instance
const whatsappClient = new WhatsAppClient();
module.exports = whatsappClient;
