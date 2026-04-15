const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Log sanitization — prevent log injection via newlines and control chars
function sanitizeForLog(input, maxLen = 200) {
  if (typeof input !== 'string') return String(input);
  // Strip control chars (newlines, tabs, null bytes, etc.) to prevent log line injection
  const sanitized = input.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return sanitized.length > maxLen ? sanitized.substring(0, maxLen) + '...' : sanitized;
}

/**
 * MessageRouter - Inter-Agent Communication Manager
 *
 * Handles agent-to-agent messaging with:
 * - Fire-and-forget (timeout = 0)
 * - Blocking mode with timeout
 * - Message persistence (JSONL logging)
 * - Security policy enforcement
 *
 * Architecture:
 * - Hub-and-spoke: All messages route through this central router
 * - Executor injection: Messages injected into target agent's conversation
 * - WebSocket broadcast: UI gets realtime updates
 */
class MessageRouter {
  constructor(options = {}) {
    this.agentManager = options.agentManager;
    this.wsServer = options.wsServer;
    this.executor = options.executor;
    this.conversationManager = options.conversationManager;
    this.logger = options.logger;
    this.policy = options.policy; // MessagePolicy instance

    // Pending messages map: messageId → { resolve, reject, timer, timestamp }
    this.pendingMessages = new Map();

    // Conversation cache: "from→to" → conversationId (reuse instead of creating new each time)
    this.conversationCache = new Map();

    // Circuit breaker: per-target-agent failure tracking
    // targetAgentId → { failures: number, lastFailure: timestamp, state: 'closed'|'open'|'half-open' }
    this.circuitBreakers = new Map();
    this.CIRCUIT_FAILURE_THRESHOLD = 5;  // consecutive failures to trip (was 2, too aggressive)
    this.CIRCUIT_COOLDOWN_MS = 60000;    // 60s cooldown before half-open (was 120s, too long)

    // Rate limiter: per-source-agent message tracking (prevent spam loops)
    // "sourceId→targetId" → { count: number, resetAt: timestamp }
    this.rateLimiters = new Map();
    this.RATE_LIMIT_WINDOW_MS = 60000;   // 60s window
    this.RATE_LIMIT_MAX_MESSAGES = 5;    // max 5 messages per source→target per minute

    // Retry config
    this.MAX_RETRIES = 2;
    this.RETRY_BACKOFF_MS = 10000;  // 10s between retries (agents need time to spin up)
    this._activeInterAgentConvs = new Map();  // messageId → conversationId (tracks which conv a message is using)

    // Delegation chain limits (roadmap 5.4)
    this.MAX_DELEGATION_DEPTH = 5; // Max hops: A→B→C→D→E→F (5 delegations)

    // Message log file (JSONL)
    const baseDir = require('../utils/base-dir');
    this.logFile = path.join(baseDir, 'data', 'inter-agent-messages.jsonl');

    // Ensure log directory exists
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Cleanup interval: remove stale pending messages every 60s
    this.cleanupInterval = setInterval(() => this._cleanupStale(), 60000);

    this.logger.info('MessageRouter', 'Initialized inter-agent message router');
  }

  /**
   * Send message from one agent to another
   *
   * @param {Object} options
   * @param {string} options.from - Source agent ID
   * @param {string} options.to - Target agent ID
   * @param {string} options.message - Message text
   * @param {number} [options.timeout=90] - Timeout in seconds (0 = fire-and-forget). Default increased to 90s for agent processing time.
   * @param {Object} [options.data] - Optional structured data
   * @param {string} [options.conversationId] - Optional conversation context
   * @returns {Promise<Object>} Response object: { status, messageId, reply?, error? }
   */
  async sendMessage(options) {
    const {
      from,
      to,
      message,
      timeout = 300,  // 5 minutes — Claude CLI can take a while, don't timeout prematurely
      data = null,
      conversationId = null,
      delegation = null,  // { originatorId, chainDepth, chainPath } — roadmap 5.4
      parentConversationId = null  // Link child job to parent for restart resume
    } = options;

    // Validate inputs
    if (!from || !to || !message) {
      throw new Error('sendMessage requires from, to, and message');
    }

    // Validate target agent ID format (reject garbage/false positives)
    // Must start with letter or digit, then allow alphanumeric, hyphens, underscores, dots (2-50 chars)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,49}$/.test(to)) {
      throw new Error(`Invalid target agent ID format: "${sanitizeForLog(to, 50)}"`);
    }

