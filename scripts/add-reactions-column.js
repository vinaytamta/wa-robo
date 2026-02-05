const { pool } = require('../src/config/database');
const logger = require('../src/utils/logger');

async function addReactionsColumn() {
  try {
    logger.info('Adding reactions_count column to messages table...');

    await pool.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS reactions_count INTEGER DEFAULT 0;
    `);

    logger.info('Successfully added reactions_count column!');

    await pool.end();
    process.exit(0);
  } catch (error) {
    logger.error('Error adding reactions_count column', {
      error: error.message,
      stack: error.stack
    });
    await pool.end();
    process.exit(1);
  }
}

addReactionsColumn();
