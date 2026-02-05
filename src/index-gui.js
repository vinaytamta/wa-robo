const guiServer = require('./gui-server');
const whatsappClient = require('./config/whatsapp');
const { closePool } = require('./config/database');
const ScraperService = require('./services/scraper-service');
const Message = require('./models/message');
const Group = require('./models/group');
const ScriptRun = require('./models/script-run');
const logger = require('./utils/logger');
const { subDays } = require('date-fns');
require('dotenv').config();

/**
 * Custom logger transport that sends logs to GUI
 */
function setupGUILogging() {
  const originalInfo = logger.info;
  const originalWarn = logger.warn;
  const originalError = logger.error;
  const originalDebug = logger.debug;

  logger.info = function(...args) {
    originalInfo.apply(logger, args);
    if (guiServer) {
      guiServer.addLog('info', formatLogMessage(args));
    }
  };

  logger.warn = function(...args) {
    originalWarn.apply(logger, args);
    if (guiServer) {
      guiServer.addLog('warn', formatLogMessage(args));
    }
  };

  logger.error = function(...args) {
    originalError.apply(logger, args);
    if (guiServer) {
      guiServer.addLog('error', formatLogMessage(args));
    }
  };

  logger.debug = function(...args) {
    originalDebug.apply(logger, args);
    if (guiServer) {
      guiServer.addLog('debug', formatLogMessage(args));
    }
  };
}

function formatLogMessage(args) {
  return args.map(arg => {
    if (typeof arg === 'object') {
      return JSON.stringify(arg);
    }
    return String(arg);
  }).join(' ');
}

/**
 * Main script execution with GUI
 */
async function main() {
  let scriptRunId = null;
  let client = null;

  try {
    // Start GUI server
    logger.info('Starting GUI server...');
    await guiServer.start();

    // Auto-open browser
    const guiUrl = `http://localhost:${guiServer.port}`;
    logger.info(`Opening browser at ${guiUrl}`);
    try {
      // Dynamic import for ES Module
      const open = (await import('open')).default;
      await open(guiUrl);
    } catch (error) {
      logger.warn('Could not auto-open browser. Please navigate to:', guiUrl);
    }

    // Setup GUI logging
    setupGUILogging();

    // Link WhatsApp client to GUI server
    whatsappClient.setGUIServer(guiServer);

    logger.info('='.repeat(60));
    logger.info('WhatsApp Message Engagement Tracker - Starting');
    logger.info('='.repeat(60));

    guiServer.updateStatus('initializing');

    // Create script run record
    scriptRunId = await ScriptRun.create();

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

    guiServer.updateStatus('scraping');

    // Initialize scraper service
    const scraper = new ScraperService(client);

    // Get monitored groups (filtered by config)
    const groups = await scraper.getMonitoredGroups();
    logger.info('Groups to monitor', { count: groups.length });

    if (groups.length === 0) {
      logger.warn('No groups to monitor. Please check your groups-config.json');
      await ScriptRun.complete(scriptRunId, {
        groupsChecked: 0,
        messagesProcessed: 0,
        errorsCount: 0
      });
      guiServer.updateStatus('ready');
      return;
    }

    // Calculate lookback date
    const lookbackDays = parseInt(process.env.MESSAGES_LOOKBACK_DAYS) || 7;
    const sinceDate = subDays(new Date(), lookbackDays);
    logger.info('Lookback period', {
      days: lookbackDays,
      since: sinceDate.toISOString()
    });

    // Track progress
    let totalMessages = 0;
    let totalErrors = 0;
    let groupsChecked = 0;

    // Process each group
    for (const chat of groups) {
      try {
        logger.info('-'.repeat(60));
        logger.info('Processing group', { name: chat.name });

        // Get actual group participant count
        const participants = await chat.participants;
        const actualMemberCount = participants ? participants.length : 0;

        // Update group with actual member count
        await Group.upsert({
          groupId: chat.id._serialized,
          groupName: chat.name,
          totalMembers: actualMemberCount
        });

        // Scrape messages from this group
        const messages = await scraper.scrapeGroupMessages(chat, sinceDate);

        // Save messages to database
        for (const msg of messages) {
          try {
            await Message.upsert(msg);
            totalMessages++;

            logger.info('Message saved', {
              group: msg.groupName,
              seenCount: msg.seenCount,
              totalMembers: msg.totalMembers,
              engagementRate: `${((msg.seenCount / msg.totalMembers) * 100).toFixed(1)}%`
            });
          } catch (error) {
            logger.error('Failed to save message', {
              messageId: msg.messageId,
              error: error.message
            });
            totalErrors++;
            await ScriptRun.logError(
              scriptRunId,
              null,
              'MESSAGE_SAVE_ERROR',
              error.message
            );
          }
        }

        groupsChecked++;
        logger.info('Group processed', {
          name: chat.name,
          messagesProcessed: messages.length
        });

        // Update progress periodically
        await ScriptRun.updateProgress(scriptRunId, {
          groupsChecked,
          messagesProcessed: totalMessages,
          errorsCount: totalErrors
        });

        // Update GUI stats
        guiServer.updateStats({
          groupsChecked,
          messagesProcessed: totalMessages,
          errorsCount: totalErrors
        });

      } catch (error) {
        logger.error('Failed to process group', {
          name: chat.name,
          error: error.message
        });
        totalErrors++;
        await ScriptRun.logError(
          scriptRunId,
          null,
          'GROUP_PROCESSING_ERROR',
          `${chat.name}: ${error.message}`
        );
        guiServer.updateStats({ errorsCount: totalErrors });
      }
    }

    // Complete script run
    await ScriptRun.complete(scriptRunId, {
      groupsChecked,
      messagesProcessed: totalMessages,
      errorsCount: totalErrors
    });

    logger.info('='.repeat(60));
    logger.info('Script execution completed successfully');
    logger.info('Summary:', {
      groupsChecked,
      messagesProcessed: totalMessages,
      errorsCount: totalErrors
    });
    logger.info('='.repeat(60));

    guiServer.updateStatus('ready');

  } catch (error) {
    logger.error('Fatal error during execution', {
      error: error.message,
      stack: error.stack
    });

    if (guiServer) {
      guiServer.updateStatus('error');
    }

    if (scriptRunId) {
      await ScriptRun.fail(scriptRunId, error.message);
    }

    process.exit(1);
  } finally {
    // Cleanup
    try {
      if (whatsappClient.isClientReady()) {
        logger.info('Shutting down WhatsApp client...');
        await whatsappClient.shutdown();
      }

      logger.info('Closing database connections...');
      await closePool();

      logger.info('Cleanup completed');
      logger.info('GUI server is still running. Press Ctrl+C to exit.');
    } catch (error) {
      logger.error('Error during cleanup', { error: error.message });
    }
  }
}

// Handle process termination signals
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal, shutting down gracefully...');

  try {
    if (whatsappClient.isClientReady()) {
      await whatsappClient.shutdown();
    }
    await closePool();
    if (guiServer) {
      await guiServer.stop();
    }
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message });
  }

  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal, shutting down gracefully...');

  try {
    if (whatsappClient.isClientReady()) {
      await whatsappClient.shutdown();
    }
    await closePool();
    if (guiServer) {
      await guiServer.stop();
    }
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message });
  }

  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason,
    promise: promise
  });
});

// Run main function
if (require.main === module) {
  main().catch(error => {
    logger.error('Unhandled error in main', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  });
}

module.exports = { main };
