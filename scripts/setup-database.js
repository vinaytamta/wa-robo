const { pool } = require('../src/config/database');
const logger = require('../src/utils/logger');

const schema = `
-- Groups table: WhatsApp group metadata
CREATE TABLE IF NOT EXISTS groups (
    id SERIAL PRIMARY KEY,
    group_id VARCHAR(255) UNIQUE NOT NULL,
    group_name VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    last_checked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Messages table: Tracked message data
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    message_id VARCHAR(255) UNIQUE NOT NULL,
    message_content TEXT,
    message_timestamp TIMESTAMP NOT NULL,
    sender_name VARCHAR(255),
    seen_count INTEGER DEFAULT 0,
    total_members INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Message snapshots: Track seen count changes over time
CREATE TABLE IF NOT EXISTS message_snapshots (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    seen_count INTEGER NOT NULL,
    checked_at TIMESTAMP DEFAULT NOW()
);

-- Script runs: Execution history
CREATE TABLE IF NOT EXISTS script_runs (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    status VARCHAR(50),
    groups_checked INTEGER DEFAULT 0,
    messages_processed INTEGER DEFAULT 0,
    errors_count INTEGER DEFAULT 0,
    error_log TEXT
);

-- Errors log: Error tracking per run
CREATE TABLE IF NOT EXISTS errors (
    id SERIAL PRIMARY KEY,
    script_run_id INTEGER REFERENCES script_runs(id),
    group_id INTEGER REFERENCES groups(id),
    error_type VARCHAR(100),
    error_message TEXT,
    occurred_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_group_timestamp
    ON messages(group_id, message_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_messages_timestamp
    ON messages(message_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_message
    ON message_snapshots(message_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_groups_active
    ON groups(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_script_runs_started
    ON script_runs(started_at DESC);
`;

async function setupDatabase() {
  try {
    logger.info('Starting database schema setup...');

    await pool.query(schema);

    logger.info('Database schema created successfully');
    logger.info('Tables created: groups, messages, message_snapshots, script_runs, errors');

    // Verify tables were created
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    logger.info('Database tables:', {
      tables: result.rows.map(row => row.table_name)
    });

    process.exit(0);
  } catch (error) {
    logger.error('Error setting up database schema', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

setupDatabase();
