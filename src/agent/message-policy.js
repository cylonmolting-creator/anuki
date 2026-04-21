/**
 * MessagePolicy - Inter-Agent Communication Security Policy
 *
 * Enforces:
 * - Allowlist/denylist
 * - Rate limiting
 * - Message size limits
 * - Custom rules
 */
class MessagePolicy {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false, // Default: enabled
      defaultAction: config.defaultAction || 'allow', // 'allow' or 'deny'
      allowlist: config.allowlist || [], // Allowed sender agent IDs
      denylist: config.denylist || [],   // Blocked sender agent IDs
      maxMessageSize: config.maxMessageSize || 50000, // 50KB max
      rateLimit: config.rateLimit || {
        maxPerMinute: 60,
        maxPerHour: 1000
      },
      rules: config.rules || [] // Custom rules: { match: {...}, action: 'allow'/'deny', reason: '...' }
    };

    // Rate limit tracking: agentId → { minute: count, hour: count, lastReset: timestamp }
    this.rateLimitCounters = new Map();

    // Cleanup stale counters every 10 minutes
    this.cleanupInterval = setInterval(() => this._cleanupCounters(), 10 * 60 * 1000);
  }

  /**
   * Check if a message can be sent
   *
   * @param {string} from - Sender agent ID
   * @param {string} to - Receiver agent ID
   * @param {string} message - Message content
   * @returns {Object} { allowed: boolean, reason?: string }
   */
  canSend(from, to, message) {
    // If policy disabled, allow all
    if (!this.config.enabled) {
      return { allowed: true };
    }

    // Check denylist first
    if (this.config.denylist.includes(from)) {
      return { allowed: false, reason: 'Sender in denylist' };
    }

    // Check allowlist (if configured)
    if (this.config.allowlist.length > 0 && !this.config.allowlist.includes(from)) {
      return { allowed: false, reason: 'Sender not in allowlist' };
    }

    // Check rate limit
    if (this._isRateLimited(from)) {
      return { allowed: false, reason: 'Rate limit exceeded' };
    }

    // Check message size
    if (message.length > this.config.maxMessageSize) {
      return { allowed: false, reason: `Message too large (max ${this.config.maxMessageSize} chars)` };
    }

    // Check custom rules
    for (const rule of this.config.rules) {
      if (this._matchRule(rule, { from, to, message })) {
        return {
          allowed: rule.action === 'allow',
          reason: rule.reason || `Matched rule: ${rule.action}`
        };
      }
    }

    // Default action
    return {
      allowed: this.config.defaultAction === 'allow',
      reason: this.config.defaultAction === 'deny' ? 'Default deny policy' : null
    };
  }

  /**
   * Check if sender is rate limited
   * @private
   */
  _isRateLimited(agentId) {
    const now = Date.now();
    const counter = this.rateLimitCounters.get(agentId) || {
      minute: 0,
      hour: 0,
      lastReset: now
    };

    // Reset counters if 1 hour has passed
    if (now - counter.lastReset > 60 * 60 * 1000) {
      counter.minute = 0;
      counter.hour = 0;
      counter.lastReset = now;
    }
    // Reset minute counter if 1 minute has passed
    else if (now - counter.lastReset > 60 * 1000) {
      counter.minute = 0;
      counter.lastReset = now;
    }

    // Check limits
    if (counter.minute >= this.config.rateLimit.maxPerMinute) {
      return true;
    }
    if (counter.hour >= this.config.rateLimit.maxPerHour) {
      return true;
    }

    // Increment counters
    counter.minute++;
    counter.hour++;
    this.rateLimitCounters.set(agentId, counter);

    return false;
  }

  /**
   * Match a custom rule
   * @private
   */
  _matchRule(rule, context) {
    const { match } = rule;
    const { from, to, message } = context;

    // Match by sender
    if (match.from && match.from !== from) {
      return false;
    }

    // Match by receiver
    if (match.to && match.to !== to) {
      return false;
    }

    // Match by message pattern (regex)
    if (match.messagePattern) {
      try {
        const pattern = new RegExp(match.messagePattern, 'i');
        if (!pattern.test(message)) {
          return false;
        }
      } catch {
        return false; // Invalid regex pattern — treat as no match
      }
    }

    return true;
  }

  /**
   * Cleanup stale rate limit counters
   * @private
   */
  _cleanupCounters() {
    const now = Date.now();
    const staleThreshold = 2 * 60 * 60 * 1000; // 2 hours

    for (const [agentId, counter] of this.rateLimitCounters) {
      if (now - counter.lastReset > staleThreshold) {
        this.rateLimitCounters.delete(agentId);
      }
    }
  }

  /**
   * Shutdown: clear intervals
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.rateLimitCounters.clear();
  }
}

module.exports = MessagePolicy;
