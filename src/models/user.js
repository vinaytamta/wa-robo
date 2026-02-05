const { pool } = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

class User {
  /**
   * Create a new user
   */
  static async create({ email, password, username, role = 'user' }) {
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, username, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, role, whatsapp_connected, is_active, created_at`,
      [email, passwordHash, username, role]
    );

    return result.rows[0];
  }

  /**
   * Find user by email
   */
  static async findByEmail(email) {
    const result = await pool.query(
      `SELECT * FROM users WHERE email = $1`,
      [email]
    );

    return result.rows[0];
  }

  /**
   * Find user by ID
   */
  static async findById(id) {
    const result = await pool.query(
      `SELECT id, email, username, role, whatsapp_connected, whatsapp_phone_number, is_active, created_at
       FROM users WHERE id = $1`,
      [id]
    );

    return result.rows[0];
  }

  /**
   * Verify password
   */
  static async verifyPassword(user, password) {
    return bcrypt.compare(password, user.password_hash);
  }

  /**
   * Create session token
   */
  static async createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO user_sessions (user_id, session_token, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, token, expiresAt]
    );

    return token;
  }

  /**
   * Find user by session token
   */
  static async findBySessionToken(token) {
    const result = await pool.query(
      `SELECT u.id, u.email, u.username, u.role, u.whatsapp_connected, u.whatsapp_phone_number, u.is_active
       FROM users u
       JOIN user_sessions s ON u.id = s.user_id
       WHERE s.session_token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    return result.rows[0];
  }

  /**
   * Delete session (logout)
   */
  static async deleteSession(token) {
    await pool.query(
      `DELETE FROM user_sessions WHERE session_token = $1`,
      [token]
    );
  }

  /**
   * Update WhatsApp connection status
   */
  static async updateWhatsAppStatus(userId, phoneNumber = null) {
    await pool.query(
      `UPDATE users
       SET whatsapp_connected = $2, whatsapp_phone_number = $3, updated_at = NOW()
       WHERE id = $1`,
      [userId, phoneNumber !== null, phoneNumber]
    );
  }

  /**
   * Get all users (admin only)
   */
  static async getAll() {
    const result = await pool.query(
      `SELECT id, email, username, role, whatsapp_connected, whatsapp_phone_number, is_active, created_at
       FROM users
       ORDER BY created_at DESC`
    );

    return result.rows;
  }

  /**
   * Clean up expired sessions
   */
  static async cleanupExpiredSessions() {
    await pool.query(
      `DELETE FROM user_sessions WHERE expires_at < NOW()`
    );
  }
}

module.exports = User;
