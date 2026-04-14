/**
 * Enhanced Agent Performance Stats (FAZ 3A)
 *
 * Extends original AgentStats with:
 * - 7d/30d rolling windows (not just 24h)
 * - Persistent long-term storage (data/agent-stats-history.json)
 * - Trend calculation (improving/declining/stable)
 * - Workflow compliance scoring
 * - Confidence score tracking
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(require('./utils/base-dir'), 'data');
const STATS_FILE = path.join(DATA_DIR, 'agent-stats.json');
const HISTORY_FILE = path.join(DATA_DIR, 'agent-stats-history.json');
const SAVE_INTERVAL_MS = 300000; // 5 minutes
const MAX_ENTRIES_PER_AGENT = 1000;

// Rolling window constants
const WINDOW_24H = 86400000;
const WINDOW_7D = 604800000;
const WINDOW_30D = 2592000000;

class AgentStatsEnhanced {
  constructor(logger) {
    this.logger = logger;
    this.entries = new Map();
    this.history = new Map(); // Long-term history (30d)
    this._loadFromDisk();
    this._loadHistory();
    this._saveTimer = setInterval(() => {
      this._saveToDisk();
      this._saveHistory();
    }, SAVE_INTERVAL_MS);
  }

  /**
   * Record a completed execution with enhanced data
   */
  record(workspaceId, data) {
    if (!workspaceId) return;

    const entry = {
      timestamp: Date.now(),
      model: data.model || 'unknown',
      cost: data.cost || 0,
      duration: data.duration || 0,
      success: data.success !== false,
      turns: data.turns || 0,
      responseLength: data.responseLength || 0,
      channel: data.channel || 'unknown',
      confidence: data.confidence || null,
      taskType: data.taskType || null,
      inputTokens: data.inputTokens || 0,
      outputTokens: data.outputTokens || 0
    };

    // Add to current entries (24h rolling)
    if (!this.entries.has(workspaceId)) {
      this.entries.set(workspaceId, []);
    }
    const arr = this.entries.get(workspaceId);
    arr.push(entry);
    if (arr.length > MAX_ENTRIES_PER_AGENT) {
      arr.splice(0, arr.length - MAX_ENTRIES_PER_AGENT);
    }

    // Add to long-term history (30d)
    if (!this.history.has(workspaceId)) {
      this.history.set(workspaceId, []);
    }
    const hist = this.history.get(workspaceId);
    hist.push(entry);
    // Cap history at 5000 entries per agent
    if (hist.length > 5000) {
      hist.splice(0, hist.length - 5000);
    }
  }

  /**
   * Get stats with time window filter
   * @param {string} workspaceId
   * @param {string} window - '24h' | '7d' | '30d'
   */
  getStats(workspaceId, window = '24h') {
    const now = Date.now();
    const windowMs = window === '30d' ? WINDOW_30D : window === '7d' ? WINDOW_7D : WINDOW_24H;

    // Use history for 7d/30d, current entries for 24h
    const source = window === '24h'
      ? (this.entries.get(workspaceId) || [])
      : (this.history.get(workspaceId) || []);

    const entries = source.filter(e => (now - e.timestamp) < windowMs);

    if (entries.length === 0) {
      return this._emptyStats(workspaceId, window);
    }

    const successful = entries.filter(e => e.success);
    const durations = entries.filter(e => e.duration > 0).map(e => e.duration).sort((a, b) => a - b);

    // P95
    const p95Index = Math.ceil(durations.length * 0.95) - 1;
    const p95 = durations.length > 0 ? durations[Math.max(0, p95Index)] : 0;
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
      : 0;

    // Cost
    const totalCost = entries.reduce((s, e) => s + (e.cost || 0), 0);

    // Tokens
    const totalInputTokens = entries.reduce((s, e) => s + (e.inputTokens || 0), 0);
    const totalOutputTokens = entries.reduce((s, e) => s + (e.outputTokens || 0), 0);
    const totalTokens = totalInputTokens + totalOutputTokens;
    const avgTokens = entries.length > 0 ? Math.round(totalTokens / entries.length) : 0;

    // Model breakdown
    const modelBreakdown = {};
    for (const e of entries) {
      modelBreakdown[e.model] = (modelBreakdown[e.model] || 0) + 1;
    }

    // Channel breakdown
    const channelBreakdown = {};
    for (const e of entries) {
      channelBreakdown[e.channel] = (channelBreakdown[e.channel] || 0) + 1;
    }

    // Confidence average
    const withConfidence = entries.filter(e => e.confidence !== null);
    const avgConfidence = withConfidence.length > 0
      ? Math.round((withConfidence.reduce((s, e) => s + e.confidence, 0) / withConfidence.length) * 100) / 100
      : null;

    // Trend calculation
    const trend = this._calculateTrend(workspaceId, windowMs);

    // Recent entries (last 10)
    const recentEntries = entries.slice(-10).reverse().map(e => ({
      timestamp: new Date(e.timestamp).toISOString(),
      model: e.model,
      cost: e.cost,
      duration: e.duration,
      success: e.success,
      channel: e.channel,
      confidence: e.confidence,
      inputTokens: e.inputTokens || 0,
      outputTokens: e.outputTokens || 0
    }));

    // Hourly throughput
    const hourlyThroughput = this._calcHourlyThroughput(entries, now);

    return {
      workspaceId,
      window,
      totalRequests: entries.length,
      successCount: successful.length,
      failureCount: entries.length - successful.length,
      successRate: Math.round((successful.length / entries.length) * 100),
      avgResponseTime: avgDuration,
      p95ResponseTime: p95,
      totalCost: Math.round(totalCost * 10000) / 10000,
      avgCost: entries.length > 0 ? Math.round((totalCost / entries.length) * 10000) / 10000 : 0,
      totalTokens,
      avgTokens,
      totalInputTokens,
      totalOutputTokens,
      avgConfidence,
      modelBreakdown,
      channelBreakdown,
      hourlyThroughput,
      recentEntries,
      trend
    };
  }

  /**
   * Get all agents stats for a given window
   */
  getAllStats(window = '24h') {
    const result = {};
    const allIds = new Set([...this.entries.keys(), ...this.history.keys()]);
    for (const id of allIds) {
      result[id] = this.getStats(id, window);
    }
    return result;
  }

  /**
   * Get system-wide stats
   */
  getSystemStats(window = '24h') {
    const allStats = this.getAllStats(window);
    const agents = Object.values(allStats);

    let totalRequests = 0;
    let totalCost = 0;
    let totalSuccess = 0;
    let totalTokens = 0;

    for (const s of agents) {
      totalRequests += s.totalRequests;
      totalCost += s.totalCost;
      totalSuccess += s.successCount;
      totalTokens += s.totalTokens || 0;
    }

    return {
      window,
      agentCount: agents.length,
      totalRequests,
      totalCost: Math.round(totalCost * 10000) / 10000,
      totalTokens,
      overallSuccessRate: totalRequests > 0 ? Math.round((totalSuccess / totalRequests) * 100) : 0,
      perAgent: allStats
    };
  }

  /**
   * Calculate trend: improving / declining / stable
   */
  _calculateTrend(workspaceId, windowMs) {
    const now = Date.now();
    const source = this.history.get(workspaceId) || [];
    const halfWindow = windowMs / 2;

    // Split into first half and second half of the window
    const firstHalf = source.filter(e => {
      const age = now - e.timestamp;
      return age >= halfWindow && age < windowMs;
    });
    const secondHalf = source.filter(e => {
      const age = now - e.timestamp;
      return age < halfWindow;
    });

    if (firstHalf.length < 2 || secondHalf.length < 2) {
      return { direction: 'stable', change: 0 };
    }

    const firstRate = firstHalf.filter(e => e.success).length / firstHalf.length;
    const secondRate = secondHalf.filter(e => e.success).length / secondHalf.length;
    const change = Math.round((secondRate - firstRate) * 100);

    let direction = 'stable';
    if (change > 5) direction = 'improving';
    else if (change < -5) direction = 'declining';

    return { direction, change };
  }

  _emptyStats(workspaceId, window) {
    return {
      workspaceId,
      window,
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      successRate: 0,
      avgResponseTime: 0,
      p95ResponseTime: 0,
      totalCost: 0,
      avgCost: 0,
      totalTokens: 0,
      avgTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      avgConfidence: null,
      modelBreakdown: {},
      channelBreakdown: {},
      hourlyThroughput: [],
      recentEntries: [],
      trend: { direction: 'stable', change: 0 }
    };
  }

  _calcHourlyThroughput(entries, now) {
    const hours = new Array(24).fill(0);
    const currentHour = new Date(now).getHours();

    for (const e of entries) {
      const hourDiff = Math.floor((now - e.timestamp) / 3600000);
      if (hourDiff >= 0 && hourDiff < 24) {
        const idx = (24 - hourDiff) % 24;
        hours[idx]++;
      }
    }

    return hours.map((count, i) => {
      const hour = (currentHour - 23 + i + 24) % 24;
      return { hour: `${String(hour).padStart(2, '0')}:00`, count };
    });
  }

  // --- Persistence ---

  _loadFromDisk() {
    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
        for (const [id, entries] of Object.entries(raw)) {
          if (Array.isArray(entries)) this.entries.set(id, entries);
        }
        this._prune(this.entries, WINDOW_24H);
      }
    } catch (e) {
      if (this.logger) this.logger.warn('AgentStats', `Failed to load stats: ${e.message}`);
    }
  }

  _loadHistory() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        for (const [id, entries] of Object.entries(raw)) {
          if (Array.isArray(entries)) this.history.set(id, entries);
        }
        this._prune(this.history, WINDOW_30D);
      }
    } catch (e) {
      if (this.logger) this.logger.warn('AgentStats', `Failed to load history: ${e.message}`);
    }
  }

  _saveToDisk() {
    try {
      this._prune(this.entries, WINDOW_24H);
      const obj = {};
      for (const [id, entries] of this.entries) obj[id] = entries;
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (e) {
      if (this.logger) this.logger.warn('AgentStats', `Failed to save stats: ${e.message}`);
    }
  }

  _saveHistory() {
    try {
      this._prune(this.history, WINDOW_30D);
      const obj = {};
      for (const [id, entries] of this.history) obj[id] = entries;
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (e) {
      if (this.logger) this.logger.warn('AgentStats', `Failed to save history: ${e.message}`);
    }
  }

  _prune(map, windowMs) {
    const now = Date.now();
    for (const [id, entries] of map) {
      const filtered = entries.filter(e => (now - e.timestamp) < windowMs);
      if (filtered.length === 0) map.delete(id);
      else map.set(id, filtered);
    }
  }

  destroy() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveToDisk();
    this._saveHistory();
  }
}

module.exports = AgentStatsEnhanced;
