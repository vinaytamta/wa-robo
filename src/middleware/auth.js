const User = require('../models/user');

/**
 * Authentication middleware
 * Checks for session token in cookie or Authorization header
 */
async function authenticate(req, res, next) {
  try {
    // Get token from cookie or Authorization header
    const token = req.cookies?.session_token ||
                  req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Find user by session token
    const user = await User.findBySessionToken(token);

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // Attach user to request
    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
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
    const token = req.cookies?.session_token ||
                  req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const user = await User.findBySessionToken(token);
      if (user && user.is_active) {
        req.user = user;
      }
    }
    next();
  } catch (error) {
    console.error('Optional auth error:', error);
    next();
  }
}

module.exports = {
  authenticate,
  requireAdmin,
  optionalAuth
};
