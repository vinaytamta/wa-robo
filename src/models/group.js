const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { DatabaseError } = require('../utils/error-handler');

class Group {
  /**
   * Upsert a group (insert or update if exists)
   * @param {Object|string} groupData - Group data object or groupId (for backward compatibility)
   * @param {string} groupName - Group display name (optional if groupData is object)
   * @returns {Promise<number>} Database ID of the group
   */
  static async upsert(groupData, groupName) {
    try {
      // Support both old and new API
      let groupId, name, totalMembers;

      if (typeof groupData === 'object') {
        groupId = groupData.groupId;
        name = groupData.groupName;
        totalMembers = groupData.totalMembers || null;
      } else {
        groupId = groupData;
        name = groupName;
        totalMembers = null;
      }

      const result = await pool.query(
        `INSERT INTO groups (group_id, group_name, total_members, last_checked_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (group_id)
         DO UPDATE SET
           group_name = EXCLUDED.group_name,
           total_members = COALESCE(EXCLUDED.total_members, groups.total_members),
           last_checked_at = NOW(),
           updated_at = NOW()
         RETURNING id`,
        [groupId, name, totalMembers]
      );

      return result.rows[0].id;
    } catch (error) {
      logger.error('Error upserting group', {
        groupData,
        groupName,
        error: error.message
      });
      throw new DatabaseError(`Failed to upsert group: ${error.message}`);
    }
  }

  /**
   * Get all active groups
   * @returns {Promise<Array>}
   */
  static async getActive() {
    try {
      const result = await pool.query(
        `SELECT * FROM groups WHERE is_active = true ORDER BY group_name`
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching active groups', { error: error.message });
      throw new DatabaseError(`Failed to fetch active groups: ${error.message}`);
    }
  }

  /**
   * Get group by WhatsApp group ID
   * @param {string} groupId - WhatsApp group ID
   * @returns {Promise<Object|null>}
   */
  static async getByGroupId(groupId) {
    try {
      const result = await pool.query(
        `SELECT * FROM groups WHERE group_id = $1`,
        [groupId]
      );
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      logger.error('Error fetching group by ID', {
        groupId,
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch group: ${error.message}`);
    }
  }

  /**
   * Update group active status
   * @param {number} id - Database ID
   * @param {boolean} isActive - Active status
   * @returns {Promise<void>}
   */
  static async updateActiveStatus(id, isActive) {
    try {
      await pool.query(
        `UPDATE groups SET is_active = $1, updated_at = NOW() WHERE id = $2`,
        [isActive, id]
      );
      logger.info('Group active status updated', { id, isActive });
    } catch (error) {
      logger.error('Error updating group status', {
        id,
        isActive,
        error: error.message
      });
      throw new DatabaseError(`Failed to update group status: ${error.message}`);
    }
  }

  /**
   * Get last checked timestamp for a group
   * @param {string} groupId - WhatsApp group ID
   * @returns {Promise<Date|null>}
   */
  static async getLastChecked(groupId) {
    try {
      const result = await pool.query(
        `SELECT last_checked_at FROM groups WHERE group_id = $1`,
        [groupId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0].last_checked_at;
    } catch (error) {
      logger.error('Error fetching last checked timestamp', {
        groupId,
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch last checked: ${error.message}`);
    }
  }

  /**
   * Get engagement statistics for a group
   * @param {number} groupDbId - Database ID of the group
   * @param {number} days - Number of days to look back
   * @returns {Promise<Object>}
   */
  static async getEngagementStats(groupDbId, days = 7) {
    try {
      const result = await pool.query(
        `SELECT
           COUNT(*) as total_messages,
           AVG(seen_count::float / NULLIF(total_members, 0) * 100) as avg_engagement_rate,
           MAX(seen_count) as max_seen,
           MIN(seen_count) as min_seen,
           AVG(seen_count) as avg_seen
         FROM messages
         WHERE group_id = $1
           AND message_timestamp > NOW() - INTERVAL '${days} days'`,
        [groupDbId]
      );

      return result.rows[0];
    } catch (error) {
      logger.error('Error fetching engagement stats', {
        groupDbId,
        days,
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch engagement stats: ${error.message}`);
    }
  }
}

module.exports = Group;
