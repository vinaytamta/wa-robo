const DataPersistence = require('./data-persistence');
const {
  MS_PER_DAY,
  MAX_RUNS_KEPT,
  DEFAULT_MESSAGE_LIMIT
} = require('./constants');

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
   * Add messages from scraping.
   * Updates group stats in a single pass after all messages are merged (O(n) instead of O(n*g)).
   */
  addMessages(messages) {
    const messageCountByGroup = new Map();

    for (const msg of messages) {
      const existingIndex = this.messages.findIndex(m => m.message_id === msg.message_id);

      if (existingIndex >= 0) {
        this.messages[existingIndex] = {
          ...this.messages[existingIndex],
          ...msg,
          updated_at: new Date().toISOString()
        };
      } else {
        this.messages.push({
          ...msg,
          is_tracked: msg.is_tracked !== undefined ? msg.is_tracked : true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
      }

      const name = msg.group_name;
      messageCountByGroup.set(name, (messageCountByGroup.get(name) || 0) + 1);
    }

    // Single pass over all messages to get per-group counts (O(n) instead of O(n*g))
    const countByGroup = new Map();
    for (const m of this.messages) {
      const name = m.group_name;
      countByGroup.set(name, (countByGroup.get(name) || 0) + 1);
    }
    const nowIso = new Date().toISOString();
    for (const [groupName] of messageCountByGroup) {
      const totalMembers = messages.find(m => m.group_name === groupName)?.total_members;
      if (!this.groups.has(groupName)) {
        this.groups.set(groupName, {
          name: groupName,
          total_members: totalMembers ?? 0,
          message_count: 0,
          last_scraped: nowIso
        });
      }
      const group = this.groups.get(groupName);
      group.message_count = countByGroup.get(groupName) || 0;
      group.last_scraped = nowIso;
      if (totalMembers != null) group.total_members = totalMembers;
    }

    this.messages.sort((a, b) =>
      new Date(b.message_timestamp) - new Date(a.message_timestamp)
    );

    this.saveToFile();
    return messages.length;
  }

  /**
   * Update group statistics (single group; used when not batching)
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

    if (this.runs.length > MAX_RUNS_KEPT) {
      this.runs = this.runs.slice(0, MAX_RUNS_KEPT);
    }
    this.saveToFile();
  }

  /**
   * Get recent messages
   */
  getRecentMessages(limit = DEFAULT_MESSAGE_LIMIT) {
    return this.messages.slice(0, limit);
  }

  /**
   * Get message by ID
   */
  getMessageById(messageId) {
    return this.messages.find(m => m.message_id === messageId);
  }

  /**
   * Resolve UI-provided message IDs to canonical stored message IDs.
   * Supports IDs like:
   * - canonical: "4A1EDBCDF594382DE881"
   * - wrapped UI: "msg_<canonical>_<suffix>_<timestamp>"
   */
  resolveMessageId(messageId) {
    if (!messageId || typeof messageId !== 'string') return null;

    // Fast path: exact match
    if (this.getMessageById(messageId)) return messageId;

    // Heuristic for wrapped IDs emitted by some UI flows
    if (messageId.startsWith('msg_')) {
      const withoutPrefix = messageId.slice(4);
      const parts = withoutPrefix.split('_');
      const primaryCandidate = parts[0];

      const directCandidates = [withoutPrefix, primaryCandidate].filter(Boolean);
      for (const candidate of directCandidates) {
        if (this.getMessageById(candidate)) return candidate;
      }
    }

    // Last-resort fuzzy match: wrapped ID contains canonical ID
    const fuzzy = this.messages.find(
      m => typeof m.message_id === 'string' && messageId.includes(m.message_id)
    );
    return fuzzy?.message_id || null;
  }

  /**
   * Update message tracking status
   */
  updateMessageTracking(messageId, isTracked) {
    const message = this.messages.find(m => m.message_id === messageId);
    if (!message) return false;
    message.is_tracked = isTracked;
    message.updated_at = new Date().toISOString();
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
  getGroupMessages(groupName, limit = DEFAULT_MESSAGE_LIMIT, offset = 0) {
    const groupMessages = this.messages.filter(m => m.group_name === groupName);
    return groupMessages.slice(offset, offset + limit);
  }

  /**
   * Get dashboard stats
   */
  getDashboardStats() {
    const now = new Date();
    const last7Days = new Date(now.getTime() - 7 * MS_PER_DAY);
    const last30Days = new Date(now.getTime() - 30 * MS_PER_DAY);

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
   * Get engagement trends (per day). Clones dates before mutating to avoid loop bugs.
   */
  getEngagementTrends(days = 7) {
    const trends = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(now.getTime() - (days - 1 - i) * MS_PER_DAY);
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

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
   * Get top groups by engagement. Returns avgEngagement as number.
   */
  getTopGroups(days = 7) {
    const cutoffDate = new Date(Date.now() - days * MS_PER_DAY);
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
      avgEngagement: parseFloat((g.totalEngagement / g.messages).toFixed(2)),
      totalMembers: g.totalMembers
    }));
    topGroups.sort((a, b) => b.avgEngagement - a.avgEngagement);
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

const localDataStore = new LocalDataStore();
module.exports = localDataStore;
