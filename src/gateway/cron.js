/**
 * ANUKI CRON JOBS MANAGER
 *
 * OpenClaw-style scheduled task system:
 * - Cron expression support
 * - One-time and recurring jobs
 * - Job persistence (survive restarts)
 * - Job history and logging
 * - Dynamic job management (add/remove at runtime)
 *
 * Built-in jobs:
 * - Reflection (nightly)
 * - Memory decay
 * - Heartbeat check-in
 *
 * User-defined jobs:
 * - Custom reminders
 * - Scheduled messages
 * - Automated tasks
 */

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

class CronManager {
  constructor(config = {}, logger) {
    this.logger = logger;

    // Storage path for persistent jobs
    this.storagePath = config.storagePath || path.join(
      require('../utils/base-dir'),
      'data',
      'cron-jobs.json'
    );

    // Active cron tasks
    this.tasks = new Map();

    // Job definitions (persistent)
    this.jobs = new Map();

    // Job execution history
    this.history = [];
    this.maxHistorySize = config.maxHistorySize || 100;

    // Timezone from config (default UTC)
    this.timezone = config.timezone || 'UTC';

    // Callbacks for job execution
    this.handlers = new Map();

    // Load persisted jobs
    this._loadJobs();

    this.log('Initialized with ' + this.jobs.size + ' persisted jobs');
  }

  /**
   * Register a handler for a job type
   */
  registerHandler(jobType, handler) {
    this.handlers.set(jobType, handler);
    this.log('Registered handler: ' + jobType);
  }

  /**
   * Add a new cron job
   */
  addJob(jobConfig) {
    const {
      id,
      name,
      type,
      schedule, // Cron expression (e.g., '0 3 * * *' for 3 AM daily)
      data,
      enabled = true,
      oneTime = false,
      channel,
      userId
    } = jobConfig;

    // Validate cron expression
    if (!cron.validate(schedule)) {
      throw new Error('Invalid cron expression: ' + schedule);
    }

    const jobId = id || this._generateId();

    const job = {
      id: jobId,
      name: name || 'Job ' + jobId,
      type,
      schedule,
      data: data || {},
      enabled,
      oneTime,
      channel,
      userId,
      createdAt: new Date().toISOString(),
      lastRun: null,
      runCount: 0,
      nextRun: this._getNextRun(schedule)
    };

    // Store job definition
    this.jobs.set(jobId, job);

    // Start if enabled
    if (enabled) {
      this._startJob(job);
    }

    // Persist
    this._saveJobs();

    this.log('Added job: ' + job.name + ' (' + schedule + ')');

    return job;
  }

  /**
   * Remove a job
   */
  removeJob(jobId) {
    // Stop if running
    if (this.tasks.has(jobId)) {
      this.tasks.get(jobId).stop();
      this.tasks.delete(jobId);
    }

    // Remove definition
    const job = this.jobs.get(jobId);
    this.jobs.delete(jobId);

    // Persist
    this._saveJobs();

    if (job) {
      this.log('Removed job: ' + job.name);
    }

    return job;
  }

  /**
   * Enable a job
   */
  enableJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    job.enabled = true;
    this._startJob(job);
    this._saveJobs();

