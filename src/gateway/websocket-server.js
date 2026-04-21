const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const Logger = require('../utils/logger');
const RequestTracer = require('../core/request-tracer');

class GatewayWebSocketServer {
  constructor(server, logger, agentExecutor, conversationManager) {
    this.server = server;
    this.logger = logger;
    this.agentExecutor = agentExecutor;
    this.conversationManager = conversationManager;
    this.security = null;
    this.startTime = Date.now(); // Track server start for restart detection
    this.requestTracer = new RequestTracer(logger); // Roadmap 10.1: Request tracing

    // Security limits
    this.maxClients = 50;
    this.maxMessageSize = 65536; // 64KB
    this.rateLimit = new Map(); // connectionId -> { count, resetAt }
    this.rateLimitWindow = 60000; // 1 minute
    this.rateLimitMax = 200; // max messages per window (was 30 — too low, ping/pong alone consumed it)

    this.clients = new Map(); // connectionId -> { ws, workspaceId, conversationId, heartbeat }

    // Message deduplication: messageId -> timestamp (5-min TTL)
    this._dedupCache = new Map();
    this._dedupTTL = 5 * 60 * 1000; // 5 minutes
    this._dedupCleanupTimer = setInterval(() => this._cleanDedupCache(), 60000);

    // Resume event buffer: when a resumed job streams events but no client is watching,
    // buffer them so they can be replayed when a client selects that conversation.
    this._resumeBuffers = new Map(); // conversationId -> { events: [], processing: bool, fullResponse: string }

    // Pending completions from self-restart: stored at boot, delivered when clients connect
    // Solves "broadcast to 0 clients" race condition
    this._pendingCompletions = []; // Array of { conversationId, response, completedAt, ... }

    this.wss = new WebSocketServer({
      server,
      verifyClient: (info, callback) => {
        const origin = info.origin || info.req.headers.origin || null;
        const ip = info.req.socket.remoteAddress;

        // Max client check
        if (this.clients.size >= this.maxClients) {
          this.logger.warn('WebSocket', `REJECTED max clients (${this.maxClients}) from ${ip}`);
          return callback(false, 503, 'Server full');
        }

        // Accept localhost connections without auth (for Web UI)
        const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

        // Origin + token validation (if security module present, skip for localhost)
        if (this.security && !isLocal) {
          if (origin && !this.security.validateOrigin(origin)) {
            this.logger.warn('WebSocket', `REJECTED invalid origin: ${origin} from ${ip}`);
            return callback(false, 403, 'Origin not allowed');
          }
          if (!this.security.authenticateWebSocket(info.req)) {
            this.logger.warn('WebSocket', `REJECTED no valid token from ${ip}`);
            return callback(false, 401, 'Authentication required');
          }
        }

        callback(true);
      }
    });

    this.wss.on('connection', (ws) => this._handleConnection(ws));

    // Rate limit cleanup every minute
    this._rateLimitCleanup = setInterval(() => {
      const now = Date.now();
      for (const [id, rl] of this.rateLimit) {
        if (now > rl.resetAt) this.rateLimit.delete(id);
      }
    }, 60000);

    // Stale resume buffer cleanup every 10 minutes
    // Prevents memory leak from completed/abandoned resume buffers
    this._resumeBufferCleanup = setInterval(() => {
      if (!this._resumeBuffers || this._resumeBuffers.size === 0) return;
      for (const [convId, buf] of this._resumeBuffers) {
        // Remove completed buffers older than 5 minutes (no client picked them up)
        if (!buf.processing && buf._completedAt && Date.now() - buf._completedAt > 5 * 60 * 1000) {
          this._resumeBuffers.delete(convId);
          this.logger.info('WebSocket', `Cleaned stale resume buffer: ${convId}`);
        }
      }
    }, 10 * 60 * 1000);
  }

