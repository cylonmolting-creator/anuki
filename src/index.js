#!/usr/bin/env node

// Load .env file — override: true ensures .env wins over inherited parent env vars
const _path = require('path');
const _fs = require('fs');
const _envPath = _path.join(__dirname, '..', '.env');
const _examplePath = _path.join(__dirname, '..', '.env.example');
if (!_fs.existsSync(_envPath) && _fs.existsSync(_examplePath)) {
  _fs.copyFileSync(_examplePath, _envPath);
}
require('dotenv').config({ path: _envPath, override: true });

const http = require('http');
const path = require('path');
const fs = require('fs');

// Core modules
const Logger = require('./utils/logger');
const WorkspaceManager = require('./agent/workspace-manager');
const AgentExecutor = require('./agent/executor');
const AgentManager = require('./agent/simple-agent-manager');
const ConversationManager = require('./utils/conversation-manager');
const UploadCleanup = require('./utils/upload-cleanup');
const HTTPServer = require('./gateway/http-server');
const GatewayWebSocketServer = require('./gateway/websocket-server');
const WebhookManager = require('./gateway/webhook-manager');

// Intelligence modules
const CognitiveMemory = require('./memory/cognitive');
const ReflectionEngine = require('./memory/reflection');
const SessionCompactor = require('./agent/compactor');
const ContextGuard = require('./agent/context-guard');
const LaneQueue = require('./agent/lane-queue');
const HealthWatchdog = require('./agent/health-watchdog');
const { CronManager } = require('./gateway/cron');
const Security = require('./core/security');
const AgentStats = require('./agent/agent-stats');
const AgentOutputs = require('./agent-outputs');
const UsageTracker = require('./agent/usage-tracker');
const PidRegistry = require('./core/pid-registry');
const { AgentSupervisor } = require('./agent/supervisor');

// Configuration
const { configManager } = require('./core/config');
const appConfig = configManager.load();
const PORT = appConfig.port;
const BASE_DIR = path.resolve(__dirname, '..');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const PID_FILE = path.join(BASE_DIR, 'anuki.pid');

// Global refs for graceful shutdown
let g_httpServer = null;
let g_wsServer = null;
let g_cronManager = null;
let g_cognitiveMemory = null;
let g_executor = null;
let g_pidRegistry = null;
let g_supervisor = null;

console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║     █████╗ ███╗   ██╗██╗   ██╗██╗  ██╗██╗               ║
║    ██╔══██╗████╗  ██║██║   ██║██║ ██╔╝██║               ║
║    ███████║██╔██╗ ██║██║   ██║█████╔╝ ██║               ║
║    ██╔══██║██║╚██╗██║██║   ██║██╔═██╗ ██║               ║
║    ██║  ██║██║ ╚████║╚██████╔╝██║  ██╗██║               ║
║    ╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝               ║
║                                                          ║
║           AI Agent LEGO Platform v0.1.0                  ║
║         Build your own multi-agent team                  ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝

