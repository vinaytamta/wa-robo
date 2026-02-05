const logger = require('./logger');

/**
 * Base error class for application-specific errors
 */
class AppError extends Error {
  constructor(message, type = 'APP_ERROR', statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.type = type;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Database-related errors
 */
class DatabaseError extends AppError {
  constructor(message) {
    super(message, 'DATABASE_ERROR', 500);
  }
}

/**
 * WhatsApp automation errors
 */
class WhatsAppError extends AppError {
  constructor(message) {
    super(message, 'WHATSAPP_ERROR', 500);
  }
}

/**
 * Configuration errors
 */
class ConfigError extends AppError {
  constructor(message) {
    super(message, 'CONFIG_ERROR', 400);
  }
}

/**
 * Handle errors with logging and optional recovery
 * @param {Error} error - Error object
 * @param {string} context - Context where error occurred
 * @param {boolean} fatal - Whether error should terminate process
 */
function handleError(error, context = 'Unknown', fatal = false) {
  const errorInfo = {
    context,
    message: error.message,
    type: error.type || error.name,
    stack: error.stack
  };

  if (fatal) {
    logger.error('Fatal error occurred', errorInfo);
    process.exit(1);
  } else {
    logger.error('Error occurred', errorInfo);
  }
}

/**
 * Async error wrapper for functions
 * @param {Function} fn - Async function to wrap
 * @param {string} context - Context for error logging
 * @returns {Function} Wrapped function with error handling
 */
function asyncErrorHandler(fn, context) {
  return async function(...args) {
    try {
      return await fn.apply(this, args);
    } catch (error) {
      handleError(error, context);
      throw error;
    }
  };
}

/**
 * Retry an async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {string} context - Context for logging
 * @returns {Promise<any>} Result of function
 */
async function retryWithBackoff(fn, maxRetries = 3, context = 'Operation') {
  const { exponentialBackoff } = require('./delays');

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1) {
        logger.error(`${context} failed after ${maxRetries} attempts`, {
          error: error.message
        });
        throw error;
      }

      logger.warn(`${context} failed (attempt ${attempt + 1}/${maxRetries}), retrying...`, {
        error: error.message
      });

      await exponentialBackoff(attempt);
    }
  }
}

module.exports = {
  AppError,
  DatabaseError,
  WhatsAppError,
  ConfigError,
  handleError,
  asyncErrorHandler,
  retryWithBackoff
};
