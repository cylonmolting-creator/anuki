'use strict';

/**
 * AGENT SUPERVISOR
 *
 * Erlang/OTP-inspired supervision for agent processes.
 * Manages: circuit breakers, restart budgets, resource monitoring, health probes.
 *
 * Strategy: one_for_one — if one agent crashes, only that agent is restarted.
 * Each agent has its own CircuitBreaker, restart budget, and resource limits.
 *
 * Integration: Called by executor.js on agent spawn/exit/error.
 * Does NOT replace executor — it wraps execution decisions.
 */

const { execFileSync } = require('child_process');

// ═══════════════════════════════════════════════════════════
// CIRCUIT BREAKER — Per-agent failure tracking
// ═══════════════════════════════════════════════════════════

class CircuitBreaker {
  /**
   * @param {string} agentId
   * @param {object} options
   * @param {number} options.failureThreshold - Failures before opening (default: 5)
   * @param {number} options.successThreshold - Successes in half-open before closing (default: 3)
   * @param {number} options.timeout - Initial open→half-open timeout ms (default: 30000)
   * @param {number} options.maxTimeout - Max backoff timeout ms (default: 300000)
   * @param {number} options.resetWindow - Window to count failures ms (default: 300000)
   */
  constructor(agentId, options = {}) {
    this.agentId = agentId;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.successCount = 0;
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 3;
    this.timeout = options.timeout || 30000;
    this.maxTimeout = options.maxTimeout || 300000;
    this.resetWindow = options.resetWindow || 300000;
    this.currentTimeout = this.timeout;
    this.openedAt = null;
    this.lastFailureTime = null;
    this.failures = []; // timestamps of recent failures
  }

  /**
   * Check if execution is allowed.
   * @returns {{ allowed: boolean, reason?: string, retryAfterMs?: number }}
   */
  canExecute() {
    this._cleanOldFailures();

    if (this.state === 'CLOSED') {
      return { allowed: true };
    }

    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.currentTimeout) {
        // Transition to half-open — allow one test execution
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `circuit_open`,
        retryAfterMs: this.currentTimeout - elapsed
      };
    }

    // HALF_OPEN — allow execution (testing recovery)
    return { allowed: true };
  }

  /**
   * Record successful execution.
   */
  recordSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.failures = [];
        this.currentTimeout = this.timeout; // Reset backoff
      }
    } else if (this.state === 'CLOSED') {
      // Reset failure count on success
      this.failureCount = 0;
    }
  }

  /**
   * Record failed execution.
   */
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.failures.push(Date.now());

    if (this.state === 'HALF_OPEN') {
      // Any failure in half-open → back to open with increased backoff
      this._open();
    } else if (this.state === 'CLOSED') {
      this._cleanOldFailures();
      if (this.failures.length >= this.failureThreshold) {
        this._open();
      }
    }
  }

  /**
   * Force reset (manual intervention).
   */
  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.failures = [];
    this.currentTimeout = this.timeout;
    this.openedAt = null;
  }

  /**
   * Get state summary.
   */
  getStatus() {
    return {
      agentId: this.agentId,
      state: this.state,
      failureCount: this.failures.length,
      successCount: this.successCount,
      currentTimeoutMs: this.currentTimeout,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      lastFailure: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null
    };
  }

  _open() {
    this.state = 'OPEN';
    this.openedAt = Date.now();
    this.currentTimeout = Math.min(this.currentTimeout * 2, this.maxTimeout);
    this.successCount = 0;
  }

  _cleanOldFailures() {
    const cutoff = Date.now() - this.resetWindow;
    this.failures = this.failures.filter(t => t > cutoff);
  }
}

// ═══════════════════════════════════════════════════════════
// AGENT SUPERVISOR — Manages all agents
// ═══════════════════════════════════════════════════════════

class AgentSupervisor {
  /**
   * @param {object} logger
   * @param {object} options
   * @param {number} options.maxRestartsPerWindow - Max restarts per agent in window (default: 5)
   * @param {number} options.restartWindow - Window for restart counting ms (default: 300000)
   * @param {number} options.resourceCheckInterval - Resource check interval ms (default: 30000)
   * @param {number} options.maxMemoryMB - Max RSS per agent MB (default: 2048)
   * @param {number} options.maxCPUPercent - Max CPU per agent (default: 150 = 1.5 cores)
   */
  constructor(logger, options = {}) {
    this.logger = logger;
    this.agents = new Map(); // agentId → AgentState
    this.circuitBreakers = new Map(); // agentId → CircuitBreaker
    this.options = {
      maxRestartsPerWindow: options.maxRestartsPerWindow || 5,
      restartWindow: options.restartWindow || 300000, // 5 min
      resourceCheckInterval: options.resourceCheckInterval || 30000, // 30s
      maxMemoryMB: options.maxMemoryMB || 2048, // 2GB
      maxCPUPercent: options.maxCPUPercent || 150, // 1.5 cores
      ...options
    };

    this._resourceCheckTimer = null;
    this._listeners = new Map(); // event → [callbacks]
  }