    this.log('Enabled job: ' + job.name);
    return job;
  }

  /**
   * Disable a job
   */
  disableJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    job.enabled = false;

    if (this.tasks.has(jobId)) {
      this.tasks.get(jobId).stop();
      this.tasks.delete(jobId);
    }

    this._saveJobs();

    this.log('Disabled job: ' + job.name);
    return job;
  }

  /**
   * Run a job immediately (bypass schedule)
   */
  async runNow(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error('Job not found: ' + jobId);
    }

    return this._executeJob(job);
  }

  /**
   * Get job by ID
   */
  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs
   */
  getAllJobs() {
    return Array.from(this.jobs.values());
  }

  /**
   * Get jobs by type
   */
  getJobsByType(type) {
    return this.getAllJobs().filter(j => j.type === type);
  }

  /**
   * Get execution history
   */
  getHistory(limit = 20) {
    return this.history.slice(-limit);
  }

  /**
   * Get stats
   */
  getStats() {
    const jobs = this.getAllJobs();

    return {
      totalJobs: jobs.length,
      enabledJobs: jobs.filter(j => j.enabled).length,
      runningTasks: this.tasks.size,
      totalExecutions: jobs.reduce((sum, j) => sum + j.runCount, 0),
      recentHistory: this.history.slice(-5)
    };
  }

  /**
   * Start all enabled jobs (call on startup)
   */
  startAll() {
    for (const job of this.jobs.values()) {
      if (job.enabled && !this.tasks.has(job.id)) {
        this._startJob(job);
      }
    }
    this.log('Started ' + this.tasks.size + ' jobs');
  }

  /**
   * Stop all jobs
   */
  stopAll() {
    for (const [id, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();
    this.log('Stopped all jobs');
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  _startJob(job) {
    if (this.tasks.has(job.id)) {
      return; // Already running
    }

    const task = cron.schedule(job.schedule, async () => {
      await this._executeJob(job);
    }, {
      timezone: this.timezone
    });

    this.tasks.set(job.id, task);
  }

  async _executeJob(job) {
    const startTime = Date.now();

    this.log('Executing: ' + job.name);

    try {
      // Get handler for job type
      const handler = this.handlers.get(job.type);

      if (!handler) {
        throw new Error('No handler for job type: ' + job.type);
      }

      // Execute
      const result = await handler(job.data, job);

      // Update job stats
      job.lastRun = new Date().toISOString();
      job.runCount++;
      job.nextRun = this._getNextRun(job.schedule);

      // Add to history
      this._addHistory(job, 'success', result, Date.now() - startTime);

      // Remove if one-time
      if (job.oneTime) {
        this.removeJob(job.id);
      } else {
        this._saveJobs();
      }

      this.log('Completed: ' + job.name + ' (' + (Date.now() - startTime) + 'ms)');

      return { success: true, result };
    } catch (error) {
      // Add to history
      this._addHistory(job, 'error', error.message, Date.now() - startTime);

      this.log('Failed: ' + job.name + ' — ' + error.message);

      return { success: false, error: error.message };
    }
  }

  _addHistory(job, status, result, duration) {
    this.history.push({
      jobId: job.id,
      jobName: job.name,
      type: job.type,
      status,
      result: typeof result === 'object' ? JSON.stringify(result).substring(0, 200) : result,
      duration,
      timestamp: new Date().toISOString()
    });

    // Trim history
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }
  }

  _getNextRun(schedule) {
    try {
      if (!cron.validate(schedule)) return 'Invalid schedule';

      // Parse cron fields using node-cron's internal TimeMatcher
      const task = cron.schedule(schedule, () => {}, { scheduled: false, timezone: this.timezone });
      const expr = task.timeMatcher.expressions; // [seconds[], minutes[], hours[], days[], months[], weekdays[]]
      task.stop();

      // Brute-force: scan next 48 hours minute-by-minute
      const now = new Date();
      // Convert to configured timezone for matching
      const tzNow = new Date(now.toLocaleString('en-US', { timeZone: this.timezone }));
      const check = new Date(tzNow);
      check.setSeconds(0, 0);
      check.setMinutes(check.getMinutes() + 1); // Start from next minute

      const maxMinutes = 48 * 60;
      for (let i = 0; i < maxMinutes; i++) {
        const sec = check.getSeconds();
        const min = check.getMinutes();
        const hour = check.getHours();
        const day = check.getDate();
        const month = check.getMonth() + 1;
        const weekday = check.getDay();

        if (expr[0].includes(sec) &&
            expr[1].includes(min) &&
            expr[2].includes(hour) &&
            expr[3].includes(day) &&
            expr[4].includes(month) &&
            expr[5].includes(weekday)) {
          // Calculate the actual UTC time by offsetting
          const diffMs = check.getTime() - tzNow.getTime();
          const result = new Date(now.getTime() + diffMs);
          return result.toISOString();
        }

        check.setMinutes(check.getMinutes() + 1);
      }

      return 'Beyond 48h';
    } catch {
      return 'Unknown';
    }
  }

  _generateId() {
    return 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  }

  _loadJobs() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = fs.readFileSync(this.storagePath, 'utf8');
        const jobs = JSON.parse(data);

        for (const job of jobs) {
          this.jobs.set(job.id, job);
        }
      }
    } catch (e) {
      this.log('Failed to load jobs: ' + e.message);
    }
  }

  _saveJobs() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = JSON.stringify(Array.from(this.jobs.values()), null, 2);
      fs.writeFileSync(this.storagePath, data);
    } catch (e) {
      this.log('Failed to save jobs: ' + e.message);
    }
  }

  log(msg) {
    if (this.logger) {
      this.logger.info('Cron', msg);
    }
  }
}

// Built-in job types
const BUILTIN_JOB_TYPES = {
  REFLECTION: 'reflection',
  DECAY: 'memory_decay',
  HEARTBEAT: 'heartbeat',
  REMINDER: 'reminder',
  MESSAGE: 'scheduled_message',
  TASK: 'scheduled_task',
  AGENT_LIFECYCLE: 'agent_lifecycle'  // Roadmap 7.4: auto-pause idle agents
};

module.exports = { CronManager, BUILTIN_JOB_TYPES };
