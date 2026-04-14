'use strict';

/**
 * API Usage Tracker (Roadmap 8.4)
 *
 * Tracks Claude CLI cost per call, daily/monthly budgets,
 * alerts at 80%, auto-throttle at 90%.
 * Persists daily usage to data/usage.json.
 */

const fs = require('fs');
const path = require('path');

const USAGE_FILE = path.join(require('../utils/base-dir'), 'data', 'usage.json');
const SAVE_INTERVAL_MS = 60000; // 1 minute

class UsageTracker {
  constructor(logger, configManager) {
    this.logger = logger;
    this.configManager = configManager;

    // { "2026-02-15": { cost: 0.42, calls: 12, models: { haiku: 5, sonnet: 4, opus: 3 } }, ... }
    this.daily = {};
    // Throttle state
    this.throttled = false;
    this.alertSent = false;

    this._loadFromDisk();
    this._saveTimer = setInterval(() => this._saveToDisk(), SAVE_INTERVAL_MS);
  }

  /**
   * Get budget config from configManager
   */
  _getBudget() {
    const config = this.configManager ? this.configManager.get() : {};
    const budget = config.budget || {};
    return {
      dailyLimit: budget.dailyLimit || 10.0,     // $10/day default
      monthlyLimit: budget.monthlyLimit || 100.0, // $100/month default
      alertPercent: budget.alertPercent || 80,
      throttlePercent: budget.throttlePercent || 90,
      enabled: budget.enabled !== false           // enabled by default
    };
  }

  /**
   * Record a completed API call cost
   * @param {number} cost - USD cost
   * @param {string} model - model name
   * @param {string} channel - channel name
   * @param {number} [inputTokens] - input token count
   * @param {number} [outputTokens] - output token count
   * @returns {{ throttled: boolean, alert: boolean, reason: string|null }}
   */
  record(cost, model, channel, inputTokens, outputTokens) {
    if (!cost || cost <= 0) return { throttled: false, alert: false, reason: null };

    const today = this._todayKey();
    if (!this.daily[today]) {
      this.daily[today] = { cost: 0, calls: 0, models: {}, inputTokens: 0, outputTokens: 0 };
    }

    const day = this.daily[today];
    day.cost = Math.round((day.cost + cost) * 10000) / 10000;
    day.calls++;
    day.models[model || 'unknown'] = (day.models[model || 'unknown'] || 0) + 1;
    // Track tokens (available after backend restart)
    if (inputTokens > 0) day.inputTokens = (day.inputTokens || 0) + inputTokens;
    if (outputTokens > 0) day.outputTokens = (day.outputTokens || 0) + outputTokens;

    // Check budget limits
    return this._checkLimits();
  }

  /**
   * Check if current usage exceeds budget limits
   * @returns {{ throttled: boolean, alert: boolean, reason: string|null }}
   */
  _checkLimits() {
    const budget = this._getBudget();
    if (!budget.enabled) return { throttled: false, alert: false, reason: null };

    const dailyCost = this.getTodayCost();
    const monthlyCost = this.getMonthCost();

    const dailyPercent = (dailyCost / budget.dailyLimit) * 100;
    const monthlyPercent = (monthlyCost / budget.monthlyLimit) * 100;

    let throttled = false;
    let alert = false;
    let reason = null;

    // Check daily limit
    if (dailyPercent >= budget.throttlePercent) {
      throttled = true;
      reason = `Daily budget ${budget.throttlePercent}% reached: $${dailyCost.toFixed(2)}/$${budget.dailyLimit.toFixed(2)}`;
    } else if (monthlyPercent >= budget.throttlePercent) {
      throttled = true;
      reason = `Monthly budget ${budget.throttlePercent}% reached: $${monthlyCost.toFixed(2)}/$${budget.monthlyLimit.toFixed(2)}`;
    }

    // Check alert threshold
    if (dailyPercent >= budget.alertPercent || monthlyPercent >= budget.alertPercent) {
      alert = true;
      if (!reason) {
        reason = dailyPercent >= budget.alertPercent
          ? `Daily budget ${budget.alertPercent}% warning: $${dailyCost.toFixed(2)}/$${budget.dailyLimit.toFixed(2)}`
          : `Monthly budget ${budget.alertPercent}% warning: $${monthlyCost.toFixed(2)}/$${budget.monthlyLimit.toFixed(2)}`;
      }
    }

    if (throttled && !this.throttled) {
      this.logger.warn('UsageTracker', `THROTTLE ACTIVATED: ${reason}`);
    }
    if (alert && !this.alertSent) {
      this.logger.warn('UsageTracker', `BUDGET ALERT: ${reason}`);
    }

    this.throttled = throttled;
    if (alert) this.alertSent = true;

    // Reset alert flag at midnight (new day)
    return { throttled, alert, reason };
  }