  // ═══════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════════

  /**
   * Start resource monitoring loop.
   */
  start() {
    if (this._resourceCheckTimer) return;
    this._resourceCheckTimer = setInterval(
      () => this._checkResources(),
      this.options.resourceCheckInterval
    );
    this._log('Started (check interval: ' + this.options.resourceCheckInterval + 'ms)');
  }

  /**
   * Stop supervisor.
   */
  stop() {
    if (this._resourceCheckTimer) {
      clearInterval(this._resourceCheckTimer);
      this._resourceCheckTimer = null;
    }
    this._log('Stopped');
  }

  // ═══════════════════════════════════════════════════════════
  // AGENT REGISTRATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Register an agent for supervision.
   * Called when executor spawns a new agent process.
   */
  registerAgent(agentId, pid, info = {}) {
    const state = {
      agentId,
      pid,
      workspaceId: info.workspaceId || null,
      conversationId: info.conversationId || null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      restartHistory: this.agents.get(agentId)?.restartHistory || [],
      status: 'running', // running, stopping, stopped, circuit_open
      memoryMB: 0,
      cpuPercent: 0,
    };

    this.agents.set(agentId, state);

    // Create circuit breaker if not exists
    if (!this.circuitBreakers.has(agentId)) {
      this.circuitBreakers.set(agentId, new CircuitBreaker(agentId, {
        failureThreshold: this.options.maxRestartsPerWindow,
        timeout: 30000,
        maxTimeout: this.options.restartWindow,
        resetWindow: this.options.restartWindow
      }));
    }

    this._log(`Registered agent ${agentId} (PID: ${pid})`);
  }

