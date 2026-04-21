/**
 * Backup Manager — Workspace snapshot, list, download
 *
 * Creates compressed archives of:
 *   - workspace/ (soul files, memory)
 *   - data/ (conversations, state)
 *   - config.json
 *
 * Backups stored in: <baseDir>/backups/
 * Format: anuki-backup-<timestamp>.tar.gz
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

class BackupManager {
  constructor(baseDir, logger) {
    this.baseDir = baseDir;
    this.logger = logger;
    this.backupDir = path.join(baseDir, 'backups');

    // Ensure backup directory exists
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  /**
   * Create a new backup archive.
   * @param {object} opts - { label?: string }
   * @returns {{ filename, path, size, items }}
   */
  create(opts = {}) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const label = opts.label ? `-${opts.label.replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
    const filename = `anuki-backup-${timestamp}${label}.tar.gz`;
    const archivePath = path.join(this.backupDir, filename);

    // Collect directories/files to back up (relative to baseDir)
    const items = [];
    const candidates = ['workspace', 'data', 'config.json', 'rules'];
    for (const name of candidates) {
      const fullPath = path.join(this.baseDir, name);
      if (fs.existsSync(fullPath)) {
        items.push(name);
      }
    }

    if (items.length === 0) {
      throw new Error('Nothing to back up — no workspace, data, or config found');
    }

    // Create tar.gz archive using system tar (available on macOS and Linux)
    try {
      execFileSync('tar', [
        '-czf', archivePath,
        '-C', this.baseDir,
        ...items
      ], { timeout: 30000 });
    } catch (e) {
      throw new Error('Archive creation failed: ' + (e.stderr ? e.stderr.toString().trim() : e.message));
    }

    const stat = fs.statSync(archivePath);
    this.logger.info('Backup', `Created: ${filename} (${(stat.size / 1024).toFixed(1)} KB, ${items.length} items)`);

    return {
      filename,
      path: archivePath,
      size: stat.size,
      sizeHuman: stat.size < 1024 * 1024
        ? (stat.size / 1024).toFixed(1) + ' KB'
        : (stat.size / (1024 * 1024)).toFixed(1) + ' MB',
      items,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * List all backup files.
   * @returns {Array<{ filename, size, sizeHuman, createdAt }>}
   */
  list() {
    if (!fs.existsSync(this.backupDir)) return [];

    return fs.readdirSync(this.backupDir)
      .filter(f => f.endsWith('.tar.gz'))
      .map(filename => {
        const fullPath = path.join(this.backupDir, filename);
        const stat = fs.statSync(fullPath);
        return {
          filename,
          size: stat.size,
          sizeHuman: stat.size < 1024 * 1024
            ? (stat.size / 1024).toFixed(1) + ' KB'
            : (stat.size / (1024 * 1024)).toFixed(1) + ' MB',
          createdAt: stat.birthtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /**
   * Get full path for a backup file (with security check).
   * @param {string} filename
   * @returns {string|null}
   */
  getPath(filename) {
    // Sanitize: strip path components, only allow alphanumeric + dash + dot
    const safe = path.basename(filename);
    if (!safe.endsWith('.tar.gz')) return null;

    const fullPath = path.join(this.backupDir, safe);
    // Path traversal guard
    if (!path.resolve(fullPath).startsWith(path.resolve(this.backupDir))) return null;
    if (!fs.existsSync(fullPath)) return null;

    return fullPath;
  }

  /**
   * Get backup stats.
   * @returns {{ count, totalSize, totalSizeHuman, backupDir }}
   */
  stats() {
    const backups = this.list();
    const totalSize = backups.reduce((sum, b) => sum + b.size, 0);
    return {
      count: backups.length,
      totalSize,
      totalSizeHuman: totalSize < 1024 * 1024
        ? (totalSize / 1024).toFixed(1) + ' KB'
        : (totalSize / (1024 * 1024)).toFixed(1) + ' MB',
      backupDir: this.backupDir
    };
  }
}

module.exports = BackupManager;
