const User = require('../models/user');
const logger = require('../utils/logger');

/**
 * Get session token from request (cookie or Authorization header)
 */
function getSessionToken(req) {
  return req.cookies?.session_token ||
    req.headers.authorization?.replace('Bearer ', '');
}

/**
 * Authentication middleware
 * Checks for session token in cookie or Authorization header
 */
async function authenticate(req, res, next) {
  try {
    const token = getSessionToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const user = await User.findBySessionToken(token);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.user = user;
    next();
  } catch (error) {
    logger.error('Authentication error', { error: error.message });
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Admin-only middleware
 * Must be used after authenticate middleware
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Optional authentication
 * Attaches user if authenticated, but doesn't reject if not
 */
async function optionalAuth(req, res, next) {
  try {
    const token = getSessionToken(req);
    if (token) {
      const user = await User.findBySessionToken(token);
      if (user && user.is_active) {
        req.user = user;
      }
    }
    next();
  } catch (error) {
    logger.error('Optional auth error', { error: error.message });
    next();
  }
}

module.exports = {
  getSessionToken,
  authenticate,
  requireAdmin,
  optionalAuth
};
