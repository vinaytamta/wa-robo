const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');

/**
 * Data Persistence Layer
 * Handles saving and loading data to/from local JSON files
 */
class DataPersistence {
  constructor() {
    // Use userData when packaged (app.asar is read-only); otherwise project-relative data/
    this.dataDir = process.env.DATA_DIR || path.join(__dirname, '../data');
    this.messagesFile = path.join(this.dataDir, 'messages.json');
    this.groupsFile = path.join(this.dataDir, 'groups.json');
    this.runsFile = path.join(this.dataDir, 'runs.json');

    // Ensure data directory exists
    this.ensureDataDir();
  }

  /**
   * Ensure data directory exists
   */
  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      logger.info('Created data directory', { path: this.dataDir });
    }
  }

  /**
   * Load JSON file or return default (shared pattern for loadMessages/loadGroups/loadRuns)
   * @param {string} filePath
   * @param {*} defaultReturn
   * @returns {*}
   */
  _loadJsonFile(filePath, defaultReturn) {
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      logger.error('Failed to load file', { path: filePath, error: error.message });
    }
    return defaultReturn;
  }

  /**
   * Save messages to file
   */
  saveMessages(messages) {
    try {
      fs.writeFileSync(this.messagesFile, JSON.stringify(messages, null, 2));
      logger.debug('Messages saved to file', { count: messages.length });
    } catch (error) {
      logger.error('Failed to save messages to file', { error: error.message });
    }
  }

  /**
   * Load messages from file
   */
  loadMessages() {
    const messages = this._loadJsonFile(this.messagesFile, []);
    if (Array.isArray(messages) && messages.length > 0) {
      logger.info('Messages loaded from file', { count: messages.length });
    }
    return Array.isArray(messages) ? messages : [];
  }

  /**
   * Save groups to file
   */
  saveGroups(groups) {
    try {
      const groupsArray = Array.from(groups.values());
      fs.writeFileSync(this.groupsFile, JSON.stringify(groupsArray, null, 2));
      logger.debug('Groups saved to file', { count: groupsArray.length });
    } catch (error) {
      logger.error('Failed to save groups to file', { error: error.message });
    }
  }

  /**
   * Load groups from file
   */
  loadGroups() {
    const groupsArray = this._loadJsonFile(this.groupsFile, []);
    const groups = new Map();
    if (Array.isArray(groupsArray)) {
      groupsArray.forEach(group => groups.set(group.name, group));
      logger.info('Groups loaded from file', { count: groups.size });
    }
    return groups;
  }

  /**
   * Save runs to file
   */
  saveRuns(runs) {
    try {
      fs.writeFileSync(this.runsFile, JSON.stringify(runs, null, 2));
      logger.debug('Runs saved to file', { count: runs.length });
    } catch (error) {
      logger.error('Failed to save runs to file', { error: error.message });
    }
  }

  /**
   * Load runs from file
   */
  loadRuns() {
    const runs = this._loadJsonFile(this.runsFile, []);
    if (Array.isArray(runs) && runs.length > 0) {
      logger.info('Runs loaded from file', { count: runs.length });
    }
    return Array.isArray(runs) ? runs : [];
  }

  /**
   * Save all data
   */
  saveAll(messages, groups, runs) {
    this.saveMessages(messages);
    this.saveGroups(groups);
    this.saveRuns(runs);
  }
}

module.exports = DataPersistence;
