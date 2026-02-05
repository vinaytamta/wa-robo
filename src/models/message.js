const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { DatabaseError } = require('../utils/error-handler');

class Message {
  /**
   * Upsert a message with transaction support
   * @param {Object} messageData - Message data object
   * @returns {Promise<number>} Database ID of the message
   */
  static async upsert(messageData) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Upsert group first
      const groupResult = await client.query(
        `INSERT INTO groups (group_id, group_name, last_checked_at, updated_at)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (group_id)
         DO UPDATE SET
           group_name = EXCLUDED.group_name,
           last_checked_at = NOW(),
           updated_at = NOW()
         RETURNING id`,
        [messageData.groupId, messageData.groupName]
      );
      const groupDbId = groupResult.rows[0].id;

      // Upsert message
      const messageResult = await client.query(
        `INSERT INTO messages (
           group_id, message_id, message_content, message_timestamp,
           sender_name, seen_count, total_members, reactions_count,
           replies_count, is_forwarded, has_media
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (message_id)
         DO UPDATE SET
           seen_count = EXCLUDED.seen_count,
           total_members = EXCLUDED.total_members,
           reactions_count = EXCLUDED.reactions_count,
           replies_count = EXCLUDED.replies_count,
           is_forwarded = EXCLUDED.is_forwarded,
           has_media = EXCLUDED.has_media
         RETURNING id, seen_count`,
        [
          groupDbId,
          messageData.messageId,
          messageData.content,
          messageData.timestamp,
          messageData.sender,
          messageData.seenCount,
          messageData.totalMembers,
          messageData.reactionsCount || 0,
          messageData.repliesCount || 0,
          messageData.isForwarded || false,
          messageData.hasMedia || false
        ]
      );
      const messageDbId = messageResult.rows[0].id;

      // Create snapshot
      await client.query(
        `INSERT INTO message_snapshots (message_id, seen_count, checked_at)
         VALUES ($1, $2, NOW())`,
        [messageDbId, messageData.seenCount]
      );

      await client.query('COMMIT');

      logger.debug('Message upserted successfully', {
        messageId: messageData.messageId,
        groupName: messageData.groupName,
        seenCount: messageData.seenCount
      });

      return messageDbId;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error upserting message', {
        messageId: messageData.messageId,
        error: error.message
      });
      throw new DatabaseError(`Failed to upsert message: ${error.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get messages for a specific group
   * @param {number} groupDbId - Database ID of the group
   * @param {number} limit - Maximum number of messages to retrieve
   * @returns {Promise<Array>}
   */
  static async getByGroup(groupDbId, limit = 50) {
    try {
      const result = await pool.query(
        `SELECT * FROM messages
         WHERE group_id = $1
         ORDER BY message_timestamp DESC
         LIMIT $2`,
        [groupDbId, limit]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching messages by group', {
        groupDbId,
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch messages: ${error.message}`);
    }
  }

  /**
   * Get recent messages since a specific timestamp
   * @param {number} groupDbId - Database ID of the group
   * @param {Date} sinceDate - Get messages after this date
   * @returns {Promise<Array>}
   */
  static async getSince(groupDbId, sinceDate) {
    try {
      const result = await pool.query(
        `SELECT * FROM messages
         WHERE group_id = $1 AND message_timestamp > $2
         ORDER BY message_timestamp DESC`,
        [groupDbId, sinceDate]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching messages since date', {
        groupDbId,
        sinceDate,
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch messages since date: ${error.message}`);
    }
  }

  /**
   * Get engagement trends for a message over time
   * @param {number} messageDbId - Database ID of the message
   * @returns {Promise<Array>}
   */
  static async getEngagementTrend(messageDbId) {
    try {
      const result = await pool.query(
        `SELECT seen_count, checked_at
         FROM message_snapshots
         WHERE message_id = $1
         ORDER BY checked_at ASC`,
        [messageDbId]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching engagement trend', {
        messageDbId,
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch engagement trend: ${error.message}`);
    }
  }

  /**
   * Get top engaging messages across all groups
   * @param {number} days - Number of days to look back
   * @param {number} limit - Maximum number of messages
   * @returns {Promise<Array>}
   */
  static async getTopEngaging(days = 7, limit = 20) {
    try {
      const result = await pool.query(
        `SELECT
           m.*,
           g.group_name,
           (m.seen_count::float / NULLIF(m.total_members, 0) * 100) as engagement_rate
         FROM messages m
         JOIN groups g ON m.group_id = g.id
         WHERE m.message_timestamp > NOW() - INTERVAL '${days} days'
         ORDER BY engagement_rate DESC
         LIMIT $1`,
        [limit]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching top engaging messages', {
        days,
        limit,
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch top engaging messages: ${error.message}`);
    }
  }
}

module.exports = Message;
