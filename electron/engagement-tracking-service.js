const logger = require('../src/utils/logger');
const fs = require('fs');
const path = require('path');

/**
 * Engagement Tracking Service
 * Automatically tracks message engagement evolution over 30 days
 * Uses progressive delays for old messages (15s for 7-30 day old messages)
 */
class EngagementTrackingService {
  constructor(scraperService, localDataStore) {
    this.scraperService = scraperService;
    this.localDataStore = localDataStore;
    this.trackingInterval = null;
    this.isRunning = false;
    this.config = this.loadConfig();
    this.lastCheckTime = null;
  }

  loadConfig() {
    try {
      const configPath = path.join(__dirname, 'engagement-tracking-config.json');
      if (fs.existsSync(configPath)) {
        const configData = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(configData);
      }
    } catch (error) {
      logger.warn('Could not load engagement tracking config, using defaults', { error: error.message });
    }

    // Default configuration
    return {
      tracking: {
        enabled: true,
        maxTrackingDays: 30,
        intervals: {
          "0-24h": 300000,    // 5 minutes
          "1-3d": 900000,     // 15 minutes
          "3-7d": 3600000,    // 1 hour
          "7-30d": 21600000   // 6 hours
        }
      },
      delays: {
        byMessageAge: {
          "0-24h": 3000,
          "1-7d": 8000,
          "7-30d": 15000,
          "30d+": 20000
        }
      },
      snapshotting: {
        enabled: true,
        storeHistoricalSnapshots: true,
        maxSnapshotsPerMessage: 100
      }
    };
  }

  /**
   * Start the engagement tracking service
   */
  start() {
    if (!this.config.tracking.enabled) {
      logger.info('Engagement tracking is disabled in config');
      return;
    }

    if (this.isRunning) {
      logger.warn('Engagement tracking service already running');
      return;
    }

    this.isRunning = true;

    // Use the shortest interval (5 minutes for 0-24h messages)
    const checkInterval = Math.min(...Object.values(this.config.tracking.intervals));

    logger.info('Starting engagement tracking service', {
      maxTrackingDays: this.config.tracking.maxTrackingDays,
      checkIntervalMinutes: checkInterval / 60000,
      intervals: this.config.tracking.intervals
    });

    // Run first check after 2 minutes (give app time to settle)
    setTimeout(() => {
      this.runTrackingCycle();
    }, 120000);

    // Then run periodically at shortest interval
    this.trackingInterval = setInterval(() => {
      this.runTrackingCycle();
    }, checkInterval);
  }