    // Prevent self-messaging loop (3 layers):
    // Layer 1: Direct string comparison
    if (from === to) {
      throw new Error('Self-messaging not allowed');
    }
    // Layer 2: Alias resolution via agentManager
    if (this.agentManager) {
      const resolvedFrom = this.agentManager.getAgent(from);
      const resolvedTo = this.agentManager.getAgent(to);
      if (resolvedFrom && resolvedTo && resolvedFrom.id === resolvedTo.id) {
        throw new Error(`Self-messaging not allowed (${from} and ${to} resolve to same agent: ${resolvedFrom.id})`);
      }
    } else {
      // Layer 3: Fallback when agentManager unavailable — check known master aliases
      const masterAliases = ['master', 'system'];
      if (masterAliases.includes(from.toLowerCase()) && masterAliases.includes(to.toLowerCase())) {
        throw new Error(`Self-messaging not allowed (both "${from}" and "${to}" are master aliases)`);
      }
    }

    // Delegation chain tracking & loop prevention (roadmap 5.4)
    // Build delegation context: track originator, depth, and path
    const chainDepth = delegation ? delegation.chainDepth + 1 : 0;
    const chainPath = delegation ? [...delegation.chainPath, from] : [from];
    const originatorId = delegation ? delegation.originatorId : from;

    // Depth limit: prevent runaway delegation chains
    if (chainDepth > this.MAX_DELEGATION_DEPTH) {
      const pathStr = chainPath.map(id => id.substring(0, 8)).join('→');
      this.logger.warn('MessageRouter', `Delegation depth exceeded (${chainDepth}/${this.MAX_DELEGATION_DEPTH}): ${pathStr}→${sanitizeForLog(to, 20)}`);
      throw new Error(`Delegation chain too deep (${chainDepth} hops, max ${this.MAX_DELEGATION_DEPTH}). Chain: ${pathStr}`);
    }

    // Cycle detection: prevent A→B→C→A loops
    if (chainPath.includes(to)) {
      const pathStr = chainPath.map(id => id.substring(0, 8)).join('→');
      this.logger.warn('MessageRouter', `Delegation loop detected: ${pathStr}→${sanitizeForLog(to, 20)} (${to.substring(0, 8)} already in chain)`);
      throw new Error(`Delegation loop detected: ${to.substring(0, 8)} already in chain. Path: ${pathStr}`);
    }

    // Originator self-loop: prevent messages returning to who started the chain
    if (chainDepth > 0 && to === originatorId) {
      this.logger.warn('MessageRouter', `Delegation loop back to originator: ${originatorId.substring(0, 8)} via ${chainPath.map(id => id.substring(0, 8)).join('→')}`);
      throw new Error(`Delegation loop: message would return to originator ${originatorId.substring(0, 8)}`);
    }

    // Attach delegation metadata for downstream agents
    const delegationContext = { originatorId, chainDepth, chainPath };

    // Security policy check
    if (this.policy) {
      const policyCheck = this.policy.canSend(from, to, message);
      if (!policyCheck.allowed) {
        this.logger.warn('MessageRouter', `Message blocked by policy: ${sanitizeForLog(policyCheck.reason, 100)}`);
        throw new Error(`Message blocked: ${sanitizeForLog(policyCheck.reason, 100)}`);
      }
    }

    const messageId = uuidv4();
    const timestamp = new Date().toISOString();

