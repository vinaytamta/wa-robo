const fs = require('fs');
const logger = require('../src/utils/logger');

/**
 * Load JSON config from file or return default.
 * @param {string} filePath - Absolute path to config file
 * @param {object} defaultConfig - Default config if file missing or invalid
 * @returns {object} Parsed config or default
 */
function loadJsonConfig(filePath, defaultConfig) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    logger.warn('Could not load config, using defaults', { path: filePath, error: error.message });
  }
  return defaultConfig;
}

module.exports = { loadJsonConfig };
