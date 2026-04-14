/**
 * ANUKI HEALTH WATCHDOG
 *
 * Detects stalled processes and self-heals:
 * - Monitors heartbeat timestamps (no activity for 2 min → warning)
 * - Detects stuck lane queues (processing for too long → clear)
 * - Tracks event loop lag (>500ms → warning)
 * - Periodic orphan process sweep (every 60s — not just boot)
 * - Agent liveness check (ghost/zombie detection — NOT output timeout)
 * - Agent state checkpointing (periodic save for crash recovery)
 * - Exposes health status for /api/health enrichment
 *
 * Runs on its own setInterval (not cron) — if cron stalls, watchdog still fires.
 */

const { execSync } = require('child_process');

class HealthWatchdog {
  constructor(config = {}, logger) {
    this.logger = logger;

    // Configuration
    this.checkIntervalMs = config.checkIntervalMs || 30000;       // Check every 30s
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs || 120000; // 2 min no heartbeat → stale
    this.laneStuckTimeoutMs = config.laneStuckTimeoutMs || 300000; // 5 min stuck lane → clear
    this.eventLoopLagThresholdMs = config.eventLoopLagThresholdMs || 500; // 500ms lag → warning
    this.orphanSweepIntervalMs = config.orphanSweepIntervalMs || 60000;   // Orphan sweep every 60s
    this.checkpointIntervalMs = config.checkpointIntervalMs || 30000;     // Checkpoint every 30s

    // Dependencies (injected after construction)
    this.laneQueue = null;
    this.executor = null;
    this.pidRegistry = null;    // For orphan sweep
    this.supervisor = null;     // For stuck agent detection

    // State
    this._lastHeartbeat = Date.now();
    this._interval = null;
    this._orphanSweepInterval = null;
    this._checkpointInterval = null;
    this._lagCheckTimer = null;
    this._lastLagCheck = Date.now();
    this._warnings = [];       // Recent warnings (last 20)
    this._healActions = [];    // Recent self-heal actions (last 20)
    this._isRunning = false;

    // Stats
    this.stats = {
      checksRun: 0,
      warningsIssued: 0,
      selfHeals: 0,
      stuckLanesCleared: 0,
      orphansKilled: 0,
      stuckAgentsKilled: 0,
      checkpointsSaved: 0,
      maxEventLoopLagMs: 0,
      lastCheckAt: null,
      lastOrphanSweepAt: null,
      lastCheckpointAt: null
    };
  }

  /**
   * Record a heartbeat — call this from the heartbeat cron handler
   */
  heartbeat() {
    this._lastHeartbeat = Date.now();
  }

  /**
   * Start the watchdog
   */
  start() {
    if (this._isRunning) return;
    this._isRunning = true;
    this._lastHeartbeat = Date.now();

    // Main check loop (heartbeat + stuck lanes + stuck agents)
    this._interval = setInterval(() => this._runCheck(), this.checkIntervalMs);

    // Periodic orphan sweep (independent timer — different interval)
    this._orphanSweepInterval = setInterval(() => {
      try { this._sweepOrphans(); } catch (e) { this._log('Orphan sweep error: ' + e.message); }
    }, this.orphanSweepIntervalMs);

    // Periodic checkpoint (save active agent state)
    this._checkpointInterval = setInterval(() => {
      try { this._checkpointAgentState(); } catch (e) { this._log('Checkpoint error: ' + e.message); }
    }, this.checkpointIntervalMs);

    // Event loop lag detection via setTimeout drift
    this._startLagMonitor();

    this._log('Started (interval=' + this.checkIntervalMs + 'ms, heartbeatTimeout=' + this.heartbeatTimeoutMs + 'ms, orphanSweep=' + this.orphanSweepIntervalMs + 'ms)');
  }

