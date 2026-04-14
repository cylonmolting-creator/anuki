/**
 * Agent Performance Stats Collector (Roadmap 7.3)
 *
 * Tracks per-agent metrics: response time (avg/p95), success rate,
 * skill usage, cost, model breakdown. 24-hour rolling window.
 * Persists to data/agent-stats.json every 5 minutes.
 */

const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(require('../utils/base-dir'), 'data', 'agent-stats.json');
const SAVE_INTERVAL_MS = 300000; // 5 minutes
const ROLLING_WINDOW_MS = 86400000; // 24 hours
const MAX_ENTRIES_PER_AGENT = 1000; // Cap per agent to prevent unbounded growth

class AgentStats {
  constructor(logger) {
    this.logger = logger;
    // workspaceId -> Array<{ timestamp, model, cost, duration, success, turns, responseLength, channel }>
    this.entries = new Map();
    this._loadFromDisk();
    this._saveTimer = setInterval(() => this._saveToDisk(), SAVE_INTERVAL_MS);
  }

  /**
   * Record a completed execution
   */
  record(workspaceId, data) {
    if (!workspaceId) return;

    const entry = {
      timestamp: Date.now(),
      model: data.model || 'unknown',
      cost: data.cost || 0,
      duration: data.duration || 0,
      success: data.success !== false, // default true
      turns: data.turns || 0,
      responseLength: data.responseLength || 0,
      channel: data.channel || 'unknown',
      inputTokens: data.inputTokens || 0,
      outputTokens: data.outputTokens || 0
    };

    if (!this.entries.has(workspaceId)) {
      this.entries.set(workspaceId, []);
    }

    const arr = this.entries.get(workspaceId);
    arr.push(entry);

    // Cap entries per agent
    if (arr.length > MAX_ENTRIES_PER_AGENT) {
      arr.splice(0, arr.length - MAX_ENTRIES_PER_AGENT);
    }
  }

  /**
   * Get stats for a single agent (workspace)
   */
  getStats(workspaceId) {
    const now = Date.now();
    const raw = this.entries.get(workspaceId) || [];
    // Only entries within rolling window
    const entries = raw.filter(e => (now - e.timestamp) < ROLLING_WINDOW_MS);

    if (entries.length === 0) {
      return {
        workspaceId,
        totalRequests: 0,
        successRate: 0,
        avgResponseTime: 0,
        p95ResponseTime: 0,
        totalCost: 0,
        avgCost: 0,
        modelBreakdown: {},
        channelBreakdown: {},
        hourlyThroughput: [],
        recentEntries: []
      };
    }

    const successful = entries.filter(e => e.success);
    const durations = entries.filter(e => e.duration > 0).map(e => e.duration).sort((a, b) => a - b);

    // P95 calculation
    const p95Index = Math.ceil(durations.length * 0.95) - 1;
    const p95 = durations.length > 0 ? durations[Math.max(0, p95Index)] : 0;
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
      : 0;

    // Cost & Tokens
    const totalCost = entries.reduce((s, e) => s + (e.cost || 0), 0);
    const totalInputTokens = entries.reduce((s, e) => s + (e.inputTokens || 0), 0);
    const totalOutputTokens = entries.reduce((s, e) => s + (e.outputTokens || 0), 0);

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

    // Hourly throughput (last 24h, grouped by hour)
    const hourlyThroughput = this._calcHourlyThroughput(entries, now);

    // Recent entries (last 10)
    const recentEntries = entries.slice(-10).reverse().map(e => ({
      timestamp: new Date(e.timestamp).toISOString(),
      model: e.model,
      cost: e.cost,
      duration: e.duration,
      success: e.success,
      channel: e.channel,
      inputTokens: e.inputTokens || 0,
      outputTokens: e.outputTokens || 0
    }));

    return {
      workspaceId,
      totalRequests: entries.length,
      successCount: successful.length,
      failureCount: entries.length - successful.length,
      successRate: Math.round((successful.length / entries.length) * 100),
      avgResponseTime: avgDuration,
      p95ResponseTime: p95,
      totalCost: Math.round(totalCost * 10000) / 10000, // 4 decimal places
      avgCost: entries.length > 0 ? Math.round((totalCost / entries.length) * 10000) / 10000 : 0,
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      avgTokens: entries.length > 0 ? Math.round((totalInputTokens + totalOutputTokens) / entries.length) : 0,
      modelBreakdown,
      channelBreakdown,
      hourlyThroughput,
      recentEntries
    };
  }

