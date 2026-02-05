const cron = require('node-cron');
const logger = require('../utils/logger');
const whatsappManager = require('./whatsapp-manager');
const { pool } = require('../config/database');
const ScraperService = require('./scraper-service');
const Message = require('../models/message');
const Group = require('../models/group');
const { subDays } = require('date-fns');

class ScraperScheduler {
  constructor() {
    this.jobs = new Map();
    this.isRunning = false;
  }

  /**
   * Start the scheduler
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Scraper scheduler already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting scraper scheduler');

    // Schedule scraping every hour
    this.mainJob = cron.schedule('0 * * * *', async () => {
      await this.runScrapingForAllUsers();
    });

    // Run immediately on startup
    setTimeout(() => {
      this.runScrapingForAllUsers();
    }, 5000);

    logger.info('Scraper scheduler started - will run every hour');
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping scraper scheduler');

    if (this.mainJob) {
      this.mainJob.stop();
    }

    // Stop all user-specific jobs
    for (const [userId, job] of this.jobs.entries()) {
      job.stop();
      logger.info('Stopped scraping job for user', { userId });
    }

    this.jobs.clear();
    this.isRunning = false;
    logger.info('Scraper scheduler stopped');
  }

  /**
   * Run scraping for all connected users
   */
  async runScrapingForAllUsers() {
    try {
      const userIds = whatsappManager.getActiveUserIds();

      if (userIds.length === 0) {
        logger.info('No active WhatsApp connections - skipping scraping');
        return;
      }

      logger.info('Starting scraping for all connected users', {
        userCount: userIds.length,
        userIds
      });

      // Run scraping for each user in parallel
      const results = await Promise.allSettled(
        userIds.map(userId => this.runScrapingForUser(userId))
      );

      // Log results
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      logger.info('Scraping round completed', {
        total: userIds.length,
        successful,
        failed
      });

    } catch (error) {
      logger.error('Error in scraping scheduler', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Run scraping for a specific user
   * @param {number} userId - User ID
   */
  async runScrapingForUser(userId) {
    const startTime = Date.now();
    let runId = null;

    try {
      // Check if user's WhatsApp is ready
      if (!whatsappManager.isReady(userId)) {
        logger.warn('User WhatsApp not ready - skipping', { userId });
        return;
      }

      const client = whatsappManager.getClient(userId);
      if (!client) {
        logger.warn('No WhatsApp client for user', { userId });
        return;
      }

      logger.info('Starting scraping for user', { userId });

      // Create script run record
      const runResult = await pool.query(
        `INSERT INTO script_runs (user_id, started_at, status)
         VALUES ($1, NOW(), 'running')
         RETURNING id`,
        [userId]
      );
      runId = runResult.rows[0].id;

      // Initialize scraper service for this user's client
      const scraper = new ScraperService(client);

      // Get monitored groups for this user
      const groups = await scraper.getMonitoredGroups();

      if (groups.length === 0) {
        logger.info('No groups to monitor for user', { userId });
        await this.updateRunRecord(runId, 0, 0, 0, 'completed');
        return;
      }

      // Calculate lookback date
      const lookbackDays = parseInt(process.env.MESSAGES_LOOKBACK_DAYS) || 7;
      const sinceDate = subDays(new Date(), lookbackDays);

      logger.info('Scraping configuration', {
        userId,
        groupsCount: groups.length,
        lookbackDays,
        sinceDate: sinceDate.toISOString()
      });

      // Track progress
      let totalMessages = 0;
      let totalErrors = 0;
      let groupsChecked = 0;

      // Process each group
      for (const chat of groups) {
        try {
          logger.info('Processing group for user', {
            userId,
            groupName: chat.name
          });

          // Get actual group participant count
          const participants = await chat.participants;
          const actualMemberCount = participants ? participants.length : 0;

          // Update group with user_id
          await Group.upsert({
            groupId: chat.id._serialized,
            groupName: chat.name,
            totalMembers: actualMemberCount,
            userId: userId
          });

          // Scrape messages from this group
          const messages = await scraper.scrapeGroupMessages(chat, sinceDate);

          // Save messages to database
          for (const msg of messages) {
            try {
              await Message.upsert({
                ...msg,
                userId: userId
              });
              totalMessages++;

              logger.info('Message saved for user', {
                userId,
                group: msg.groupName,
                seenCount: msg.seenCount,
                totalMembers: msg.totalMembers
              });
            } catch (error) {
              logger.error('Failed to save message', {
                userId,
                messageId: msg.messageId,
                error: error.message
              });
              totalErrors++;
            }
          }

          groupsChecked++;

          // Update progress periodically
          await this.updateRunRecord(runId, groupsChecked, totalMessages, totalErrors, 'running');

        } catch (error) {
          logger.error('Failed to process group for user', {
            userId,
            groupName: chat.name,
            error: error.message
          });
          totalErrors++;
        }
      }

      // Complete script run
      await this.updateRunRecord(runId, groupsChecked, totalMessages, totalErrors, 'completed');

      const duration = Date.now() - startTime;
      logger.info('Scraping completed for user', {
        userId,
        duration: `${(duration / 1000).toFixed(2)}s`,
        groupsChecked,
        messagesProcessed: totalMessages,
        errorsCount: totalErrors
      });

    } catch (error) {
      logger.error('Error scraping for user', {
        userId,
        error: error.message,
        stack: error.stack
      });

      if (runId) {
        await this.updateRunRecord(runId, 0, 0, 1, 'failed');
      }

      throw error;
    }
  }

  /**
   * Update script run record
   */
  async updateRunRecord(runId, groupsChecked, messagesProcessed, errorsCount, status) {
    try {
      await pool.query(
        `UPDATE script_runs
         SET groups_checked = $1,
             messages_processed = $2,
             errors_count = $3,
             status = $4,
             completed_at = NOW()
         WHERE id = $5`,
        [groupsChecked, messagesProcessed, errorsCount, status, runId]
      );
    } catch (error) {
      logger.error('Error updating run record', {
        runId,
        error: error.message
      });
    }
  }

  /**
   * Manually trigger scraping for a specific user
   * @param {number} userId - User ID
   */
  async triggerManualScraping(userId) {
    logger.info('Manual scraping triggered', { userId });
    return this.runScrapingForUser(userId);
  }
}

// Export singleton
const scraperScheduler = new ScraperScheduler();
module.exports = scraperScheduler;