  /**
   * Stop the engagement tracking service
   */
  stop() {
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
      this.isRunning = false;
      logger.info('Engagement tracking service stopped');
    }
  }

  /**
   * Run a single tracking cycle
   */
  async runTrackingCycle() {
    try {
      this.lastCheckTime = new Date();
      logger.info('Starting engagement tracking cycle');

      // Get all messages from local store
      const allMessages = this.localDataStore.getRecentMessages(1000);

      // Find messages that need tracking
      const messagesToTrack = this.findMessagesNeedingTracking(allMessages);

      if (messagesToTrack.length === 0) {
        logger.info('No messages need tracking at this time', {
          totalMessages: allMessages.length
        });
        return;
      }

      logger.info('Found messages to track', {
        count: messagesToTrack.length,
        breakdown: this.categorizeMessages(messagesToTrack)
      });

      // Track each message with appropriate delays
      let successCount = 0;
      let failCount = 0;
      let skippedCount = 0;

      for (const message of messagesToTrack) {
        try {
          const messageAge = this.getMessageAgeInHours(message);
          const delayBetweenMessages = this.getDelayForMessageAge(messageAge);

          // Wait between messages to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));

          logger.info('Tracking message engagement', {
            messageId: message.message_id,
            group: message.group_name,
            ageHours: messageAge.toFixed(1),
            willUseDelay: delayBetweenMessages + 'ms'
          });

          const result = await this.scraperService.refreshMessageStats(
            message.message_id,
            message.group_name
          );

          if (result.success) {
            // Store engagement snapshot
            await this.storeEngagementSnapshot(message, result.stats);
            successCount++;

            logger.info('Successfully tracked message engagement', {
              messageId: message.message_id,
              stats: result.stats,
              warnings: result.warnings?.length || 0
            });
          } else {
            failCount++;
            logger.warn('Failed to track message engagement', {
              messageId: message.message_id,
              reason: result.message
            });
          }
        } catch (error) {
          failCount++;
          logger.error('Error tracking message', {
            messageId: message.message_id,
            error: error.message
          });
        }
      }

      logger.info('Engagement tracking cycle completed', {
        attempted: messagesToTrack.length,
        successful: successCount,
        failed: failCount,
        skipped: skippedCount
      });

    } catch (error) {
      logger.error('Error in engagement tracking cycle', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Find messages that need tracking based on age and last tracking time
   */
  findMessagesNeedingTracking(messages) {
    const now = new Date();
    const maxTrackingAge = this.config.tracking.maxTrackingDays * 24 * 60 * 60 * 1000;

    return messages.filter(msg => {
      // Skip messages that are not marked for tracking
      if (msg.is_tracked === false) {
        return false;
      }

      const messageAge = now - new Date(msg.message_timestamp);

      // Skip messages older than max tracking days
      if (messageAge > maxTrackingAge) {
        return false;
      }

      // Determine appropriate tracking interval based on age
      const ageInHours = messageAge / (1000 * 60 * 60);
      let trackingInterval;

      if (ageInHours < 24) {
        trackingInterval = this.config.tracking.intervals["0-24h"];
      } else if (ageInHours < 72) {
        trackingInterval = this.config.tracking.intervals["1-3d"];
      } else if (ageInHours < 168) {
        trackingInterval = this.config.tracking.intervals["3-7d"];
      } else {
        trackingInterval = this.config.tracking.intervals["7-30d"];
      }

      // Check if enough time has passed since last update
      const timeSinceUpdate = now - new Date(msg.updated_at);
      return timeSinceUpdate >= trackingInterval;
    });
  }

  /**
   * Store engagement snapshot with timestamp
   */
  async storeEngagementSnapshot(message, stats) {
    try {
      if (!this.config.snapshotting.enabled) {
        return;
      }

      // Get current message from store
      const currentMessage = this.localDataStore.getMessageById(message.message_id);
      if (!currentMessage) {
        return;
      }

      // Initialize engagement_history if it doesn't exist
      if (!currentMessage.engagement_history) {
        currentMessage.engagement_history = [];
      }

      // Create snapshot
      const snapshot = {
        timestamp: new Date().toISOString(),
        seen_count: stats.seenCount,
        reactions_count: stats.reactionsCount,
        replies_count: stats.repliesCount,
        engagement_rate: stats.engagementRate
      };

      // Add snapshot (avoiding duplicates)
      const isDuplicate = currentMessage.engagement_history.some(s =>
        s.seen_count === snapshot.seen_count &&
        s.reactions_count === snapshot.reactions_count &&
        s.replies_count === snapshot.replies_count
      );

      if (!isDuplicate) {
        currentMessage.engagement_history.push(snapshot);

        // Limit snapshots to prevent bloat
        const maxSnapshots = this.config.snapshotting.maxSnapshotsPerMessage;
        if (currentMessage.engagement_history.length > maxSnapshots) {
          currentMessage.engagement_history = currentMessage.engagement_history.slice(-maxSnapshots);
        }

        // Save updated message
        this.localDataStore.addMessages([currentMessage]);

        logger.debug('Stored engagement snapshot', {
          messageId: message.message_id,
          snapshotCount: currentMessage.engagement_history.length,
          snapshot
        });
      }
    } catch (error) {
      logger.error('Error storing engagement snapshot', {
        messageId: message.message_id,
        error: error.message
      });
    }
  }

  /**
   * Get message age in hours
   */
  getMessageAgeInHours(message) {
    const now = new Date();
    const messageDate = new Date(message.message_timestamp);
    return (now - messageDate) / (1000 * 60 * 60);
  }

  /**
   * Get appropriate delay for message based on age
   */
  getDelayForMessageAge(ageInHours) {
    if (ageInHours < 24) {
      return this.config.delays.byMessageAge["0-24h"];
    } else if (ageInHours < 168) {
      return this.config.delays.byMessageAge["1-7d"];
    } else if (ageInHours < 720) {
      return this.config.delays.byMessageAge["7-30d"];
    } else {
      return this.config.delays.byMessageAge["30d+"];
    }
  }

  /**
   * Categorize messages by age for logging
   */
  categorizeMessages(messages) {
    const categories = {
      "0-24h": 0,
      "1-3d": 0,
      "3-7d": 0,
      "7-30d": 0
    };

    messages.forEach(msg => {
      const ageInHours = this.getMessageAgeInHours(msg);
      if (ageInHours < 24) categories["0-24h"]++;
      else if (ageInHours < 72) categories["1-3d"]++;
      else if (ageInHours < 168) categories["3-7d"]++;
      else categories["7-30d"]++;
    });

    return categories;
  }

  /**
   * Get tracking service status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      lastCheckTime: this.lastCheckTime,
      nextCheckEstimate: this.isRunning && this.lastCheckTime
        ? new Date(this.lastCheckTime.getTime() + Math.min(...Object.values(this.config.tracking.intervals)))
        : null
    };
  }
}

module.exports = EngagementTrackingService;
