/**
 * WebhookManager — Webhook system with retry, logging, signature verification, rate limiting
 * Roadmap 6.3: Webhook system hardening
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class WebhookManager {
  constructor(baseDir, logger) {
    this.baseDir = baseDir;
    this.logger = logger;
    this.hooksFile = path.join(baseDir, 'data', 'webhooks.json');
    this.logsFile = path.join(baseDir, 'data', 'webhook-logs.jsonl');
    this.hooks = {};

    // Rate limiting: per source IP
    this.rateLimits = new Map(); // ip -> { count, resetAt }
    this.rateLimitWindow = 60000; // 1 minute
    this.rateLimitMax = 30; // max deliveries per IP per minute

    // Retry config
    this.maxRetries = 3;
    this.retryDelays = [1000, 5000, 15000]; // exponential-ish backoff

    // Log rotation
    this.maxLogLines = 5000;

    this._load();

    // Cleanup rate limits every minute
    this._cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [ip, rl] of this.rateLimits) {
        if (now > rl.resetAt) this.rateLimits.delete(ip);
      }
    }, 60000);
  }

  // --- CRUD ---

  create(id, options = {}) {
    if (this.hooks[id]) return this.hooks[id];
    const secret = crypto.randomBytes(32).toString('hex');
    this.hooks[id] = {
      id,
      description: options.description || '',
      secret,
      forwardUrl: options.forwardUrl || null, // optional: forward payloads to this URL
      createdAt: new Date().toISOString(),
      active: true,
      deliveryCount: 0,
      lastDelivery: null
    };
    this._save();
    this.logger.info('Webhook', `Created: ${id}`);
    return this.hooks[id];
  }

  delete(id) {
    if (!this.hooks[id]) return false;
    delete this.hooks[id];
    this._save();
    this.logger.info('Webhook', `Deleted: ${id}`);
    return true;
  }

  list() {
    return Object.values(this.hooks).map(h => ({
      id: h.id,
      description: h.description,
      active: h.active,
      createdAt: h.createdAt,
      deliveryCount: h.deliveryCount,
      lastDelivery: h.lastDelivery,
      hasForwardUrl: !!h.forwardUrl
    }));
  }

  get(id) {
    return this.hooks[id] || null;
  }

  // --- Signature Verification ---

  verifySignature(hookId, payload, signature) {
    const hook = this.hooks[hookId];
    if (!hook) return false;
    if (!signature) return false;

    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const expected = 'sha256=' + crypto
      .createHmac('sha256', hook.secret)
      .update(payloadStr)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      );
    } catch {
      return false;
    }
  }

  // --- Rate Limiting ---

  isRateLimited(ip) {
    const now = Date.now();
    let entry = this.rateLimits.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + this.rateLimitWindow };
      this.rateLimits.set(ip, entry);
    }

    entry.count++;
    return entry.count > this.rateLimitMax;
  }

  // --- Delivery & Retry ---

  async receive(hookId, payload, metadata = {}) {
    const hook = this.hooks[hookId];
    if (!hook) return { ok: false, error: 'Webhook not found' };
    if (!hook.active) return { ok: false, error: 'Webhook inactive' };

    hook.deliveryCount++;
    hook.lastDelivery = new Date().toISOString();
    this._save();

    const logEntry = {
      hookId,
      timestamp: new Date().toISOString(),
      payload: this._truncatePayload(payload),
      sourceIp: metadata.ip || 'unknown',
      signatureValid: metadata.signatureValid !== undefined ? metadata.signatureValid : null,
      status: 'received',
      forwardResult: null
    };

    // Forward to subscriber URL if configured
    if (hook.forwardUrl) {
      logEntry.forwardResult = await this._forwardWithRetry(hook, payload);
      logEntry.status = logEntry.forwardResult.success ? 'delivered' : 'failed';
    }

    this._appendLog(logEntry);
    return { ok: true, id: hookId, status: logEntry.status };
  }

  async _forwardWithRetry(hook, payload) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const payloadStr = JSON.stringify(payload);
        const signature = 'sha256=' + crypto
          .createHmac('sha256', hook.secret)
          .update(payloadStr)
          .digest('hex');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(hook.forwardUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': signature,
            'X-Webhook-Id': hook.id,
            'X-Webhook-Delivery': crypto.randomUUID()
          },
          body: payloadStr,
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.ok) {
          return { success: true, statusCode: response.status, attempts: attempt + 1 };
        }

        // Non-retryable status codes
        if (response.status >= 400 && response.status < 500) {
          return { success: false, statusCode: response.status, attempts: attempt + 1, error: `HTTP ${response.status}` };
        }

        // Server error — retry
        if (attempt < this.maxRetries) {
          await new Promise(r => setTimeout(r, this.retryDelays[attempt]));
        }
      } catch (err) {
        if (attempt >= this.maxRetries) {
          return { success: false, attempts: attempt + 1, error: err.message };
        }
        await new Promise(r => setTimeout(r, this.retryDelays[attempt]));
      }
    }

    return { success: false, attempts: this.maxRetries + 1, error: 'Max retries exceeded' };
  }

  // --- Delivery Logs ---

  getLogs(hookId = null, limit = 50) {
    try {
      if (!fs.existsSync(this.logsFile)) return [];
      const content = fs.readFileSync(this.logsFile, 'utf-8').trim();
      if (!content) return [];

      let lines = content.split('\n');
      const logs = [];
      // Read from end for most recent
      for (let i = lines.length - 1; i >= 0 && logs.length < limit; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (!hookId || entry.hookId === hookId) {
            logs.push(entry);
          }
        } catch { /* skip malformed lines */ }
      }
      return logs;
    } catch {
      return [];
    }
  }

  _appendLog(entry) {
    try {
      const dir = path.dirname(this.logsFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.logsFile, JSON.stringify(entry) + '\n');
      this._rotateLogsIfNeeded();
    } catch (err) {
      this.logger.error('Webhook', `Log write failed: ${err.message}`);
    }
  }

  _rotateLogsIfNeeded() {
    try {
      const stat = fs.statSync(this.logsFile);
      if (stat.size > 5 * 1024 * 1024) { // 5MB
        const content = fs.readFileSync(this.logsFile, 'utf-8');
        const lines = content.trim().split('\n');
        // Keep last half
        const kept = lines.slice(Math.floor(lines.length / 2));
        fs.writeFileSync(this.logsFile, kept.join('\n') + '\n');
        this.logger.info('Webhook', `Log rotated: ${lines.length} → ${kept.length} entries`);
      }
    } catch { /* ignore rotation errors */ }
  }

  // --- Persistence ---

  _load() {
    try {
      if (fs.existsSync(this.hooksFile)) {
        this.hooks = JSON.parse(fs.readFileSync(this.hooksFile, 'utf-8'));
      }
    } catch (err) {
      this.logger.error('Webhook', `Failed to load hooks: ${err.message}`);
      this.hooks = {};
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.hooksFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.hooksFile, JSON.stringify(this.hooks, null, 2));
    } catch (err) {
      this.logger.error('Webhook', `Failed to save hooks: ${err.message}`);
    }
  }

  _truncatePayload(payload) {
    const str = JSON.stringify(payload);
    if (str.length > 2048) {
      return JSON.parse(str.substring(0, 2048) + '..."}}');
    }
    return payload;
  }

  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }
}

module.exports = WebhookManager;
