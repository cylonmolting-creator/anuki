/**
 * LANE QUEUE
 *
 * OpenClaw-style serial execution queue per user/channel:
 * - Separate lane for each user/channel
 * - Messages in the same lane are processed sequentially (race condition prevention)
 * - Different lanes can run in parallel
 * - Timeout and retry mechanism
 * - Queue depth limit
 *
 * Why needed:
 * - If user sends messages rapidly, Claude calls can interfere with each other
 * - Session state can become corrupt
 * - Responses can arrive in wrong order
 */

class LaneQueue {
  constructor(config = {}, logger) {
    this.logger = logger;

    // Lane storage: Map<laneId, { queue: [], processing: boolean, currentTask: null }>
    this.lanes = new Map();

    // Configuration
    this.maxQueueDepth = config.maxQueueDepth || 10;
    this.taskTimeout = config.taskTimeout || 120000; // 2 minutes
    this.maxRetries = config.maxRetries || 2;

    // Stats
    this.stats = {
      totalEnqueued: 0,
      totalProcessed: 0,
      totalDropped: 0,
      totalTimedOut: 0,
      totalRetried: 0
    };

    this.log('Initialized | maxQueue=' + this.maxQueueDepth + ' timeout=' + this.taskTimeout + 'ms');
  }

  /**
   * Get lane ID from channel and user
   */
  getLaneId(channel, userId) {
    return channel + ':' + userId;
  }

  /**
   * Enqueue a task for processing
   * Returns a promise that resolves when task completes
   */
  async enqueue(channel, userId, task) {
    const laneId = this.getLaneId(channel, userId);

    // Get or create lane
    if (!this.lanes.has(laneId)) {
      this.lanes.set(laneId, {
        queue: [],
        processing: false,
        currentTask: null
      });
    }

    const lane = this.lanes.get(laneId);

    // Check queue depth
    if (lane.queue.length >= this.maxQueueDepth) {
      this.stats.totalDropped++;
      this.log(laneId + ' queue full, dropping task');
      throw new Error('Queue full for ' + laneId);
    }

    // Create task wrapper with promise
    const taskWrapper = {
      id: Date.now() + '-' + Math.random().toString(36).substring(2, 11),
      task,
      retries: 0,
      enqueuedAt: Date.now(),
      resolve: null,
      reject: null
    };

    const promise = new Promise((resolve, reject) => {
      taskWrapper.resolve = resolve;
      taskWrapper.reject = reject;
    });

    lane.queue.push(taskWrapper);
    this.stats.totalEnqueued++;

    this.log(laneId + ' enqueued task ' + taskWrapper.id + ' (queue: ' + lane.queue.length + ')');

    // Start processing if not already
    this._processLane(laneId);

    return promise;
  }

  /**
   * Get queue status for a lane
   */
  getQueueStatus(channel, userId) {
    const laneId = this.getLaneId(channel, userId);
    const lane = this.lanes.get(laneId);

    if (!lane) {
      return { queueLength: 0, processing: false, position: 0 };
    }

    return {
      queueLength: lane.queue.length,
      processing: lane.processing,
      currentTaskId: lane.currentTask?.id || null,
      waitTime: lane.queue.length > 0 ? (Date.now() - lane.queue[0].enqueuedAt) : 0
    };
  }

  /**
   * Clear queue for a lane
   */
  clearQueue(channel, userId) {
    const laneId = this.getLaneId(channel, userId);
    const lane = this.lanes.get(laneId);

    if (!lane) return 0;

    const dropped = lane.queue.length;

    // Reject all pending tasks
    for (const task of lane.queue) {
      task.reject(new Error('Queue cleared'));
    }

    lane.queue = [];
    this.log(laneId + ' queue cleared (' + dropped + ' tasks)');

    return dropped;
  }

  /**
   * Get global stats
   */
  getStats() {
    const activeLanes = Array.from(this.lanes.entries())
      .filter(([_, lane]) => lane.processing || lane.queue.length > 0)
      .map(([id, lane]) => ({
        id,
        queueLength: lane.queue.length,
        processing: lane.processing
      }));

    return {
      ...this.stats,
      activeLanes: activeLanes.length,
      lanes: activeLanes
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  async _processLane(laneId) {
    const lane = this.lanes.get(laneId);

    // Already processing or empty queue
    if (lane.processing || lane.queue.length === 0) {
      return;
    }

    lane.processing = true;

    while (lane.queue.length > 0) {
      const taskWrapper = lane.queue[0];
      lane.currentTask = taskWrapper;

      try {
        // Execute with timeout
        const result = await this._executeWithTimeout(taskWrapper.task, this.taskTimeout);

        taskWrapper.resolve(result);
        this.stats.totalProcessed++;

        this.log(laneId + ' completed task ' + taskWrapper.id);
      } catch (error) {
        // Check if we should retry
        if (taskWrapper.retries < this.maxRetries && this._isRetryableError(error)) {
          taskWrapper.retries++;
          this.stats.totalRetried++;
          this.log(laneId + ' retrying task ' + taskWrapper.id + ' (' + taskWrapper.retries + '/' + this.maxRetries + ')');

          // Move to end of queue for retry
          lane.queue.shift();
          lane.queue.push(taskWrapper);
          continue;
        }

        // Max retries exceeded or non-retryable error
        if (error.message === 'Task timeout') {
          this.stats.totalTimedOut++;
        }

        taskWrapper.reject(error);
        this.log(laneId + ' failed task ' + taskWrapper.id + ': ' + error.message);
      }

      // Remove completed/failed task
      lane.queue.shift();
      lane.currentTask = null;
    }

    lane.processing = false;

    // Clean up empty lanes after a delay
    setTimeout(() => {
      const currentLane = this.lanes.get(laneId);
      if (currentLane && currentLane.queue.length === 0 && !currentLane.processing) {
        this.lanes.delete(laneId);
      }
    }, 60000);
  }

  async _executeWithTimeout(task, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Task timeout'));
      }, timeout);

      Promise.resolve()
        .then(() => task())
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  _isRetryableError(error) {
    const retryablePatterns = [
      'timeout',
      'network',
      'ECONNRESET',
      'ETIMEDOUT',
      'rate limit',
      'overloaded',
      'temporarily'
    ];

    const errorLower = error.message.toLowerCase();
    return retryablePatterns.some(p => errorLower.includes(p));
  }

  /**
   * Graceful shutdown: reject all pending tasks, clear lanes and timers
   */
  shutdown() {
    let rejectedCount = 0;

    for (const [laneId, lane] of this.lanes) {
      // Reject all queued tasks
      for (const taskWrapper of lane.queue) {
        try {
          taskWrapper.reject(new Error('Server shutting down'));
          rejectedCount++;
        } catch (_) {
          // Promise may already be settled
        }
      }
      lane.queue = [];
      lane.currentTask = null;
      lane.processing = false;
    }

    this.lanes.clear();

    if (rejectedCount > 0) {
      this.log(`Shutdown: rejected ${rejectedCount} pending tasks`);
    }
  }

  log(msg) {
    if (this.logger) {
      this.logger.info('LaneQueue', msg);
    }
  }
}

module.exports = LaneQueue;
