const logger = require('../src/utils/logger');
const { subDays } = require('date-fns');
const localDataStore = require('./local-data-store');
const fs = require('fs');
const { loadJsonConfig } = require('./config-loader');
const { getDelayMsForMessageAge, getMessageAgeInHours } = require('./delay-util');
const { SCRAPER_CONFIG_PATH, GROUPS_CONFIG_PATH } = require('./constants');

const VPS_BASE_URL = process.env.VPS_BASE_URL || 'https://group-iq.com';
const allowInsecureSSL = process.env.ALLOW_INSECURE_SSL === 'true';

const defaultScraperConfig = {
  delays: {
    afterFetchMessages: 3000,
    retryBaseDelay: 500,
    betweenGroups: 2000,
    byMessageAge: { '0-24h': 3000, '1-7d': 8000, '7-30d': 15000, '30d+': 20000 }
  },
  retries: { maxAttempts: 3, enablePeriodicRetry: true, periodicRetryInterval: 300000 },
  dataQuality: { minSeenCountThreshold: 0, retryMessagesWithZeroSeen: true, retryMessagesOlderThanDays: 30 }
};

/**
 * Scraper Service for Electron
 * Handles scraping WhatsApp groups and syncing to VPS
 */
class ScraperService {
  constructor(whatsappManager) {
    this.whatsappManager = whatsappManager;
    this.vpsApiUrl = `${VPS_BASE_URL}/api`;
    this.localDataStore = localDataStore;
    this.config = loadJsonConfig(SCRAPER_CONFIG_PATH, defaultScraperConfig);
    if (fs.existsSync(SCRAPER_CONFIG_PATH)) {
      logger.info('Loaded scraper configuration', this.config);
    }
    this._nodeFetch = null;
    this._httpsAgent = null;
  }

