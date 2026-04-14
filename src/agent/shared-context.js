const fs = require('fs');
const path = require('path');

/**
 * SharedContext — Shared Memory Namespace for Multi-Agent Collaboration
 *
 * Roadmap 5.5: Agents on the same task share key facts (not full conversation)
 * via a shared memory namespace.
 *
 * Design:
 * - Each namespace = one collaborative task (e.g., a TaskPlanner plan)
 * - Agents write key facts (key-value pairs) into the namespace
 * - Other agents on the same task can read those facts
 * - Namespaces auto-expire after maxAge (default 1 hour)
 * - Persisted to disk for crash recovery
 *
 * Usage:
 * - TaskPlanner creates a namespace when a plan starts
 * - Each subtask receives the namespace ID
 * - Agents write results/facts via set()
 * - Sequential subtasks read earlier results via getAll()
 * - Tool tag: [SHARED_CONTEXT:namespace:key:value]
 */
class SharedContext {
  constructor(options = {}) {
    this.logger = options.logger;
    this.maxAge = options.maxAge || 60 * 60 * 1000; // 1 hour default
    this.maxNamespaces = options.maxNamespaces || 100;
    this.maxFactsPerNamespace = options.maxFactsPerNamespace || 50;
    this.maxValueLength = options.maxValueLength || 10000; // 10KB per value

    // In-memory store: namespaceId → { meta, facts }
    this.namespaces = new Map();

    // Persistence
    const baseDir = options.baseDir || require('../utils/base-dir');
    this.persistDir = path.join(baseDir, 'data', 'shared-contexts');
    if (!fs.existsSync(this.persistDir)) {
      fs.mkdirSync(this.persistDir, { recursive: true });
    }

    // Load persisted namespaces on startup
    this._loadFromDisk();

    // Cleanup interval: every 5 minutes, remove expired namespaces
    this._cleanupInterval = setInterval(() => this._cleanupExpired(), 5 * 60 * 1000);

    this._log('SharedContext initialized', `${this.namespaces.size} namespaces loaded`);
  }

  /**
   * Create a new shared context namespace.
   *
   * @param {Object} options
   * @param {string} [options.namespaceId] - Custom ID (auto-generated if omitted)
   * @param {string} options.taskDescription - What this namespace is for
   * @param {string} [options.createdBy='master'] - Agent that created it
   * @param {string[]} [options.participants=[]] - Agent IDs that can access
   * @returns {Object} { namespaceId, createdAt }
   */
  create(options = {}) {
    const namespaceId = options.namespaceId || this._generateId();
    const now = new Date().toISOString();

    if (this.namespaces.has(namespaceId)) {
      return { namespaceId, createdAt: this.namespaces.get(namespaceId).meta.createdAt, existing: true };
    }

    // Evict oldest if at capacity
    if (this.namespaces.size >= this.maxNamespaces) {
      this._evictOldest();
    }

    const namespace = {
      meta: {
        namespaceId,
        taskDescription: (options.taskDescription || '').substring(0, 500),
        createdBy: options.createdBy || 'master',
        participants: options.participants || [],
        createdAt: now,
        updatedAt: now,
        factCount: 0
      },
      facts: new Map() // key → { value, setBy, setAt, updatedAt }
    };

    this.namespaces.set(namespaceId, namespace);
    this._persist(namespaceId);
    this._log('Namespace created', `${namespaceId.substring(0, 12)} — "${(options.taskDescription || '').substring(0, 60)}"`);

    return { namespaceId, createdAt: now };
  }

