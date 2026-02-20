const winston = require('winston');
const path    = require('path');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`
    )
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) =>
          `[${timestamp}] ${level} ${message}`
        )
      )
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/algo.log'),
      maxsize:  5242880, // 5MB
      maxFiles: 5,
    })
  ]
});

// Create logs dir if not exists
const fs   = require('fs');
const dir  = path.join(__dirname, '../../logs');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

module.exports = logger;
