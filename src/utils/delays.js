/**
 * Generate a random delay between min and max milliseconds
 * @param {number} min - Minimum delay in ms
 * @param {number} max - Maximum delay in ms
 * @returns {number} Random delay value
 */
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Pause execution for a human-like random delay (2-8 seconds by default)
 * Helps avoid WhatsApp rate limiting and detection
 * @returns {Promise<void>}
 */
async function humanDelay() {
  const minDelay = parseInt(process.env.MIN_DELAY_MS) || 2000;
  const maxDelay = parseInt(process.env.MAX_DELAY_MS) || 8000;
  const delay = randomDelay(minDelay, maxDelay);

  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Exponential backoff delay for retry logic
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {number} baseDelay - Base delay in ms (default 1000)
 * @returns {Promise<void>}
 */
async function exponentialBackoff(attempt, baseDelay = 1000) {
  const delay = baseDelay * Math.pow(2, attempt);
  const jitter = randomDelay(-delay * 0.1, delay * 0.1);
  const totalDelay = Math.min(delay + jitter, 30000); // Cap at 30 seconds

  return new Promise(resolve => setTimeout(resolve, totalDelay));
}

/**
 * Simple delay for a fixed duration
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  randomDelay,
  humanDelay,
  exponentialBackoff,
  sleep
};
