const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { DatabaseError } = require('../utils/error-handler');

class ScriptRun {
  /**
   * Create a new script run record
   * @returns {Promise<number>} Script run ID
   */
  static async create() {
    try {
      const result = await pool.query(
        `INSERT INTO script_runs (status, started_at)
         VALUES ('running', NOW())
         RETURNING id`
      );

      const runId = result.rows[0].id;
      logger.info('Script run started', { runId });
      return runId;
    } catch (error) {
      logger.error('Error creating script run', { error: error.message });
      throw new DatabaseError(`Failed to create script run: ${error.message}`);
    }
  }

  /**
   * Mark a script run as completed
   * @param {number} id - Script run ID
   * @param {Object} stats - Execution statistics
   * @returns {Promise<void>}
   */
  static async complete(id, stats) {
    try {
      await pool.query(
        `UPDATE script_runs
         SET completed_at = NOW(),
             status = 'completed',
             groups_checked = $1,
             messages_processed = $2,
             errors_count = $3
         WHERE id = $4`,
        [stats.groupsChecked, stats.messagesProcessed, stats.errorsCount, id]
      );

      logger.info('Script run completed', {
        runId: id,
        groupsChecked: stats.groupsChecked,
        messagesProcessed: stats.messagesProcessed,
        errorsCount: stats.errorsCount
      });
    } catch (error) {
      logger.error('Error completing script run', {
        id,
        error: error.message
      });
      throw new DatabaseError(`Failed to complete script run: ${error.message}`);
    }
  }

  /**
   * Mark a script run as failed
   * @param {number} id - Script run ID
   * @param {string} errorLog - Error details
   * @returns {Promise<void>}
   */
  static async fail(id, errorLog) {
    try {
      await pool.query(
        `UPDATE script_runs
         SET completed_at = NOW(),
             status = 'failed',
             error_log = $1
         WHERE id = $2`,
        [errorLog, id]
      );

      logger.error('Script run failed', { runId: id, errorLog });
    } catch (error) {
      logger.error('Error marking script run as failed', {
        id,
        error: error.message
      });
      throw new DatabaseError(`Failed to mark script run as failed: ${error.message}`);
    }
  }

  /**
   * Update script run progress
   * @param {number} id - Script run ID
   * @param {Object} progress - Current progress
   * @returns {Promise<void>}
   */
  static async updateProgress(id, progress) {
    try {
      await pool.query(
        `UPDATE script_runs
         SET groups_checked = $1,
             messages_processed = $2,
             errors_count = $3
         WHERE id = $4`,
        [progress.groupsChecked, progress.messagesProcessed, progress.errorsCount, id]
      );

      logger.debug('Script run progress updated', { runId: id, ...progress });
    } catch (error) {
      logger.error('Error updating script run progress', {
        id,
        error: error.message
      });
      // Don't throw error for progress updates to avoid disrupting execution
    }
  }

  /**
   * Log an error for a script run
   * @param {number} scriptRunId - Script run ID
   * @param {number|null} groupId - Group database ID (optional)
   * @param {string} errorType - Error type/category
   * @param {string} errorMessage - Error message
   * @returns {Promise<void>}
   */
  static async logError(scriptRunId, groupId, errorType, errorMessage) {
    try {
      await pool.query(
        `INSERT INTO errors (script_run_id, group_id, error_type, error_message, occurred_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [scriptRunId, groupId, errorType, errorMessage]
      );

      logger.debug('Error logged to database', {
        scriptRunId,
        groupId,
        errorType
      });
    } catch (error) {
      logger.error('Error logging error to database', {
        scriptRunId,
        error: error.message
      });
      // Don't throw error for error logging to avoid infinite loops
    }
  }

  /**
   * Get recent script runs
   * @param {number} limit - Maximum number of runs to retrieve
   * @returns {Promise<Array>}
   */
  static async getRecent(limit = 10) {
    try {
      const result = await pool.query(
        `SELECT * FROM script_runs
         ORDER BY started_at DESC
         LIMIT $1`,
        [limit]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching recent script runs', {
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch recent script runs: ${error.message}`);
    }
  }

  /**
   * Get errors for a specific script run
   * @param {number} scriptRunId - Script run ID
   * @returns {Promise<Array>}
   */
  static async getErrors(scriptRunId) {
    try {
      const result = await pool.query(
        `SELECT e.*, g.group_name
         FROM errors e
         LEFT JOIN groups g ON e.group_id = g.id
         WHERE e.script_run_id = $1
         ORDER BY e.occurred_at DESC`,
        [scriptRunId]
      );
      return result.rows;
    } catch (error) {
      logger.error('Error fetching script run errors', {
        scriptRunId,
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch script run errors: ${error.message}`);
    }
  }

  /**
   * Get last successful run timestamp
   * @returns {Promise<Date|null>}
   */
  static async getLastSuccessfulRun() {
    try {
      const result = await pool.query(
        `SELECT completed_at
         FROM script_runs
         WHERE status = 'completed'
         ORDER BY completed_at DESC
         LIMIT 1`
      );

      return result.rows.length > 0 ? result.rows[0].completed_at : null;
    } catch (error) {
      logger.error('Error fetching last successful run', {
        error: error.message
      });
      throw new DatabaseError(`Failed to fetch last successful run: ${error.message}`);
    }
  }
}

module.exports = ScriptRun;
