const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Level priority: lower number = more verbose
const LEVEL_PRIORITY = { debug: 0, info: 1, success: 2, warn: 3, error: 4 };

class Logger {
  constructor(logDir) {
    this.logDir = logDir;
    this.logFile = path.join(logDir, 'master.log');
    this.errorFile = path.join(logDir, 'master-error.log');

    // Rotation config (roadmap 3.3: 10MB, keep 5)
    this.maxSize = 10 * 1024 * 1024; // 10MB
    this.maxFiles = 5;

    // LOG_LEVEL filtering: debug|info|success|warn|error (default: info)
    const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
    this._minLevel = LEVEL_PRIORITY[envLevel] !== undefined ? LEVEL_PRIORITY[envLevel] : LEVEL_PRIORITY.info;
    this._minLevelName = envLevel;

    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Throttled rotation: check every N writes instead of every write
    this._writeCount = 0;
    this._rotationCheckInterval = 100; // Check rotation every 100 writes
    this._lastRotationCheck = Date.now();
    this._rotationCheckMinInterval = 30000; // Also check at least every 30s

    // Initial rotation check
    this._checkRotation(this.logFile);
    this._checkRotation(this.errorFile);
  }

  _timestamp() {
    return new Date().toISOString();
  }

  _write(level, module, message, data) {
    const priority = LEVEL_PRIORITY[level] !== undefined ? LEVEL_PRIORITY[level] : LEVEL_PRIORITY.info;

    // Extract requestId from data if present (structured logging)
    let requestId = null;
    if (data && typeof data === 'object' && data.requestId) {
      requestId = data.requestId;
    }

    // Error-level ALWAYS goes to error log regardless of filter
    if (level === 'error') {
      const errorEntry = JSON.stringify({
        timestamp: this._timestamp(), level, module, message,
        ...(requestId && { requestId }),
        ...(data && { data })
      }) + '\n';
      this._writeError(errorEntry);
    }

    // Skip if below configured LOG_LEVEL
    if (priority < this._minLevel) return;

    const logEntry = {
      timestamp: this._timestamp(),
      level,
      module,
      message,
      ...(requestId && { requestId }),
      ...(data && { data })
    };

    const logLine = JSON.stringify(logEntry) + '\n';

    // Write to file
    try {
      fs.appendFileSync(this.logFile, logLine);
      this._maybeCheckRotation(this.logFile);
    } catch (e) {
      // Fallback: just console
    }

    // Console output with colors
    const colors = {
      info: '\x1b[36m',    // cyan
      warn: '\x1b[33m',    // yellow
      error: '\x1b[31m',   // red
      success: '\x1b[32m', // green
      debug: '\x1b[90m'    // gray
    };

    const color = colors[level] || '';
    const reset = '\x1b[0m';
    const ridTag = requestId ? ` [${requestId}]` : '';

    console.log(`${color}[${this._timestamp()}] [${level.toUpperCase()}] [${module}]${ridTag}${reset} ${message}`);
    if (data) {
      console.log(data);
    }
  }

  _writeError(logLine) {
    try {
      fs.appendFileSync(this.errorFile, logLine);
      this._maybeCheckRotation(this.errorFile);
    } catch (e) {
      // Ignore error log write failures
    }
  }

  // Throttled rotation check: avoids fs.statSync on every single write
  _maybeCheckRotation(filePath) {
    this._writeCount++;
    const now = Date.now();
    if (this._writeCount >= this._rotationCheckInterval ||
        now - this._lastRotationCheck >= this._rotationCheckMinInterval) {
      this._writeCount = 0;
      this._lastRotationCheck = now;
      this._checkRotation(this.logFile);
      this._checkRotation(this.errorFile);
    }
  }

  _checkRotation(filePath) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < this.maxSize) return;

      // Rotate: file.7 -> delete, file.6 -> file.7, ... file.1 -> file.2, file -> file.1
      for (let i = this.maxFiles; i >= 1; i--) {
        const from = i === 1 ? filePath : filePath + '.' + (i - 1);
        const to = filePath + '.' + i;
        if (i === this.maxFiles && fs.existsSync(to)) {
          fs.unlinkSync(to);
        }
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
        }
      }
    } catch (e) {
      // Rotation failure is non-critical
    }
  }

  info(module, message, data) {
    this._write('info', module, message, data);
  }

  warn(module, message, data) {
    this._write('warn', module, message, data);
  }

  error(module, message, data) {
    this._write('error', module, message, data);
  }

  success(module, message, data) {
    this._write('success', module, message, data);
  }

  debug(module, message, data) {
    this._write('debug', module, message, data);
  }

  /**
   * Periodic log maintenance — call from cron (e.g. daily at 05:00)
   * 1. Delete rotated logs older than maxAgeDays
   * 2. Trim service logs if they exceed maxserviceSize
   * Returns { deletedFiles, trimmedFiles, totalSize }
   */
  maintenance({ maxAgeDays = 7, maxserviceSize = 512 * 1024, serviceKeepLines = 200 } = {}) {
    const result = { deletedFiles: 0, trimmedFiles: 0, totalSize: 0 };
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    try {
      const files = fs.readdirSync(this.logDir);

      for (const file of files) {
        const fp = path.join(this.logDir, file);
        let stat;
        try { stat = fs.statSync(fp); } catch { continue; }
        if (!stat.isFile()) continue;

        result.totalSize += stat.size;

        // Delete old rotated logs (master.log.1, master-error.log.3, etc.)
        if (/\.(log)\.\d+$/.test(file) && (now - stat.mtimeMs) > maxAgeMs) {
          try {
            fs.unlinkSync(fp);
            result.deletedFiles++;
            result.totalSize -= stat.size;
          } catch { /* ignore */ }
          continue;
        }

        // Trim service logs at runtime
        if (file.startsWith('service-') && file.endsWith('.log') && stat.size > maxserviceSize) {
          try {
            const lines = fs.readFileSync(fp, 'utf8').split('\n');
            fs.writeFileSync(fp, lines.slice(-serviceKeepLines).join('\n'));
            result.trimmedFiles++;
          } catch { /* ignore */ }
        }
      }
    } catch { /* logDir read failure is non-critical */ }

    return result;
  }

  /**
   * Generate a short unique request ID for tracking requests across HTTP/WS/agent.
   * Format: 8-char hex string (4 random bytes) — short enough for logs, unique enough for correlation.
   */
  static generateRequestId() {
    return crypto.randomBytes(4).toString('hex');
  }

  getStatus() {
    const getSize = (f) => {
      try { return fs.statSync(f).size; } catch { return 0; }
    };
    return {
      logFile: this.logFile,
      logSize: getSize(this.logFile),
      errorFile: this.errorFile,
      errorSize: getSize(this.errorFile),
      maxSize: this.maxSize,
      maxFiles: this.maxFiles,
      logLevel: this._minLevelName,
      levels: Object.keys(LEVEL_PRIORITY)
    };
  }
}

module.exports = Logger;
