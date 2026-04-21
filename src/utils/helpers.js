/**
 * Shared utility functions — single source of truth.
 *
 * Consolidates duplicate implementations of sanitizeForLog and tryParseJSON
 * that were previously copy-pasted across multiple agent modules.
 */

/**
 * Sanitize untrusted input for safe log output.
 * Strips control characters (preventing log injection) and truncates.
 *
 * @param {*} input - Value to sanitize
 * @param {number} [maxLen=200] - Maximum output length
 * @returns {string}
 */
function sanitizeForLog(input, maxLen = 200) {
  if (typeof input !== 'string') return String(input);
  const sanitized = input.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return sanitized.length > maxLen ? sanitized.substring(0, maxLen) + '...' : sanitized;
}

/**
 * Attempt to parse a JSON string, returning fallback on failure.
 *
 * @param {string} str - JSON string to parse
 * @param {*} [fallback={}] - Value returned on parse failure
 * @returns {*}
 */
function tryParseJSON(str, fallback = {}) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = { sanitizeForLog, tryParseJSON };
