const path = require('path');

/** Milliseconds per day */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** SSE heartbeat interval (ms) */
const SSE_HEARTBEAT_MS = 30000;

/** Default message limit for analytics endpoints */
const DEFAULT_ANALYTICS_MESSAGE_LIMIT = 1000;

/** Max scraper runs to keep in memory */
const MAX_RUNS_KEPT = 50;

/** Default limit for getRecentMessages / getGroupMessages */
const DEFAULT_MESSAGE_LIMIT = 50;

/** 7 days in hours (for delay buckets) */
const HOURS_7_DAYS = 7 * 24;

/** 30 days in hours (for delay buckets) */
const HOURS_30_DAYS = 30 * 24;

/** Path to scraper config (shared by scraper-service and message-retry-service) */
const SCRAPER_CONFIG_PATH = path.join(__dirname, 'scraper-config.json');

/** Path to groups config (relative to electron folder) */
const GROUPS_CONFIG_PATH = path.join(__dirname, '../src/config/groups-config.json');

/** Engagement tracking config path */
const ENGAGEMENT_TRACKING_CONFIG_PATH = path.join(__dirname, 'engagement-tracking-config.json');

module.exports = {
  MS_PER_DAY,
  SSE_HEARTBEAT_MS,
  DEFAULT_ANALYTICS_MESSAGE_LIMIT,
  MAX_RUNS_KEPT,
  DEFAULT_MESSAGE_LIMIT,
  HOURS_7_DAYS,
  HOURS_30_DAYS,
  SCRAPER_CONFIG_PATH,
  GROUPS_CONFIG_PATH,
  ENGAGEMENT_TRACKING_CONFIG_PATH
};
