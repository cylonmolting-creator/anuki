const fs = require('fs');
const path = require('path');

/**
 * Upload Cleanup Utility
 * LAYER 2: Delete files older than 30 days
 * LAYER 3: Keep max 1000 files, delete oldest
 */
class UploadCleanup {
  constructor(uploadsDir, logger) {
    this.uploadsDir = uploadsDir;
    this.logger = logger;
    this.maxFiles = 1000;
    this.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
  }

  /**
   * LAYER 2: Delete orphaned files older than 30 days
   * (files that don't exist in any conversation)
   */
  cleanupOldFiles() {
    try {
      if (!fs.existsSync(this.uploadsDir)) return;

      const files = fs.readdirSync(this.uploadsDir);
      const now = Date.now();
      let cleanedCount = 0;

      files.forEach(file => {
        const filePath = path.join(this.uploadsDir, file);
        const stats = fs.statSync(filePath);
        const age = now - stats.mtimeMs;

        // Delete if older than 30 days
        if (age > this.maxAge) {
          try {
            fs.unlinkSync(filePath);
            cleanedCount++;
            this.logger?.info('UploadCleanup', `Deleted old file: ${file}`);
          } catch (e) {
            this.logger?.error('UploadCleanup', `Failed to delete ${file}: ${e.message}`);
          }
        }
      });

      if (cleanedCount > 0) {
        this.logger?.success('UploadCleanup', `Layer 2: Deleted ${cleanedCount} old files (>30 days)`);
      }
    } catch (e) {
      this.logger?.error('UploadCleanup', `Layer 2 cleanup failed: ${e.message}`);
    }
  }

  /**
   * LAYER 3: Enforce max file limit (1000)
   * Delete oldest files if exceeded
   */
  enforceMaxLimit() {
    try {
      if (!fs.existsSync(this.uploadsDir)) return;

      const files = fs.readdirSync(this.uploadsDir);

      if (files.length > this.maxFiles) {
        // Get file stats sorted by mtime (oldest first)
        const sortedFiles = files
          .map(file => ({
            name: file,
            path: path.join(this.uploadsDir, file),
            mtime: fs.statSync(path.join(this.uploadsDir, file)).mtimeMs
          }))
          .sort((a, b) => a.mtime - b.mtime);

        // Delete oldest files until we're under the limit
        const toDelete = sortedFiles.slice(0, files.length - this.maxFiles);
        let deletedCount = 0;

        toDelete.forEach(file => {
          try {
            fs.unlinkSync(file.path);
            deletedCount++;
            this.logger?.info('UploadCleanup', `Deleted excess file: ${file.name}`);
          } catch (e) {
            this.logger?.error('UploadCleanup', `Failed to delete ${file.name}: ${e.message}`);
          }
        });

        this.logger?.success('UploadCleanup', `Layer 3: Deleted ${deletedCount} excess files (limit: ${this.maxFiles})`);
      }
    } catch (e) {
      this.logger?.error('UploadCleanup', `Layer 3 cleanup failed: ${e.message}`);
    }
  }

  /**
   * Run all cleanup layers
   */
  runFullCleanup() {
    this.logger?.info('UploadCleanup', 'Starting 3-layer cleanup...');
    this.cleanupOldFiles(); // Layer 2
    this.enforceMaxLimit(); // Layer 3
    this.logger?.success('UploadCleanup', 'Full cleanup completed');
  }
}

module.exports = UploadCleanup;
