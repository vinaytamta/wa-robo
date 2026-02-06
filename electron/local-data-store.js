const DataPersistence = require('./data-persistence');

/**
 * Local Data Store for Electron App
 * Stores scraped messages in memory and persists to file
 */
class LocalDataStore {
  constructor() {
    this.messages = [];
    this.groups = new Map();
    this.runs = [];
    this.persistence = new DataPersistence();

    // Load persisted data on startup
    this.loadPersistedData();
  }

  /**
   * Load persisted data from files
   */
  loadPersistedData() {
    try {
      this.messages = this.persistence.loadMessages();
      this.groups = this.persistence.loadGroups();
      this.runs = this.persistence.loadRuns();

      console.log('Loaded persisted data:', {
        messages: this.messages.length,
        groups: this.groups.size,
        runs: this.runs.length
      });
    } catch (error) {
      console.error('Error loading persisted data:', error);
    }
  }

  /**
   * Save all data to file
   */
  saveToFile() {
    this.persistence.saveAll(this.messages, this.groups, this.runs);
  }

  /**
   * Add messages from scraping
   */
  addMessages(messages) {
    for (const msg of messages) {
      // Check if message already exists (by message_id)
      const existingIndex = this.messages.findIndex(m => m.message_id === msg.message_id);

      if (existingIndex >= 0) {
        // Update existing message
        this.messages[existingIndex] = {
          ...this.messages[existingIndex],
          ...msg,
          updated_at: new Date().toISOString()
        };
      } else {
        // Add new message
        this.messages.push({
          ...msg,
          is_tracked: msg.is_tracked !== undefined ? msg.is_tracked : true, // Default to tracked
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }

      // Update group stats
      this.updateGroupStats(msg.group_name, msg.total_members);
    }

    // Sort by timestamp (newest first)
    this.messages.sort((a, b) =>
      new Date(b.message_timestamp) - new Date(a.message_timestamp)
    );

    // Persist to file
    this.saveToFile();

    return messages.length;
  }

  /**
   * Update group statistics
   */
  updateGroupStats(groupName, totalMembers) {
    if (!this.groups.has(groupName)) {
      this.groups.set(groupName, {
        name: groupName,
        total_members: totalMembers,
        message_count: 0,
        last_scraped: new Date().toISOString()
      });
    }

    const group = this.groups.get(groupName);
    group.message_count = this.messages.filter(m => m.group_name === groupName).length;
    group.last_scraped = new Date().toISOString();
    group.total_members = totalMembers;
  }

  /**
   * Add a scraper run record
   */
  addRun(stats) {
    this.runs.unshift({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      groups_processed: stats.groups || 0,
      messages_found: stats.messages || 0,
      status: 'completed',
      sync_to_vps: false
    });

    // Keep only last 50 runs
    if (this.runs.length > 50) {
      this.runs = this.runs.slice(0, 50);
    }

    // Persist to file
    this.saveToFile();
  }

  /**
   * Get recent messages
   */
  getRecentMessages(limit = 50) {
    return this.messages.slice(0, limit);
  }

  /**
   * Get message by ID
   */
  getMessageById(messageId) {
    return this.messages.find(m => m.message_id === messageId);
  }

  /**
   * Update message tracking status
   */
  updateMessageTracking(messageId, isTracked) {
    const message = this.messages.find(m => m.message_id === messageId);

    if (!message) {
      return false;
    }

    message.is_tracked = isTracked;
    message.updated_at = new Date().toISOString();

    // Persist to file
    this.saveToFile();

    return true;
  }

  /**
   * Get all groups
   */
  getGroups() {
    return Array.from(this.groups.values());
  }

  /**
   * Get group by name
   */
  getGroupByName(groupName) {
    return this.groups.get(groupName);
  }

  /**
   * Get messages for a specific group
   */
  getGroupMessages(groupName, limit = 50, offset = 0) {
    const groupMessages = this.messages.filter(m => m.group_name === groupName);
    return groupMessages.slice(offset, offset + limit);
  }

  /**
   * Get dashboard stats
   */
  getDashboardStats() {
    const now = new Date();
    const last7Days = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const last30Days = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const messages7d = this.messages.filter(m =>
      new Date(m.message_timestamp) >= last7Days
    );
    const messages30d = this.messages.filter(m =>
      new Date(m.message_timestamp) >= last30Days
    );

    const avgEngagement7d = messages7d.length > 0
      ? messages7d.reduce((sum, m) => sum + m.engagement_rate, 0) / messages7d.length
      : 0;

    const avgEngagement30d = messages30d.length > 0
      ? messages30d.reduce((sum, m) => sum + m.engagement_rate, 0) / messages30d.length
      : 0;

    return {
      totalMessages: this.messages.length,
      totalGroups: this.groups.size,
      averageEngagement: avgEngagement30d.toFixed(2),
      messagesLast7Days: messages7d.length,
      messagesLast30Days: messages30d.length,
      engagementChange: avgEngagement7d > 0
        ? ((avgEngagement7d - avgEngagement30d) / avgEngagement30d * 100).toFixed(2)
        : 0
    };
  }

  /**
   * Get engagement trends
   */
  getEngagementTrends(days = 7) {
    const trends = [];
    const now = new Date();

    // Build trends from oldest to newest
    for (let i = 0; i < days; i++) {
      const date = new Date(now - (days - 1 - i) * 24 * 60 * 60 * 1000);
      const startOfDay = new Date(date.setHours(0, 0, 0, 0));
      const endOfDay = new Date(date.setHours(23, 59, 59, 999));

      const dayMessages = this.messages.filter(m => {
        const msgDate = new Date(m.message_timestamp);
        return msgDate >= startOfDay && msgDate <= endOfDay;
      });

      const avgEngagement = dayMessages.length > 0
        ? dayMessages.reduce((sum, m) => sum + m.engagement_rate, 0) / dayMessages.length
        : 0;

      trends.push({
        date: startOfDay.toISOString().split('T')[0],
        messages: dayMessages.length,
        avgEngagement: parseFloat(avgEngagement.toFixed(2))
      });
    }

    return trends;
  }

  /**
   * Get top groups by engagement
   */
  getTopGroups(days = 7) {
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const recentMessages = this.messages.filter(m =>
      new Date(m.message_timestamp) >= cutoffDate
    );

    const groupStats = new Map();

    for (const msg of recentMessages) {
      if (!groupStats.has(msg.group_name)) {
        groupStats.set(msg.group_name, {
          name: msg.group_name,
          messages: 0,
          totalEngagement: 0,
          totalMembers: msg.total_members
        });
      }

      const stats = groupStats.get(msg.group_name);
      stats.messages++;
      stats.totalEngagement += msg.engagement_rate;
    }

    const topGroups = Array.from(groupStats.values()).map(g => ({
      name: g.name,
      messages: g.messages,
      avgEngagement: (g.totalEngagement / g.messages).toFixed(2),
      totalMembers: g.totalMembers
    }));

    // Sort by average engagement
    topGroups.sort((a, b) => parseFloat(b.avgEngagement) - parseFloat(a.avgEngagement));

    return topGroups;
  }

  /**
   * Get recent runs
   */
  getRuns(limit = 20) {
    return this.runs.slice(0, limit);
  }

  /**
   * Clear all data
   */
  clear() {
    this.messages = [];
    this.groups.clear();
    this.runs = [];
  }
}

// Export singleton instance
const localDataStore = new LocalDataStore();
module.exports = localDataStore;
