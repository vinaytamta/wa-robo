const { HOURS_7_DAYS, HOURS_30_DAYS } = require('./constants');

/**
 * Get delay in ms for a message based on its age (hours).
 * Used by scraper-service and engagement-tracking-service with their respective configs.
 * @param {number} ageInHours - Message age in hours
 * @param {object} configDelays - Config object with keys "0-24h", "1-7d", "7-30d", "30d+"
 * @returns {number} Delay in milliseconds
 */
function getDelayMsForMessageAge(ageInHours, configDelays = {}) {
  if (ageInHours < 24) {
    return configDelays['0-24h'] ?? 3000;
  }
  if (ageInHours < HOURS_7_DAYS) {
    return configDelays['1-7d'] ?? 8000;
  }
  if (ageInHours < HOURS_30_DAYS) {
    return configDelays['7-30d'] ?? 15000;
  }
  return configDelays['30d+'] ?? 20000;
}

/**
 * Get message age in hours from timestamp.
 * @param {string|number|Date} messageTimestamp - Message timestamp
 * @returns {number} Age in hours
 */
function getMessageAgeInHours(messageTimestamp) {
  const now = Date.now();
  const ts = typeof messageTimestamp === 'object' && messageTimestamp instanceof Date
    ? messageTimestamp.getTime()
    : new Date(messageTimestamp).getTime();
  return (now - ts) / (1000 * 60 * 60);
}

module.exports = {
  getDelayMsForMessageAge,
  getMessageAgeInHours
};