🚀 Starting Anuki...
📍 Base Directory: ${BASE_DIR}
🔌 Port: ${PORT}
`);

// ═══════════════════════════════════════════════════════════
// JOB HISTORY
// ═══════════════════════════════════════════════════════════
const JOB_HISTORY_FILE = path.join(BASE_DIR, 'data', 'job-history.json');
const JOB_HISTORY_MAX = 100;

function loadJobHistory() {
  try {
    if (fs.existsSync(JOB_HISTORY_FILE)) return JSON.parse(fs.readFileSync(JOB_HISTORY_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return [];
}
function saveJobHistory(history) {
  try {
    const dir = path.dirname(JOB_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (history.length > JOB_HISTORY_MAX) history = history.slice(-JOB_HISTORY_MAX);
    const { atomicWriteFileSync } = require('./utils/atomic-write');
    atomicWriteFileSync(JOB_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) { /* ignore */ }
}
function updateJobInHistory(jobId, updates) {
  const history = loadJobHistory();
  const idx = history.findIndex(j => j.jobId === jobId);
  if (idx >= 0) Object.assign(history[idx], updates);
  saveJobHistory(history);
}

async function main() {
  try {
    // Check for existing PID file
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
      try {
        process.kill(oldPid, 0);
        console.log(`Killing previous instance (PID ${oldPid})...`);
        try { process.kill(oldPid, 'SIGKILL'); } catch (e) { /* ignore */ }
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.log(`Removing stale PID file (${oldPid})`);
      }
      try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 1: Core Infrastructure
    // ═══════════════════════════════════════════════════════

    const logger = new Logger(LOG_DIR);
    logger.success('System', 'Logger initialized');

    // PID Registry
    g_pidRegistry = new PidRegistry(logger);
    const orphansKilled = g_pidRegistry.cleanupOrphans();
    if (orphansKilled > 0) {
      logger.warn('System', `Boot cleanup: killed ${orphansKilled} orphan process(es)`);
    }

    // Config hot-reload
    configManager.watch();
    configManager.on('reload', (newCfg) => {
      logger.info('Config', `config.json reloaded (port=${newCfg.port})`);
    });
    logger.success('System', 'Config loaded + hot-reload active');

    // Security
    const security = new Security(BASE_DIR, logger);
    logger.success('System', 'Security ready');

    // Storage
    const Storage = require('./core/storage');
    const storage = new Storage({
      dataDir: path.join(BASE_DIR, 'data'),
      workspace: path.join(BASE_DIR, 'workspace')
    });
    logger.success('System', 'Storage ready');

    // Workspace manager
    const workspaceManager = new WorkspaceManager(BASE_DIR, logger);
    let defaultWorkspace = workspaceManager.getDefaultWorkspace();
    if (!defaultWorkspace) {
      logger.info('System', 'Creating default workspace (PROTOS)...');
      defaultWorkspace = workspaceManager.createWorkspace({
        name: 'PROTOS',
        id: 'default'
      });
    }
    logger.success('System', `Default workspace: ${defaultWorkspace.name} (${defaultWorkspace.id})`);

    // ═══════════════════════════════════════════════════════
    // PHASE 2: Memory & Intelligence
    // ═══════════════════════════════════════════════════════

    const cognitiveMemory = new CognitiveMemory(BASE_DIR, logger);
    g_cognitiveMemory = cognitiveMemory;
    const memStats = cognitiveMemory.getStats();
    logger.success('System', `Cognitive memory ready (E:${memStats.episodic} S:${memStats.semantic} P:${memStats.procedural})`);

    const contextGuard = new ContextGuard({
      model: appConfig.agent.model,
      warningThreshold: 0.7,
      actionThreshold: 0.85,
      criticalThreshold: 0.95,
      reservedForResponse: 8192
    }, logger);
    logger.success('System', 'Context guard ready');

    const compactor = new SessionCompactor({
      maxMessages: 30,
      compactTo: 12,
      softTrimTokenThreshold: 0.70,
      hardClearTokenThreshold: 0.90,
      targetUsageAfterTrim: 0.50,
      toolResultMaxChars: 300
    }, logger);
    compactor.setContextGuard(contextGuard);
    logger.success('System', 'Session compactor ready');

    const reflectionEngine = new ReflectionEngine(cognitiveMemory, logger);
    logger.success('System', 'Reflection engine ready');

    const laneQueue = new LaneQueue({
      maxQueueDepth: 10,
      taskTimeout: 120000,
      maxRetries: 2
    }, logger);
    logger.success('System', 'Lane queue ready');

    // Health watchdog
    const healthWatchdog = new HealthWatchdog({
      checkIntervalMs: 30000,
      heartbeatTimeoutMs: 2100000,
      laneStuckTimeoutMs: 300000,
      eventLoopLagThresholdMs: 500,
      orphanSweepIntervalMs: 60000,
      stuckAgentTimeoutMs: 600000,
      checkpointIntervalMs: 30000
    }, logger);
    healthWatchdog.laneQueue = laneQueue;
    healthWatchdog.pidRegistry = g_pidRegistry;
    healthWatchdog.start();
    logger.success('System', 'Health watchdog ready');

    // ═══════════════════════════════════════════════════════
    // PHASE 3: Agent Execution
    // ═══════════════════════════════════════════════════════

    // Message router (inter-agent communication)
    const MessageRouter = require('./agent/message-router');
    const MessagePolicy = require('./agent/message-policy');
    const messagePolicy = new MessagePolicy({
      enabled: true,
      defaultAction: 'allow',
      allowlist: [],
      denylist: [],
      maxMessageSize: 50000,
      rateLimit: { maxPerMinute: 60, maxPerHour: 1000 },
      rules: []
    });
    const messageRouter = new MessageRouter({
      agentManager: null,
      wsServer: null,
      logger: logger,
      policy: messagePolicy
    });
    logger.success('System', 'Inter-agent message router ready');

    // Agent executor
    const agentExecutor = new AgentExecutor(workspaceManager, logger);
    agentExecutor.pidRegistry = g_pidRegistry;
    g_executor = agentExecutor;

    // Supervisor (circuit breakers + resource monitoring)
    g_supervisor = new AgentSupervisor(logger, {
      maxRestartsPerWindow: 5,
      restartWindow: 300000,
      resourceCheckInterval: 30000,
      maxMemoryMB: 2048,
      maxCPUPercent: 200,
    });
    g_supervisor.start();
    agentExecutor.supervisor = g_supervisor;
    agentExecutor.reflectionEngine = reflectionEngine;
    agentExecutor.compactor = compactor;
    agentExecutor.contextGuard = contextGuard;
    agentExecutor.security = security;
    agentExecutor.laneQueue = laneQueue;
    healthWatchdog.executor = agentExecutor;
    healthWatchdog.supervisor = g_supervisor;

    // Model resolver
    const ModelResolver = require('./agent/model-resolver');
    const modelResolver = new ModelResolver({
      strategy: 'priority',
      providers: [
        { name: 'sonnet', type: 'anthropic', model: 'claude-sonnet-4-20250514', priority: 1, maxTokens: 8192 },
        { name: 'haiku', type: 'anthropic', model: 'claude-haiku-4-5-20251001', priority: 2, maxTokens: 8192 }
      ]
    }, logger);
    agentExecutor.modelResolver = modelResolver;
    agentExecutor.storage = storage;
    agentExecutor.messageRouter = messageRouter;
    logger.success('System', 'Agent executor ready');

    // Agent manager
    const agentManager = {
      getAgent: (id) => AgentManager.getAgent(id),
      createAgent: (data, options) => AgentManager.createAgent(data, options),
      deleteAgent: (id, options) => AgentManager.deleteAgent(id, options),
      listAgents: () => AgentManager.listAgents(),
      startAgent: (id) => AgentManager.startAgent(id),
      stopAgent: (id) => AgentManager.stopAgent(id),
      updateAgentChannels: (id, channels) => AgentManager.updateAgentChannels(id, channels),
      updateAgent: (id, updates) => AgentManager.updateAgent(id, updates),
      checkIdleAgents: (thresholdMs) => AgentManager.checkIdleAgents(thresholdMs),
      touchAgentActivity: (id) => AgentManager.touchAgentActivity(id),
      getAgentLifecycle: (id) => AgentManager.getAgentLifecycle(id),
      getLifecycleOverview: () => AgentManager.getLifecycleOverview()
    };
    logger.success('System', 'Agent manager ready');

    // Sync agents.json ↔ workspaces.json (bidirectional)
    const allAgentsAtBoot = agentManager.listAgents();
    let syncCount = 0;
    for (const agent of allAgentsAtBoot) {
      if (agent.isMaster) continue;
      if (!workspaceManager.getWorkspace(agent.id)) {
        workspaceManager.createWorkspace({ name: agent.name, id: agent.id, port: agent.port });
        syncCount++;
      }
    }
    if (syncCount > 0) logger.success('System', `Workspace sync: ${syncCount} missing workspace(s) registered`);

    // Ensure default workspace is also registered as an agent (enables inter-agent messaging)
    if (defaultWorkspace && !agentManager.getAgent(defaultWorkspace.id)) {
      try {
        AgentManager.createAgent(
          { id: defaultWorkspace.id, name: defaultWorkspace.name },
          { workspaceManager }
        );
        logger.success('System', `Default agent registered: ${defaultWorkspace.name} (${defaultWorkspace.id})`);
      } catch (e) {
        // Agent may already exist with that ID — not fatal
        logger.warn('System', `Default agent registration skipped: ${e.message}`);
      }
    }

    messageRouter.agentManager = agentManager;
    agentExecutor.agentManager = agentManager;

    // Auto-router
    const AutoRouter = require('./agent/auto-router');
    const autoRouter = new AutoRouter(agentManager, logger);
    agentExecutor.autoRouter = autoRouter;
    logger.success('System', 'Auto-router ready');

    // Group chat
    const GroupChat = require('./agent/group-chat');
    const groupChat = new GroupChat(messageRouter, agentManager, logger);
    logger.success('System', 'Group chat ready');

    // Skill registry
    const SkillRegistry = require('./agent/skill-registry');
    const skillRegistry = new SkillRegistry(workspaceManager, agentManager, logger);
    skillRegistry.initialize();

    const SkillCache = require('./agent/skill-cache');
    const skillCache = new SkillCache(agentManager, logger);
    skillCache.skillRegistry = skillRegistry;
    skillCache.initialize();
    agentExecutor.skillCache = skillCache;
    autoRouter.skillCache = skillCache;
    logger.success('System', 'Skill system ready');

    // Task planner
    const TaskPlanner = require('./agent/task-planner');
    const taskPlanner = new TaskPlanner({ skillCache, messageRouter, logger });
    agentExecutor.taskPlanner = taskPlanner;

    // Agent stats & outputs
    const agentStats = new AgentStats(logger);
    agentExecutor.agentStats = agentStats;
    const agentOutputs = new AgentOutputs(logger);
    agentExecutor.agentOutputs = agentOutputs;

    // Usage tracker
    const usageTracker = new UsageTracker(logger, configManager);
    agentExecutor.usageTracker = usageTracker;

    // Shared context
    const SharedContext = require('./agent/shared-context');
    const sharedContext = new SharedContext({ logger });
    agentExecutor.sharedContext = sharedContext;
    taskPlanner.sharedContext = sharedContext;

    // Conversation manager
    const conversationManager = new ConversationManager(BASE_DIR, logger);
    messageRouter.executor = agentExecutor;
    messageRouter.conversationManager = conversationManager;
    agentExecutor.conversationManager = conversationManager;
    logger.success('System', 'Conversation manager ready');

    // ═══════════════════════════════════════════════════════
    // PHASE 4: Cron System
    // ═══════════════════════════════════════════════════════

    const cronManager = new CronManager({ dataDir: BASE_DIR, timezone: appConfig.timezone }, logger);
    g_cronManager = cronManager;

    const uploadsDir = path.join(BASE_DIR, 'data', 'uploads');
    const uploadCleanup = new UploadCleanup(uploadsDir, logger);

    cronManager.registerHandler('reflection', async (data) => {
      const dateStr = data.date || new Date().toISOString().split('T')[0];
      return await reflectionEngine.runReflection(dateStr);
    });

    cronManager.registerHandler('memory_decay', async () => {
      const decayResult = cognitiveMemory.applyDecay();
      const cleanupResult = cognitiveMemory.cleanupOldSteps(7);
      return { decay: decayResult, stepCleanup: cleanupResult };
    });

    cronManager.registerHandler('upload_cleanup', async () => {
      uploadCleanup.runFullCleanup();
      return { success: true };
    });

    cronManager.registerHandler('conversation_cleanup', async () => {
      return conversationManager.pruneStaleConversations();
    });

    // Create default cron jobs if none exist
    const existingJobs = cronManager.getAllJobs();
    if (existingJobs.length === 0) {
      cronManager.addJob({ name: 'Nightly Reflection', type: 'reflection', schedule: '0 3 * * *', data: {}, enabled: true });
      cronManager.addJob({ name: 'Memory Decay', type: 'memory_decay', schedule: '0 4 * * *', data: {}, enabled: true });
      cronManager.addJob({ name: 'Upload Cleanup', type: 'upload_cleanup', schedule: '0 5 * * *', data: {}, enabled: true });
      cronManager.addJob({ name: 'Conversation Cleanup', type: 'conversation_cleanup', schedule: '0 */6 * * *', data: {}, enabled: true });
      logger.success('System', 'Default cron jobs created');
    }

    cronManager.startAll();
    logger.success('System', `Cron manager ready (${cronManager.getAllJobs().length} jobs)`);

    // ═══════════════════════════════════════════════════════
    // PHASE 5: HTTP & WebSocket Servers
    // ═══════════════════════════════════════════════════════

    const httpServer = new HTTPServer(workspaceManager, logger, agentManager, conversationManager);
    httpServer.setSecurity(security);
    httpServer.agentExecutor = agentExecutor;
    httpServer.messageRouter = messageRouter;
    httpServer.groupChat = groupChat;
    agentExecutor.requestTracer = httpServer.requestTracer;
    httpServer.skillCache = skillCache;
    httpServer.skillRegistry = skillRegistry;
    httpServer.taskPlanner = taskPlanner;
    httpServer.sharedContext = sharedContext;
    httpServer.agentStats = agentStats;
    httpServer.agentOutputs = agentOutputs;
    httpServer.usageTracker = usageTracker;

    // Enhanced stats (optional)
    try {
      const AgentStatsEnhanced = require('./agent-stats-enhanced');
      const agentStatsEnhanced = new AgentStatsEnhanced({ dataDir: path.join(BASE_DIR, 'data'), logger });
      httpServer.agentStatsEnhanced = agentStatsEnhanced;
    } catch (e) { /* optional */ }

    const webhookManager = new WebhookManager(BASE_DIR, logger);
    httpServer.webhookManager = webhookManager;
    const app = httpServer.getApp();

    // Memory API
    app.get('/api/memory/stats', (req, res) => res.json(cognitiveMemory.getStats()));
    app.get('/api/memory/core', (req, res) => res.json({ content: cognitiveMemory.getCoreMemory() }));
    app.post('/api/memory/search', (req, res) => {
      const { query, limit } = req.body;
      res.json({ results: cognitiveMemory.search(query || '', { limit: limit || 10 }) });
    });

    // Health watchdog
    app.get('/api/health/watchdog', (req, res) => res.json(healthWatchdog.getStatus()));

    // Cron API
    app.get('/api/cron/jobs', (req, res) => res.json({ jobs: cronManager.getAllJobs() }));
    app.get('/api/cron/history', (req, res) => res.json({ history: cronManager.getHistory(50) }));
    app.post('/api/cron/run/:jobId', async (req, res) => {
      try {
        const result = await cronManager.runNow(req.params.jobId);
        res.json({ success: true, result });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Active Jobs API
    app.get('/api/active-jobs', (req, res) => {
      try {
        const resolveAgentName = (wsId) => {
          const agent = agentManager.getAgent(wsId);
          return agent ? agent.name : (wsId ? wsId.substring(0, 8) + '...' : 'unknown');
        };
        const jobs = agentExecutor.getActiveJobs(resolveAgentName);
        const agents = agentManager.listAgents().map(a => ({
          id: a.id, name: a.name, port: a.port, running: a.running !== false
        }));
        res.json({ jobs, agents, timestamp: new Date().toISOString() });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ═══════════════════════════════════════════════════════
    // Start HTTP server
    // ═══════════════════════════════════════════════════════

    const server = http.createServer(app);
    g_httpServer = server;

    // Initialize WebSocket server
    const wsServer = new GatewayWebSocketServer(server, logger, agentExecutor, conversationManager);
    wsServer.agentManager = agentManager;
    wsServer.messageRouter = messageRouter;
    g_wsServer = wsServer;

    // Inject wsServer into components that need it
    agentExecutor.wsServer = wsServer;
    messageRouter.wsServer = wsServer;
    httpServer.wsServer = wsServer;

    // WebChat channel (always active)
    const WebChat = require('./channels/webchat');
    const webchat = new WebChat(wsServer, agentExecutor, workspaceManager, agentManager, logger);

    // Write PID file
    fs.writeFileSync(PID_FILE, String(process.pid));

    // Start listening
    server.listen(PORT, () => {
      logger.success('System', `🌐 Anuki is running on http://localhost:${PORT}`);
      logger.success('System', `📊 Agents: ${agentManager.listAgents().length}`);
      logger.success('System', `🔧 Core agents: ENKI (creator) + PROTOS (bridge) + UTU (rules)`);
    });

  } catch (error) {
    console.error('❌ Fatal startup error:', error);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════
// Graceful Shutdown
// ═══════════════════════════════════════════════════════════

async function gracefulShutdown(signal) {
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);

  try {
    if (g_cronManager) g_cronManager.stopAll();
    if (g_supervisor) g_supervisor.stop();
    if (g_wsServer) g_wsServer.close();
    if (g_httpServer) {
      await new Promise(resolve => g_httpServer.close(resolve));
    }
    if (g_pidRegistry) await g_pidRegistry.killAll();
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* ignore */ }
  } catch (e) {
    console.error('Shutdown error:', e.message);
  }

  console.log('👋 Anuki stopped.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

main();
