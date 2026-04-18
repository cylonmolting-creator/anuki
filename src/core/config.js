'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// Load .env first — override: true ensures .env wins over inherited parent env vars
// (prevents inherited PORT from parent process overriding .env value)
const envPath = path.join(__dirname, '../../.env');
const examplePath = path.join(__dirname, '../../.env.example');
if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
  fs.copyFileSync(examplePath, envPath);
}
require('dotenv').config({ path: envPath, override: true });

const CONFIG_FILE = path.join(__dirname, '../../config.json');

// Deep merge: source into target (source wins)
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// Env overrides: map process.env → config paths
function applyEnvOverrides(config) {
  const c = JSON.parse(JSON.stringify(config)); // deep clone

  // Port (ANUKI_TEST_PORT overrides everything — used by pre-push-gate.sh)
  if (process.env.ANUKI_TEST_PORT) {
    c.port = parseInt(process.env.ANUKI_TEST_PORT) || c.port;
  } else if (process.env.PORT) {
    c.port = parseInt(process.env.PORT) || c.port;
  }

  // LLM Provider
  if (process.env.LLM_PROVIDER) c.agent.provider = process.env.LLM_PROVIDER;

  // Claude provider
  if (!c.agent.providers) c.agent.providers = {};
  if (!c.agent.providers.claude) c.agent.providers.claude = {};
  if (process.env.CLAUDE_PATH) c.agent.providers.claude.path = process.env.CLAUDE_PATH;
  if (process.env.ANTHROPIC_API_KEY) c.agent.apiKey = process.env.ANTHROPIC_API_KEY;

  // OpenAI provider
  if (!c.agent.providers.openai) c.agent.providers.openai = {};
  if (process.env.OPENAI_API_KEY) c.agent.providers.openai.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_MODEL) c.agent.providers.openai.model = process.env.OPENAI_MODEL;
  if (process.env.OPENAI_BASE_URL) c.agent.providers.openai.baseUrl = process.env.OPENAI_BASE_URL;

  // Ollama provider
  if (!c.agent.providers.ollama) c.agent.providers.ollama = {};
  if (process.env.OLLAMA_URL) c.agent.providers.ollama.url = process.env.OLLAMA_URL;
  if (process.env.OLLAMA_MODEL) c.agent.providers.ollama.model = process.env.OLLAMA_MODEL;

  // Logging
  if (process.env.LOG_LEVEL) c.logging.level = process.env.LOG_LEVEL.toLowerCase();

  // Features
  if (process.env.AGENT_MANAGER_ENABLED !== undefined) c.features.agentManager = process.env.AGENT_MANAGER_ENABLED === 'true';

  // Security — allowed origins
  if (process.env.ALLOWED_ORIGINS) c.security.allowedOrigins = process.env.ALLOWED_ORIGINS.split(',').filter(Boolean);

  return c;
}

// Validate required structure
function validate(config) {
  const errors = [];
  if (!config.port || typeof config.port !== 'number') errors.push('port must be a number');
  if (!config.agent || !config.agent.model) errors.push('agent.model is required');
  if (!config.channels || typeof config.channels !== 'object') errors.push('channels must be an object');
  if (!config.gateway || typeof config.gateway !== 'object') errors.push('gateway must be an object');
  if (!config.logging || !config.logging.level) errors.push('logging.level is required');
  const validLevels = ['debug', 'info', 'warn', 'error'];
  if (config.logging && !validLevels.includes(config.logging.level)) {
    errors.push(`logging.level must be one of: ${validLevels.join(', ')}`);
  }
  return errors;
}

// Load config.json from disk
function loadFromFile() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to parse config.json: ${err.message}`);
  }
}

// Default config
const DEFAULTS = {
  port: 3000,
  gateway: { http: { enabled: true }, websocket: { enabled: true }, health: { enabled: true } },
  agent: {
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
    agentic: true,
    providers: {
      claude: { path: 'claude' },
      openai: { model: 'gpt-4o' },
      ollama: { model: 'llama3.1', url: 'http://localhost:11434' }
    }
  },
  channels: {
    webchat: { enabled: true }
  },
  features: { webhooks: true, agentManager: true },
  timezone: 'UTC',
  memory: { decayRate: 0.05, reflectionHour: 3, decayHour: 4 },
  security: {
    rateLimit: {
      interAgent: { perMinute: 60, perHour: 1000 },
      websocket: { messagesPerMinute: 30, maxClients: 50, maxMessageSize: 65536 }
    }
  },
  logging: { level: 'info', maxSize: '10MB', maxFiles: 5, jsonFormat: true }
};

// Singleton config manager
class ConfigManager extends EventEmitter {
  constructor() {
    super();
    this._config = null;
    this._watcher = null;
    this._reloadTimeout = null;
  }

  load() {
    const fileConfig = loadFromFile();
    const merged = fileConfig ? deepMerge(DEFAULTS, fileConfig) : { ...DEFAULTS };
    this._config = applyEnvOverrides(merged);

    const errors = validate(this._config);
    if (errors.length > 0) {
      throw new Error(`Config validation failed:\n  - ${errors.join('\n  - ')}`);
    }

    return this._config;
  }

  get() {
    if (!this._config) return this.load();
    return this._config;
  }

  getValue(path) {
    return path.split('.').reduce((obj, key) => (obj && obj[key] !== undefined ? obj[key] : undefined), this._config);
  }

  watch() {
    if (this._watcher) return;
    try {
      this._watcher = fs.watch(CONFIG_FILE, (eventType) => {
        if (eventType === 'change') {
          if (this._reloadTimeout) clearTimeout(this._reloadTimeout);
          this._reloadTimeout = setTimeout(() => this._reload(), 500);
        }
      });
      this._watcher.on('error', () => {
        this.unwatch();
      });
    } catch {
      // config.json may not exist
    }
  }

  unwatch() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  _reload() {
    try {
      const oldConfig = this._config;
      this.load();
      this.emit('reload', this._config, oldConfig);
    } catch (err) {
      this.emit('error', err);
    }
  }

  getSanitized() {
    const c = JSON.parse(JSON.stringify(this._config || this.get()));
    const secretKeys = ['token', 'password', 'appPassword', 'accessToken', 'signingSecret', 'appToken', 'apiKey', 'serviceAccount'];
    function scrub(obj) {
      for (const key of Object.keys(obj)) {
        if (secretKeys.includes(key)) {
          obj[key] = '***';
        } else if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
          scrub(obj[key]);
        }
      }
    }
    scrub(c);
    return c;
  }
}

const configManager = new ConfigManager();

function loadConfig(workspace) {
  return configManager.get();
}

module.exports = { configManager, loadConfig };