  /**
   * Set a fact in a namespace.
   *
   * @param {string} namespaceId
   * @param {string} key - Fact key (max 100 chars)
   * @param {string} value - Fact value (max maxValueLength chars)
   * @param {string} [agentId='unknown'] - Agent writing the fact
   * @returns {Object} { success, key, isNew }
   */
  set(namespaceId, key, value, agentId = 'unknown') {
    const namespace = this.namespaces.get(namespaceId);
    if (!namespace) {
      return { success: false, error: `Namespace not found: ${namespaceId}` };
    }

    // Validate key
    const cleanKey = String(key).substring(0, 100).trim();
    if (!cleanKey) {
      return { success: false, error: 'Empty key' };
    }

    // Validate value
    const cleanValue = String(value).substring(0, this.maxValueLength);

    // Check facts limit
    if (!namespace.facts.has(cleanKey) && namespace.facts.size >= this.maxFactsPerNamespace) {
      return { success: false, error: `Namespace fact limit reached (${this.maxFactsPerNamespace})` };
    }

    const now = new Date().toISOString();
    const isNew = !namespace.facts.has(cleanKey);

    namespace.facts.set(cleanKey, {
      value: cleanValue,
      setBy: agentId,
      setAt: isNew ? now : namespace.facts.get(cleanKey).setAt,
      updatedAt: now
    });

    namespace.meta.updatedAt = now;
    namespace.meta.factCount = namespace.facts.size;

    this._persist(namespaceId);
    this._log('Fact set', `${namespaceId.substring(0, 12)}/${cleanKey} by ${agentId} (${cleanValue.length} chars)`);

    return { success: true, key: cleanKey, isNew };
  }

  /**
   * Get a specific fact from a namespace.
   *
   * @param {string} namespaceId
   * @param {string} key
   * @returns {Object|null} { value, setBy, setAt, updatedAt } or null
   */
  get(namespaceId, key) {
    const namespace = this.namespaces.get(namespaceId);
    if (!namespace) return null;

    const fact = namespace.facts.get(key);
    return fact ? { ...fact } : null;
  }

  /**
   * Get all facts from a namespace.
   *
   * @param {string} namespaceId
   * @returns {Object} { meta, facts: { key: { value, setBy, setAt } } } or null
   */
  getAll(namespaceId) {
    const namespace = this.namespaces.get(namespaceId);
    if (!namespace) return null;

    const facts = {};
    for (const [key, fact] of namespace.facts) {
      facts[key] = { ...fact };
    }

    return {
      meta: { ...namespace.meta },
      facts
    };
  }

  /**
   * Get a summary of all facts suitable for injecting into agent context.
   * Returns a compact text representation.
   *
   * @param {string} namespaceId
   * @returns {string|null} Compact fact summary or null
   */
  getSummary(namespaceId) {
    const namespace = this.namespaces.get(namespaceId);
    if (!namespace || namespace.facts.size === 0) return null;

    const lines = [`[Shared Context: ${namespace.meta.taskDescription || namespaceId}]`];
    for (const [key, fact] of namespace.facts) {
      // Truncate long values for context injection
      const shortValue = fact.value.length > 200 ? fact.value.substring(0, 200) + '...' : fact.value;
      lines.push(`- ${key}: ${shortValue} (by ${fact.setBy})`);
    }

    return lines.join('\n');
  }

  /**
   * Delete a specific fact from a namespace.
   *
   * @param {string} namespaceId
   * @param {string} key
   * @returns {boolean}
   */
  deleteFact(namespaceId, key) {
    const namespace = this.namespaces.get(namespaceId);
    if (!namespace) return false;

    const deleted = namespace.facts.delete(key);
    if (deleted) {
      namespace.meta.factCount = namespace.facts.size;
      namespace.meta.updatedAt = new Date().toISOString();
      this._persist(namespaceId);
    }
    return deleted;
  }

