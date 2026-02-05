const { pool } = require('../src/config/database');
const logger = require('../src/utils/logger');

const multiUserSchema = `
-- Users table: User accounts
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'user', -- 'admin' or 'user'
    whatsapp_connected BOOLEAN DEFAULT false,
    whatsapp_phone_number VARCHAR(50),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- User sessions: Login sessions
CREATE TABLE IF NOT EXISTS user_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User groups: Which groups each user is monitoring
CREATE TABLE IF NOT EXISTS user_groups (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, group_id)
);

-- Add user_id to existing tables
ALTER TABLE groups ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE script_runs ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_groups_user ON user_groups(user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_groups_user ON groups(user_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, message_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_script_runs_user ON script_runs(user_id, started_at DESC);
`;

async function migrateToMultiUser() {
  try {
    logger.info('Starting multi-user migration...');

    await pool.query(multiUserSchema);

    logger.info('Multi-user schema created successfully');
    logger.info('New tables: users, user_sessions, user_groups');
    logger.info('Added user_id columns to: groups, script_runs, messages');

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

    logger.info('Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    logger.error('Error during migration', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

migrateToMultiUser();
