const whatsappClient = require('./config/whatsapp');
const ScraperService = require('./services/scraper-service');
const logger = require('./utils/logger');
const { subDays } = require('date-fns');

/**
 * Local WhatsApp Scraper Client for Electron
 * Runs on user's computer, syncs data to VPS
 */

let client = null;
let isRunning = false;

async function startScraping() {
  if (isRunning) {
    console.log('Scraper is already running');
    return;
  }

  isRunning = true;

  try {
    logger.info('='.repeat(60));
    logger.info('WhatsApp Scraper Client - Starting');
    logger.info('='.repeat(60));

    // Initialize WhatsApp client
    logger.info('Initializing WhatsApp client...');
    await whatsappClient.initialize();
    client = whatsappClient.getClient();

    // Get client info
    const clientInfo = await whatsappClient.getClientInfo();
    logger.info('Logged in as', {
      name: clientInfo.pushname,
      number: clientInfo.wid.user
    });

    // Send QR code to main process if needed
    client.on('qr', (qr) => {
      console.log('QR_CODE:', qr); // Electron will listen for this
    });

    client.on('ready', () => {
      console.log('WHATSAPP_READY');
      startPeriodicScraping();
    });

    client.on('disconnected', (reason) => {
      console.log('WHATSAPP_DISCONNECTED:', reason);
      isRunning = false;
    });

  } catch (error) {
    logger.error('Failed to start scraper', {
      error: error.message,
      stack: error.stack
    });
    console.error('SCRAPER_ERROR:', error.message);
    isRunning = false;
    process.exit(1);
  }
}

async function startPeriodicScraping() {
  // Initial scrape
  await performScrape();

  // Schedule periodic scraping (every 6 hours)
  setInterval(async () => {
    await performScrape();
  }, 6 * 60 * 60 * 1000);
}

async function performScrape() {
  try {
    logger.info('Starting scrape cycle...');

    const scraper = new ScraperService(client);
    const groups = await scraper.getMonitoredGroups();

    logger.info('Groups to monitor', { count: groups.length });

    if (groups.length === 0) {
      logger.warn('No groups to monitor');
      return;
    }

    const lookbackDays = parseInt(process.env.MESSAGES_LOOKBACK_DAYS) || 7;
    const sinceDate = subDays(new Date(), lookbackDays);

    let totalMessages = 0;

    for (const chat of groups) {
      try {
        logger.info('Processing group', { name: chat.name });

        const messages = await scraper.scrapeGroupMessages(chat, sinceDate);

        // Send data to VPS API
        await sendDataToVPS(messages);

        totalMessages += messages.length;

        logger.info('Group completed', {
          name: chat.name,
          messages: messages.length
        });

      } catch (error) {
        logger.error('Failed to process group', {
          name: chat.name,
          error: error.message
        });
      }
    }

    logger.info('Scrape cycle completed', { totalMessages });
    console.log('SCRAPE_COMPLETED:', totalMessages);

  } catch (error) {
    logger.error('Scrape cycle failed', { error: error.message });
    console.error('SCRAPE_ERROR:', error.message);
  }
}

async function sendDataToVPS(messages) {
  // Get user data from environment
  const userData = JSON.parse(process.env.USER_DATA || '{}');

  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch('https://group-iq.com/scraper/api/data/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userData.token}`
      },
      body: JSON.stringify({ messages })
    });

    if (!response.ok) {
      throw new Error(`Failed to sync data: ${response.statusText}`);
    }

    logger.info('Data synced to VPS', { count: messages.length });
  } catch (error) {
    logger.error('Failed to sync data to VPS', { error: error.message });
    throw error;
  }
}

// Handle process signals
process.on('SIGINT', async () => {
  logger.info('Shutting down scraper...');
  if (whatsappClient.isClientReady()) {
    await whatsappClient.shutdown();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down scraper...');
  if (whatsappClient.isClientReady()) {
    await whatsappClient.shutdown();
  }
  process.exit(0);
});

// Start the scraper
if (require.main === module) {
  startScraping().catch(error => {
    logger.error('Fatal error', { error: error.message });
    process.exit(1);
  });
}

module.exports = { startScraping };
