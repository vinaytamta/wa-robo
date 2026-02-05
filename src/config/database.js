const { Pool } = require('pg');
const logger = require('../utils/logger');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'wa_robo',
  user: process.env.DB_USER || 'wa_robo_user',
  password: process.env.DB_PASSWORD || 'wa_robo_password',
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 5000, // Timeout for acquiring connection
});

// Handle pool errors
pool.on('error', (err, client) => {
  logger.error('Unexpected error on idle PostgreSQL client', {
    error: err.message,
    stack: err.stack
  });
});

// Test database connection on startup
pool.on('connect', (client) => {
  logger.debug('New PostgreSQL client connected');
});

/**
 * Test the database connection
 * @returns {Promise<boolean>}
 */
async function testConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    logger.info('Database connection successful', {
      timestamp: result.rows[0].now
    });
    return true;
  } catch (error) {
    logger.error('Database connection failed', {
      error: error.message,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME
    });
    throw error;
  }
}

/**
 * Close all database connections
 * @returns {Promise<void>}
 */
async function closePool() {
  try {
    await pool.end();
    logger.info('Database connection pool closed');
  } catch (error) {
    logger.error('Error closing database pool', { error: error.message });
    throw error;
  }
}

module.exports = {
  pool,
  testConnection,
  closePool
};
