const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Prefer LOGS_DIR; otherwise default to relative path.
// When packaged, __dirname can be inside app.asar (a file), so creating
// directories under that path will fail with ENOTDIR on Windows.
let logsDir = process.env.LOGS_DIR || path.join(__dirname, '../../logs');

let logsDirReady = false;

// If the computed path clearly points inside app.asar, skip creating a logs
// directory there entirely. We'll just use console logging in that case.
const looksLikeAsarPath = typeof logsDir === 'string' && logsDir.includes('app.asar');

if (!looksLikeAsarPath) {
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    logsDirReady = fs.statSync(logsDir).isDirectory();
  } catch (_) {
    logsDirReady = false;
  }
}

// Fallback to temp dir if logsDir is invalid and we're not obviously inside asar.
if (!logsDirReady && !looksLikeAsarPath && typeof process !== 'undefined') {
  const os = require('os');
  logsDir = path.join(os.tmpdir(), 'groupiq-logs');
  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    logsDirReady = fs.statSync(logsDir).isDirectory();
  } catch (_) {
    logsDirReady = false;
  }
}

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...metadata }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(metadata).length > 0) {
          msg += ` ${JSON.stringify(metadata)}`;
        }
        return msg;
      })
    )
  })
];
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024; // 10MB
if (logsDirReady) {
  transports.push(
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: MAX_LOG_FILE_SIZE,
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: MAX_LOG_FILE_SIZE,
      maxFiles: 5
    })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports
});

module.exports = logger;
