'use strict';

/**
 * Atomic file write utility — crash-safe writes via temp + rename.
 *
 * Pattern: write to temp file → fsync → rename to target
 * rename() is atomic on POSIX — file is either old or new, never corrupt.
 *
 * Used for: active-jobs.json, children.json, checkpoints, sessions, etc.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Atomically write data to a file.
 * @param {string} filePath - Target file path
 * @param {string|Buffer} data - Data to write
 * @param {object} [options] - Options
 * @param {string} [options.encoding='utf8'] - File encoding
 * @param {number} [options.mode=0o644] - File permissions
 */
function atomicWriteFileSync(filePath, data, options = {}) {
  const { encoding = 'utf8', mode = 0o644 } = options;
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Generate unique temp file name in same directory (required for atomic rename)
  const tmpName = `.${path.basename(filePath)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  try {
    // Write to temp file
    const fd = fs.openSync(tmpPath, 'w', mode);
    try {
      fs.writeSync(fd, data, 0, encoding);
      fs.fsyncSync(fd); // Force flush to disk
    } finally {
      fs.closeSync(fd);
    }

    // Atomic rename (POSIX guarantees this is atomic)
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    throw err;
  }
}

/**
 * Atomically write JSON data to a file.
 * @param {string} filePath - Target file path
 * @param {*} data - Data to serialize
 * @param {number} [indent=2] - JSON indentation
 */
function atomicWriteJsonSync(filePath, data, indent = 2) {
  const json = JSON.stringify(data, null, indent) + '\n';
  atomicWriteFileSync(filePath, json);
}

module.exports = { atomicWriteFileSync, atomicWriteJsonSync };
