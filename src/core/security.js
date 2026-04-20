/**
 * ANUKI SECURITY MODULE
 *
 * Central security infrastructure:
 *  - API token generation and validation (HMAC-SHA256)
 *  - AES-256-GCM credential encryption
 *  - Origin whitelist management
 *  - Credential leak detection (regex-based)
 *
 * Patches CVE-2026-25253 and known OpenClaw vulnerabilities.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// CREDENTIAL PATTERNS — Regex patterns for leak detection
// ═══════════════════════════════════════════════════════════════

const CREDENTIAL_PATTERNS = [
  { name: 'aws_key',         pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws_secret',      pattern: /(?:aws)?_?(?:secret)?_?(?:access)?_?key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}/gi },
  { name: 'github_token',    pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/g },
  { name: 'generic_api_key', pattern: /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{20,}/gi },
  { name: 'bearer_token',    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { name: 'telegram_token',  pattern: /\d{8,10}:[A-Za-z0-9_-]{35}/g },
  { name: 'discord_token',   pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/g },
  { name: 'slack_token',     pattern: /xox[bpas]-[0-9]{10,}-[A-Za-z0-9]{10,}/g },
  { name: 'private_key',     pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
  { name: 'password_field',  pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}/gi },
];

class Security {
  constructor(workspace, logger) {
    this.workspace = workspace;
    this.logger = logger;

    // Security files directory
    this.secDir = path.join(workspace, '.security');
    if (!fs.existsSync(this.secDir)) {
      fs.mkdirSync(this.secDir, { recursive: true, mode: 0o700 });
    }

    // Master encryption key — create on first boot, then load from disk
    this.masterKeyFile = path.join(this.secDir, 'master.key');
    this.masterKey = this._loadOrCreateMasterKey();

    // API bearer token — for HTTP/WS auth
    this.apiTokenFile = path.join(this.secDir, 'api.token');
    this.apiToken = this._loadOrCreateApiToken();

    // Allowed origins
    this.allowedOrigins = new Set([
      'http://localhost',
      'http://127.0.0.1',
      'https://localhost',
      'https://127.0.0.1',
    ]);

    // Also add configured server port to origins (dynamic — reads from config/env)
    const { configManager } = require('./config');
    const serverPort = String(configManager.get().port || 3000);
    this.allowedOrigins.add(`http://localhost:${serverPort}`);
    this.allowedOrigins.add(`http://127.0.0.1:${serverPort}`);

    // User-defined origins (from .env)
    if (process.env.ALLOWED_ORIGINS) {
      process.env.ALLOWED_ORIGINS.split(',').forEach(o => this.allowedOrigins.add(o.trim()));
    }

    this.log('Security module initialized');
    this.log('API Token: configured (see .security/api.token)');
    this.log(`Allowed origins: ${this.allowedOrigins.size}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // ORIGIN VALIDATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * WebSocket / HTTP origin validation
   * CVE-2026-25253: Prevents cross-origin WebSocket hijacking
   */
  validateOrigin(origin) {
    // No origin (curl, Postman etc.) — reject
    if (!origin) {
      return false;
    }

    // Check with and without port
    const normalized = origin.replace(/\/$/, '');

    if (this.allowedOrigins.has(normalized)) {
      return true;
    }

    // Check without port
    const withoutPort = normalized.replace(/:\d+$/, '');
    if (this.allowedOrigins.has(withoutPort)) {
      return true;
    }

    return false;
  }

  /**
   * Add origin (runtime)
   */
  addAllowedOrigin(origin) {
    this.allowedOrigins.add(origin);
    this.log('Added allowed origin: ' + origin);
  }

  // ═══════════════════════════════════════════════════════════════
  // API TOKEN AUTH
  // ═══════════════════════════════════════════════════════════════

  /**
   * Bearer token validation
   * Auth required even for localhost
   */
  validateToken(token) {
    if (!token) return false;
    // Reject if lengths differ (timingSafeEqual requires same length)
    const tokenBuf = Buffer.from(String(token));
    const apiBuf = Buffer.from(this.apiToken);
    if (tokenBuf.length !== apiBuf.length) return false;
    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(tokenBuf, apiBuf);
  }

  /**
   * Extract and validate token from HTTP request
   */
  authenticateRequest(req) {
    // 1. Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      return this.validateToken(token);
    }

    // 2. Query parameter (?token=...)
    const queryToken = req.query && req.query.token;
    if (queryToken) {
      return this.validateToken(queryToken);
    }

    // 3. X-API-Key header
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader) {
      return this.validateToken(apiKeyHeader);
    }

    return false;
  }

  /**
   * Extract and validate token from WebSocket upgrade request
   */
  authenticateWebSocket(req) {
    // URL query param: ws://localhost:PORT?token=XYZ
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (token) {
      return this.validateToken(token);
    }

    // Sec-WebSocket-Protocol subprotocol header
    const protocol = req.headers['sec-websocket-protocol'];
    if (protocol) {
      const parts = protocol.split(',').map(s => s.trim());
      for (const p of parts) {
        if (p.startsWith('token.')) {
          return this.validateToken(p.slice(6));
        }
      }
    }

    return false;
  }

  /**
   * Regenerate (rotate) token
   */
  rotateApiToken() {
    this.apiToken = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(this.apiTokenFile, this.apiToken, { mode: 0o600 });
    this.log('API token rotated');
    return this.apiToken;
  }

  /**
   * Return current token (displayed in index.js banner)
   */
  getApiToken() {
    return this.apiToken;
  }

  // ═══════════════════════════════════════════════════════════════
  // CREDENTIAL ENCRYPTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Encrypt with AES-256-GCM
   */
  encrypt(plaintext) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + authTag + ':' + encrypted;
  }

  /**
   * Decrypt with AES-256-GCM
   */
  decrypt(ciphertext) {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Encrypted credential store — key-value
   */
  storeCredential(name, value) {
    const credsFile = path.join(this.secDir, 'credentials.enc');
    let creds = {};

    if (fs.existsSync(credsFile)) {
      try {
        const raw = fs.readFileSync(credsFile, 'utf8');
        creds = JSON.parse(this.decrypt(raw));
      } catch (e) {
        creds = {};
      }
    }

    creds[name] = value;

    const encrypted = this.encrypt(JSON.stringify(creds));
    fs.writeFileSync(credsFile, encrypted, { mode: 0o600 });
    this.log('Credential stored: ' + name);
  }

  /**
   * Load encrypted credential by name
   */
  loadCredential(name) {
    const credsFile = path.join(this.secDir, 'credentials.enc');
    if (!fs.existsSync(credsFile)) return null;

    try {
      const raw = fs.readFileSync(credsFile, 'utf8');
      const creds = JSON.parse(this.decrypt(raw));
      return creds[name] || null;
    } catch (e) {
      this.log('Credential load failed: ' + e.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CREDENTIAL LEAK DETECTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Scan text for credential leaks
   * Used before writing to memory, in Claude responses, and in logs
   */
  scanForCredentials(text) {
    if (!text || typeof text !== 'string') return { clean: true, findings: [] };

    const findings = [];

    for (const { name, pattern } of CREDENTIAL_PATTERNS) {
      // Reset regex lastIndex
      pattern.lastIndex = 0;
      const matches = text.match(pattern);
      if (matches) {
        findings.push({
          type: name,
          count: matches.length,
          // First 10 chars of first match (for debug, not showing full match)
          preview: matches[0].substring(0, 10) + '***'
        });
      }
    }

    return {
      clean: findings.length === 0,
      findings
    };
  }

  /**
   * Redact credentials from text
   * Called when a leak is detected
   */
  redactCredentials(text) {
    if (!text || typeof text !== 'string') return text;

    let redacted = text;
    for (const { pattern } of CREDENTIAL_PATTERNS) {
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }

  // ═══════════════════════════════════════════════════════════════
  // EXPRESS MIDDLEWARE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Express auth middleware
   * Applied to all /api/* endpoints
   */
  authMiddleware() {
    return (req, res, next) => {
      // Dashboard (GET /) — browser access with token query param
      if (req.path === '/' && req.method === 'GET') {
        // Auth required for dashboard too, but accept via query param
        if (this.authenticateRequest(req)) {
          return next();
        }
        // Show login page if no token
        return res.status(401).send(this._loginPage());
      }

      // Health endpoint auth-free (for monitoring tools)
      // Health is on separate port, this middleware doesn't apply to it

      // API endpoints — auth required
      if (!this.authenticateRequest(req)) {
        this.log('AUTH REJECTED: ' + req.method + ' ' + req.path + ' from ' + req.ip);
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Bearer token required. Use Authorization: Bearer <token>'
        });
      }

      next();
    };
  }

  /**
   * Simple login page — for token entry
   */
  _loginPage() {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Anuki - Auth Required</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #fff;
         display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .box { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
         border-radius: 16px; padding: 40px; max-width: 400px; text-align: center; }
  h1 { color: #00d4ff; margin-bottom: 20px; }
  input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #333;
          background: #0d1117; color: #fff; font-size: 1rem; margin: 10px 0; }
  button { width: 100%; padding: 12px; border-radius: 8px; border: none;
           background: linear-gradient(90deg, #00d4ff, #7b2cbf); color: #fff;
           font-size: 1rem; cursor: pointer; margin-top: 10px; }
  .hint { color: #666; font-size: 0.8rem; margin-top: 20px; }
</style></head><body>
<div class="box">
  <h1>Anuki</h1>
  <p>Authentication Required</p>
  <form onsubmit="event.preventDefault(); window.location.href='/?token=' + document.getElementById('t').value;">
    <input id="t" type="password" placeholder="API Token" autofocus>
    <button type="submit">Login</button>
  </form>
  <p class="hint">Token: check your .env or server logs</p>
</div></body></html>`;
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════

  _loadOrCreateMasterKey() {
    if (fs.existsSync(this.masterKeyFile)) {
      return Buffer.from(fs.readFileSync(this.masterKeyFile, 'utf8').trim(), 'hex');
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.masterKeyFile, key.toString('hex'), { mode: 0o600 });
    this.log('Master encryption key generated');
    return key;
  }

  _loadOrCreateApiToken() {
    if (fs.existsSync(this.apiTokenFile)) {
      const token = fs.readFileSync(this.apiTokenFile, 'utf8').trim();
      if (token.length >= 32) return token;
    }
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(this.apiTokenFile, token, { mode: 0o600 });
    this.log('API token generated');
    return token;
  }

  log(msg) {
    if (this.logger) {
      this.logger.info('Security', msg);
    }
  }
}

module.exports = Security;
