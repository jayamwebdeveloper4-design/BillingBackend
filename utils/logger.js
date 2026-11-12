const fs = require('fs');
const path = require('path');
require('dotenv').config();

/**
 * Cleanup log files older than process.env.LOG_RETENTION_DAYS days (defaults to 30)
 */
const cleanupOldLogs = () => {
  try {
    const logsDir = path.join(__dirname, '../logs');
    if (!fs.existsSync(logsDir)) return;

    const files = fs.readdirSync(logsDir);
    const now = new Date();
    const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS) || 30;
    const thresholdMs = retentionDays * 24 * 60 * 60 * 1000;

    files.forEach(file => {
      if (file.endsWith('.log')) {
        const filePath = path.join(logsDir, file);
        const datePart = file.substring(0, 10);
        const fileDate = new Date(datePart);
        
        if (!isNaN(fileDate.getTime())) {
          // Set to start of day for accurate comparison
          const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const logDayStart = new Date(fileDate.getFullYear(), fileDate.getMonth(), fileDate.getDate());
          const ageMs = todayStart - logDayStart;
          if (ageMs > thresholdMs) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Deleted old log file: ${file}`);
          }
        } else {
          const stats = fs.statSync(filePath);
          const ageMs = now - stats.mtime;
          if (ageMs > thresholdMs) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Deleted old log file (fallback stats): ${file}`);
          }
        }
      }
    });
  } catch (error) {
    console.error('❌ Failed to cleanup old logs:', error);
  }
};

/**
 * Global Daily Logger Utility
 * Creates a new log file each day and appends system activities.
 */
const logActivity = (user, type, status, message = '') => {
  try {
    const logsDir = path.join(__dirname, '../logs');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir);
    }

    // Get current date for filename (YYYY-MM-DD)
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const logFilePath = path.join(logsDir, `${dateStr}.log`);

    // Create log entry
    const timestamp = now.toLocaleTimeString();
    const logEntry = `[${timestamp}] [${type.toUpperCase()}] [${status.toUpperCase()}] User: "${user}" | Message: ${message}\n`;

    // Append to file
    fs.appendFileSync(logFilePath, logEntry);
    
    console.log(`📝 Activity Logged: [${type}] for ${user}`);
    
    // Run cleanup
    cleanupOldLogs();
  } catch (error) {
    console.error('❌ Failed to write to log file:', error);
  }
};

/**
 * Cron Logger Utility
 * Appends auto-reminder cron events to the daily log file.
 * @param {'START'|'SENT'|'SKIP'|'ERROR'|'DONE'} event
 * @param {string} message  Human-readable detail
 */
const logCron = (event, message = '') => {
  try {
    const logsDir = path.join(__dirname, '../logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const logFilePath = path.join(logsDir, `${dateStr}.log`);

    const timestamp = now.toLocaleTimeString();
    const logEntry = `[${timestamp}] [CRON] [${event.toUpperCase()}] ${message}\n`;

    fs.appendFileSync(logFilePath, logEntry);
    console.log(`🕐 Cron Log: [${event}] ${message}`);
  } catch (error) {
    console.error('❌ Failed to write cron log:', error);
  }
};

module.exports = { logActivity, logCron };