  async withTimeout(promiseFactory, timeoutMs, stepLabel) {
    let timeoutId = null;
    try {
      return await Promise.race([
        Promise.resolve().then(() => promiseFactory()),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`${stepLabel} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async _getFetch() {
    if (!this._nodeFetch) this._nodeFetch = (await import('node-fetch')).default;
    return this._nodeFetch;
  }

  _getHttpsAgent() {
    if (!this._httpsAgent) {
      const https = require('https');
      this._httpsAgent = new https.Agent({ rejectUnauthorized: !allowInsecureSSL });
    }
    return this._httpsAgent;
  }

  async _fetchVPS(url, options = {}) {
    const fetch = await this._getFetch();
    return fetch(url, {
      ...options,
      agent: this._getHttpsAgent(),
      headers: { 'Content-Type': 'application/json', ...options.headers }
    });
  }

  getDelayForMessageAge(messageTimestamp) {
    const ageInHours = getMessageAgeInHours(messageTimestamp);
    return getDelayMsForMessageAge(ageInHours, this.config.delays?.byMessageAge || {});
  }

  /**
   * Get list of groups to monitor from local config file
   */
  async getMonitoredGroupsLocal() {
    try {
      const config = loadJsonConfig(GROUPS_CONFIG_PATH, { groups: [] });
      const groupsList = config.groups || [];
      logger.info('Loaded groups from local config', { count: groupsList.length });
      return groupsList.filter(group => group.enabled);
    } catch (error) {
      logger.error('Error loading local groups config', { error: error.message });
      throw error;
    }
  }

  /**
   * Get list of groups to monitor from VPS config
   */
  async getMonitoredGroups(token, useLocal = false) {
    // Use local config if specified or if no token
    if (useLocal || !token) {
      return this.getMonitoredGroupsLocal();
    }

    try {
      const response = await this._fetchVPS(`${this.vpsApiUrl}/config/groups`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();

      // Handle response format: { groups: [...], config: {...} }
      const groupsList = data.groups || data || [];
      logger.info('Fetched monitored groups from VPS', { count: groupsList.length });

      // Filter to only enabled groups
      return groupsList.filter(group => group.enabled);
    } catch (error) {
      logger.warn('Error fetching monitored groups from VPS, falling back to local config', {
        error: error.message
      });
      // Fallback to local config
      return this.getMonitoredGroupsLocal();
    }
  }

  /**
   * Find WhatsApp chat by group name
   */
  async findChatByName(groupName) {
    try {
      const client = this.whatsappManager.getClient();
      const chats = await client.getChats();

      // Find matching group (case-insensitive)
      const chat = chats.find(c =>
        c.isGroup &&
        c.name.toLowerCase() === groupName.toLowerCase()
      );

      if (!chat) {
        logger.warn('Group not found in WhatsApp', { groupName });
        return null;
      }

      logger.info('Found matching WhatsApp group', {
        name: chat.name,
        id: chat.id._serialized
      });

      return chat;
    } catch (error) {
      logger.error('Error finding chat', { error: error.message });
      throw error;
    }
  }

  /**
   * Scrape messages from a group (only user's own messages with engagement metrics)
   */
  async scrapeGroupMessages(chat, sinceDate, userPhoneNumber) {
    try {
      logger.info('Fetching messages', {
        group: chat.name,
        since: sinceDate.toISOString(),
        userPhone: userPhoneNumber
      });

      // Fetch messages from the chat
      const messages = await chat.fetchMessages({ limit: 1000 });

      // Get group participants count
      const totalMembers = chat.participants?.length || 0;

      // Filter messages: only from user, within date range
      const userMessages = messages.filter(msg => {
        const msgDate = new Date(msg.timestamp * 1000);
        const isFromUser = msg.fromMe; // WhatsApp Web.js flag for messages sent by you
        const isInDateRange = msgDate >= sinceDate;
        return isFromUser && isInDateRange;
      });

      logger.info('User messages found', {
        group: chat.name,
        total: messages.length,
        userMessages: userMessages.length,
        totalMembers
      });

      // CRITICAL FIX: Add delay to let WhatsApp sync message info
      // For historical messages, WhatsApp needs time to load read receipts and reactions
      const syncDelay = this.config.delays.afterFetchMessages;
      logger.info('Waiting for message info to sync...', {
        group: chat.name,
        messageCount: userMessages.length,
        delayMs: syncDelay
      });
      await new Promise(resolve => setTimeout(resolve, syncDelay));

      // Format messages with engagement metrics
      const formattedMessages = await Promise.all(userMessages.map(async (msg) => {
        try {
          // Get message info with retry logic (configurable attempts with exponential backoff)
          let messageInfo = null;
          let attempts = 0;
          const maxAttempts = this.config.retries.maxAttempts;

          while (!messageInfo && attempts < maxAttempts) {
            attempts++;
            try {
              messageInfo = await msg.getInfo?.();
              if (!messageInfo && attempts < maxAttempts) {
                // Wait before retry with exponential backoff
                const delay = this.config.delays.retryBaseDelay * Math.pow(2, attempts - 1);
                logger.debug('Retrying getInfo()', {
                  messageId: msg.id.id,
                  attempt: attempts,
                  delayMs: delay
                });
                await new Promise(resolve => setTimeout(resolve, delay));
              }
            } catch (infoError) {
              logger.warn('getInfo() failed', {
                messageId: msg.id.id,
                attempt: attempts,
                error: infoError.message
              });
            }
          }

          // Log if we failed to get message info after all retries
          if (!messageInfo) {
            logger.warn('Failed to get message info after retries', {
              messageId: msg.id.id,
              group: chat.name,
              messageAge: Math.floor((Date.now() - msg.timestamp * 1000) / (1000 * 60 * 60 * 24)) + ' days'
            });
          }

          // Debug: Log the actual structure to understand what we're getting
          if (messageInfo) {
            logger.debug('Message info structure', {
              messageId: msg.id.id,
              hasDelivery: !!messageInfo.delivery,
              deliveryCount: messageInfo.delivery?.length || 0,
              hasRead: !!messageInfo.read,
              readCount: messageInfo.read?.length || 0,
              hasPlayed: !!messageInfo.played,
              playedCount: messageInfo.played?.length || 0
            });
          }

          // Count seen/read receipts (use read, not delivery)
          // Read receipts indicate the message was actually read/seen
          const seenCount = messageInfo?.read?.length || 0;

          // Get reactions - try multiple methods
          let reactionsCount = 0;
          let reactionsData = [];

          try {
            // Method 1: Try getReactions() method
            if (typeof msg.getReactions === 'function') {
              const reactions = await msg.getReactions();
              if (reactions && reactions.length > 0) {
                reactionsData = reactions;
                reactionsCount = reactions.length;
                logger.info('Reactions via getReactions()', {
                  messageId: msg.id.id,
                  count: reactions.length
                });
              }
            }

            // Method 2: Check msg.reactions property
            if (reactionsCount === 0 && msg.reactions) {
              reactionsData = Array.isArray(msg.reactions) ? msg.reactions : [msg.reactions];
              reactionsCount = reactionsData.length;
              logger.info('Reactions via msg.reactions', {
                messageId: msg.id.id,
                count: reactionsCount
              });
            }

            // Method 3: Check msg._data.reactions
            if (reactionsCount === 0 && msg._data?.reactions) {
              const dataReactions = msg._data.reactions;
              if (Array.isArray(dataReactions)) {
                reactionsData = dataReactions;
                reactionsCount = dataReactions.length;
              } else if (typeof dataReactions === 'object') {
                // Reactions might be stored as an object with reaction IDs as keys
                reactionsData = Object.values(dataReactions);
                reactionsCount = reactionsData.length;
              }
              logger.info('Reactions via msg._data.reactions', {
                messageId: msg.id.id,
                count: reactionsCount,
                type: Array.isArray(dataReactions) ? 'array' : 'object'
              });
            }

            // Count total reactions (sum up all reaction counts)
            if (reactionsCount > 0) {
              // Each reaction might have multiple senders or a count property
              let totalReactions = 0;

              reactionsData.forEach(r => {
                // Method 1: Check if reaction has a senders array
                if (r.senders && Array.isArray(r.senders)) {
                  totalReactions += r.senders.length;
                }
                // Method 2: Check if reaction has a count property
                else if (r.count) {
                  totalReactions += r.count;
                }
                // Method 3: Check if reaction has an id array (list of users who reacted)
                else if (r.id && Array.isArray(r.id)) {
                  totalReactions += r.id.length;
                }
                // Method 4: Single reaction
                else {
                  totalReactions += 1;
                }
              });

              // Update count to total reactions
              reactionsCount = totalReactions;

              logger.info('Total reactions calculated', {
                messageId: msg.id.id,
                reactionTypes: reactionsData.length,
                totalReactions: totalReactions,
                breakdown: reactionsData.map(r => ({
                  emoji: r.text || r.emoji || r.reaction || r.aggregateEmoji,
                  count: r.senders?.length || r.count || r.id?.length || 1,
                  senders: r.senders?.slice(0, 3)
                }))
              });
            }
          } catch (e) {
            logger.warn('Error getting reactions', {
              messageId: msg.id.id,
              error: e.message
            });
          }

          // Count replies (messages that quote this message)
          // Need to match both the message ID and check if it's actually a reply
          const repliesCount = messages.filter(m => {
            if (!m.hasQuotedMsg) return false;

            // Try multiple ways to match the quoted message ID
            const quotedId = m._data?.quotedMsg?.id || m._data?.quotedStanzaID || m.quotedMsg?.id;
            const thisMessageId = msg.id.id || msg.id._serialized;

            return quotedId === thisMessageId;
          }).length;

          logger.debug('Engagement metrics extracted', {
            messageId: msg.id.id,
            seenCount,
            reactionsCount,
            repliesCount,
            totalMembers
          });

          // Calculate engagement rate using UNIQUE USERS (Option B)
          // Track unique user IDs from read receipts, reactions, and replies
          const uniqueEngagedUsers = new Set();

          // Add users who read the message
          if (messageInfo?.read && Array.isArray(messageInfo.read)) {
            messageInfo.read.forEach(userId => {
              if (userId && userId.id) {
                uniqueEngagedUsers.add(userId.id);
              } else if (typeof userId === 'string') {
                uniqueEngagedUsers.add(userId);
              }
            });
          }

          // Add users who reacted (from all reaction types)
          reactionsData.forEach(reaction => {
            if (reaction.senders && Array.isArray(reaction.senders)) {
              reaction.senders.forEach(sender => {
                if (sender && sender.id) {
                  uniqueEngagedUsers.add(sender.id);
                } else if (typeof sender === 'string') {
                  uniqueEngagedUsers.add(sender);
                }
              });
            }
          });

          // Add users who replied
          const replierIds = messages
            .filter(m => {
              if (!m.hasQuotedMsg) return false;
              const quotedId = m._data?.quotedMsg?.id || m._data?.quotedStanzaID || m.quotedMsg?.id;
              const thisMessageId = msg.id.id || msg.id._serialized;
              return quotedId === thisMessageId;
            })
            .map(m => m.author || m.from)
            .filter(Boolean);

          replierIds.forEach(userId => {
            uniqueEngagedUsers.add(userId);
          });

          // Calculate engagement rate based on unique users (capped at 100%)
          // Exclude sender from total: engagement = seen / (total - 1)
          const uniqueEngagedCount = uniqueEngagedUsers.size;
          const engagementRate = totalMembers > 1
            ? Math.min(((uniqueEngagedCount / (totalMembers - 1)) * 100), 100).toFixed(2)
            : 0;

          logger.debug('Unique engagement calculated', {
            messageId: msg.id.id,
            uniqueUsers: uniqueEngagedCount,
            totalMembers,
            engagementRate: engagementRate + '%'
          });

          return {
            message_id: msg.id.id,
            group_id: chat.id._serialized,
            group_name: chat.name,
            sender_id: msg.author || msg.from,
            message_content: msg.body || '',
            message_timestamp: new Date(msg.timestamp * 1000).toISOString(),
            has_media: msg.hasMedia,
            message_type: msg.type,
            is_forwarded: msg.isForwarded || false,
            // Engagement metrics
            seen_count: seenCount,
            total_members: totalMembers,
            reactions_count: reactionsCount,
            replies_count: repliesCount,
            engagement_rate: parseFloat(engagementRate)
          };
        } catch (msgError) {
          logger.error('Error processing message', {
            messageId: msg.id.id,
            error: msgError.message
          });
          // Return basic message data without engagement metrics
          return {
            message_id: msg.id.id,
            group_id: chat.id._serialized,
            group_name: chat.name,
            sender_id: msg.author || msg.from,
            message_content: msg.body || '',
            message_timestamp: new Date(msg.timestamp * 1000).toISOString(),
            has_media: msg.hasMedia,
            message_type: msg.type,
            is_forwarded: msg.isForwarded || false,
            seen_count: 0,
            total_members: totalMembers,
            reactions_count: 0,
            replies_count: 0,
            engagement_rate: 0
          };
        }
      }));

      return formattedMessages;
    } catch (error) {
      logger.error('Error scraping messages', {
        group: chat.name,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Sync messages to VPS database
   */
  async syncMessagesToVPS(messages, token) {
    try {
      logger.info('Syncing messages to VPS', { count: messages.length });
      const response = await this._fetchVPS(`${this.vpsApiUrl}/messages/bulk`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ messages })
      });

      const result = await response.json();
      logger.info('Messages synced successfully', result);

      return result;
    } catch (error) {
      logger.error('Error syncing messages to VPS', { error: error.message });
      throw error;
    }
  }

  /**
   * Run scraping for all monitored groups
   */
  async runScraping(token, lookbackDays = 30, syncToVPS = false) {
    try {
      // Ensure WhatsApp is ready
      const status = this.whatsappManager.getStatus();
      if (status.status !== 'ready') {
        throw new Error('WhatsApp not connected');
      }

      // Get user's phone number
      const userPhoneNumber = status.phoneNumber;
      if (!userPhoneNumber) {
        throw new Error('Could not determine user phone number');
      }

      logger.info('Starting scraping job', { lookbackDays, userPhoneNumber, syncToVPS });

      // Get monitored groups from config (use local if not syncing to VPS)
      const useLocalConfig = !syncToVPS;
      const monitoredGroups = await this.getMonitoredGroups(token, useLocalConfig);
      logger.info('Monitored groups loaded', { count: monitoredGroups.length, source: useLocalConfig ? 'local' : 'VPS' });

      if (monitoredGroups.length === 0) {
        logger.warn('No groups configured for monitoring');
        return {
          success: true,
          message: 'No groups to scrape',
          stats: { groups: 0, messages: 0 }
        };
      }

      const sinceDate = subDays(new Date(), lookbackDays);
      let totalMessages = 0;
      let processedGroups = 0;

      // Process each monitored group
      for (const configGroup of monitoredGroups) {
        try {
          // Find the WhatsApp chat
          const chat = await this.findChatByName(configGroup.name);

          if (!chat) {
            logger.warn('Skipping group - not found in WhatsApp', {
              name: configGroup.name
            });
            continue;
          }

          // Scrape messages (only user's messages with engagement metrics)
          const messages = await this.scrapeGroupMessages(chat, sinceDate, userPhoneNumber);

          if (messages.length > 0) {
            // Always save to local data store
            this.localDataStore.addMessages(messages);
            totalMessages += messages.length;
            logger.info('Messages saved to local store', { count: messages.length });

            // Try to sync to VPS if enabled (but don't fail if it errors)
            if (syncToVPS) {
              try {
                await this.syncMessagesToVPS(messages, token);
                logger.info('Messages synced to VPS', { count: messages.length });
              } catch (syncError) {
                logger.warn('VPS sync failed, but messages saved locally', {
                  error: syncError.message
                });
                // Continue - local data is saved
              }
            }
          }

          processedGroups++;
          logger.info('Group processed successfully', {
            name: configGroup.name,
            messages: messages.length
          });

        } catch (error) {
          logger.error('Error processing group', {
            name: configGroup.name,
            error: error.message
          });
          // Continue with next group
        }
      }

      // Record the run
      this.localDataStore.addRun({
        groups: processedGroups,
        messages: totalMessages
      });

      logger.info('Scraping job completed', {
        processedGroups,
        totalMessages
      });

      return {
        success: true,
        message: 'Scraping completed successfully. Data saved locally.',
        stats: {
          groups: processedGroups,
          messages: totalMessages
        }
      };
    } catch (error) {
      logger.error('Scraping job failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Scrape a single group only (e.g. refresh FIG without running full scraper).
   * Use this to refresh one group without straining the rest.
   * @param {string} groupName - Exact group name (e.g. "FIG")
   * @param {number} lookbackDays - Days to look back (default 30)
   * @param {boolean} syncToVPS - Whether to sync new messages to VPS
   * @param {string} [token] - VPS auth token (required if syncToVPS is true)
   */
  async runScrapingForGroup(groupName, lookbackDays = 30, syncToVPS = false, token = null) {
    const status = this.whatsappManager.getStatus();
    if (status.status !== 'ready') {
      throw new Error('WhatsApp not connected');
    }
    const userPhoneNumber = status.phoneNumber;
    if (!userPhoneNumber) {
      throw new Error('Could not determine user phone number');
    }

    const chat = await this.findChatByName(groupName);
    if (!chat) {
      return {
        success: false,
        message: `Group "${groupName}" not found in WhatsApp. Check the name matches exactly.`
      };
    }

    const sinceDate = subDays(new Date(), lookbackDays);
    const messages = await this.scrapeGroupMessages(chat, sinceDate, userPhoneNumber);

    if (messages.length > 0) {
      this.localDataStore.addMessages(messages);
      if (syncToVPS && token) {
        try {
          await this.syncMessagesToVPS(messages, token);
        } catch (syncError) {
          logger.warn('VPS sync failed for single group', { group: groupName, error: syncError.message });
        }
      }
    }

    this.localDataStore.addRun({ groups: 1, messages: messages.length });
    logger.info('Single-group scrape completed', { group: groupName, messages: messages.length });

    return {
      success: true,
      message: `Refreshed "${groupName}". ${messages.length} message(s) saved locally.`,
      stats: { groups: 1, messages: messages.length }
    };
  }

  /**
   * Test scraping for a single group (no VPS sync)
   */
  async testScrapeGroup(groupName, lookbackDays = 30) {
    try {
      // Ensure WhatsApp is ready
      const status = this.whatsappManager.getStatus();
      if (status.status !== 'ready') {
        throw new Error('WhatsApp not connected');
      }

      // Get user's phone number
      const userPhoneNumber = status.phoneNumber;
      if (!userPhoneNumber) {
        throw new Error('Could not determine user phone number');
      }

      logger.info('Testing scrape for group (fast mode)', { groupName, lookbackDays, userPhoneNumber });

      // Find the WhatsApp chat
      const chat = await this.findChatByName(groupName);

      if (!chat) {
        return {
          success: false,
          message: `Group "${groupName}" not found in WhatsApp`,
          suggestions: 'Make sure the group name matches exactly'
        };
      }

      const sinceDate = subDays(new Date(), lookbackDays);

      // FAST MODE: Just get message list without engagement metrics
      // This is much faster for message selection UI
      const messages = await this.getMessageListOnly(chat, sinceDate, userPhoneNumber);

      logger.info('Test scrape completed (fast mode)', {
        group: groupName,
        userMessages: messages.length
      });

      return {
        success: true,
        group: {
          name: chat.name,
          id: chat.id._serialized,
          participants: chat.participants?.length || 0
        },
        stats: {
          yourMessages: messages.length,
          lookbackDays
        },
        sampleMessages: messages.slice(0, 5).map(msg => ({
          content: msg.message_content.substring(0, 100),
          timestamp: msg.message_timestamp,
          messageId: msg.message_id,
          seenBy: '0/0', // Will be populated later
          reactions: 0,
          replies: 0,
          engagementRate: '0%'
        })),
        allMessages: messages // Return all messages for frontend to display
      };
    } catch (error) {
      logger.error('Test scrape failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Fast message list - just IDs and content, no engagement metrics
   * Used for message selection UI
   */
  async getMessageListOnly(chat, sinceDate, userPhoneNumber) {
    logger.info('Fetching message list (fast mode)', {
      chatName: chat.name,
      sinceDate: sinceDate.toISOString()
    });

    // Fetch messages - limit to reasonable amount
    const allMessages = await chat.fetchMessages({ limit: 500 });

    // Filter for user's messages within date range
    const userMessages = allMessages.filter(msg => {
      const msgDate = new Date(msg.timestamp * 1000);
      const isAfterSince = msgDate >= sinceDate;
      const isFromUser = msg.fromMe || msg.author?.includes(userPhoneNumber);
      return isAfterSince && isFromUser;
    });

    logger.info('Filtered messages (fast mode)', {
      total: allMessages.length,
      userMessages: userMessages.length
    });

    // Return minimal message data (fast!)
    return userMessages.map(msg => ({
      message_id: msg.id.id,
      message_content: msg.body || '(No text content)',
      message_timestamp: new Date(msg.timestamp * 1000).toISOString(),
      group_name: chat.name,
      total_members: chat.participants?.length || 0,
      // Placeholder values - will be fetched later if message is selected for tracking
      seen_count: 0,
      reactions_count: 0,
      replies_count: 0,
      engagement_rate: 0,
      is_tracked: true
    }));
  }

  /**
   * Refresh stats for a single message
   */
  async refreshMessageStats(messageId, groupName) {
    try {
      logger.info('Refreshing stats for message', { messageId, groupName });

      // Ensure WhatsApp is ready
      const status = this.whatsappManager.getStatus();
      if (status.status !== 'ready') {
        throw new Error('WhatsApp not connected');
      }

      // Find the WhatsApp chat
      const chat = await this.withTimeout(
        () => this.findChatByName(groupName),
        15000,
        'findChatByName'
      );
      if (!chat) {
        return {
          success: false,
          message: `Group "${groupName}" not found in WhatsApp`
        };
      }

      // Fetch recent messages from the chat
      const messages = await this.withTimeout(
        () => chat.fetchMessages({ limit: 1000 }),
        25000,
        'fetchMessages'
      );

      // Find the specific message by ID
      const targetMessage = messages.find(m => m.id.id === messageId);

      if (!targetMessage) {
        return {
          success: false,
          message: 'Message not found in WhatsApp chat'
        };
      }

      logger.info('Found message, extracting updated metrics', { messageId });

      // Get group participants count
      const totalMembers = chat.participants?.length || 0;

      // Add delay based on message age (older messages need more time)
      const messageAge = Math.floor((Date.now() - targetMessage.timestamp * 1000) / (1000 * 60 * 60 * 24));
      const syncDelay = this.getDelayForMessageAge(new Date(targetMessage.timestamp * 1000));

      logger.info('Waiting for message info to sync...', {
        messageId,
        messageAgeDays: messageAge,
        delayMs: syncDelay
      });
      await new Promise(resolve => setTimeout(resolve, syncDelay));

      // Extract updated engagement metrics with retry logic
      let messageInfo = null;
      let attempts = 0;
      const maxAttempts = this.config.retries.maxAttempts;

      while (!messageInfo && attempts < maxAttempts) {
        attempts++;
        try {
          messageInfo = await this.withTimeout(
            () => targetMessage.getInfo?.(),
            8000,
            'getInfo'
          );
          if (!messageInfo && attempts < maxAttempts) {
            const delay = this.config.delays.retryBaseDelay * Math.pow(2, attempts - 1);
            logger.debug('Retrying getInfo() during refresh', {
              messageId,
              attempt: attempts,
              delayMs: delay
            });
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } catch (infoError) {
          logger.warn('getInfo() failed during refresh', {
            messageId,
            attempt: attempts,
            error: infoError.message
          });
        }
      }

      if (!messageInfo) {
        logger.warn('Failed to get message info after retries during refresh', {
          messageId,
          messageAge: Math.floor((Date.now() - targetMessage.timestamp * 1000) / (1000 * 60 * 60 * 24)) + ' days'
        });
      }

      const seenCount = messageInfo?.read?.length || 0;

      // Get reactions - try multiple methods
      let reactionsCount = 0;
      let reactionsData = [];

      try {
        if (typeof targetMessage.getReactions === 'function') {
          const reactions = await this.withTimeout(
            () => targetMessage.getReactions(),
            8000,
            'getReactions'
          );
          if (reactions && reactions.length > 0) {
            reactionsData = reactions;
          }
        }

        if (reactionsData.length === 0 && targetMessage.reactions) {
          reactionsData = Array.isArray(targetMessage.reactions) ? targetMessage.reactions : [targetMessage.reactions];
        }

        if (reactionsData.length === 0 && targetMessage._data?.reactions) {
          const dataReactions = targetMessage._data.reactions;
          reactionsData = Array.isArray(dataReactions) ? dataReactions : Object.values(dataReactions);
        }

        // Count total reactions
        if (reactionsData.length > 0) {
          let totalReactions = 0;
          reactionsData.forEach(r => {
            if (r.senders && Array.isArray(r.senders)) {
              totalReactions += r.senders.length;
            } else if (r.count) {
              totalReactions += r.count;
            } else if (r.id && Array.isArray(r.id)) {
              totalReactions += r.id.length;
            } else {
              totalReactions += 1;
            }
          });
          reactionsCount = totalReactions;
        }
      } catch (e) {
        logger.warn('Error getting reactions during refresh', { error: e.message });
      }

      // Count replies
      const repliesCount = messages.filter(m => {
        if (!m.hasQuotedMsg) return false;
        const quotedId = m._data?.quotedMsg?.id || m._data?.quotedStanzaID || m.quotedMsg?.id;
        const thisMessageId = targetMessage.id.id || targetMessage.id._serialized;
        return quotedId === thisMessageId;
      }).length;

      // Calculate engagement rate using UNIQUE USERS (Option B)
      const uniqueEngagedUsers = new Set();

      // Add users who read the message
      if (messageInfo?.read && Array.isArray(messageInfo.read)) {
        messageInfo.read.forEach(userId => {
          if (userId && userId.id) {
            uniqueEngagedUsers.add(userId.id);
          } else if (typeof userId === 'string') {
            uniqueEngagedUsers.add(userId);
          }
        });
      }

      // Add users who reacted
      reactionsData.forEach(reaction => {
        if (reaction.senders && Array.isArray(reaction.senders)) {
          reaction.senders.forEach(sender => {
            if (sender && sender.id) {
              uniqueEngagedUsers.add(sender.id);
            } else if (typeof sender === 'string') {
              uniqueEngagedUsers.add(sender);
            }
          });
        }
      });

      // Add users who replied
      const replierIds = messages
        .filter(m => {
          if (!m.hasQuotedMsg) return false;
          const quotedId = m._data?.quotedMsg?.id || m._data?.quotedStanzaID || m.quotedMsg?.id;
          const thisMessageId = targetMessage.id.id || targetMessage.id._serialized;
          return quotedId === thisMessageId;
        })
        .map(m => m.author || m.from)
        .filter(Boolean);

      replierIds.forEach(userId => {
        uniqueEngagedUsers.add(userId);
      });

      // Calculate engagement rate based on unique users (capped at 100%)
      // Exclude sender from total: engagement = seen / (total - 1)
      const uniqueEngagedCount = uniqueEngagedUsers.size;
      const engagementRate = totalMembers > 1
        ? Math.min(((uniqueEngagedCount / (totalMembers - 1)) * 100), 100).toFixed(2)
        : 0;

      logger.info('Unique engagement calculated during refresh', {
        messageId,
        uniqueUsers: uniqueEngagedCount,
        totalMembers,
        engagementRate: engagementRate + '%'
      });

      // Update the message in local data store
      const updatedMessage = {
        message_id: messageId,
        group_id: chat.id._serialized,
        group_name: chat.name,
        sender_id: targetMessage.author || targetMessage.from,
        message_content: targetMessage.body || '',
        message_timestamp: new Date(targetMessage.timestamp * 1000).toISOString(),
        has_media: targetMessage.hasMedia,
        message_type: targetMessage.type,
        is_forwarded: targetMessage.isForwarded || false,
        seen_count: seenCount,
        total_members: totalMembers,
        reactions_count: reactionsCount,
        replies_count: repliesCount,
        engagement_rate: parseFloat(engagementRate),
        updated_at: new Date().toISOString()
      };

      // Update in local store
      this.localDataStore.addMessages([updatedMessage]);

      logger.info('Message stats refreshed', {
        messageId,
        seenCount,
        reactionsCount,
        repliesCount,
        engagementRate,
        messageInfoAvailable: !!messageInfo
      });

      // Check for data quality issues
      const warnings = [];
      // messageAge already declared above, reuse it

      if (!messageInfo) {
        warnings.push({
          type: 'message_info_unavailable',
          severity: 'high',
          message: 'WhatsApp message info could not be loaded. Read receipts may be unavailable.',
          details: `Message is ${messageAge} days old. Older messages often don't have detailed read receipt data.`
        });
      }

      if (seenCount === 0 && messageAge < 7) {
        warnings.push({
          type: 'zero_seen_count',
          severity: 'medium',
          message: 'Message has zero seen count but is less than 7 days old.',
          details: 'This might indicate the message info is still loading. Try refreshing again in a few moments.'
        });
      }

      if (messageAge > 30) {
        warnings.push({
          type: 'old_message',
          severity: 'low',
          message: `Message is ${messageAge} days old.`,
          details: 'Very old messages may not have complete engagement data available from WhatsApp servers.'
        });
      }

      return {
        success: true,
        message: warnings.length > 0 ? 'Stats refreshed with warnings' : 'Stats refreshed successfully',
        stats: {
          seenCount,
          reactionsCount,
          repliesCount,
          engagementRate: parseFloat(engagementRate)
        },
        warnings: warnings,
        dataQuality: {
          messageInfoLoaded: !!messageInfo,
          messageAge: messageAge,
          hasWarnings: warnings.length > 0
        }
      };
    } catch (error) {
      logger.error('Error refreshing message stats', { error: error.message });
      throw error;
    }
  }
}

module.exports = ScraperService;