  _handleConnection(ws) {
    const connectionId = uuidv4();

    // Track liveness for dead connection cleanup
    let isAlive = true;

    // Heartbeat: send app-level ping every 60s
    // During active agent processing, still send pings so client knows connection is alive
    const heartbeat = setInterval(() => {
      const client = this.clients.get(connectionId);
      if (client && client._processing) {
        // Still send ping during processing — client needs to know connection is alive
        isAlive = true;
        this._send(ws, { type: 'ping' });
        return;
      }
      if (!isAlive) {
        this.logger.warn('WebSocket', `Client ${connectionId} unresponsive, terminating`);
        clearInterval(heartbeat);
        ws.terminate();
        return;
      }
      isAlive = false;
      this._send(ws, { type: 'ping' });
    }, 60000);

    this.clients.set(connectionId, {
      id: connectionId,
      ws,
      workspaceId: null,
      conversationId: null,
      heartbeat,
      markAlive: () => { isAlive = true; },
      requestId: uuidv4(), // Unique ID for this WebSocket connection (roadmap 10.1)
      _connectedAt: Date.now(),
    });

    this.logger.info('WebSocket', `Client connected: ${connectionId}`);

    ws.on('message', async (data) => {
      try {
        // Message size limit (64KB)
        if (data.length > this.maxMessageSize) {
          this._sendError(ws, 'Message too large');
          return;
        }

        const message = JSON.parse(data.toString());

        // Rate limiting — exempt keepalive messages (ping/pong)
        if (message.type !== 'pong' && message.type !== 'ping') {
          if (this._isRateLimited(connectionId)) {
            this._sendError(ws, 'Rate limited');
            return;
          }
        }
        await this._handleMessage(connectionId, message);
      } catch (e) {
        this.logger.error('WebSocket', 'Message handling error', e.message);
        this._sendError(ws, 'Invalid message format');
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      const uptime = Math.round((Date.now() - (this.clients.get(connectionId)?._connectedAt || Date.now())) / 1000);
      this.logger.info('WebSocket', `Client disconnected: ${connectionId} | code=${code} reason="${reasonStr}" uptime=${uptime}s`);
      const client = this.clients.get(connectionId);
      if (client && client.heartbeat) {
        clearInterval(client.heartbeat);
      }
      this.clients.delete(connectionId);
      this.rateLimit.delete(connectionId);
    });

    ws.on('error', (error) => {
      this.logger.error('WebSocket', `Connection error: ${connectionId}`, error.message);
      const client = this.clients.get(connectionId);
      if (client) {
        if (client.heartbeat) clearInterval(client.heartbeat);
        this.clients.delete(connectionId);
      }
    });

    // Handle native WebSocket pong frames (browser auto-responds to ws.ping())
    ws.on('pong', () => {
      isAlive = true;
    });

    // Collect active resume conversation IDs for the welcome message
    const activeResumes = [];
    if (this._resumeBuffers) {
      for (const [convId, buf] of this._resumeBuffers) {
        if (buf.processing) activeResumes.push(convId);
      }
    }

    // Send welcome message
    this._send(ws, {
      type: 'connected',
      connectionId,
      timestamp: new Date().toISOString(),
      serverStartTime: this.startTime,
      staticHash: this.staticHash,
      isResuming: global.isResumingSession || false,
      activeResumes: activeResumes.length > 0 ? activeResumes : undefined
    });
  }

  async _handleMessage(connectionId, message) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    const { ws, requestId } = client;

    // Start tracing this WebSocket message (roadmap 10.1)
    this.requestTracer.startTrace(requestId, 'websocket', {
      connectionId: connectionId.substring(0, 8),
      messageType: message.type,
      conversationId: client.conversationId,
    });

    switch (message.type) {
      case 'select-workspace':
      case 'select': // Legacy alias
        await this._handleSelectWorkspace(connectionId, message);
        break;

      case 'send-message':
      case 'message': // Legacy alias
        await this._handleSendMessage(connectionId, message);
        break;

      case 'abort':
      case 'cancel': // Legacy alias
        await this._handleAbort(connectionId, message);
        break;

      case 'pong':
        // Heartbeat response — mark client as alive
        if (client.markAlive) client.markAlive();
        break;

      case 'ping':
        this._send(ws, { type: 'pong', timestamp: new Date().toISOString() });
        break;

      case 'test-stream':
        await this._handleTestStream(connectionId, message);
        break;

      default:
        this.logger.warn('WebSocket', `Unknown message type: ${message.type}`);
    }
  }

  async _handleSelectWorkspace(connectionId, message) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    // Use actual default workspace UUID if workspaceId not provided
    const defaultWsId = this.agentExecutor?.workspaceManager?.getDefaultWorkspace()?.id || 'default';
    client.workspaceId = message.workspaceId || defaultWsId;
    client.conversationId = message.conversationId;

    this.logger.info('WebSocket', `Conversation selected: ${client.conversationId}`);

