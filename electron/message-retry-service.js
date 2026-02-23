const logger = require('../src/utils/logger');
const { loadJsonConfig } = require('./config-loader');
const { SCRAPER_CONFIG_PATH, MS_PER_DAY } = require('./constants');

const defaultRetryConfig = {
  retries: { enablePeriodicRetry: true, periodicRetryInterval: 300000 },
  dataQuality: { retryMessagesWithZeroSeen: true, retryMessagesOlderThanDays: 7 }
};

/**
 * Background service that periodically retries fetching missing message data
 */
class MessageRetryService {
  constructor(scraperService, localDataStore) {
    this.scraperService = scraperService;
    this.localDataStore = localDataStore;
    this.retryInterval = null;
    this.isRunning = false;
    this.config = loadJsonConfig(SCRAPER_CONFIG_PATH, defaultRetryConfig);
  }

  /**
   * Start the periodic retry service
   */
  start() {
    if (!this.config.retries.enablePeriodicRetry) {
      logger.info('Periodic retry is disabled in config');
      return;
    }

    if (this.isRunning) {
      logger.warn('Retry service already running');
      return;
    }

    this.isRunning = true;
    const intervalMs = this.config.retries.periodicRetryInterval;

    logger.info('Starting periodic retry service', {
      intervalMinutes: intervalMs / 60000,
      intervalMs
    });

    // Run first check after 1 minute (give app time to settle)
    setTimeout(() => {
      this.runRetryCheck();
    }, 60000);

    // Then run periodically
    this.retryInterval = setInterval(() => {
      this.runRetryCheck();
    }, intervalMs);
  }

  /**
   * Stop the periodic retry service
   */
  stop() {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
      this.isRunning = false;
      logger.info('Periodic retry service stopped');
    }
  }

  /**
   * Run a single retry check cycle
   */
  async runRetryCheck() {
    try {
      logger.info('Starting periodic retry check');

      // Get all messages from local store
      const allMessages = this.localDataStore.getRecentMessages(1000);

      // Find messages that need retry
      const messagesToRetry = this.findMessagesNeedingRetry(allMessages);

      if (messagesToRetry.length === 0) {
        logger.info('No messages need retry', {
          totalMessages: allMessages.length
        });
        return;
      }

      logger.info('Found messages needing retry', {
        count: messagesToRetry.length,
        totalMessages: allMessages.length
      });

      // Retry each message (with rate limiting to avoid overwhelming WhatsApp)
      let successCount = 0;
      let failCount = 0;

      for (const message of messagesToRetry) {
        try {
          // Wait 2 seconds between retries to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));

          const result = await this.scraperService.refreshMessageStats(
            message.message_id,
            message.group_name
          );

          if (result.success) {
            successCount++;
            logger.info('Successfully refreshed message stats', {
              messageId: message.message_id,
              group: message.group_name,
              stats: result.stats
            });
          } else {
            failCount++;
            logger.warn('Failed to refresh message stats', {
              messageId: message.message_id,
              reason: result.message
            });
          }
        } catch (error) {
          failCount++;
          logger.error('Error refreshing message during retry', {
            messageId: message.message_id,
            error: error.message
          });
        }
      }

      logger.info('Periodic retry check completed', {
        attempted: messagesToRetry.length,
        successful: successCount,
        failed: failCount
      });

    } catch (error) {
      logger.error('Error in periodic retry check', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Find messages that need retry based on data quality criteria
   */
  findMessagesNeedingRetry(messages) {
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - this.config.dataQuality.retryMessagesOlderThanDays * MS_PER_DAY);

    return messages.filter(msg => {
      // Skip very old messages (beyond retry threshold)
      const messageDate = new Date(msg.message_timestamp);
      if (messageDate < cutoffDate) {
        return false;
      }

      // Retry if seen_count is 0 (likely missing data)
      if (this.config.dataQuality.retryMessagesWithZeroSeen && msg.seen_count === 0) {
        return true;
      }

      // Retry if engagement_rate is 0 but there are reactions/replies
      if (msg.engagement_rate === 0 && (msg.reactions_count > 0 || msg.replies_count > 0)) {
        return true;
      }

      // Retry if total_members is 0 (shouldn't happen but indicates data issue)
      if (msg.total_members === 0) {
        return true;
      }

      return false;
    });
  }

  /**
   * Get retry service status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      nextCheckIn: this.isRunning
        ? Math.floor((this.config.retries.periodicRetryInterval - (Date.now() % this.config.retries.periodicRetryInterval)) / 1000)
        : null
    };
  }
}

module.exports = MessageRetryService;