  /**
   * Delete an entire namespace.
   *
   * @param {string} namespaceId
   * @returns {boolean}
   */
  deleteNamespace(namespaceId) {
    const existed = this.namespaces.delete(namespaceId);
    if (existed) {
      // Remove persisted file
      const filePath = path.join(this.persistDir, namespaceId + '.json');
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) { /* non-fatal */ }
      this._log('Namespace deleted', namespaceId.substring(0, 12));
    }
    return existed;
  }

  /**
   * List all active namespaces (metadata only).
   *
   * @returns {Array<Object>}
   */
  listNamespaces() {
    return Array.from(this.namespaces.values()).map(ns => ({ ...ns.meta }));
  }

  /**
   * Get statistics.
   */
  getStats() {
    let totalFacts = 0;
    for (const ns of this.namespaces.values()) {
      totalFacts += ns.facts.size;
    }

    return {
      namespaces: this.namespaces.size,
      totalFacts,
      maxNamespaces: this.maxNamespaces,
      maxFactsPerNamespace: this.maxFactsPerNamespace,
      maxAge: this.maxAge
    };
  }

  /**
   * Extract a key fact from an agent's reply text.
   * Heuristic: takes first 1-2 meaningful sentences as a summary.
   *
   * @param {string} reply - Full agent reply
   * @param {number} [maxLength=300] - Maximum extracted length
   * @returns {string} Extracted fact (empty string if reply is empty)
   */
  extractKeyFact(reply, maxLength = 300) {
    if (!reply || reply.trim().length === 0) return '';

    const text = reply.trim();

    // Split by sentence-ending punctuation or newlines
    const sentences = text.split(/(?<=[.!?\n])\s+/).filter(s => s.trim().length > 10);

    if (sentences.length === 0) {
      return text.substring(0, maxLength);
    }

    // Take first 1-2 sentences that fit within maxLength
    let result = sentences[0].trim();
    if (sentences.length > 1 && (result.length + sentences[1].trim().length + 1) <= maxLength) {
      result += ' ' + sentences[1].trim();
    }

    return result.substring(0, maxLength);
  }

  /**
   * Shutdown — cleanup interval and persist all.
   */
  shutdown() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    // Final persist
    for (const namespaceId of this.namespaces.keys()) {
      this._persist(namespaceId);
    }
    this._log('SharedContext shutdown');
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════

  _generateId() {
    return 'sc_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
  }

  _persist(namespaceId) {
    const namespace = this.namespaces.get(namespaceId);
    if (!namespace) return;

    const filePath = path.join(this.persistDir, namespaceId + '.json');
    try {
      const data = {
        meta: namespace.meta,
        facts: Object.fromEntries(namespace.facts)
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      this._log('Persist failed', `${namespaceId}: ${e.message}`);
    }
  }

  _loadFromDisk() {
    try {
      const files = fs.readdirSync(this.persistDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const filePath = path.join(this.persistDir, file);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

          // Check expiration
          const age = Date.now() - new Date(data.meta.createdAt).getTime();
          if (age > this.maxAge) {
            fs.unlinkSync(filePath);
            continue;
          }

          const namespace = {
            meta: data.meta,
            facts: new Map(Object.entries(data.facts || {}))
          };
          this.namespaces.set(data.meta.namespaceId, namespace);
        } catch (e) {
          // Corrupt file — skip
        }
      }
    } catch (e) {
      // Directory doesn't exist or can't be read — that's fine
    }
  }

  _cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;

    for (const [namespaceId, namespace] of this.namespaces) {
      const age = now - new Date(namespace.meta.createdAt).getTime();
      if (age > this.maxAge) {
        this.deleteNamespace(namespaceId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this._log('Cleanup', `${cleaned} expired namespaces removed`);
    }
  }

  _evictOldest() {
    let oldestId = null;
    let oldestTime = Infinity;

    for (const [id, ns] of this.namespaces) {
      const time = new Date(ns.meta.updatedAt).getTime();
      if (time < oldestTime) {
        oldestTime = time;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.deleteNamespace(oldestId);
      this._log('Evicted oldest namespace', oldestId.substring(0, 12));
    }
  }

  _log(label, detail) {
    if (this.logger) {
      this.logger.info('SharedContext', label + (detail ? ' | ' + detail : ''));
    }
  }
}

module.exports = SharedContext;
