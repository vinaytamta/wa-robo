const cron = require('node-cron');
const logger = require('./utils/logger');
const { main } = require('./index');
require('dotenv').config();

/**
 * Scheduled execution wrapper
 */
class Scheduler {
  constructor() {
    this.cronSchedule = process.env.CRON_SCHEDULE || '0 9 * * *'; // Default: Daily at 9 AM
    this.enabled = process.env.ENABLE_SCHEDULED_RUNS === 'true';
    this.task = null;
  }

  /**
   * Validate cron schedule format
   * @returns {boolean}
   */
  validateSchedule() {
    return cron.validate(this.cronSchedule);
  }

  /**
   * Start the scheduled task
   */
  start() {
    if (!this.enabled) {
      logger.warn('Scheduled runs are disabled. Set ENABLE_SCHEDULED_RUNS=true in .env to enable');
      logger.info('You can also run the script manually with: npm start');
      return;
    }

    if (!this.validateSchedule()) {
      logger.error('Invalid cron schedule format', { schedule: this.cronSchedule });
      logger.info('Please check CRON_SCHEDULE in .env file');
      logger.info('Format: minute hour day month weekday');
      logger.info('Example: "0 9 * * *" for daily at 9 AM');
      process.exit(1);
    }

    logger.info('='.repeat(60));
    logger.info('WhatsApp Message Engagement Tracker - Scheduler Started');
    logger.info('='.repeat(60));
    logger.info('Schedule:', { cronSchedule: this.cronSchedule });
    logger.info('Next run:', { time: this.getNextRunTime() });
    logger.info('Press Ctrl+C to stop the scheduler');
    logger.info('='.repeat(60));

    // Schedule the task
    this.task = cron.schedule(this.cronSchedule, async () => {
      logger.info('Scheduled task triggered');
      logger.info('Starting scraping execution...');

      try {
        await main();
        logger.info('Scheduled task completed successfully');
      } catch (error) {
        logger.error('Scheduled task failed', {
          error: error.message,
          stack: error.stack
        });
      }

      logger.info('Next run:', { time: this.getNextRunTime() });
    });

    logger.info('Scheduler is running and waiting for scheduled time...');
  }

  /**
   * Get the next scheduled run time
   * @returns {string}
   */
  getNextRunTime() {
    const now = new Date();
    const parts = this.cronSchedule.split(' ');

    if (parts.length !== 5) {
      return 'Invalid schedule';
    }

    const [minute, hour, day, month, weekday] = parts;

    // Simple calculation for daily schedules (hour-based)
    if (day === '*' && month === '*' && weekday === '*') {
      const nextRun = new Date();
      nextRun.setHours(parseInt(hour) || 0);
      nextRun.setMinutes(parseInt(minute) || 0);
      nextRun.setSeconds(0);

      // If time has passed today, schedule for tomorrow
      if (nextRun < now) {
        nextRun.setDate(nextRun.getDate() + 1);
      }

      return nextRun.toLocaleString();
    }

    return 'See cron schedule for exact time';
  }

  /**
   * Stop the scheduled task
   */
  stop() {
    if (this.task) {
      this.task.stop();
      logger.info('Scheduler stopped');
    }
  }

  /**
   * Run once immediately (for testing)
   */
  async runNow() {
    logger.info('Running task immediately...');
    try {
      await main();
      logger.info('Immediate run completed');
    } catch (error) {
      logger.error('Immediate run failed', { error: error.message });
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, stopping scheduler...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, stopping scheduler...');
  process.exit(0);
});

// Run scheduler if executed directly
if (require.main === module) {
  const scheduler = new Scheduler();

  // Check for --now flag to run immediately
  if (process.argv.includes('--now')) {
    scheduler.runNow().then(() => {
      logger.info('Immediate execution completed, exiting...');
      process.exit(0);
    }).catch(error => {
      logger.error('Immediate execution failed', { error: error.message });
      process.exit(1);
    });
  } else {
    scheduler.start();
  }
}

module.exports = Scheduler;
