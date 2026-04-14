'use strict';

/**
 * PID Registry — tracks all child processes spawned by Anuki.
 *
 * On boot: checks children.json, kills any still-running orphans.
 * On spawn: registers PID.
 * On exit: unregisters PID.
 * On shutdown: provides list of all active PIDs for cleanup.
 *
 * File: data/children.json
 * Format: { "children": [{ pid, pgid, convId, workspaceId, startedAt }] }
 */

const fs = require('fs');
const path = require('path');
const { atomicWriteJsonSync } = require('../utils/atomic-write');

const DATA_DIR = path.join(require('../utils/base-dir'), 'data');
const CHILDREN_FILE = path.join(DATA_DIR, 'children.json');

class PidRegistry {
  constructor(logger) {
    this.logger = logger;
    this.children = new Map(); // pid → { pgid, convId, workspaceId, startedAt }

    // Ensure data dir exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /**
   * Register a child process.
   */
  register(pid, info = {}) {
    const entry = {
      pid,
      pgid: pid, // For detached processes, pgid = its own pid
      convId: info.conversationId || null,
      workspaceId: info.workspaceId || null,
      startedAt: new Date().toISOString()
    };

    this.children.set(pid, entry);
    this._persist();

    if (this.logger) {
      this.logger.info('PidRegistry', `Registered child PID ${pid} (conv: ${entry.convId})`);
    }
  }

  /**
   * Unregister a child process (on normal exit).
   */
  unregister(pid) {
    if (this.children.has(pid)) {
      this.children.delete(pid);
      this._persist();
      if (this.logger) {
        this.logger.info('PidRegistry', `Unregistered child PID ${pid}`);
      }
    }
  }

  /**
   * Get all registered children (for shutdown).
   */
  getAll() {
    return Array.from(this.children.values());
  }

  /**
   * Boot-time orphan cleanup.
   * Reads children.json from previous run, checks which PIDs are still alive,
   * kills any orphans (process group kill for thoroughness).
   *
   * @returns {number} Number of orphans killed
   */
  cleanupOrphans() {
    let orphansKilled = 0;

    try {
      if (!fs.existsSync(CHILDREN_FILE)) return 0;

      const raw = fs.readFileSync(CHILDREN_FILE, 'utf8');
      const data = JSON.parse(raw);
      const prevChildren = data.children || [];

      if (prevChildren.length === 0) return 0;

      if (this.logger) {
        this.logger.info('PidRegistry', `Found ${prevChildren.length} child(ren) from previous run, checking for orphans...`);
      }

      for (const child of prevChildren) {
        const pid = child.pid;
        if (!pid) continue;

        // Check if process is still alive
        try {
          process.kill(pid, 0); // Signal 0 = check existence, don't kill
        } catch (e) {
          // Process doesn't exist — already dead, skip
          continue;
        }

        // Process is still alive — it's an orphan from previous run
        if (this.logger) {
          this.logger.warn('PidRegistry', `Orphan detected: PID ${pid} (conv: ${child.convId}, started: ${child.startedAt})`);
        }

        // Try process group kill first (kills all descendants)
        try {
          process.kill(-pid, 'SIGTERM');
          if (this.logger) {
            this.logger.info('PidRegistry', `Sent SIGTERM to process group -${pid}`);
          }
        } catch (e) {
          // Process group kill failed — try individual
          try {
            process.kill(pid, 'SIGTERM');
          } catch (_) { /* already dead */ }
        }

        orphansKilled++;
      }

      // Give orphans 3s to die, then SIGKILL survivors
      if (orphansKilled > 0) {
        setTimeout(() => {
          for (const child of prevChildren) {
            try {
              process.kill(child.pid, 0); // Still alive?
              process.kill(-child.pid, 'SIGKILL'); // Force kill group
              if (this.logger) {
                this.logger.warn('PidRegistry', `SIGKILL sent to orphan process group -${child.pid}`);
              }
            } catch (_) { /* dead — good */ }
          }
        }, 3000);
      }

    } catch (e) {
      if (this.logger) {
        this.logger.warn('PidRegistry', `Orphan cleanup error: ${e.message}`);
      }
    }

    // Clear the file — we've handled all previous children
    this._persist();

    return orphansKilled;
  }

  /**
   * Shutdown: kill all registered children.
   * Two-phase: SIGTERM → wait → SIGKILL
   *
   * @param {number} [graceMs=3000] - Grace period before SIGKILL
   * @returns {Promise<number>} Number of children killed
   */
  async killAll(graceMs = 3000) {
    const children = this.getAll();
    if (children.length === 0) return 0;

    if (this.logger) {
      this.logger.info('PidRegistry', `Killing ${children.length} child process(es)...`);
    }

    // Phase 1: SIGTERM all process groups
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGTERM');
        if (this.logger) {
          this.logger.info('PidRegistry', `SIGTERM → process group -${child.pid} (conv: ${child.convId})`);
        }
      } catch (e) {
        // Try individual kill if group kill fails
        try { process.kill(child.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
      }
    }

    // Phase 2: Wait for grace period
    await new Promise(resolve => setTimeout(resolve, graceMs));

    // Phase 3: SIGKILL survivors
    let killed = 0;
    for (const child of children) {
      try {
        process.kill(child.pid, 0); // Check if still alive
        process.kill(-child.pid, 'SIGKILL');
        if (this.logger) {
          this.logger.warn('PidRegistry', `SIGKILL → process group -${child.pid} (survived SIGTERM)`);
        }
        killed++;
      } catch (_) {
        // Already dead — good
        killed++;
      }
    }

    // Clear registry
    this.children.clear();
    this._persist();

    return killed;
  }

  /**
   * Persist registry to disk (atomic write).
   */
  _persist() {
    try {
      const data = {
        children: Array.from(this.children.values()),
        updatedAt: new Date().toISOString(),
        parentPid: process.pid
      };
      atomicWriteJsonSync(CHILDREN_FILE, data);
    } catch (e) {
      if (this.logger) {
        this.logger.warn('PidRegistry', `Failed to persist: ${e.message}`);
      }
    }
  }
}

module.exports = PidRegistry;