    // Send connection acknowledgement
    // Just save the current conversation ID
    if (this.conversationManager && client.conversationId) {
      const data = this.conversationManager.getAllConversations();
      data.currentId = client.conversationId;
      this.conversationManager.saveConversations(data);
    }

    // RESUME REPLAY: If this conversation has buffered resume events, flush them
    if (client.conversationId && this._resumeBuffers) {
      const buf = this._resumeBuffers.get(client.conversationId);
      if (buf) {
        this.logger.info('WebSocket', `Replaying ${buf.events.length} buffered resume events for conv ${client.conversationId}`);

        // If job already completed, send the full response as a single message
        if (!buf.processing && buf.fullResponse) {
          this._send(client.ws, { type: 'text', content: buf.fullResponse });
          this._send(client.ws, { type: 'complete', response: buf.fullResponse });
          this._send(client.ws, { type: 'done', code: 0 });
          this._cleanResumeBuffer(client.conversationId);
        } else if (buf.processing) {
          // Job still running — send what we have so far and mark client as watching
          // Future events will now be delivered directly via broadcastToConversation
          if (buf.fullResponse) {
            this._send(client.ws, { type: 'system', content: 'Resumed job in progress...' });
            this._send(client.ws, { type: 'text', content: buf.fullResponse });
          }
          // Don't clean buffer yet — job still active, but now client is watching
          // so broadcastToConversation will deliver future events directly
          this.logger.info('WebSocket', `Client now watching active resumed job for conv ${client.conversationId}`);
        }
      }
    }

    // Also notify client about ANY active resumed job in their workspace
    // (even if they haven't selected the specific conversation yet)
    if (this._resumeBuffers && this._resumeBuffers.size > 0) {
      for (const [convId, buf] of this._resumeBuffers) {
        if (buf.processing && convId !== client.conversationId) {
          // There's an active resume in a different conversation — notify client
          this._send(client.ws, {
            type: 'resume-active',
            conversationId: convId,
            message: 'A previously interrupted job is being resumed'
          });
        }
      }
    }