  /**
   * Check if API calls should be throttled
   * In throttle mode, only haiku model is allowed
   * @returns {{ allowed: boolean, reason: string|null, forcedModel: string|null }}
   */
  checkThrottle() {
    const budget = this._getBudget();
    if (!budget.enabled) return { allowed: true, reason: null, forcedModel: null };

    const result = this._checkLimits();

    if (result.throttled) {
      // Allow calls but force cheapest model
      return {
        allowed: true,
        reason: result.reason,
        forcedModel: 'haiku'
      };
    }

    return { allowed: true, reason: null, forcedModel: null };
  }

  /**
   * Get today's total cost
   */
  getTodayCost() {
    const today = this._todayKey();
    return this.daily[today] ? this.daily[today].cost : 0;
  }

  /**
   * Get current month's total cost
   */
  getMonthCost() {
    const now = new Date();
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let total = 0;
    for (const [key, val] of Object.entries(this.daily)) {
      if (key.startsWith(prefix)) {
        total += val.cost;
      }
    }
    return Math.round(total * 10000) / 10000;
  }

  /**
   * Get usage summary for API/UI
   */
  getSummary() {
    const budget = this._getBudget();
    const todayCost = this.getTodayCost();
    const monthCost = this.getMonthCost();
    const today = this._todayKey();
    const todayData = this.daily[today] || { cost: 0, calls: 0, models: {} };

    // Last 7 days
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = this._dateKey(d);
      const data = this.daily[key] || { cost: 0, calls: 0, models: {} };
      last7Days.push({ date: key, cost: data.cost, calls: data.calls, inputTokens: data.inputTokens || 0, outputTokens: data.outputTokens || 0 });
    }

    // Last 30 days
    const last30Days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = this._dateKey(d);
      const data = this.daily[key] || { cost: 0, calls: 0, models: {} };
      last30Days.push({ date: key, cost: data.cost, calls: data.calls, inputTokens: data.inputTokens || 0, outputTokens: data.outputTokens || 0 });
    }

    // Token totals
    const todayTokens = { input: todayData.inputTokens || 0, output: todayData.outputTokens || 0 };
    todayTokens.total = todayTokens.input + todayTokens.output;

    // Week token totals
    let weekInputTokens = 0, weekOutputTokens = 0;
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const data = this.daily[this._dateKey(d)];
      if (data) {
        weekInputTokens += data.inputTokens || 0;
        weekOutputTokens += data.outputTokens || 0;
      }
    }

    // Month token totals
    const now = new Date();
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let monthInputTokens = 0, monthOutputTokens = 0;
    for (const [key, val] of Object.entries(this.daily)) {
      if (key.startsWith(prefix)) {
        monthInputTokens += val.inputTokens || 0;
        monthOutputTokens += val.outputTokens || 0;
      }
    }

    return {
      today: {
        cost: todayCost,
        calls: todayData.calls,
        models: todayData.models,
        limit: budget.dailyLimit,
        percent: budget.dailyLimit > 0 ? Math.round((todayCost / budget.dailyLimit) * 100) : 0,
        tokens: todayTokens
      },
      month: {
        cost: monthCost,
        limit: budget.monthlyLimit,
        percent: budget.monthlyLimit > 0 ? Math.round((monthCost / budget.monthlyLimit) * 100) : 0,
        tokens: { input: monthInputTokens, output: monthOutputTokens, total: monthInputTokens + monthOutputTokens }
      },
      week: {
        tokens: { input: weekInputTokens, output: weekOutputTokens, total: weekInputTokens + weekOutputTokens }
      },
      budget: {
        dailyLimit: budget.dailyLimit,
        monthlyLimit: budget.monthlyLimit,
        alertPercent: budget.alertPercent,
        throttlePercent: budget.throttlePercent,
        enabled: budget.enabled
      },
      throttled: this.throttled,
      last7Days,
      last30Days,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get date key for today
   */
  _todayKey() {
    return this._dateKey(new Date());
  }

  /**
   * Get date key for a given date
   */
  _dateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  /**
   * Load from disk
   */
  _loadFromDisk() {
    try {
      if (fs.existsSync(USAGE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
        if (raw && typeof raw === 'object') {
          this.daily = raw;
        }
        // Prune entries older than 90 days
        this._prune(90);
        if (this.logger) {
          const keys = Object.keys(this.daily);
          this.logger.info('UsageTracker', `Loaded ${keys.length} days of usage data`);
        }
      }
    } catch (e) {
      if (this.logger) {
        this.logger.warn('UsageTracker', `Failed to load usage data: ${e.message}`);
      }
    }
  }

  /**
   * Save to disk
   */
  _saveToDisk() {
    try {
      const dir = path.dirname(USAGE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(USAGE_FILE, JSON.stringify(this.daily, null, 2), 'utf-8');
    } catch (e) {
      if (this.logger) {
        this.logger.warn('UsageTracker', `Failed to save usage data: ${e.message}`);
      }
    }
  }

  /**
   * Remove entries older than maxDays
   */
  _prune(maxDays) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxDays);
    const cutoffKey = this._dateKey(cutoff);

    for (const key of Object.keys(this.daily)) {
      if (key < cutoffKey) {
        delete this.daily[key];
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

module.exports = UsageTracker;
