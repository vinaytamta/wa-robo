const logger = require('../utils/logger');
const { humanDelay } = require('../utils/delays');
const { WhatsAppError } = require('../utils/error-handler');
const fs = require('fs');
const path = require('path');

class ScraperService {
  constructor(whatsappClient) {
    this.client = whatsappClient;
    this.groupsConfig = this.loadGroupsConfig();
  }

  /**
   * Load groups configuration from JSON file
   * @returns {Object}
   */
  loadGroupsConfig() {
    try {
      // Allow custom config path via environment variable (for single message refresh)
      const configPath = process.env.GROUPS_CONFIG_PATH || path.join(__dirname, '../config/groups-config.json');
      const configData = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configData);

      logger.info('Groups configuration loaded', {
        totalGroups: config.groups.length,
        enabledGroups: config.groups.filter(g => g.enabled).length
      });

      return config;
    } catch (error) {
      logger.error('Error loading groups config', { error: error.message });
      // Return default config if file doesn't exist
      return {
        groups: [],
        config: {
          autoDiscoverNewGroups: false,
          matchStrategy: 'exact'
        }
      };
    }
  }

  /**
   * Get all group chats from WhatsApp
   * @returns {Promise<Array>}
   */
  async getAllGroupChats() {
    try {
      logger.info('Fetching all group chats...');
      const chats = await this.client.getChats();
      const groupChats = chats.filter(chat => chat.isGroup);

      logger.info('Group chats retrieved', { count: groupChats.length });
      return groupChats;
    } catch (error) {
      logger.error('Error fetching group chats', { error: error.message });
      throw new WhatsAppError(`Failed to fetch group chats: ${error.message}`);
    }
  }

  /**
   * Filter groups based on configuration
   * @param {Array} allGroups - All WhatsApp group chats
   * @returns {Array} Filtered groups to monitor
   */
  filterGroupsByConfig(allGroups) {
    const enabledGroupNames = this.groupsConfig.groups
      .filter(g => g.enabled)
      .map(g => g.name);

    if (enabledGroupNames.length === 0) {
      logger.warn('No groups enabled in configuration');
      return [];
    }

    const matchStrategy = this.groupsConfig.config.matchStrategy || 'exact';
    const filteredGroups = [];

    for (const group of allGroups) {
      const isMatch = this.matchGroupName(group.name, enabledGroupNames, matchStrategy);
      if (isMatch) {
        filteredGroups.push(group);
        logger.debug('Group matched', { groupName: group.name });
      }
    }

    logger.info('Groups filtered by config', {
      total: allGroups.length,
      matched: filteredGroups.length,
      strategy: matchStrategy
    });

    return filteredGroups;
  }

  /**
   * Match group name against configured names
   * @param {string} groupName - WhatsApp group name
   * @param {Array} configNames - Configured group names
   * @param {string} strategy - Matching strategy ('exact' or 'fuzzy')
   * @returns {boolean}
   */
  matchGroupName(groupName, configNames, strategy) {
    if (strategy === 'exact') {
      return configNames.includes(groupName);
    } else if (strategy === 'fuzzy') {
      return configNames.some(configName =>
        groupName.toLowerCase().includes(configName.toLowerCase())
      );
    }
    return false;
  }

  /**
   * Get recent messages from a group chat
   * @param {Chat} chat - WhatsApp chat object
   * @param {Date} sinceDate - Get messages after this date
   * @param {number} limit - Maximum messages to fetch
   * @returns {Promise<Array>}
   */
  async getRecentMessages(chat, sinceDate, limit = 50) {
    try {
      logger.debug('Fetching messages', {
        groupName: chat.name,
        since: sinceDate,
        limit
      });

      await humanDelay();

      const messages = await chat.fetchMessages({ limit });

      // Filter messages after sinceDate
      const recentMessages = messages.filter(msg => {
        const msgDate = new Date(msg.timestamp * 1000);
        return msgDate > sinceDate;
      });

      logger.debug('Messages fetched', {
        groupName: chat.name,
        total: messages.length,
        recent: recentMessages.length
      });

      return recentMessages;
    } catch (error) {
      logger.error('Error fetching messages', {
        groupName: chat.name,
        error: error.message
      });
      throw new WhatsAppError(`Failed to fetch messages: ${error.message}`);
    }
  }

  /**
   * Get message info including seen count
   * @param {Message} message - WhatsApp message object
   * @returns {Promise<Object|null>}
   */
  async getMessageInfo(message) {
    try {
      await humanDelay();

      const info = await message.getInfo();

      // For group messages, use delivery info differently
      let seenCount = 0;
      let totalRecipients = 0;
      let deliveredCount = 0;

      if (info.delivery && Array.isArray(info.delivery)) {
        // Group messages: delivery = received, read = actually read
        deliveredCount = info.delivery.length;
        seenCount = info.read ? info.read.length : 0;
        totalRecipients = deliveredCount;

        // Debug logging for message engagement
        logger.debug('Message engagement breakdown', {
          messageId: message.id._serialized,
          totalRecipients,
          deliveredCount,
          seenCount,
          notReadYet: info.readRemaining?.length || 0,
          engagementRate: ((seenCount / totalRecipients) * 100).toFixed(1) + '%'
        });

      } else if (info.deliveryInfo && Array.isArray(info.deliveryInfo)) {
        // Private messages - might have different structure
        // For private chats, there's usually just one recipient
        totalRecipients = 1;
        deliveredCount = 1;
        // Check if message was read
        seenCount = info.read && info.read.length > 0 ? 1 : 0;

        logger.debug('Private message breakdown', {
          messageId: message.id._serialized,
          totalRecipients,
          deliveredCount,
          seenCount
        });
      } else {
        // Fallback: try to get from message properties
        logger.warn('Message info structure unexpected', {
          messageId: message.id._serialized,
          infoKeys: Object.keys(info)
        });
        return null;
      }

      // Get reactions properly - need to fetch them
      let reactionsCount = 0;
      let reactions = [];

      try {
        // Try to get reactions from the message object
        reactions = await message.getReactions();

        // Count total number of people who reacted (not just reaction types)
        if (reactions && Array.isArray(reactions)) {
          reactionsCount = reactions.reduce((total, reactionGroup) => {
            // Each reaction group has a 'senders' array with individual reactions
            return total + (reactionGroup.senders ? reactionGroup.senders.length : 0);
          }, 0);
        }
      } catch (err) {
        // If getReactions doesn't exist, try alternative methods
        if (message.hasReaction && message._data?.reactions) {
          reactions = message._data.reactions;
          // Count senders across all reaction types
          reactionsCount = reactions.reduce((total, reactionGroup) => {
            return total + (reactionGroup.senders ? reactionGroup.senders.length : 0);
          }, 0);
        }
      }

      // Note: repliesCount will be calculated in scrapeGroupMessages by scanning all messages

      // Debug logging for reactions
      logger.debug('Message reactions', {
        messageId: message.id._serialized,
        hasReaction: message.hasReaction,
        reactionsCount,
        reactionTypes: reactions.map(r => r.aggregateEmoji || r.id).join(', ')
      });

      return {
        messageId: message.id._serialized,
        seenCount: seenCount,
        totalRecipients: totalRecipients,
        reactionsCount: reactionsCount,
        timestamp: new Date(message.timestamp * 1000),
        hasQuotedMsg: message.hasQuotedMsg,
        isForwarded: message.isForwarded,
        hasMedia: message.hasMedia || false
      };
    } catch (error) {
      // Some messages may not have info available (e.g., system messages)
      logger.error('Could not get message info', {
        messageId: message.id._serialized,
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }

  /**
   * Check if message is from the authenticated user
   * @param {Message} message - WhatsApp message object
   * @returns {boolean}
   */
  isOwnMessage(message) {
    return message.fromMe;
  }

  /**
   * Count replies to a specific message
   * @param {Array} allMessages - All messages in the chat
   * @param {string} messageId - The message ID to count replies for
   * @returns {Promise<number>}
   */
  async countRepliesTo(allMessages, messageId) {
    let count = 0;

    logger.debug('Checking for replies', {
      targetMessageId: messageId,
      totalMessagesToScan: allMessages.length,
      messagesWithQuotes: allMessages.filter(m => m.hasQuotedMsg).length
    });

    for (const msg of allMessages) {
      // Check if this message quotes/replies to our target message
      if (msg.hasQuotedMsg) {
        try {
          // Need to fetch the actual quoted message to get its full ID
          const quotedMsg = await msg.getQuotedMessage();
          const quotedId = quotedMsg ? quotedMsg.id._serialized : null;

          if (quotedId === messageId) {
            count++;
          }
        } catch (err) {
          // Skip if we can't access quoted message data
          logger.debug('Could not fetch quoted message', {
            error: err.message,
            msgId: msg.id._serialized
          });
        }
      }
    }

    logger.debug('Reply detection complete', {
      repliesFound: count
    });

    return count;
  }

  /**
   * Scrape messages from a specific group
   * @param {Chat} chat - WhatsApp chat object
   * @param {Date} sinceDate - Get messages after this date
   * @returns {Promise<Array>}
   */
  async scrapeGroupMessages(chat, sinceDate) {
    try {
      logger.info('Scraping group', { groupName: chat.name });

      const messages = await this.getRecentMessages(chat, sinceDate);
      const messagesData = [];

      // Get actual group participant count
      const participants = await chat.participants;
      const actualGroupSize = participants ? participants.length : 0;

      logger.debug('Group size info', {
        groupName: chat.name,
        actualGroupSize
      });

      // Only process own messages (sent by the authenticated user)
      const ownMessages = messages.filter(msg => this.isOwnMessage(msg));

      logger.info('Found own messages', {
        groupName: chat.name,
        ownMessages: ownMessages.length,
        totalMessages: messages.length
      });

      for (const message of ownMessages) {
        try {
          const info = await this.getMessageInfo(message);

          if (info) {
            // Count how many messages in the chat reply to this message
            const repliesCount = await this.countRepliesTo(messages, info.messageId);

            logger.debug('Message engagement summary', {
              messageId: info.messageId,
              seenCount: info.seenCount,
              reactionsCount: info.reactionsCount,
              repliesCount
            });

            messagesData.push({
              groupName: chat.name,
              groupId: chat.id._serialized,
              messageId: info.messageId,
              content: message.body || '[Media/No text]',
              sender: message.author || message.from,
              timestamp: info.timestamp,
              seenCount: info.seenCount,
              totalMembers: actualGroupSize, // Use actual group size instead of delivery count
              reactionsCount: info.reactionsCount || 0,
              repliesCount: repliesCount,
              hasQuotedMsg: info.hasQuotedMsg,
              isForwarded: info.isForwarded,
              hasMedia: info.hasMedia
            });

            logger.debug('Message data collected', {
              messageId: info.messageId,
              seenCount: info.seenCount,
              totalMembers: info.totalRecipients
            });
          }
        } catch (error) {
          logger.warn('Failed to process message', {
            messageId: message.id._serialized,
            error: error.message
          });
          // Continue processing other messages
        }
      }

      logger.info('Group scraping completed', {
        groupName: chat.name,
        messagesCollected: messagesData.length
      });

      return messagesData;
    } catch (error) {
      logger.error('Error scraping group', {
        groupName: chat.name,
        error: error.message
      });
      // Return empty array instead of throwing to continue with other groups
      return [];
    }
  }

  /**
   * Get configured groups that match WhatsApp groups
   * @returns {Promise<Array>}
   */
  async getMonitoredGroups() {
    const allGroups = await this.getAllGroupChats();
    const filteredGroups = this.filterGroupsByConfig(allGroups);

    return filteredGroups;
  }
}

module.exports = ScraperService;