  /**
   * Unregister agent (normal exit).
   */
  unregisterAgent(agentId) {
    const state = this.agents.get(agentId);
    if (state) {
      state.status = 'stopped';
      state.pid = null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // EXECUTION CONTROL
  // ═══════════════════════════════════════════════════════════

  /**
   * Check if agent is allowed to execute.
   * Called by executor BEFORE spawning claude CLI.
   *
   * @param {string} agentId
   * @returns {{ allowed: boolean, reason?: string, retryAfterMs?: number }}
   */
  canExecute(agentId) {
    const breaker = this.circuitBreakers.get(agentId);
    if (!breaker) return { allowed: true }; // Unknown agent = allow

    return breaker.canExecute();
  }

  /**
   * Record successful agent execution.
   */
  recordSuccess(agentId) {
    const breaker = this.circuitBreakers.get(agentId);
    if (breaker) breaker.recordSuccess();

    const state = this.agents.get(agentId);
    if (state) state.lastActivity = Date.now();
  }

  /**
   * Record failed agent execution (crash, error, timeout).
   * Returns whether restart is allowed.
   *
   * @param {string} agentId
   * @param {string} reason - Why it failed
   * @returns {{ restartAllowed: boolean, reason?: string, backoffMs?: number }}
   */
  recordFailure(agentId, reason = 'unknown') {
    const breaker = this.circuitBreakers.get(agentId);
    if (breaker) breaker.recordFailure();

    const state = this.agents.get(agentId);
    if (state) {
      state.restartHistory.push({
        timestamp: Date.now(),
        reason,
      });

      // Clean old restart history
      const cutoff = Date.now() - this.options.restartWindow;
      state.restartHistory = state.restartHistory.filter(r => r.timestamp > cutoff);
    }

    // Check circuit breaker
    const canExec = breaker ? breaker.canExecute() : { allowed: true };
    if (!canExec.allowed) {
      this._log(`Circuit OPEN for ${agentId}: ${reason} (${breaker.failures.length} failures in window)`);
      this._emit('circuit_open', { agentId, reason, status: breaker.getStatus() });

      if (state) state.status = 'circuit_open';

      return {
        restartAllowed: false,
        reason: 'circuit_open',
        backoffMs: canExec.retryAfterMs || this.options.restartWindow
      };
    }

    // Calculate backoff based on recent restart count
    const recentRestarts = state ? state.restartHistory.length : 0;
    const backoffMs = Math.min(1000 * Math.pow(2, recentRestarts), 60000);

    this._log(`Failure for ${agentId}: ${reason} (restart #${recentRestarts}, backoff: ${backoffMs}ms)`);

    return {
      restartAllowed: true,
      backoffMs,
      reason: `restart_${recentRestarts}`
    };
  }

  /**
   * Force reset circuit breaker for an agent.
   */
  resetCircuitBreaker(agentId) {
    const breaker = this.circuitBreakers.get(agentId);
    if (breaker) {
      breaker.reset();
      this._log(`Circuit breaker reset for ${agentId}`);
    }
    const state = this.agents.get(agentId);
    if (state && state.status === 'circuit_open') {
      state.status = 'stopped';
    }
  }

  // ═══════════════════════════════════════════════════════════
  // RESOURCE MONITORING
  // ═══════════════════════════════════════════════════════════

  /**
   * Check resource usage for all active agents.
   * Kills agents exceeding limits.
   */
  _checkResources() {
    for (const [agentId, state] of this.agents) {
      if (!state.pid || state.status !== 'running') continue;

      try {
        const usage = this._getProcessUsage(state.pid);
        if (!usage) continue;

        state.memoryMB = usage.memoryMB;
        state.cpuPercent = usage.cpuPercent;

        // Memory limit check
        if (usage.memoryMB > this.options.maxMemoryMB) {
          this._warn(`Agent ${agentId} (PID ${state.pid}) exceeding memory limit: ${usage.memoryMB}MB > ${this.options.maxMemoryMB}MB`);
          this._emit('resource_exceeded', {
            agentId,
            pid: state.pid,
            resource: 'memory',
            value: usage.memoryMB,
            limit: this.options.maxMemoryMB
          });
          // Kill the rogue process — supervisor will handle restart via circuit breaker
          try {
            process.kill(-state.pid, 'SIGTERM');
            this._warn(`Killed agent ${agentId} (PID ${state.pid}) for memory violation`);
          } catch (_) {}
        }

        // CPU limit check (sustained — only warn, don't kill immediately)
        if (usage.cpuPercent > this.options.maxCPUPercent) {
          this._warn(`Agent ${agentId} (PID ${state.pid}) high CPU: ${usage.cpuPercent}% > ${this.options.maxCPUPercent}%`);
          this._emit('resource_warning', {
            agentId,
            pid: state.pid,
            resource: 'cpu',
            value: usage.cpuPercent,
            limit: this.options.maxCPUPercent
          });
        }
      } catch (e) {
        // Process may have died between check and reading — that's OK
      }
    }
  }

  /**
   * Get process resource usage.
   * @param {number} pid
   * @returns {{ memoryMB: number, cpuPercent: number } | null}
   */
  _getProcessUsage(pid) {
    try {
      // Check if process exists first
      process.kill(pid, 0);

      // Get RSS (KB) and CPU%
      const output = execFileSync('ps', ['-p', String(pid), '-o', 'rss=,pcpu='], {
        encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      if (!output) return null;

      const parts = output.split(/\s+/);
      const rssKB = parseInt(parts[0]) || 0;
      const cpuPercent = parseFloat(parts[1]) || 0;

      return {
        memoryMB: Math.round(rssKB / 1024),
        cpuPercent: Math.round(cpuPercent * 10) / 10
      };
    } catch (e) {
      return null; // Process doesn't exist or ps failed
    }
  }

  // ═══════════════════════════════════════════════════════════
  // STATUS & EVENTS
  // ═══════════════════════════════════════════════════════════

  /**
   * Get full supervisor status.
   */
  getStatus() {
    const agents = {};
    for (const [id, state] of this.agents) {
      const breaker = this.circuitBreakers.get(id);
      agents[id] = {
        pid: state.pid,
        status: state.status,
        memoryMB: state.memoryMB,
        cpuPercent: state.cpuPercent,
        restartsInWindow: state.restartHistory.length,
        lastActivity: state.lastActivity ? new Date(state.lastActivity).toISOString() : null,
        circuitBreaker: breaker ? breaker.getStatus() : null
      };
    }
    return {
      agentCount: this.agents.size,
      agents,
      options: this.options
    };
  }

  /**
   * Subscribe to supervisor events.
   * Events: 'circuit_open', 'resource_exceeded', 'resource_warning'
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(callback);
  }

  _emit(event, data) {
    const callbacks = this._listeners.get(event) || [];
    for (const cb of callbacks) {
      try { cb(data); } catch (_) {}
    }
  }

  _log(msg) {
    if (this.logger) this.logger.info('Supervisor', msg);
  }

  _warn(msg) {
    if (this.logger) this.logger.warn('Supervisor', msg);
  }
}

module.exports = { AgentSupervisor, CircuitBreaker };
