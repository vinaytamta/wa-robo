const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');

/**
 * Data Persistence Layer
 * Handles saving and loading data to/from local JSON files
 */
class DataPersistence {
  constructor() {
    this.dataDir = path.join(__dirname, '../data');
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
   * Save messages to file
   */
  saveMessages(messages) {
    try {
      fs.writeFileSync(this.messagesFile, JSON.stringify(messages, null, 2));
      logger.info('Messages saved to file', { count: messages.length });
    } catch (error) {
      logger.error('Failed to save messages to file', { error: error.message });
    }
  }

  /**
   * Load messages from file
   */
  loadMessages() {
    try {
      if (fs.existsSync(this.messagesFile)) {
        const data = fs.readFileSync(this.messagesFile, 'utf8');
        const messages = JSON.parse(data);
        logger.info('Messages loaded from file', { count: messages.length });
        return messages;
      }
    } catch (error) {
      logger.error('Failed to load messages from file', { error: error.message });
    }
    return [];
  }

  /**
   * Save groups to file
   */
  saveGroups(groups) {
    try {
      const groupsArray = Array.from(groups.values());
      fs.writeFileSync(this.groupsFile, JSON.stringify(groupsArray, null, 2));
      logger.info('Groups saved to file', { count: groupsArray.length });
    } catch (error) {
      logger.error('Failed to save groups to file', { error: error.message });
    }
  }

  /**
   * Load groups from file
   */
  loadGroups() {
    try {
      if (fs.existsSync(this.groupsFile)) {
        const data = fs.readFileSync(this.groupsFile, 'utf8');
        const groupsArray = JSON.parse(data);
        const groups = new Map();
        groupsArray.forEach(group => {
          groups.set(group.name, group);
        });
        logger.info('Groups loaded from file', { count: groups.size });
        return groups;
      }
    } catch (error) {
      logger.error('Failed to load groups from file', { error: error.message });
    }
    return new Map();
  }

  /**
   * Save runs to file
   */
  saveRuns(runs) {
    try {
      fs.writeFileSync(this.runsFile, JSON.stringify(runs, null, 2));
      logger.info('Runs saved to file', { count: runs.length });
    } catch (error) {
      logger.error('Failed to save runs to file', { error: error.message });
    }
  }

  /**
   * Load runs from file
   */
  loadRuns() {
    try {
      if (fs.existsSync(this.runsFile)) {
        const data = fs.readFileSync(this.runsFile, 'utf8');
        const runs = JSON.parse(data);
        logger.info('Runs loaded from file', { count: runs.length });
        return runs;
      }
    } catch (error) {
      logger.error('Failed to load runs from file', { error: error.message });
    }
    return [];
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