  /**
   * Get summary stats for all agents
   */
  getAllStats() {
    const result = {};
    for (const [workspaceId] of this.entries) {
      result[workspaceId] = this.getStats(workspaceId);
    }
    return result;
  }

  /**
   * Get aggregated system-wide stats
   */
  getSystemStats() {
    const allStats = this.getAllStats();
    const agents = Object.values(allStats);

    let totalRequests = 0;
    let totalCost = 0;
    let totalSuccess = 0;
    let totalTokens = 0;
    let allDurations = [];

    for (const s of agents) {
      totalRequests += s.totalRequests;
      totalCost += s.totalCost;
      totalSuccess += s.successCount;
      totalTokens += s.totalTokens || 0;
      // Collect durations from recent entries for system-wide p95
      for (const e of s.recentEntries) {
        if (e.duration > 0) allDurations.push(e.duration);
      }
    }

    allDurations.sort((a, b) => a - b);
    const p95Index = Math.ceil(allDurations.length * 0.95) - 1;
    const avgDuration = allDurations.length > 0
      ? Math.round(allDurations.reduce((s, d) => s + d, 0) / allDurations.length)
      : 0;

    return {
      agentCount: agents.length,
      totalRequests,
      totalCost: Math.round(totalCost * 10000) / 10000,
      totalTokens,
      avgDuration,
      overallSuccessRate: totalRequests > 0 ? Math.round((totalSuccess / totalRequests) * 100) : 0,
      systemP95: allDurations.length > 0 ? allDurations[Math.max(0, p95Index)] : 0,
      perAgent: allStats
    };
  }

  /**
   * Calculate hourly throughput for last 24 hours
   */
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

    // Return with hour labels
    return hours.map((count, i) => {
      const hour = (currentHour - 23 + i + 24) % 24;
      return { hour: `${String(hour).padStart(2, '0')}:00`, count };
    });
  }

  /**
   * Prune old entries beyond rolling window
   */
  _prune() {
    const now = Date.now();
    for (const [workspaceId, entries] of this.entries) {
      const filtered = entries.filter(e => (now - e.timestamp) < ROLLING_WINDOW_MS);
      if (filtered.length === 0) {
        this.entries.delete(workspaceId);
      } else {
        this.entries.set(workspaceId, filtered);
      }
    }
  }

  /**
   * Load from disk
   */
  _loadFromDisk() {
    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
        for (const [workspaceId, entries] of Object.entries(raw)) {
          if (Array.isArray(entries)) {
            this.entries.set(workspaceId, entries);
          }
        }
        this._prune(); // Remove stale on load
        if (this.logger) {
          this.logger.info('AgentStats', `Loaded stats for ${this.entries.size} agents`);
        }
      }
    } catch (e) {
      if (this.logger) {
        this.logger.warn('AgentStats', `Failed to load stats: ${e.message}`);
      }
    }
  }

  /**
   * Save to disk
   */
  _saveToDisk() {
    try {
      this._prune();
      const obj = {};
      for (const [workspaceId, entries] of this.entries) {
        obj[workspaceId] = entries;
      }
      const dir = path.dirname(STATS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(STATS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (e) {
      if (this.logger) {
        this.logger.warn('AgentStats', `Failed to save stats: ${e.message}`);
      }
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveToDisk();
  }
}

module.exports = AgentStats;