    // PENDING COMPLETIONS: If this conversation has a pending completion from
    // a previous self-restart, deliver it now. This solves the race condition
    // where boot broadcasts to 0 clients before any client has connected.
    if (client.conversationId) {
      this._deliverPendingCompletion(client, client.conversationId);
    }
  }

  async _handleSendMessage(connectionId, msg) {
    const client = this.clients.get(connectionId);
    if (!client) {
      return;
    }

    // Message deduplication — reject if messageId already processed
    if (msg.messageId && this._dedupCache.has(msg.messageId)) {
      this.logger.info('WebSocket', `Duplicate message rejected: ${msg.messageId}`);
      this._send(client.ws, { type: 'duplicate', messageId: msg.messageId });
      return;
    }
    if (msg.messageId) this._dedupCache.set(msg.messageId, Date.now());

    // Support multiple message field names for backwards compatibility
    const userMessage = msg.userMessage || msg.message || msg.content || '';
    const images = msg.images || [];

    if (!userMessage && images.length === 0) {
      this._sendError(client.ws, 'Empty message');
      return;
    }

    // Update workspace from message (UI sends it with each message for multi-agent support)
    // Fallback to client's stored workspaceId if not provided
    // UI sends the workspace the user is currently viewing — this takes priority
    const uiRequestedWorkspace = msg.workspaceId || null;
    const defaultWsIdMsg = this.agentExecutor?.workspaceManager?.getDefaultWorkspace()?.id || 'default';
    client.workspaceId = uiRequestedWorkspace || client.workspaceId || defaultWsIdMsg;

    // SINGLE CONVERSATION PER AGENT: Ignore UI-sent conversationId.
    // Always find or create the workspace's canonical conversation.
    // This eliminates cross-agent contamination, stale ID bugs, and duplicate chats.

    // Generate request ID for tracking this message through the entire processing chain
    const requestId = Logger.generateRequestId();

    this.logger.info('WebSocket', `Processing message in workspace ${client.workspaceId}`, { requestId });

    // Get or create the workspace's single conversation
    let conv = null;
    if (this.conversationManager) {
      // Find existing conversations for this workspace (sorted by updatedAt desc)
      const wsConvs = this.conversationManager.getWorkspaceConversations(client.workspaceId);
      // Filter out inter-agent conversations (ia-*) — those are system-managed
      const userConvs = wsConvs.filter(c => !c.id.startsWith('ia-'));

      if (userConvs.length > 0) {
        // Use the conversation with most messages (the canonical one)
        conv = userConvs.reduce((best, c) => (c.messages?.length || 0) > (best.messages?.length || 0) ? c : best, userConvs[0]);
        if (userConvs.length > 1) {
          this.logger.info('WebSocket', `Workspace ${client.workspaceId} has ${userConvs.length} conversations — using canonical: ${conv.id} (${conv.messages?.length || 0} msgs)`, { requestId });
        }
      }

      if (!conv) {
        // Auto-create the workspace's single conversation
        const title = (userMessage || 'New chat').substring(0, 50) + (userMessage.length > 50 ? '...' : '');
        conv = this.conversationManager.createConversation(title, client.workspaceId);
        this.logger.info('WebSocket', `Created canonical conversation for workspace ${client.workspaceId}: ${conv.id}`, { requestId });
      }

      client.conversationId = conv.id;

      // Notify UI of the active conversation (in case it had a stale ID)
      this._send(client.ws, {
        type: 'conversationSync',
        conversationId: conv.id,
        title: conv.title
      });

      // Add user message to conversation
      this.conversationManager.addMessage(client.conversationId, 'user', userMessage);
    }

    // Capture conversationId locally so it doesn't change if user switches chats
    const activeConvId = client.conversationId;

    // Send acknowledgment
    this._send(client.ws, {
      type: 'message-received',
      conversationId: activeConvId
    });

    // Check if conversation is already being processed — if so, executor will queue the message
    const isConversationBusy = this.agentExecutor.isRunning(activeConvId);
    if (isConversationBusy) {
      this.logger.info('WebSocket', `Conversation ${activeConvId} is busy — message will be queued for resume`);
      // Notify user their message was queued
      this._send(client.ws, {
        type: 'message-queued',
        conversationId: activeConvId,
        message: 'Message queued — will be processed after current task completes.'
      });
    }

    // Mark client as processing (prevents heartbeat timeout)
    client._processing = true;

    // Broadcast agent activity status to all clients (for sidebar status dots)
    const defaultWsIdAgent = this.agentExecutor?.workspaceManager?.getDefaultWorkspace()?.id || 'default';
    const agentId = client.workspaceId || defaultWsIdAgent;
    if (!this._activeAgents) this._activeAgents = new Map();
    if (!isConversationBusy) {
      this._activeAgents.set(agentId, (this._activeAgents.get(agentId) || 0) + 1);
      // Broadcast to all — agent status dots are visible in sidebar for every workspace
      this.broadcast({ type: 'agent-status', agentId, status: 'active' });
    }

    try {
      let fullResponse = '';

      // Helper: send to client if connected, otherwise buffer for reconnect
      const sendOrBuffer = (event) => {
        if (client.ws && client.ws.readyState === 1) {
          this._send(client.ws, event);
        } else {
          // Client disconnected mid-processing — route to resume buffer
          this.broadcastToConversation(activeConvId, event);
        }
      };

      // Execute agent with streaming (if busy, executor will queue internally)
      await this.agentExecutor.execute({
        workspaceId: client.workspaceId,
        conversationId: activeConvId,
        userMessage,
        images,
        sessionId: conv?.sessionId || null, // Resume session if available
        requestId,
        requestTracer: this.requestTracer, // Pass tracer for roadmap 10.1
        apiKeyOverride: msg.apiKey || null, // BYOK: user-provided API key
        onEvent: (event) => {
          // Capture text for conversation history
          if (event.type === 'text') {
            fullResponse += event.content;
          }

          // Pass event through directly (falls back to resume buffer if disconnected)
          sendOrBuffer(event);
        },
        onComplete: (result) => {
          // Save to conversation using captured ID (not client.conversationId which may have changed)
          if (this.conversationManager && activeConvId) {
            // Save session ID for resumption
            if (result.sessionId) {
              this.conversationManager.setSessionId(activeConvId, result.sessionId);
            }

            // Save assistant response
            if (result.response || fullResponse) {
              this.conversationManager.addMessage(
                activeConvId,
                'assistant',
                result.response || fullResponse.trim()
              );
            }

            // Auto-title from first message
            this.conversationManager.autoTitle(activeConvId);
          }

          // Send completion event with confidence score (roadmap 9.3)
          const responseObj = typeof (result.response) === 'string'
            ? { text: result.response, confidence: result.confidence || 0.5 }
            : { ...result, confidence: result.confidence || 0.5 };
          sendOrBuffer({
            type: 'complete',
            response: responseObj
          });

          // If there's a pending message queued, DON'T send 'done' —
          // the follow-up will start processing immediately and UI should stay in processing state
          if (result.hasPendingMessage) {
            this.logger.info('WebSocket', `[QUEUE] Pending message exists for ${activeConvId} — skipping 'done' event`);
            // Reset fullResponse for the next message in the queue
            fullResponse = '';
          } else {
            // Send 'done' event to signal response completion
            sendOrBuffer({
              type: 'done',
              code: 0
            });
          }
        },
        onError: (error) => {
          client._processing = false;
          this._markAgentIdle(agentId);
          sendOrBuffer({ type: 'error', content: error.message, timestamp: new Date().toISOString() });
          // Send 'done' event so UI can finish processing state
          sendOrBuffer({ type: 'done', code: 1 });
        }
      });

      // Mark processing complete (only if no pending messages being processed)
      if (!this.agentExecutor.isRunning(activeConvId)) {
        client._processing = false;
        this._markAgentIdle(agentId);
      }
    } catch (e) {
      client._processing = false;
      this._markAgentIdle(agentId);
      this.logger.error('WebSocket', 'Agent execution error', e.message);
      // Use broadcastToConversation so error reaches client OR resume buffer
      // (if client disconnected mid-processing, _send would silently fail)
      const errorEvent = { type: 'error', content: 'Agent execution failed', timestamp: new Date().toISOString() };
      const doneEvent = { type: 'done', code: 1 };
      if (client.ws && client.ws.readyState === 1) {
        this._send(client.ws, errorEvent);
        this._send(client.ws, doneEvent);
      } else {
        this.broadcastToConversation(activeConvId, errorEvent);
        this.broadcastToConversation(activeConvId, doneEvent);
      }
    }
  }

  /**
   * Test streaming: sends fake streaming output to client for visual verification.
   * Triggered via WebSocket { type: 'test-stream' } or HTTP POST /api/test-stream
   */
  async _handleTestStream(connectionId, message) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    const ws = client.ws;
    const chunks = [
      'Hello! ',
      'This is a **streaming** ',
      'test message. \n\n',
      'Each word ',
      'arrives one ',
      'by one...\n\n',
      '```javascript\n',
      'const hello = ',
      '"world";\n',
      'console.log(',
      'hello);\n',
      '```\n\n',
      'Streaming ',
      'successfully ',
      'working!'
    ];

    // Send system event
    this._send(ws, { type: 'system', content: 'Test streaming started', model: 'test-stream' });
    this._send(ws, { type: 'message-received' });

    // Stream chunks with delay
    for (const chunk of chunks) {
      await new Promise(r => setTimeout(r, message.delay || 120));
      this._send(ws, { type: 'text', content: chunk });
    }

    // Send completion
    await new Promise(r => setTimeout(r, 200));
    this._send(ws, { type: 'complete', response: { text: chunks.join(''), confidence: 0.99 } });
    this._send(ws, { type: 'done', code: 0 });

    this.logger.info('WebSocket', `Test stream completed for ${connectionId.substring(0, 8)}`);
  }

  async _handleAbort(connectionId, message) {
    const client = this.clients.get(connectionId);
    if (!client) return;

    this.logger.info('WebSocket', `Aborting conversation: ${client.conversationId}`);

    if (client.conversationId) {
      this.agentExecutor.abort(client.conversationId, { cancelledByUser: true });
    }

    this._send(client.ws, {
      type: 'cancelled',
      conversationId: client.conversationId
    });
  }

  _send(ws, data) {
    if (ws.readyState === 1) { // OPEN
      const payload = JSON.stringify(data);

      // Log critical events (done, complete, error) for debugging
      if (['done', 'complete', 'error', 'reload'].includes(data.type)) {
        this.logger.info('WebSocket', `Sending ${data.type} event`);
      }

      ws.send(payload, (err) => {
        if (err) {
          this.logger.error('WebSocket', `Send failed (${data.type}): ${err.message}`);
        } else if (['done', 'complete'].includes(data.type)) {
          this.logger.info('WebSocket', `${data.type} event sent successfully`);
        }
      });

      // Force flush buffer (critical for streaming text and completion events)
      if (ws._socket && ws._socket.flush) {
        ws._socket.flush();
      }
    } else {
      this.logger.warn('WebSocket', `Cannot send ${data.type} - socket not OPEN (state: ${ws.readyState})`);
    }
  }

  _sendError(ws, message) {
    this._send(ws, {
      type: 'error',
      content: message,
      timestamp: new Date().toISOString()
    });
  }

  // Store pending completions from boot for delivery when clients connect
  setPendingCompletions(completions) {
    this._pendingCompletions = Array.isArray(completions) ? completions : [];
  }

  // Deliver pending completions to a specific client for a specific conversation
  // Called when client selects a conversation that has a pending completion
  _deliverPendingCompletion(client, conversationId) {
    if (!this._pendingCompletions || this._pendingCompletions.length === 0) return false;

    const idx = this._pendingCompletions.findIndex(c => c.conversationId === conversationId);
    if (idx === -1) return false;

    const completion = this._pendingCompletions[idx];

    // Already delivered to this client — don't re-send (prevents select→deliver→select loop)
    if (completion._deliveredTo && completion._deliveredTo.has(client.id)) {
      return false;
    }

    this._send(client.ws, {
      type: 'pending-completion',
      conversationId: completion.conversationId,
      response: completion.response,
      completedAt: completion.completedAt
    });
    this.logger.info('WebSocket', `Delivered pending completion to client for conv ${conversationId}`);

    // Track which clients received this completion — prevents re-delivery loops
    if (!completion._deliveredTo) completion._deliveredTo = new Set();
    completion._deliveredTo.add(client.id);

    // Mark as delivered with timestamp; cleanup after 60 seconds.
    completion._deliveredAt = Date.now();
    if (!this._pendingCompletionCleanup) {
      this._pendingCompletionCleanup = setTimeout(() => {
        this._pendingCompletions = this._pendingCompletions.filter(c => !c._deliveredAt || Date.now() - c._deliveredAt < 60000);
        this._pendingCompletionCleanup = null;
      }, 60000);
    }
    return true;
  }

  getClientCount() {
    return this.clients ? this.clients.size : 0;
  }

  broadcastToConversation(conversationId, data) {
    if (!this.clients) return;
    const msg = JSON.stringify(data);

    // Check if any client is actually watching this conversation
    let delivered = false;
    for (const [, client] of this.clients) {
      if (client.conversationId === conversationId && client.ws.readyState === 1) {
        client.ws.send(msg);
        delivered = true;
      }
    }

    // If no client received it, buffer the event for later replay
    if (!delivered && this._resumeBuffers) {
      let buf = this._resumeBuffers.get(conversationId);
      if (!buf) {
        buf = { events: [], processing: true, fullResponse: '' };
        this._resumeBuffers.set(conversationId, buf);
      }

      // Accumulate text for full response
      if (data.type === 'text' || data.type === 'stream') {
        buf.fullResponse += (data.content || '');
      }

      // Buffer important events (skip high-frequency stream chunks, keep milestones)
      if (data.type !== 'stream') {
        buf.events.push(data);
      }

      // Mark complete when done (with timestamp for stale cleanup)
      if (data.type === 'done' || data.type === 'complete') {
        buf.processing = false;
        buf._completedAt = Date.now();
      }

      // Cap buffer size (keep last 200 events max)
      if (buf.events.length > 200) {
        buf.events = buf.events.slice(-200);
      }
    }
  }

  // Start tracking a resumed job's conversation
  startResumeBuffer(conversationId) {
    this._resumeBuffers.set(conversationId, { events: [], processing: true, fullResponse: '' });
  }

  // Clean up buffer after it's been delivered or job is done
  _cleanResumeBuffer(conversationId) {
    this._resumeBuffers.delete(conversationId);
  }

  _isRateLimited(connectionId) {
    const now = Date.now();
    let rl = this.rateLimit.get(connectionId);
    if (!rl || now > rl.resetAt) {
      rl = { count: 0, resetAt: now + this.rateLimitWindow };
      this.rateLimit.set(connectionId, rl);
    }
    rl.count++;
    if (rl.count > this.rateLimitMax) {
      this.logger.warn('WebSocket', `Rate limited: ${connectionId}`);
      return true;
    }
    return false;
  }

  // Broadcast message to all connected clients
  broadcast(message) {
    const payload = JSON.stringify(message);
    let sent = 0;
    for (const [id, client] of this.clients) {
      if (client.ws && client.ws.readyState === 1) { // 1 = OPEN
        try {
          client.ws.send(payload, (err) => {
            if (err) this.logger.error('WebSocket', `Broadcast error to ${id}:`, err.message);
          });
          if (client.ws._socket) client.ws._socket.flush?.();
          sent++;
        } catch (e) {
          this.logger.error('WebSocket', `Failed to broadcast to ${id}:`, e.message);
        }
      }
    }
    // Only log non-streaming broadcasts to reduce log spam
    const quietTypes = ['text', 'tool_start', 'tool_result', 'progress', 'ping', 'pong'];
    if (!quietTypes.includes(message.type)) {
      this.logger.info('WebSocket', `Broadcast ${message.type} to ${sent} clients`);
    }
    return sent;
  }

  // Broadcast message only to clients viewing a specific workspace
  broadcastToWorkspace(workspaceId, message) {
    const payload = JSON.stringify(message);
    let sent = 0;
    for (const [id, client] of this.clients) {
      if (client.workspaceId === workspaceId && client.ws && client.ws.readyState === 1) {
        try {
          client.ws.send(payload, (err) => {
            if (err) this.logger.error('WebSocket', `Workspace broadcast error to ${id}:`, err.message);
          });
          sent++;
        } catch (e) {
          this.logger.error('WebSocket', `Failed workspace broadcast to ${id}:`, e.message);
        }
      }
    }
    return sent;
  }

  // Clean expired entries from dedup cache
  _cleanDedupCache() {
    const now = Date.now();
    for (const [id, ts] of this._dedupCache) {
      if (now - ts > this._dedupTTL) this._dedupCache.delete(id);
    }
  }

  // Decrement active count for agent and broadcast idle if no more active tasks
  _markAgentIdle(agentId) {
    if (!this._activeAgents) return;
    const count = (this._activeAgents.get(agentId) || 1) - 1;
    if (count <= 0) {
      this._activeAgents.delete(agentId);
      this.broadcast({ type: 'agent-status', agentId, status: 'idle' });
    } else {
      this._activeAgents.set(agentId, count);
    }
  }

  // Send message to a specific agent (by workspace ID)
  sendToAgent(agentId, data) {
    const payload = JSON.stringify(data);
    let sent = 0;
    for (const [id, client] of this.clients) {
      if (client.workspaceId === agentId && client.ws && client.ws.readyState === 1) {
        try {
          client.ws.send(payload, (err) => {
            if (err) this.logger.error('WebSocket', `sendToAgent error to ${id}:`, err.message);
          });
          if (client.ws._socket) client.ws._socket.flush?.();
          sent++;
        } catch (e) {
          this.logger.error('WebSocket', `Failed to send to agent ${agentId}:`, e.message);
        }
      }
    }
    this.logger.info('WebSocket', `Sent ${data.type} to agent ${agentId}: ${sent} clients`);
    return sent;
  }

  // Graceful shutdown: notify clients and close
  async gracefulShutdown() {
    this.logger.info('WebSocket', 'Starting graceful shutdown...');

    // Stop background cleanup intervals
    if (this._rateLimitCleanup) clearInterval(this._rateLimitCleanup);
    if (this._resumeBufferCleanup) clearInterval(this._resumeBufferCleanup);

    // Notify all clients to reload
    this.broadcast({ type: 'reload', reason: 'Server restarting' });

    // Wait 500ms for message delivery
    await new Promise(resolve => setTimeout(resolve, 500));

    // Close all connections
    for (const [id, client] of this.clients) {
      try {
        clearInterval(client.heartbeat);
        client.ws.close();
      } catch (e) {
        this.logger.error('WebSocket', `Error closing ${id}:`, e.message);
      }
    }
    this.clients.clear();
    this.rateLimit.clear();
    this._resumeBuffers.clear();

    // Close WebSocket server
    this.wss.close();
    this.logger.info('WebSocket', 'Graceful shutdown complete');
  }

  close() {
    if (this._rateLimitCleanup) clearInterval(this._rateLimitCleanup);
    if (this._resumeBufferCleanup) clearInterval(this._resumeBufferCleanup);
    if (this._dedupCleanupTimer) clearInterval(this._dedupCleanupTimer);
    this.wss.close();
    this.logger.info('WebSocket', 'Server closed');
  }
}

module.exports = GatewayWebSocketServer;