    const msg = {
      type: 'agent_message',
      id: messageId,
      timestamp,
      from: { agentId: from, conversationId },
      to: { agentId: to },
      payload: { message, data, delegation: delegationContext, parentConversationId },
      options: { timeout }
    };

    // Log message (sent)
    this._logMessage({ ...msg, direction: 'sent' });

    // Fire-and-forget mode
    if (timeout === 0) {
      setImmediate(() => {
        try {
          this._routeMessage(msg);
        } catch (err) {
          this.logger.error('MessageRouter', `Fire-and-forget route failed for ${sanitizeForLog(messageId, 36)}: ${sanitizeForLog(err.message, 150)}`);
        }
      });
      return { status: 'accepted', messageId };
    }

    // Circuit breaker check — fast-fail if target is tripped
    const cbState = this._checkCircuitBreaker(to);
    if (cbState === 'open') {
      this.logger.warn('MessageRouter', `Circuit breaker OPEN for agent "${sanitizeForLog(to, 50)}" — fast-failing`);
      this._logMessage({
        type: 'agent_response',
        requestId: messageId,
        status: 'circuit_open',
        timestamp: new Date().toISOString()
      });
      throw new Error(`Circuit breaker open for agent "${to}" — too many consecutive failures. Retry after cooldown.`);
    }