  /**
   * Stop the watchdog
   */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    if (this._orphanSweepInterval) {
      clearInterval(this._orphanSweepInterval);
      this._orphanSweepInterval = null;
    }
    if (this._checkpointInterval) {
      clearInterval(this._checkpointInterval);
      this._checkpointInterval = null;
    }
    if (this._lagCheckTimer) {
      clearTimeout(this._lagCheckTimer);
      this._lagCheckTimer = null;
    }
    this._isRunning = false;
    this._log('Stopped');
  }

  /**
   * Get current health status (for /api/health enrichment)
   */
  getStatus() {
    const now = Date.now();
    const heartbeatAge = now - this._lastHeartbeat;
    const heartbeatStale = heartbeatAge > this.heartbeatTimeoutMs;

    return {
      running: this._isRunning,
      heartbeatAgeMs: heartbeatAge,
      heartbeatStale,
      stats: { ...this.stats },
      recentWarnings: this._warnings.slice(-5),
      recentHeals: this._healActions.slice(-5)
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  _runCheck() {
    this.stats.checksRun++;
    this.stats.lastCheckAt = new Date().toISOString();

    try {
      this._checkHeartbeat();
      this._checkStuckLanes();
      this._checkStuckAgents();
    } catch (err) {
      this._log('Check error: ' + err.message);
    }
  }

  /**
   * Check if heartbeat is stale (no heartbeat cron fired for >2 min)
   */
  _checkHeartbeat() {
    const age = Date.now() - this._lastHeartbeat;

    if (age > this.heartbeatTimeoutMs) {
      this._warn('Heartbeat stale (' + Math.round(age / 1000) + 's since last heartbeat)');

      // Self-heal: reset heartbeat to avoid repeated warnings every 30s
      // The next real heartbeat cron will reset it properly
      // We only warn once per timeout window
      this._lastHeartbeat = Date.now() - (this.heartbeatTimeoutMs * 0.9);
    }
  }

  /**
   * Check for stuck lane queues (processing for too long)
   */
  _checkStuckLanes() {
    if (!this.laneQueue) return;

    const stats = this.laneQueue.getStats();
    if (!stats.lanes || stats.lanes.length === 0) return;

    for (const lane of stats.lanes) {
      if (!lane.processing) continue;

      // Get the actual lane object to check current task
      const laneObj = this.laneQueue.lanes.get(lane.id);
      if (!laneObj || !laneObj.currentTask) continue;

      const taskAge = Date.now() - laneObj.currentTask.enqueuedAt;

      if (taskAge > this.laneStuckTimeoutMs) {
        this._warn('Stuck lane: ' + lane.id + ' (task ' + laneObj.currentTask.id + ' running for ' + Math.round(taskAge / 1000) + 's)');

        // Self-heal: clear the stuck lane's queue (don't kill current task — it may still complete)
        // Just drop queued items so they don't pile up behind the stuck task
        const queuedCount = laneObj.queue.length - 1; // -1 for current task (index 0)
        if (queuedCount > 0) {
          // Reject queued tasks (not the current one at index 0)
          const stuck = laneObj.queue.splice(1);
          for (const task of stuck) {
            try {
              task.reject(new Error('Cleared by health watchdog — lane stuck'));
            } catch (_) {}
          }
          this.stats.stuckLanesCleared++;
          this._heal('Cleared ' + stuck.length + ' queued tasks from stuck lane ' + lane.id);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ORPHAN SWEEP — Periodic scan for orphan processes (ppid=1)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Sweep for orphan claude/node processes that have ppid=1 (adopted by launchd).
   * These can appear when:
   * - A child process survives parent death (detached:true + missed cleanup)
   * - A kill signal was missed during shutdown
   * - A process was spawned but never registered in PID registry
   *
   * This runs periodically (every 60s) as a safety net on top of boot cleanup.
   */
  _sweepOrphans() {
    this.stats.lastOrphanSweepAt = new Date().toISOString();

    try {
      const psOutput = execSync('ps -eo pid,ppid,pgid,args 2>/dev/null || true', {
        encoding: 'utf8',
        timeout: 5000
      });

      const currentPid = process.pid;
      const knownPids = new Set();

      // Collect known child PIDs from executor's activeProcesses
      if (this.executor && this.executor.activeProcesses) {
        for (const [, proc] of this.executor.activeProcesses) {
          if (proc && proc.pid) knownPids.add(proc.pid);
        }
      }

      // Collect known PIDs from PID registry
      if (this.pidRegistry && this.pidRegistry.children) {
        for (const [pid] of this.pidRegistry.children) {
          knownPids.add(pid);
        }
      }

      const orphans = psOutput.split('\n')
        .map(line => line.trim().split(/\s+/))
        .filter(parts => {
          if (parts.length < 4) return false;
          const pid = parseInt(parts[0]);
          const ppid = parseInt(parts[1]);
          const args = parts.slice(3).join(' ');

          // Must be orphan (ppid=1) and not ourselves
          if (ppid !== 1 || pid === currentPid) return false;

          // Skip known processes (they're being tracked normally)
          if (knownPids.has(pid)) return false;

          // Match: claude CLI processes OR Anuki's own node process (path-specific)
          const isClaude = args.includes('claude') && !args.includes('Claude.app');
          // CRITICAL: Only match THIS Anuki installation — resolve own install path from __dirname
          // This prevents orphan sweep from killing unrelated node projects running 'src/index.js'
          const pathModule = require('path');
          const ownInstallPath = pathModule.resolve(__dirname, '..', '..');
          const ownEntryPoint = pathModule.join(ownInstallPath, 'src/index.js');
          const isOwnNode = args.includes(ownEntryPoint);
          return isClaude || isOwnNode;
        })
        .map(parts => ({
          pid: parseInt(parts[0]),
          pgid: parseInt(parts[2]),
          args: parts.slice(3).join(' ').substring(0, 100)
        }));

      if (orphans.length === 0) return; // Clean — most common case

      // SAFETY: Get our own process group to avoid suicide
      // If orphan pgid matches our own pgid, kill only the PID, not the group
      let ownPgid = null;
      try {
        const pgidOut = execSync(`ps -o pgid= -p ${currentPid}`, { encoding: 'utf8' }).trim();
        ownPgid = parseInt(pgidOut);
      } catch (_) { /* fallback: no pgid kill */ }

      // Kill orphans
      for (const orphan of orphans) {
        this._warn('Orphan sweep: PID ' + orphan.pid + ' pgid=' + orphan.pgid + ' — ' + orphan.args);
        // CRITICAL: Only group-kill if pgid differs from ours (prevents self-kill)
        const safeToGroupKill = ownPgid && orphan.pgid !== ownPgid && orphan.pgid > 1;
        try {
          if (safeToGroupKill) {
            process.kill(-orphan.pgid, 'SIGTERM');
          } else {
            process.kill(orphan.pid, 'SIGTERM');
          }
        } catch (_) {
          try { process.kill(orphan.pid, 'SIGTERM'); } catch (__) { /* dead */ }
        }
        this.stats.orphansKilled++;
      }

      // Schedule SIGKILL for survivors after 3s
      setTimeout(() => {
        for (const orphan of orphans) {
          try {
            process.kill(orphan.pid, 0); // Check if still alive
            const safeToGroupKill = ownPgid && orphan.pgid !== ownPgid && orphan.pgid > 1;
            if (safeToGroupKill) {
              process.kill(-orphan.pgid, 'SIGKILL');
            } else {
              process.kill(orphan.pid, 'SIGKILL');
            }
            this._warn('Orphan sweep SIGKILL: PID ' + orphan.pid);
          } catch (_) { /* dead — good */ }
        }
      }, 3000);

      this._heal('Killed ' + orphans.length + ' orphan process(es)');

    } catch (e) {
      // ps command failed — not critical, will retry next interval
      this._log('Orphan sweep failed: ' + e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // AGENT LIVENESS CHECK — Detect dead/zombie processes, NOT output silence
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if tracked agents are actually alive. Does NOT kill based on output silence.
   * Agents can work silently for hours during tool_use (reading files, running commands).
   *
   * Only kills in two cases:
   * 1. Ghost agent: supervisor tracks it as running, but process is dead (kill(pid,0) fails)
   * 2. Zombie process: process exists but is in zombie state (ps -o state= shows 'Z')
   */
  _checkStuckAgents() {
    if (!this.supervisor) return;

    const status = this.supervisor.getStatus();

    for (const [agentId, agentInfo] of Object.entries(status.agents)) {
      if (agentInfo.status !== 'running' || !agentInfo.pid) continue;

      const pid = agentInfo.pid;

      // Check 1: Is the process actually alive?
      let isAlive = false;
      try {
        process.kill(pid, 0); // Signal 0 = existence check only
        isAlive = true;
      } catch (e) {
        // ESRCH = no such process — ghost agent
        if (e.code === 'ESRCH') {
          this._warn('Ghost agent: ' + agentId + ' (PID ' + pid + ') — process dead but supervisor still tracking');
          // Clean up supervisor tracking
          if (this.supervisor.unregisterAgent) {
            this.supervisor.unregisterAgent(agentId);
          }
          this.stats.stuckAgentsKilled++;
          this._heal('Cleaned ghost agent ' + agentId + ' (PID ' + pid + ')');
          continue;
        }
      }

      // Check 2: Is it a zombie process?
      if (isAlive) {
        try {
          const state = execSync('ps -p ' + pid + ' -o state= 2>/dev/null || true', {
            encoding: 'utf8',
            timeout: 3000
          }).trim();

          if (state === 'Z') {
            this._warn('Zombie agent: ' + agentId + ' (PID ' + pid + ') — process is zombie');
            try {
              process.kill(pid, 'SIGKILL'); // Zombies only respond to SIGKILL (to reap)
            } catch (_) {}
            if (this.supervisor.unregisterAgent) {
              this.supervisor.unregisterAgent(agentId);
            }
            this.stats.stuckAgentsKilled++;
            this._heal('Killed zombie agent ' + agentId + ' (PID ' + pid + ')');
          }
        } catch (e) {
          // ps failed — not critical
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CHECKPOINT — Periodic save of agent state for crash recovery
  // ═══════════════════════════════════════════════════════════════

  /**
   * Periodically checkpoint active agent state.
   * This ensures that if the orchestrator crashes, we know:
   * - Which agents were running
   * - What conversations were active
   * - Last known output per agent
   *
   * Data is saved via executor's existing _saveActiveJobs() and _saveSessions().
   * This is a safety net — normally these are saved on job start/end,
   * but a crash between events would lose state.
   */
  _checkpointAgentState() {
    if (!this.executor) return;

    try {
      // Save active jobs snapshot
      if (typeof this.executor._saveActiveJobs === 'function') {
        this.executor._saveActiveJobs();
      }

      // Save sessions snapshot
      if (typeof this.executor._saveSessions === 'function') {
        this.executor._saveSessions();
      }

      this.stats.checkpointsSaved++;
      this.stats.lastCheckpointAt = new Date().toISOString();

    } catch (e) {
      this._warn('Checkpoint failed: ' + e.message);
    }
  }

  /**
   * Event loop lag monitor — uses setTimeout drift detection
   */
  _startLagMonitor() {
    const EXPECTED_DELAY = 1000; // Check every 1s

    const check = () => {
      if (!this._isRunning) return;

      const now = Date.now();
      const elapsed = now - this._lastLagCheck;
      const lag = elapsed - EXPECTED_DELAY;

      if (lag > 0 && lag > this.stats.maxEventLoopLagMs) {
        this.stats.maxEventLoopLagMs = lag;
      }

      if (lag > this.eventLoopLagThresholdMs) {
        this._warn('Event loop lag: ' + lag + 'ms (threshold: ' + this.eventLoopLagThresholdMs + 'ms)');
      }

      this._lastLagCheck = now;
      this._lagCheckTimer = setTimeout(check, EXPECTED_DELAY);
    };

    this._lastLagCheck = Date.now();
    this._lagCheckTimer = setTimeout(check, EXPECTED_DELAY);
  }

  _warn(message) {
    this.stats.warningsIssued++;
    const entry = { time: new Date().toISOString(), message };
    this._warnings.push(entry);
    if (this._warnings.length > 20) this._warnings.shift();
    if (this.logger) {
      this.logger.warn('HealthWatchdog', message);
    }
  }

  _heal(message) {
    this.stats.selfHeals++;
    const entry = { time: new Date().toISOString(), message };
    this._healActions.push(entry);
    if (this._healActions.length > 20) this._healActions.shift();
    if (this.logger) {
      this.logger.info('HealthWatchdog', 'SELF-HEAL: ' + message);
    }
  }

  _log(message) {
    if (this.logger) {
      this.logger.info('HealthWatchdog', message);
    }
  }
}

module.exports = HealthWatchdog;