    // Blocking mode with timeout + retry logic
    return this._sendWithRetry(msg, timeout, 0);
  }

  /**
   * Send message with retry logic (max 2 retries, 5s backoff)
   * @private
   * @param {Object} msg - The message object
   * @param {number} timeout - Timeout per attempt in seconds
   * @param {number} attempt - Current attempt (0-based)
   * @returns {Promise<Object>}
   */
  _sendWithRetry(msg, timeout, attempt) {
    const messageId = msg.id;
    const targetAgentId = msg.to.agentId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._logMessage({
          type: 'agent_response',
          requestId: messageId,
          status: 'timeout',
          attempt: attempt + 1,
          timestamp: new Date().toISOString()
        });

        // Check if executor still has an active process for this message's conversation
        const convId = this._activeInterAgentConvs.get(messageId);
        const processStillRunning = convId && this.executor && this.executor.isProcessActive(convId);

        if (processStillRunning && attempt < this.MAX_RETRIES) {
          // Process is still working — DON'T spawn new process, just extend the timer
          this.logger.info('MessageRouter', `Message to "${sanitizeForLog(targetAgentId, 50)}" timeout (attempt ${attempt + 1}/${this.MAX_RETRIES + 1}) but process still active — extending wait`);

          // Keep the same pending entry, just reset the timer AND timestamp
          const pending = this.pendingMessages.get(messageId);
          if (pending) {
            const extendTimer = setTimeout(() => {
              // Recursive: check again after another timeout period
              this.pendingMessages.delete(messageId);
              this._sendWithRetry(msg, timeout, attempt + 1)
                .then(resolve)
                .catch(reject);
            }, timeout * 1000);
            pending.timer = extendTimer;
            pending.attempt = attempt + 1;
            pending.timestamp = Date.now(); // Reset timestamp so _cleanupStale doesn't kill active retries
          }
        } else if (!processStillRunning && attempt < this.MAX_RETRIES) {
          // Process died — retry with new process
          this.logger.warn('MessageRouter', `Message to "${sanitizeForLog(targetAgentId, 50)}" timeout (attempt ${attempt + 1}/${this.MAX_RETRIES + 1}), process dead — retrying in ${this.RETRY_BACKOFF_MS}ms`);
          this.pendingMessages.delete(messageId);
          this._activeInterAgentConvs.delete(messageId);  // Clear so new conversation can be created
          setTimeout(() => {
            this._sendWithRetry(msg, timeout, attempt + 1)
              .then(resolve)
              .catch(reject);
          }, this.RETRY_BACKOFF_MS);
        } else {
          // All retries exhausted — abort the running process if any, then fail
          this.pendingMessages.delete(messageId);
          if (convId && this.executor) {
            this.executor.abortProcess(convId);
            this.logger.warn('MessageRouter', `Aborted stale process for conversation ${convId}`);
          }
          this._activeInterAgentConvs.delete(messageId);
          this._recordFailure(targetAgentId);
          this.logger.error('MessageRouter', `Message to "${sanitizeForLog(targetAgentId, 50)}" failed after ${attempt + 1} attempts — all retries exhausted`);
          reject(new Error(`Message timeout after ${attempt + 1} attempts`));
        }
      }, timeout * 1000);

      this.pendingMessages.set(messageId, {
        resolve: (result) => {
          this._activeInterAgentConvs.delete(messageId);
          this._recordSuccess(targetAgentId);
          resolve(result);
        },
        reject: (err) => {
          this._activeInterAgentConvs.delete(messageId);
          reject(err);
        },
        timer,
        timestamp: Date.now(),
        attempt
      });

      // Only route (spawn new process) on first attempt, or if process died
      if (attempt === 0 || !this.executor.isProcessActive(this._activeInterAgentConvs.get(messageId))) {
        this._routeMessage(msg);
      }
    });
  }

  /**
   * Route message to target agent via executor injection
   *
   * All agents run in the same process, so we inject directly into the
   * target agent's executor. No network transport needed.
   * @private
   */
  _routeMessage(msg) {
    const targetAgentId = msg.to.agentId;

    // Check if target agent exists
    const targetAgent = this.agentManager.getAgent(targetAgentId);
    if (!targetAgent) {
      // Log available agents for debugging
      const available = this.agentManager.listAgents
        ? this.agentManager.listAgents().map(a => `${a.name || 'unnamed'}(${(a.id || '').substring(0, 8)})`).join(', ')
        : 'unknown';
      this.logger.warn('MessageRouter', `Target agent not found: "${sanitizeForLog(targetAgentId, 50)}" (from: ${sanitizeForLog(msg.from?.agentId || '?', 50)}). Available: [${available}]`);
      this._sendError(msg.id, `Target agent not found: ${sanitizeForLog(targetAgentId, 50)}`, targetAgentId);
      return;
    }

    // Check if target agent is running
    if (!targetAgent.running) {
      this.logger.warn('MessageRouter', `Target agent not running: "${sanitizeForLog(targetAgentId, 50)}" (${targetAgent.name || 'unnamed'})`);
      this._sendError(msg.id, `Target agent not running: ${sanitizeForLog(targetAgentId, 50)}`, targetAgentId);
      return;
    }

    // Inject message into target agent's executor
    this._injectToExecutor(targetAgentId, msg);
  }

  /**
   * Inject message into target agent's executor
   * @private
   */
  _injectToExecutor(agentId, msg) {
    if (!this.executor || !this.conversationManager) {
      this.logger.warn('MessageRouter', 'Executor or ConversationManager not available');
      this._sendError(msg.id, 'Executor not available', agentId);
      return;
    }

    // Find workspace ID for agent — use agent.id (the actual workspace ID), NOT the agentId parameter
    // agentId parameter might be a name string like "ENKI" (from name-based lookup in getAgent),
    // but workspace operations need the real ID from agents.json
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) {
      this.logger.warn('MessageRouter', `Agent not found for ID: ${agentId}`);
      this._sendError(msg.id, `Agent not found: ${agentId}`, agentId);
      return;
    }
    // Dynamic workspace resolution — NEVER hardcode workspace IDs
    const workspaceId = agent.isMaster && this.executor?.workspaceManager
      ? (this.executor.workspaceManager.getDefaultWorkspace()?.id || agent.id)
      : agent.id;  // Use agent.id (real ID from agents.json), NOT the agentId parameter which could be a name

    // Reuse existing inter-agent conversation for this agent pair, or create new one
    const cacheKey = `${msg.from.agentId}→${agentId}`;
    const convTitle = `Agent: ${msg.from.agentId} → ${agentId}`;
    let conversationId = this.conversationCache.get(cacheKey);

    // Verify cached conversation still exists
    if (conversationId) {
      const existing = this.conversationManager.getConversation(conversationId);
      if (!existing) {
        // Conversation was pruned — clear cache
        this.conversationCache.delete(cacheKey);
        conversationId = null;
      }
    }

    if (!conversationId) {
      // Use "ia-" prefix in the actual conversation ID to prevent collision with user conversations
      const iaId = `ia-${Date.now()}`;
      const conv = this.conversationManager.createConversationWithId(iaId, convTitle, workspaceId);
      conversationId = conv.id;  // Now equals "ia-xxx" — cache and lookup stay in sync
      this.conversationCache.set(cacheKey, conversationId);
    }

    // Trim old messages if conversation is getting large (keep last 20 messages)
    // FIX: Summarize truncated messages instead of silently dropping
    const MAX_AGENT_MESSAGES = 20;
    const existingConv = this.conversationManager.getConversation(conversationId);
    if (existingConv && existingConv.messages && existingConv.messages.length > MAX_AGENT_MESSAGES) {
      const toRemove = existingConv.messages.slice(0, -MAX_AGENT_MESSAGES);
      const toKeep = existingConv.messages.slice(-MAX_AGENT_MESSAGES);

      // Extract key topics from removed messages
      const topics = toRemove
        .filter(m => m.role === 'user' && m.content && m.content.length > 10)
        .map(m => m.content.substring(0, 100))
        .slice(-5);

      const summary = {
        role: 'system',
        content: `[Previous ${toRemove.length} messages summarized]\nTopics: ${topics.join('; ') || 'general conversation'}`,
        timestamp: new Date().toISOString(),
        isCompacted: true
      };

      existingConv.messages = [summary, ...toKeep];
      this.conversationManager.updateConversation(conversationId, { messages: existingConv.messages });
    }

    // Add the incoming message to conversation
    this.conversationManager.addMessage(conversationId, 'user', msg.payload.message);

    const messageId = msg.id;
    const startTime = Date.now();
    const self = this;

    // Track which conversation this message is using (for retry duplicate prevention)
    this._activeInterAgentConvs.set(messageId, conversationId);

    // Build delegation info string for agent awareness (roadmap 5.4)
    const delegation = msg.payload.delegation;
    const chainInfo = delegation && delegation.chainDepth > 0
      ? ` (delegation chain: ${delegation.chainPath.map(id => id.substring(0, 8)).join('→')}, depth: ${delegation.chainDepth}/${this.MAX_DELEGATION_DEPTH})`
      : '';

    // Execute via agentExecutor (same as normal chat flow)
    try {
      this.executor.execute({
        workspaceId: workspaceId,
        conversationId: conversationId,
        userMessage: `[Inter-agent message — from agent ${msg.from.agentId}${chainInfo}]\n\n${msg.payload.message}`,
        channel: 'agent',
        userId: msg.from.agentId,
        parentConversationId: msg.payload.parentConversationId || null,  // Track parent job for restart resume
        delegationContext: delegation || null,  // Pass delegation chain for AGENT_MESSAGE tag processing (roadmap 5.4)
        onEvent: () => {},
        onComplete: (result) => {
          const reply = (result.response || '').trim();
          const latency = Date.now() - startTime;
          self.logger.info('MessageRouter', `Agent ${agentId} replied (${reply.length} chars, ${latency}ms): ${reply.substring(0, 100)}`);

          // Save reply to conversation
          if (reply) {
            self.conversationManager.addMessage(conversationId, 'assistant', reply);
          }

          // Log the response
          self._logMessage({
            type: 'agent_response',
            requestId: messageId,
            status: 'ok',
            reply: reply,
            conversationId: conversationId,
            latency: latency,
            timestamp: new Date().toISOString(),
            direction: 'received'
          });

          // Resolve pending promise if blocking mode
          self.handleResponse({
            requestId: messageId,
            status: 'ok',
            reply: reply
          });

          // Broadcast to WebSocket for UI (inter-agent chat history)
          if (self.wsServer) {
            self.wsServer.broadcast({
              type: 'inter_agent_message',
              data: {
                messageId: messageId,
                from: msg.from.agentId,
                to: agentId,
                message: msg.payload.message,
                reply: reply,
                conversationId: conversationId,
                startedAt: msg.timestamp,
                completedAt: new Date().toISOString(),
                latency: latency
              }
            });
          }
        },
        onError: (err) => {
          self.logger.error('MessageRouter', `Agent ${agentId} execution error: ${err.message}`);
          self._sendError(messageId, err.message);
        }
      });
    } catch (err) {
      this.logger.error('MessageRouter', `Failed to inject message to agent ${sanitizeForLog(agentId, 50)}: ${sanitizeForLog(err.message, 150)}`);
      this._sendError(messageId, `Executor injection failed: ${err.message}`);
    }

    this.logger.info('MessageRouter', `Message injected to agent ${agentId} executor: ${messageId}`);
  }

  /**
   * Handle response from target agent
   * Resolves/rejects pending promises for blocking mode.
   * @param {Object} response
   */
  handleResponse(response) {
    const { requestId, status, reply, error } = response;

    const pending = this.pendingMessages.get(requestId);
    if (!pending) {
      // No pending entry — either fire-and-forget mode or stale cleanup already removed it.
      // Log a warning if there's a reply (means work was done but response was lost).
      if (reply && reply.length > 0) {
        this.logger.warn('MessageRouter', `handleResponse: reply received for ${requestId} (${reply.length} chars) but no pending entry — response lost (likely cleaned up by stale sweep)`);
        // Still log the response so it's not completely lost
        this._logMessage({
          type: 'agent_response_orphaned',
          requestId,
          status,
          reply: reply.substring(0, 200),
          timestamp: new Date().toISOString(),
          note: 'Reply arrived after pending entry was cleaned up'
        });
      }
      return;
    }

    clearTimeout(pending.timer);
    this.pendingMessages.delete(requestId);

    if (status === 'ok') {
      pending.resolve({ status, reply, messageId: requestId });
    } else {
      pending.reject(new Error(error || 'Unknown error'));
    }
  }

  /**
   * Send error response
   * @private
   * @param {string} messageId - Message ID (may contain _retryN suffix)
   * @param {string} errorMsg - Error message
   * @param {string} [targetAgentId] - Target agent ID for circuit breaker tracking
   */
  _sendError(messageId, errorMsg, targetAgentId) {
    const response = {
      type: 'agent_response',
      requestId: messageId,
      status: 'error',
      error: errorMsg,
      timestamp: new Date().toISOString()
    };

    this._logMessage({ ...response, direction: 'received' });

    // Record failure for circuit breaker (routing errors count as failures)
    if (targetAgentId) {
      this._recordFailure(targetAgentId);
    }

    this.handleResponse(response);
  }

  /**
   * Log message to JSONL file with automatic rotation (max 5MB)
   * @private
   */
  _logMessage(msg) {
    try {
      const line = JSON.stringify(msg) + '\n';
      fs.appendFileSync(this.logFile, line, 'utf8');

      // Rotate if log exceeds 5MB
      try {
        const stats = fs.statSync(this.logFile);
        if (stats.size > 5 * 1024 * 1024) {
          const rotatedFile = this.logFile + '.old';
          if (fs.existsSync(rotatedFile)) fs.unlinkSync(rotatedFile);
          fs.renameSync(this.logFile, rotatedFile);
          this.logger.info('MessageRouter', 'Rotated inter-agent log file (>5MB)');
        }
      } catch (_) { /* stat/rotate failure is non-fatal */ }
    } catch (e) {
      this.logger.error('MessageRouter', `Failed to log message: ${e.message}`);
    }
  }

  /**
   * Cleanup stale pending messages — only truly orphaned ones.
   * A message is stale if:
   *   1. Its timestamp is older than staleThreshold AND
   *   2. The target agent's process is NOT actively running
   * This prevents killing valid retry chains where the agent is still working.
   * @private
   */
  _cleanupStale() {
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000; // 10 minutes (was 5 — too aggressive for long-running agents)

    for (const [messageId, pending] of this.pendingMessages) {
      if (now - pending.timestamp > staleThreshold) {
        // Check if the target agent's process is still active before cleaning up
        const convId = this._activeInterAgentConvs.get(messageId);
        const processActive = convId && this.executor && this.executor.isProcessActive(convId);

        if (processActive) {
          // Agent still working — update timestamp to prevent re-checking immediately
          this.logger.info('MessageRouter', `Stale check: message ${messageId} old but agent process still active — keeping alive`);
          pending.timestamp = now; // Reset so we don't spam this log every 60s
        } else {
          this.logger.warn('MessageRouter', `Cleaning up stale message: ${messageId} (no active process)`);
          clearTimeout(pending.timer);
          this.pendingMessages.delete(messageId);
          this._activeInterAgentConvs.delete(messageId);
        }
      }
    }
  }

  /**
   * Check circuit breaker state for a target agent
   * @private
   * @param {string} agentId - Target agent ID
   * @returns {'closed'|'open'|'half-open'}
   */
  _checkCircuitBreaker(agentId) {
    const cb = this.circuitBreakers.get(agentId);
    if (!cb) return 'closed';

    if (cb.state === 'open') {
      // Check if cooldown has passed → transition to half-open
      if (Date.now() - cb.lastFailure >= this.CIRCUIT_COOLDOWN_MS) {
        cb.state = 'half-open';
        this.logger.info('MessageRouter', `Circuit breaker HALF-OPEN for "${sanitizeForLog(agentId, 50)}" — allowing probe request`);
        return 'half-open';
      }
      return 'open';
    }

    return cb.state || 'closed';
  }

  /**
   * Record a failure for circuit breaker tracking
   * @private
   * @param {string} agentId - Target agent ID
   */
  _recordFailure(agentId) {
    let cb = this.circuitBreakers.get(agentId);
    if (!cb) {
      cb = { failures: 0, lastFailure: 0, state: 'closed' };
      this.circuitBreakers.set(agentId, cb);
    }

    cb.failures++;
    cb.lastFailure = Date.now();

    if (cb.failures >= this.CIRCUIT_FAILURE_THRESHOLD) {
      cb.state = 'open';
      this.logger.warn('MessageRouter', `Circuit breaker OPEN for "${sanitizeForLog(agentId, 50)}" after ${cb.failures} consecutive failures — cooldown ${this.CIRCUIT_COOLDOWN_MS / 1000}s`);
    }
  }

  /**
   * Record a success — reset circuit breaker for agent
   * @private
   * @param {string} agentId - Target agent ID
   */
  _recordSuccess(agentId) {
    const cb = this.circuitBreakers.get(agentId);
    if (cb) {
      if (cb.state !== 'closed') {
        this.logger.info('MessageRouter', `Circuit breaker CLOSED for "${sanitizeForLog(agentId, 50)}" — recovered`);
      }
      cb.failures = 0;
      cb.state = 'closed';
    }
  }

  /**
   * Shutdown: clear all pending messages and intervals
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Reject all pending messages
    for (const [messageId, pending] of this.pendingMessages) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Router shutdown'));
    }
    this.pendingMessages.clear();
    this.conversationCache.clear();
    this.circuitBreakers.clear();

    this.logger.info('MessageRouter', 'Shutdown complete');
  }
}

module.exports = MessageRouter;
