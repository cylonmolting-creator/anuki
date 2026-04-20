const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Logger = require('../utils/logger');
const RequestTracer = require('../core/request-tracer');
const PreventionGuard = require('../core/prevention-guard');

// Sanitize user-provided strings to prevent XSS (strip HTML tags)
function sanitizeName(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}

class HTTPServer {
  constructor(workspaceManager, logger, agentManager, conversationManager) {
    this.workspaceManager = workspaceManager;
    this.logger = logger;
    this.agentManager = agentManager;
    this.conversationManager = conversationManager;
    this.security = null;
    this.notify = null; // notifyFn reference
    this.webhookManager = null; // Roadmap 6.3: hardened webhook system
    this.wsServer = null; // For webhook broadcast
    this.channelManager = null;
    this.messageRouter = null; // Inter-agent message router
    this.groupChat = null; // Group chat manager
    this.skillCache = null; // Skill discovery cache
    this.taskPlanner = null; // Multi-agent task planner (roadmap 5.3)
    this.sharedContext = null; // Shared memory namespace (roadmap 5.5)
    this.skillValidators = new Map(); // agentId -> { skillId -> SkillValidator }
    this.baseDir = path.join(__dirname, '../..');
    this.app = express();
    this.requestTracer = new RequestTracer(logger); // Roadmap 10.1: Request tracing
    this._initializeSkillValidators();

    // Middleware
    // Performance profiling: HTTP request parsing (roadmap 10.3)
    const jsonParserWithTiming = express.json();
    this.app.use((req, res, next) => {
      const parseStart = Date.now();
      jsonParserWithTiming(req, res, () => {
        const parseDuration = Date.now() - parseStart;
        // Record HTTP parse latency
        if (this.agentExecutor && this.agentExecutor.performanceProfiler && req.method === 'POST') {
          this.agentExecutor.performanceProfiler.recordLatency('http_parse', parseDuration, {
            path: req.path,
            method: req.method,
            bodySize: JSON.stringify(req.body || {}).length
          });
        }
        next();
      });
    });
    this.app.use(express.static(path.join(__dirname, '../../public'), {
      etag: false,
      lastModified: false,
      setHeaders: (res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.set('Pragma', 'no-cache');
      }
    }));

    // Serve avatars directory
    this.app.use('/api/avatars', express.static(path.join(__dirname, '../../data/avatars')));

    // Setup file upload
    this.uploadsDir = path.join(__dirname, '../../data/uploads');
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }

    // Setup avatars directory
    this.avatarsDir = path.join(__dirname, '../../data/avatars');
    if (!fs.existsSync(this.avatarsDir)) {
      fs.mkdirSync(this.avatarsDir, { recursive: true });
    }

    const storage = multer.diskStorage({
      destination: (req, file, cb) => cb(null, this.uploadsDir),
      filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${file.originalname}`;
        cb(null, uniqueName);
      }
    });

    this.upload = multer({
      storage,
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
      fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
          cb(null, true);
        } else {
          cb(new Error('Only images are allowed'), false);
        }
      }
    });

    // Request ID middleware — generates unique ID for request tracking across HTTP/WS/agent (roadmap 10.1)
    this.app.use('/api', (req, res, next) => {
      req.requestId = req.headers['x-request-id'] || Logger.generateRequestId();
      res.set('X-Request-Id', req.requestId);
      // Start trace for this request
      this.requestTracer.startTrace(req.requestId, 'http', {
        method: req.method,
        path: req.path,
        ip: req.ip || req.socket.remoteAddress,
      });
      next();
    });

    // Auth middleware MUST be registered before routes
    this.app.use('/api', (req, res, next) => {
      // Health check is auth-free (monitoring)
      if (req.path === '/health') return next();
      // Localhost auth-free (for Web UI)
      const ip = req.ip || req.socket.remoteAddress || '';
      const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (isLocal) return next();
      // If security module is set, require auth for all /api/* endpoints
      if (this.security && !this.security.authenticateRequest(req)) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Bearer token required. Use Authorization: Bearer <token>'
        });
      }
      next();
    });

    this._startTime = Date.now(); // Boot timestamp for health dashboard
    this._setupRoutes();
    this._setupTracingRoutes(); // Roadmap 10.1: Request tracing endpoints

    // Catch-all 404 for unknown /api/* routes — return JSON, not Express HTML
    this.app.use('/api', (req, res) => {
      res.status(404).json({ error: 'Not found', path: req.path });
    });
  }

  setSecurity(sec) {
    this.security = sec;
    if (sec) {
      this.logger.info('HTTP', 'Auth middleware ACTIVE — token required for /api/* endpoints');
    }
  }

  /**
   * Initialize skill validators for all agents
   * @private
   */
  _initializeSkillValidators() {
    const SkillValidator = require('../agent/skill-validator');

    // Load agents and create validators
    if (!this.agentManager) return;

    const agents = this.agentManager.listAgents();
    for (const agent of agents) {
      if (!agent.capabilities || !agent.capabilities.skills) continue;

      const agentValidators = {};
      for (const skill of agent.capabilities.skills) {
        if (!skill.id || !skill.inputSchema && !skill.outputSchema) continue;

        try {
          agentValidators[skill.id] = new SkillValidator(skill, this.logger);
        } catch (e) {
          this.logger.error('HTTP', `Failed to create validator for ${agent.name}/${skill.name}: ${e.message}`);
        }
      }

      if (Object.keys(agentValidators).length > 0) {
        this.skillValidators.set(agent.id, agentValidators);
      }
    }

    this.logger.info('HTTP', `Initialized skill validators for ${this.skillValidators.size} agents`);
  }

  _setupRoutes() {
    // CORS (localhost only)
    this.app.use('/api', (req, res, next) => {
      const origin = req.headers.origin;
      if (origin && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    // Health check (no auth — must be accessible for monitoring)
    this.app.get('/api/health', async (req, res) => {
      const health = {
        status: 'ok',
        version: require('../../package.json').version,
        nodeVersion: process.version,
        uptime: process.uptime(),
        workspaces: this.workspaceManager.listWorkspaces().length,
        provider: this.agentExecutor ? this.agentExecutor.provider.name : 'unknown'
      };

      // Include provider details if requested
      if (req.query.providers === 'true' && this.agentExecutor) {
        try {
          health.providerStatus = await this.agentExecutor.getProviderStatus();
        } catch { /* skip provider details on error */ }
      }

      res.json(health);
    });

    // ═══════════════ Provider Status ═══════════════
    this.app.get('/api/providers', async (req, res) => {
      if (!this.agentExecutor) {
        return res.status(503).json({ error: 'Executor not initialized' });
      }
      try {
        const status = await this.agentExecutor.getProviderStatus();
        res.json(status);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ═══════════════ System Health Dashboard ═══════════════
    this.app.get('/api/system/stats', (req, res) => {
      try {
        const mem = process.memoryUsage();
        const uptimeSec = process.uptime();

        // Agent counts
        const agents = this.agentManager ? this.agentManager.listAgents() : [];
        const activeAgents = agents.filter(a => a.running).length;
        const pausedAgents = agents.filter(a => a.lifecycle?.state === 'paused').length;

        // Message throughput & error rate from agentStats (if available)
        let throughput = { totalRequests: 0, overallSuccessRate: 100, totalCost: 0 };
        if (this.agentStats) {
          try { throughput = this.agentStats.getSystemStats(); } catch (_) {}
        }

        // Error log count (last hour — count ERROR lines in master.log)
        let recentErrors = 0;
        try {
          const logPath = path.join(this.baseDir, 'logs', 'master.log');
          if (fs.existsSync(logPath)) {
            const stat = fs.statSync(logPath);
            // Read last 50KB max to avoid large reads
            const readSize = Math.min(stat.size, 50 * 1024);
            const fd = fs.openSync(logPath, 'r');
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
            fs.closeSync(fd);
            const logTail = buf.toString('utf8');
            const oneHourAgo = new Date(Date.now() - 3600000).toISOString().substring(0, 13);
            const lines = logTail.split('\n');
            for (const line of lines) {
              if (line.includes('ERROR') && line >= oneHourAgo) recentErrors++;
            }
          }
        } catch (_) {}

        // WebSocket connections
        let wsConnections = 0;
        if (this.wsServer && this.wsServer.getClientCount) {
          wsConnections = this.wsServer.getClientCount();
        }

        res.json({
          uptime: uptimeSec,
          bootTime: new Date(this._startTime).toISOString(),
          memory: {
            rss: Math.round(mem.rss / 1024 / 1024),
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
            external: Math.round((mem.external || 0) / 1024 / 1024),
            heapPercent: Math.round((mem.heapUsed / mem.heapTotal) * 100)
          },
          agents: {
            total: agents.length,
            active: activeAgents,
            paused: pausedAgents
          },
          throughput: {
            totalRequests: throughput.totalRequests || 0,
            successRate: throughput.overallSuccessRate || 100,
            totalCost: throughput.totalCost || 0
          },
          wsConnections,
          recentErrors,
          workspaces: this.workspaceManager ? this.workspaceManager.listWorkspaces().length : 0,
          pid: process.pid,
          nodeVersion: process.version,
          platform: process.platform
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get system stats', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Configuration endpoint (roadmap 8.1) — returns sanitized config (no secrets)
    this.app.get('/api/config', (req, res) => {
      try {
        const { configManager } = require('../core/config');
        res.json(configManager.getSanitized());
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get config', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Workspace endpoints
    this.app.get('/api/workspaces', (req, res) => {
      try {
        const workspaces = this.workspaceManager.listWorkspaces();
        const defaultWorkspace = this.workspaceManager.getDefaultWorkspace();
        res.json({
          workspaces,
          defaultId: defaultWorkspace?.id || null
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to list workspaces', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/workspaces', (req, res) => {
      try {
        const { name: rawName, soul, createIcon = false } = req.body;
        const name = sanitizeName(rawName);
        if (!name || name.length === 0) {
          return res.status(400).json({ error: 'Workspace name is required' });
        }
        if (name.length > 100) {
          return res.status(400).json({ error: 'Workspace name must be 100 characters or less' });
        }

        // Check for duplicate name before creating
        const allWorkspaces = this.workspaceManager.listWorkspaces();
        const duplicate = allWorkspaces.find(ws => ws.name.toLowerCase() === name.toLowerCase());
        if (duplicate) {
          return res.status(409).json({ error: `Workspace with name "${name}" already exists`, existing: duplicate });
        }

        const workspace = this.workspaceManager.createWorkspace({ name, soul });

        // Optionally create desktop icon
        if (createIcon && this.agentManager) {
          try {
            this.agentManager.createAgent(workspace);
            this.logger.success('HTTP', `Desktop icon created for ${workspace.name}`);
          } catch (e) {
            this.logger.warn('HTTP', `Failed to create desktop icon: ${e.message}`);
          }
        }

        res.json({ workspace });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to create workspace', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/workspaces/:id', (req, res) => {
      try {
        const workspace = this.workspaceManager.getWorkspace(req.params.id);
        if (!workspace) {
          return res.status(404).json({ error: 'Workspace not found' });
        }
        res.json({ workspace });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get workspace', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.delete('/api/workspaces/:id', (req, res) => {
      try {
        const force = req.query.force === 'true' || req.body?.force === true;

        // Delete associated desktop icon if exists
        if (this.agentManager) {
          try {
            this.agentManager.deleteAgent(req.params.id, { force });
            this.logger.success('HTTP', `Desktop icon deleted`);
          } catch (e) {
            // Agent icon might not exist, or protected — that's OK
          }
        }

        this.workspaceManager.deleteWorkspace(req.params.id, { force });
        res.json({ success: true });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to delete workspace', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Soul files endpoint
    this.app.get('/api/workspaces/:id/soul', (req, res) => {
      try {
        const soulFiles = this.workspaceManager.loadSoulFiles(req.params.id);
        // Strip internal metadata keys (prefixed with _) from API response
        const publicSoulFiles = {};
        for (const [key, value] of Object.entries(soulFiles)) {
          if (!key.startsWith('_')) publicSoulFiles[key] = value;
        }
        res.json({ soulFiles: publicSoulFiles });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to load soul files', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Validate workspace ID format (prevents path traversal via workspace ID param)
    const isValidWsId = (id) => /^[a-zA-Z0-9_-]+$/.test(id);

    // Read workspace file (INCOME_LOG.md, CHANNELS.md, ROADMAP.md, CHANGELOG.md, etc.)
    this.app.get('/api/workspaces/:id/file/:filename', (req, res) => {
      try {
        if (!isValidWsId(req.params.id)) return res.status(400).json({ error: 'Invalid workspace ID' });
        const wsDir = path.join(this.baseDir, 'workspace', req.params.id);
        const filePath = path.join(wsDir, req.params.filename);
        // Security: only allow .md files within workspace dir
        if (!req.params.filename.endsWith('.md') || req.params.filename.includes('..') || req.params.filename.includes('/')) {
          return res.status(400).json({ error: 'Only .md files allowed' });
        }
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'File not found' });
        }
        const content = fs.readFileSync(filePath, 'utf8');
        res.type('text/plain').send(content);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Read soul file (GET) — for UI to read soul/CYCLE_LOG.md, soul/ROADMAP.md etc.
    this.app.get('/api/workspaces/:id/soul/:filename', (req, res) => {
      try {
        if (!isValidWsId(req.params.id)) return res.status(400).json({ error: 'Invalid workspace ID' });
        const wsDir = path.join(this.baseDir, 'workspace', req.params.id, 'soul');
        const filePath = path.join(wsDir, req.params.filename);
        if (!req.params.filename.endsWith('.md') || req.params.filename.includes('..') || req.params.filename.includes('/')) {
          return res.status(400).json({ error: 'Only .md files allowed' });
        }
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'File not found' });
        }
        const content = fs.readFileSync(filePath, 'utf8');
        res.json({ content });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Read file from agent's sandbox (cwdOverride) directory
    this.app.get('/api/workspaces/:id/sandbox/:filename', (req, res) => {
      try {
        if (!isValidWsId(req.params.id)) return res.status(400).json({ error: 'Invalid workspace ID' });
        const filename = req.params.filename;
        if (!filename.endsWith('.md') || filename.includes('..') || filename.includes('/')) {
          return res.status(400).json({ error: 'Only .md files allowed' });
        }
        // Find workspace to get cwdOverride
        const ws = this.workspaceManager.getWorkspace
          ? this.workspaceManager.getWorkspace(req.params.id)
          : null;
        if (!ws || !ws.cwdOverride) {
          return res.status(404).json({ error: 'No sandbox directory configured' });
        }
        const sandboxDir = ws.cwdOverride.replace(/^~/, process.env.HOME);
        const filePath = path.join(sandboxDir, filename);
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'File not found' });
        }
        const content = fs.readFileSync(filePath, 'utf8');
        res.json({ content });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Get agent's sandbox info (cwdOverride, file list)
    this.app.get('/api/workspaces/:id/sandbox', (req, res) => {
      try {
        const ws = this.workspaceManager.getWorkspace
          ? this.workspaceManager.getWorkspace(req.params.id)
          : null;
        if (!ws || !ws.cwdOverride) {
          return res.json({ sandboxDir: null, files: [] });
        }
        const sandboxDir = ws.cwdOverride.replace(/^~/, process.env.HOME);
        if (!fs.existsSync(sandboxDir)) {
          return res.json({ sandboxDir: ws.cwdOverride, files: [] });
        }
        // List top-level files and directories
        const items = fs.readdirSync(sandboxDir, { withFileTypes: true });
        const files = items
          .filter(i => !i.name.startsWith('.') && i.name !== 'node_modules')
          .map(i => ({
            name: i.name,
            type: i.isDirectory() ? 'dir' : 'file',
            size: i.isFile() ? fs.statSync(path.join(sandboxDir, i.name)).size : null
          }));
        res.json({ sandboxDir: ws.cwdOverride, files });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Save individual soul file (roadmap 7.2: soul editor)
    this.app.put('/api/workspaces/:id/soul/:filename', (req, res) => {
      try {
        const { content } = req.body;
        const filename = req.params.filename;
        const workspaceId = req.params.id;

        // DEBUG
        const contentLen = content?.length || -1;
        const trimLen = content?.trim?.().length || -2;
        this.logger.info('HTTP', `[SOUL-PUT] ${filename}: content=${typeof content}, len=${contentLen}, trimmed=${trimLen}`);

        // FIX 1: Comprehensive content validation
        if (content === undefined || content === null) {
          return res.status(400).json({ error: 'content field is required' });
        }
        if (typeof content !== 'string') {
          return res.status(400).json({ error: 'content must be a string' });
        }
        if (content.trim().length === 0) {
          this.logger.warn('HTTP', `[VALIDATION BLOCKED] Empty content for ${filename}`);
          return res.status(400).json({ error: 'content cannot be empty' });
        }
        if (content.length > 16384) {
          return res.status(413).json({ error: 'content exceeds 16KB limit' });
        }

        // FIX 2: File-specific validation
        if (filename === 'first_prompt.txt') {
          // first_prompt must have agent description
          if (!content.includes('You are') && !content.includes('sen') && !content.includes('Sen')) {
            return res.status(400).json({ error: 'first_prompt.txt must contain agent description (You are / Sen / sen)' });
          }
          if (content.length < 100) {
            return res.status(400).json({ error: 'first_prompt.txt is too short (min 100 chars)' });
          }
        } else if (filename.endsWith('.md')) {
          // Markdown files need at least one heading
          if (!content.includes('#')) {
            return res.status(400).json({ error: `${filename} must contain at least one markdown heading (#)` });
          }
          // TOOLS.md specific
          if (filename === 'TOOLS.md' && !content.includes('##')) {
            return res.status(400).json({ error: 'TOOLS.md must contain tool sections (##)' });
          }
          // IDENTITY.md specific
          if (filename === 'IDENTITY.md' && !content.includes('**')) {
            return res.status(400).json({ error: 'IDENTITY.md must contain emphasized text (**text**)' });
          }
        }

        // PREVENTION GUARD (2026-03-31): Detect dangerous overwrites
        const soulDir = path.join(this.baseDir, 'workspace', workspaceId, 'soul');
        const filePath = path.join(soulDir, filename);
        if (fs.existsSync(filePath)) {
          const existingContent = fs.readFileSync(filePath, 'utf8');

          // Guard 1: Check for dangerous content shrink
          const shrinkCheck = PreventionGuard.validateContentShrink(filename, existingContent, content);
          if (!shrinkCheck.allowed) {
            this.logger.warn('HTTP', `[PREVENTION] ${shrinkCheck.details.message}`);
            return res.status(400).json({
              error: shrinkCheck.details.message,
              reason: shrinkCheck.reason,
              details: shrinkCheck.details
            });
          }
        }

        const result = this.workspaceManager.saveSoulFile(workspaceId, filename, content);

        // Refresh skill registry for any changes
        // FIX 3: Refresh on all soul file updates, not just TOOLS.md
        if (this.skillRegistry) {
          this.skillRegistry.refreshAgent(req.params.id);
          if (this.skillCache) this.skillCache.refreshNow();
        }

        res.json({ success: true, ...result });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to save soul file', e.message);
        const status = e.message.includes('not found') ? 404 : 400;
        res.status(status).json({ error: e.message });
      }
    });

    // Delete individual soul file (clear ROADMAP/MISSION/CYCLE_LOG)
    this.app.delete('/api/workspaces/:id/soul/:filename', (req, res) => {
      try {
        if (!isValidWsId(req.params.id)) return res.status(400).json({ error: 'Invalid workspace ID' });
        const allowedFiles = ['ROADMAP.md', 'MISSION.md', 'CYCLE_LOG.md'];
        const filename = req.params.filename;
        if (!allowedFiles.includes(filename)) {
          return res.status(400).json({ error: `Cannot delete ${filename}. Only ${allowedFiles.join(', ')} can be deleted.` });
        }
        const wsDir = path.join(this.baseDir, 'workspace', req.params.id, 'soul');
        const filePath = path.join(wsDir, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          this.logger.info('HTTP', `Deleted soul file: ${req.params.id}/soul/${filename}`);
          res.json({ success: true, deleted: filename });
        } else {
          res.json({ success: true, deleted: filename, note: 'File did not exist' });
        }
      } catch (e) {
        this.logger.error('HTTP', 'Failed to delete soul file', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Image upload endpoints
    this.app.post('/api/upload-image', this.upload.single('image'), (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: 'No image uploaded' });
        }

        const imagePath = path.join(this.uploadsDir, req.file.filename);
        this.logger.info('HTTP', `Image uploaded: ${req.file.filename}`);

        res.json({
          success: true,
          path: imagePath,
          filename: req.file.filename,
          size: req.file.size
        });
      } catch (e) {
        this.logger.error('HTTP', 'Image upload error', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Multiple images upload
    const multiUpload = this.upload.fields([
      { name: 'image0', maxCount: 1 },
      { name: 'image1', maxCount: 1 },
      { name: 'image2', maxCount: 1 },
      { name: 'image3', maxCount: 1 },
      { name: 'image4', maxCount: 1 }
    ]);

    this.app.post('/api/upload-images', multiUpload, (req, res) => {
      try {
        const paths = [];

        for (let i = 0; i < 5; i++) {
          const fieldName = `image${i}`;
          if (req.files && req.files[fieldName]) {
            const file = req.files[fieldName][0];
            const imagePath = path.join(this.uploadsDir, file.filename);
            paths.push(imagePath);
            this.logger.info('HTTP', `Image ${i+1} uploaded: ${file.filename}`);
          }
        }

        if (paths.length === 0) {
          return res.status(400).json({ error: 'No images uploaded' });
        }

        res.json({
          success: true,
          paths,
          count: paths.length
        });
      } catch (e) {
        this.logger.error('HTTP', 'Multiple images upload error', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Agent endpoints
    this.app.get('/api/agents', (req, res) => {
      try {
        const agents = this.agentManager ? this.agentManager.listAgents() : [];
        res.json({ agents });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to list agents', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Crew Roster endpoint — with agent registry info (tagline, story, model)
    this.app.get('/api/agents/crew', (req, res) => {
      try {
        const agents = this.agentManager ? this.agentManager.listAgents() : [];
        const crew = agents.map(agent => ({
          id: agent.id,
          name: agent.name,
          nickname: agent.nickname,
          appearance: agent.appearance || {},
          personality: agent.personality || {},
          capabilities: agent.capabilities || [],
          registry: agent.registry || null,
          port: agent.port,
          createdAt: agent.createdAt,
          isMaster: agent.isMaster || false,
          lifecycle: agent.lifecycle || {},
          interests: agent.interests || {},
          system: agent.system || null,
          
        }));
        res.json({ crew });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to list crew', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Agent templates endpoint — Returns available auto-creation templates (roadmap 5.1)
    this.app.get('/api/agents/templates', (req, res) => {
      try {
        const AgentExecutor = require('../agent/executor');
        const AGENT_TEMPLATES = AgentExecutor.AGENT_TEMPLATES;
        const templates = Object.entries(AGENT_TEMPLATES).map(([key, tpl]) => ({
          key,
          name: tpl.name,
          skills: tpl.skills,
          personality: tpl.personality.style,
          color: tpl.color,
          keywords: tpl.matchKeywords
        }));
        res.json({ templates });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Agent template detail — Returns template config + soul file preview (roadmap 7.1)
    this.app.get('/api/agents/templates/:key', (req, res) => {
      try {
        const AgentExecutor = require('../agent/executor');
        const WorkspaceManager = require('../agent/workspace-manager');
        const AGENT_TEMPLATES = AgentExecutor.AGENT_TEMPLATES;
        const SOUL_TEMPLATES = WorkspaceManager.SOUL_TEMPLATES;
        const key = req.params.key;
        const tpl = AGENT_TEMPLATES[key];
        if (!tpl) {
          return res.status(404).json({ error: `Template "${key}" not found` });
        }
        const soulTpl = SOUL_TEMPLATES[key];
        const previewName = tpl.name;
        res.json({
          key,
          name: tpl.name,
          skills: tpl.skills,
          personality: tpl.personality,
          color: tpl.color,
          keywords: tpl.matchKeywords,
          firstPrompt: tpl.firstPrompt,
          soulFiles: soulTpl ? {
            'IDENTITY.md': soulTpl.identity(previewName),
            'SOUL.md': soulTpl.soul(previewName),
            'TOOLS.md': soulTpl.tools(previewName)
          } : null
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Agent discovery endpoint — Returns agent capabilities with rating
    this.app.get('/api/agents/discover', (req, res) => {
      try {
        // Use skillCache for enhanced discovery if available
        if (this.skillCache) {
          const agents = this.skillCache.getAllAgents();
          const discovery = agents.map(agent => {
            // Check real running status from agent manager
            const fullAgent = this.agentManager.getAgent(agent.id);
            const running = fullAgent ? fullAgent.running : false;
            return {
            id: agent.id,
            name: agent.name,
            running,
            skillCount: agent.skillCount,
            description: agent.description,
            language: agent.language,
            responseTime: agent.responseTime,
            rating: agent.rating,
            successCount: agent.successCount,
            failureCount: agent.failureCount,
            avgLatency: agent.avgLatency,
            capabilities: {
              skills: agent.skills,
              description: agent.description,
              language: agent.language,
              responseTime: agent.responseTime
            },
            appearance: {
              color: this.agentManager.getAgent(agent.id)?.appearance?.color || '#6b7280',
              emoji: this.agentManager.getAgent(agent.id)?.appearance?.emoji || '',
              avatarUrl: this.agentManager.getAgent(agent.id)?.appearance?.avatarUrl || null
            }
            };
          });

          res.json({ agents: discovery, count: discovery.length, cached: true });
          return;
        }

        // Fallback without cache
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }

        const agents = this.agentManager.listAgents();
        const discovery = agents.map(agent => ({
          id: agent.id,
          name: agent.name,
          nickname: agent.nickname,
          running: agent.running,
          capabilities: agent.capabilities || {
            skills: [],
            description: 'No capabilities defined',
            language: 'en',
            responseTime: 'unknown'
          },
          appearance: {
            color: agent.appearance?.color || '#6b7280',
            emoji: agent.appearance?.emoji || '',
            avatarUrl: agent.appearance?.avatarUrl || null
          }
        }));

        res.json({ agents: discovery, count: discovery.length });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to discover agents', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Agent skill search — Find agents by skill (roadmap 5.2: uses skillCache when available)
    this.app.get('/api/agents/search', (req, res) => {
      try {
        const { skill, query } = req.query;
        if (!skill && !query) {
          return res.status(400).json({ error: 'Query parameter required: skill or query' });
        }

        const searchTerm = (skill || query).toLowerCase();

        // Use skillCache for fast indexed search (if available)
        if (this.skillCache) {
          const results = this.skillCache.search(searchTerm);
          res.json({ matches: results.agents, skills: results.skills, categories: results.categories, count: results.agents.length, query: searchTerm, cached: true });
          return;
        }

        // Fallback: direct agent search
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }

        const agents = this.agentManager.listAgents();
        const matches = agents.filter(agent => {
          if (!agent.capabilities) return false;

          // Search in skillsSimple (string array)
          const simpleMatch = agent.capabilities.skillsSimple?.some(s =>
            s.toLowerCase().includes(searchTerm)
          );

          // Search in skills (object array — match by name/category)
          const schemaMatch = agent.capabilities.skills?.some(s =>
            (typeof s === 'string' ? s : (s.name || s.category || '')).toLowerCase().includes(searchTerm)
          );

          // Search in description
          const descMatch = agent.capabilities.description?.toLowerCase().includes(searchTerm);

          return simpleMatch || schemaMatch || descMatch;
        }).map(agent => ({
          id: agent.id,
          name: agent.name,
          rating: agent.rating || 1.0,
          skillCount: (agent.capabilities.skillsSimple?.length || 0) + (agent.capabilities.skills?.length || 0)
        }));

        res.json({ matches, count: matches.length, query: searchTerm });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to search agents', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Get agent skills with full schema
    this.app.get('/api/agents/:agentId/skills', (req, res) => {
      try {
        const agent = this.agentManager.getAgent(req.params.agentId);
        if (!agent) {
          return res.status(404).json({ error: 'Agent not found' });
        }

        const skills = agent.capabilities?.skills || [];
        res.json({
          agentId: agent.id,
          agentName: agent.name,
          skills: skills.map(skill => ({
            id: skill.id,
            name: skill.name,
            category: skill.category,
            description: skill.description,
            inputSchema: skill.inputSchema || null,
            outputSchema: skill.outputSchema || null,
            examples: skill.examples || []
          })),
          count: skills.length
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get agent skills', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Get single skill with schema
    this.app.get('/api/agents/:agentId/skills/:skillId', (req, res) => {
      try {
        const agent = this.agentManager.getAgent(req.params.agentId);
        if (!agent) {
          return res.status(404).json({ error: 'Agent not found' });
        }

        const skill = agent.capabilities?.skills?.find(s => s.id === req.params.skillId);
        if (!skill) {
          return res.status(404).json({ error: 'Skill not found' });
        }

        res.json({
          id: skill.id,
          name: skill.name,
          category: skill.category,
          description: skill.description,
          inputSchema: skill.inputSchema || null,
          outputSchema: skill.outputSchema || null,
          examples: skill.examples || []
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get skill', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Validate skill input
    this.app.post('/api/agents/:agentId/skills/:skillId/validate-input', (req, res) => {
      try {
        const agent = this.agentManager.getAgent(req.params.agentId);
        if (!agent) {
          return res.status(404).json({ error: 'Agent not found' });
        }

        const skill = agent.capabilities?.skills?.find(s => s.id === req.params.skillId);
        if (!skill) {
          return res.status(404).json({ error: 'Skill not found' });
        }

        const validators = this.skillValidators.get(req.params.agentId);
        if (!validators || !validators[req.params.skillId]) {
          return res.status(400).json({ error: 'No schema defined for this skill' });
        }

        const validator = validators[req.params.skillId];
        const result = validator.validateInput(req.body.input);

        res.json(result);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to validate skill input', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Validate skill output
    this.app.post('/api/agents/:agentId/skills/:skillId/validate-output', (req, res) => {
      try {
        const agent = this.agentManager.getAgent(req.params.agentId);
        if (!agent) {
          return res.status(404).json({ error: 'Agent not found' });
        }

        const skill = agent.capabilities?.skills?.find(s => s.id === req.params.skillId);
        if (!skill) {
          return res.status(404).json({ error: 'Skill not found' });
        }

        const validators = this.skillValidators.get(req.params.agentId);
        if (!validators || !validators[req.params.skillId]) {
          return res.status(400).json({ error: 'No schema defined for this skill' });
        }

        const validator = validators[req.params.skillId];
        const result = validator.validateOutput(req.body.output);

        res.json(result);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to validate skill output', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Manual skill registration (Roadmap 5.2)
    this.app.post('/api/agents/:agentId/skills/register', (req, res) => {
      try {
        const agent = this.agentManager.getAgent(req.params.agentId);
        if (!agent) {
          return res.status(404).json({ error: 'Agent not found' });
        }

        const { name, category, description, inputSchema, outputSchema } = req.body;
        if (!name) {
          return res.status(400).json({ error: 'Skill name is required' });
        }

        // Build skill object
        const skillId = `skill-${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
        const skill = {
          id: skillId,
          name: name,
          category: category || 'general',
          description: description || `${name} capability`,
          source: 'manual'
        };
        if (inputSchema) skill.inputSchema = inputSchema;
        if (outputSchema) skill.outputSchema = outputSchema;

        // Check for duplicate
        const existing = agent.capabilities?.skills || [];
        if (existing.some(s => s.id === skillId || s.name === name)) {
          return res.status(409).json({ error: `Skill "${name}" already registered` });
        }

        // Add to agent capabilities in agents.json
        if (!agent.capabilities) agent.capabilities = {};
        if (!agent.capabilities.skills) agent.capabilities.skills = [];
        agent.capabilities.skills.push(skill);

        // Update via agent manager
        this.agentManager.updateAgent(req.params.agentId, {
          capabilities: agent.capabilities
        });

        // Refresh skill cache
        if (this.skillCache) this.skillCache.refreshNow();
        if (this.skillRegistry) this.skillRegistry.refreshAgent(req.params.agentId);

        this.logger.info('HTTP', `Skill "${name}" registered for agent ${agent.name}`);
        res.status(201).json({ skill, message: `Skill "${name}" registered successfully` });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to register skill', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Skill cache endpoints
    this.app.get('/api/skills/cache/stats', (req, res) => {
      try {
        if (!this.skillCache) {
          return res.status(500).json({ error: 'Skill cache not available' });
        }

        const stats = this.skillCache.getStats();
        res.json(stats);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get cache stats', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/skills/search', (req, res) => {
      try {
        const { q } = req.query;
        if (!q) {
          return res.status(400).json({ error: 'Query parameter "q" required' });
        }

        // Primary: SkillCache search (indexed, fast)
        let results = null;
        if (this.skillCache) {
          results = this.skillCache.search(q);
        }

        // Fallback: SkillRegistry direct search (soul-file based)
        if (this.skillRegistry) {
          const registryResults = this.skillRegistry.search(q);
          if (registryResults.length > 0) {
            // Merge registry results into response
            if (!results) results = { agents: [], skills: [], categories: [] };
            // Add registry matches that aren't already in cache results
            const existingAgentIds = new Set((results.agents || []).map(a => a.id));
            for (const r of registryResults) {
              if (!existingAgentIds.has(r.agentId)) {
                results.agents.push({
                  id: r.agentId,
                  name: r.agentName,
                  matchedSkills: r.matchedSkills,
                  source: 'registry'
                });
              }
            }
          }
        }

        if (!results) {
          return res.status(500).json({ error: 'Skill search not available' });
        }

        res.json(results);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to search skills', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/skills/categories', (req, res) => {
      try {
        if (!this.skillCache) {
          return res.status(500).json({ error: 'Skill cache not available' });
        }

        const categories = this.skillCache.getCategories();
        res.json({ categories, count: categories.length });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get categories', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/skills/by-category/:category', (req, res) => {
      try {
        if (!this.skillCache) {
          return res.status(500).json({ error: 'Skill cache not available' });
        }

        const { category } = req.params;
        const results = this.skillCache.findByCategory(category);

        res.json({
          category,
          results: results.map(r => ({
            agentId: r.agentId,
            agentName: r.agentName,
            skillId: r.skillId,
            skillName: r.skillName,
            rating: r.rating
          })),
          count: results.length
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get skills by category', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/skills/by-name/:skillName', (req, res) => {
      try {
        if (!this.skillCache) {
          return res.status(500).json({ error: 'Skill cache not available' });
        }

        const { skillName } = req.params;
        const results = this.skillCache.findBySkillName(skillName);

        res.json({
          skillName,
          results: results.map(r => ({
            agentId: r.agentId,
            agentName: r.agentName,
            skillId: r.skillId,
            category: r.category,
            rating: r.rating
          })),
          count: results.length
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get skills by name', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Skill registry — soul-file-derived skills for all agents (roadmap 5.2)
    this.app.get('/api/skills/registry', (req, res) => {
      try {
        if (!this.skillRegistry) {
          return res.status(500).json({ error: 'Skill registry not available' });
        }

        const allSkills = this.skillRegistry.getAllSkills();
        const entries = [];
        for (const [agentId, skills] of allSkills) {
          const agent = this.agentManager?.getAgent(agentId);
          entries.push({
            agentId,
            agentName: agent?.name || agentId,
            skills,
            skillCount: skills.length
          });
        }

        res.json({
          agents: entries,
          totalAgents: entries.length,
          totalSkills: entries.reduce((sum, e) => sum + e.skillCount, 0)
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get skill registry', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Refresh skill registry for a specific agent (e.g., after soul file edit)
    this.app.post('/api/skills/registry/:agentId/refresh', (req, res) => {
      try {
        if (!this.skillRegistry) {
          return res.status(500).json({ error: 'Skill registry not available' });
        }

        const { agentId } = req.params;
        this.skillRegistry.refreshAgent(agentId);

        // Also refresh skill cache to pick up changes
        if (this.skillCache) this.skillCache.refreshNow();

        const skills = this.skillRegistry.getSkills(agentId);
        res.json({
          agentId,
          skills,
          skillCount: skills.length,
          message: 'Skills refreshed from soul files'
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to refresh agent skills', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Update agent rating
    this.app.post('/api/agents/:agentId/rating', (req, res) => {
      try {
        if (!this.skillCache) {
          return res.status(500).json({ error: 'Skill cache not available' });
        }

        const { success, latency = 0 } = req.body;
        const { agentId } = req.params;

        if (typeof success !== 'boolean') {
          return res.status(400).json({ error: 'success boolean required' });
        }

        this.skillCache.updateRating(agentId, success, latency);

        const agent = this.skillCache.getAgent(agentId);
        res.json({
          agentId,
          rating: agent.rating,
          successCount: agent.successCount,
          failureCount: agent.failureCount,
          avgLatency: agent.avgLatency
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to update agent rating', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════════════ Agent Performance Stats (Roadmap 7.3) ═══════════════

    // GET /api/agents/stats — all agents performance overview
    this.app.get('/api/agents/stats', (req, res) => {
      try {
        if (!this.agentStats) {
          return res.status(500).json({ error: 'Agent stats not available' });
        }
        const systemStats = this.agentStats.getSystemStats();
        res.json(systemStats);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get agent stats', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // GET /api/agents/:id/stats — single agent detailed stats
    this.app.get('/api/agents/:id/stats', (req, res) => {
      try {
        if (!this.agentStats) {
          return res.status(500).json({ error: 'Agent stats not available' });
        }
        // Verify agent exists before returning stats
        const agent = this.agentManager && this.agentManager.getAgent(req.params.id);
        if (!agent) {
          return res.status(404).json({ error: `Agent not found: ${req.params.id}` });
        }
        const stats = this.agentStats.getStats(req.params.id);
        res.json(stats);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get agent stats', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════════════ Enhanced Stats + Project Portfolio (FAZ 3) ═══════════════

    // GET /api/agents/stats/enhanced?window=24h|7d|30d — system-wide enhanced stats
    this.app.get('/api/agents/stats/enhanced', (req, res) => {
      try {
        if (!this.agentStatsEnhanced) {
          // Fallback to basic stats
          if (!this.agentStats) return res.status(500).json({ error: 'Stats not available' });
          return res.json(this.agentStats.getSystemStats());
        }
        const window = req.query.window || '24h';
        if (!['24h', '7d', '30d'].includes(window)) {
          return res.status(400).json({ error: 'Invalid window. Use: 24h, 7d, 30d' });
        }
        const systemStats = this.agentStatsEnhanced.getSystemStats(window);
        for (const [id, stats] of Object.entries(systemStats.perAgent || {})) {
          const ws = this.workspaceManager.getWorkspace(id);
          if (ws) stats.agentName = ws.name;
        }
        res.json(systemStats);
      } catch (e) {
        this.logger.error('HTTP', 'Enhanced stats error', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // GET /api/agents/:id/stats/enhanced?window=24h|7d|30d — per-agent enhanced stats
    this.app.get('/api/agents/:id/stats/enhanced', (req, res) => {
      try {
        if (!this.agentStatsEnhanced) {
          if (!this.agentStats) return res.status(500).json({ error: 'Stats not available' });
          return res.json(this.agentStats.getStats(req.params.id));
        }
        const window = req.query.window || '24h';
        if (!['24h', '7d', '30d'].includes(window)) {
          return res.status(400).json({ error: 'Invalid window. Use: 24h, 7d, 30d' });
        }
        const stats = this.agentStatsEnhanced.getStats(req.params.id, window);
        const ws = this.workspaceManager.getWorkspace(req.params.id);
        if (ws) stats.agentName = ws.name;
        res.json(stats);
      } catch (e) {
        this.logger.error('HTTP', 'Enhanced agent stats error', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // GET /api/agents/outputs — all agents' last outputs (OUTPUT popup)
    this.app.get('/api/agents/outputs', (req, res) => {
      try {
        if (!this.agentOutputs) {
          return res.json({ outputs: {} });
        }
        const allOutputs = this.agentOutputs.getAllLastOutputs();
        // Enrich with agent info (emoji, name) from workspace manager
        const enriched = {};
        for (const [wsId, data] of Object.entries(allOutputs)) {
          const ws = this.workspaceManager.getWorkspace(wsId);
          enriched[wsId] = {
            ...data,
            agentName: ws ? ws.name : data.agentName,
            emoji: ws && ws.appearance ? ws.appearance.emoji : '🤖'
          };
        }
        res.json({ outputs: enriched });
      } catch (e) {
        this.logger.error('HTTP', 'Agent outputs error', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // GET /api/agents/:id/outputs — single agent output history
    this.app.get('/api/agents/:id/outputs', (req, res) => {
      try {
        if (!this.agentOutputs) {
          return res.json({ entries: [], lastOutput: null });
        }
        const data = this.agentOutputs.getOutputs(req.params.id);
        const ws = this.workspaceManager.getWorkspace(req.params.id);
        if (ws) {
          data.agentName = ws.name;
          data.emoji = ws.appearance ? ws.appearance.emoji : '🤖';
        }
        res.json(data);
      } catch (e) {
        this.logger.error('HTTP', 'Agent outputs detail error', e.message);
        res.status(500).json({ error: e.message });
      }
    });


    // ═══════════════ API Usage & Budget Tracking (Roadmap 8.4) ═══════════════

    // GET /api/usage — usage summary (today, month, last 7/30 days, budget status)
    this.app.get('/api/usage', (req, res) => {
      try {
        if (!this.usageTracker) {
          return res.status(500).json({ error: 'Usage tracker not available' });
        }
        res.json(this.usageTracker.getSummary());
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get usage', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════════════ Performance Profiling (Roadmap 10.3) ═══════════════

    // GET /api/performance — P50/P95/P99 latency metrics per layer
    this.app.get('/api/performance', (req, res) => {
      try {
        if (!this.agentExecutor || !this.agentExecutor.performanceProfiler) {
          return res.status(500).json({ error: 'Performance profiler not available' });
        }
        res.json(this.agentExecutor.performanceProfiler.getSummary());
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get performance stats', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // GET /api/performance/:layer — Detailed stats for a specific layer
    this.app.get('/api/performance/:layer', (req, res) => {
      try {
        if (!this.agentExecutor || !this.agentExecutor.performanceProfiler) {
          return res.status(500).json({ error: 'Performance profiler not available' });
        }
        const stats = this.agentExecutor.performanceProfiler.getLayerStats(req.params.layer);
        if (!stats) {
          return res.status(404).json({ error: `No data for layer: ${req.params.layer}` });
        }
        res.json({
          layer: req.params.layer,
          stats: stats,
          recentSamples: this.agentExecutor.performanceProfiler.getRecentSamples(req.params.layer, 50)
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get layer performance stats', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════════════ Agent CRUD ═══════════════

    this.app.post('/api/agents', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }

        const agentConfig = req.body;
        if (!agentConfig.name || !agentConfig.name.trim()) {
          return res.status(400).json({ error: 'Agent name is required' });
        }
        if (agentConfig.name.length > 100) {
          return res.status(400).json({ error: 'Agent name must be 100 characters or less' });
        }
        agentConfig.name = sanitizeName(agentConfig.name);
        if (agentConfig.description) agentConfig.description = sanitizeName(agentConfig.description);

        // createAgent handles both agents.json and workspaces.json registration
        const agent = this.agentManager.createAgent(agentConfig, {
          workspaceManager: this.workspaceManager
        });
        this.logger.success('HTTP', `Agent created: ${agent.name} (${agent.id})`);
        // Register skills from soul files for new agent (roadmap 5.2)
        if (this.skillRegistry) this.skillRegistry.refreshAgent(agent.id);
        if (this.skillCache) this.skillCache.refreshNow();
        res.json(agent);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to create agent', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.delete('/api/agents/:id', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }

        const preserveWorkspace = req.query.preserveWorkspace === 'true' || req.body?.preserveWorkspace === true;
        const force = req.query.force === 'true' || req.body?.force === true;
        const result = this.agentManager.deleteAgent(req.params.id, { preserveWorkspace, force });

        // Also delete workspace (if not preserved)
        if (!preserveWorkspace) {
          try {
            this.workspaceManager.deleteWorkspace(req.params.id);
          } catch (e) {
            // Workspace might not exist, that's OK
          }
        }

        const msg = preserveWorkspace
          ? `Agent deleted (workspace preserved): ${req.params.id}`
          : `Agent deleted: ${req.params.id}`;
        this.logger.success('HTTP', msg);
        if (this.skillCache) this.skillCache.refreshNow();
        res.json(result);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to delete agent', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.put('/api/agents/:id', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }
        // Whitelist allowed update fields to prevent injection of arbitrary properties
        const allowedFields = ['name', 'description', 'appearance', 'capabilities', 'channels', 'skills', 'skillsSimple', 'tags', 'modelOverride'];
        const sanitized = {};
        for (const key of allowedFields) {
          if (req.body[key] !== undefined) sanitized[key] = req.body[key];
        }
        const agent = this.agentManager.updateAgent(req.params.id, sanitized);
        this.logger.success('HTTP', `Agent updated: ${agent.name} (${req.params.id})`);
        res.json(agent);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to update agent', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Avatar upload for agent
    this.app.post('/api/agents/:id/avatar', this.upload.single('avatar'), (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'No avatar file provided' });
        }

        const agentId = req.params.id;
        const oldPath = req.file.path;
        const ext = path.extname(req.file.originalname);
        const newFilename = `${agentId}${ext}`;
        const newPath = path.join(this.avatarsDir, newFilename);

        // Move from uploads to avatars directory
        fs.renameSync(oldPath, newPath);

        // Update agent with avatar URL
        const avatarUrl = `/api/avatars/${newFilename}`;
        const agent = this.agentManager.updateAgent(agentId, {
          appearance: {
            ...this.agentManager.getAgent(agentId)?.appearance,
            avatarUrl
          }
        });

        this.logger.success('HTTP', `Avatar uploaded for agent: ${agent.name}`);
        res.json({ avatarUrl, agent });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to upload avatar', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/agents/:id/start', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }

        const agent = this.agentManager.startAgent(req.params.id);
        res.json(agent);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to start agent', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/agents/:id/stop', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }

        this.agentManager.stopAgent(req.params.id);
        res.json({ success: true });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to stop agent', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // ═══════════════ Agent Lifecycle Management (Roadmap 7.4) ═══════════════

    // Pause an agent
    this.app.post('/api/agents/:id/pause', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }
        const { reason } = req.body || {};
        const agent = this.agentManager.pauseAgent(req.params.id, reason || 'manual');
        this.logger.info('HTTP', `Agent paused: ${agent.name} (${req.params.id})`);
        res.json({ success: true, agent: { id: agent.id, name: agent.name, lifecycle: agent.lifecycle } });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to pause agent', e.message);
        const status = e.message.includes('not found') ? 404 : 400;
        res.status(status).json({ error: e.message });
      }
    });

    // Wake a paused agent
    this.app.post('/api/agents/:id/wake', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }
        const agent = this.agentManager.wakeAgent(req.params.id);
        this.logger.info('HTTP', `Agent woken: ${agent.name} (${req.params.id})`);
        res.json({ success: true, agent: { id: agent.id, name: agent.name, lifecycle: agent.lifecycle } });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to wake agent', e.message);
        const status = e.message.includes('not found') ? 404 : 400;
        res.status(status).json({ error: e.message });
      }
    });

    // Get agent lifecycle status
    this.app.get('/api/agents/:id/lifecycle', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }
        const lifecycle = this.agentManager.getAgentLifecycle(req.params.id);
        if (!lifecycle) {
          return res.status(404).json({ error: 'Agent not found' });
        }
        res.json(lifecycle);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get agent lifecycle', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Get lifecycle overview for all agents
    this.app.get('/api/agents/lifecycle/overview', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }
        const overview = this.agentManager.getLifecycleOverview();
        res.json(overview);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get lifecycle overview', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Trigger idle check manually
    this.app.post('/api/agents/lifecycle/check-idle', (req, res) => {
      try {
        if (!this.agentManager) {
          return res.status(500).json({ error: 'Agent manager not available' });
        }
        const { thresholdHours } = req.body || {};
        const thresholdMs = thresholdHours ? thresholdHours * 60 * 60 * 1000 : undefined;
        const paused = this.agentManager.checkIdleAgents(thresholdMs);
        res.json({ paused, count: paused.length });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to check idle agents', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // GET /api/agents/:id/reasoning — reasoning trace for a conversation (roadmap 9.1)
    this.app.get('/api/agents/:id/reasoning', (req, res) => {
      try {
        const conversationId = req.query.conversationId || req.params.id;
        if (!conversationId) {
          return res.status(400).json({ error: 'conversationId required in query' });
        }

        // Get reasoning trace from executor
        // Note: executor instance is passed via this.agentExecutor setter from index.js
        if (!this.agentExecutor || !this.agentExecutor.getReasoningTrace) {
          return res.status(500).json({ error: 'Executor not available for reasoning trace' });
        }

        const trace = this.agentExecutor.getReasoningTrace(conversationId);
        res.json(trace);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get reasoning trace', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // DELETE /api/agents/:id/reasoning — clear reasoning trace
    this.app.delete('/api/agents/:id/reasoning', (req, res) => {
      try {
        const conversationId = req.query.conversationId || req.params.id;
        if (!conversationId) {
          return res.status(400).json({ error: 'conversationId required in query' });
        }

        if (!this.agentExecutor || !this.agentExecutor.clearReasoningTrace) {
          return res.status(500).json({ error: 'Executor not available' });
        }

        this.agentExecutor.clearReasoningTrace(conversationId);
        res.json({ ok: true, conversationId });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to clear reasoning trace', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // GET /api/agents/:id/confidence — confidence score for a response (roadmap 9.3)
    this.app.get('/api/agents/:id/confidence', (req, res) => {
      try {
        const conversationId = req.query.conversationId || req.params.id;
        if (!conversationId) {
          return res.status(400).json({ error: 'conversationId required in query' });
        }

        if (!this.agentExecutor || !this.agentExecutor.getConfidenceScore) {
          return res.status(500).json({ error: 'Executor not available for confidence scoring' });
        }

        const score = this.agentExecutor.getConfidenceScore(conversationId);
        res.json({
          conversationId,
          ...score,
          uiIndicator: {
            opacity: score.composite, // 0-1 maps directly to opacity
            color: score.composite > 0.8 ? '#10b981' : (score.composite > 0.6 ? '#f59e0b' : '#ef4444') // green/amber/red
          }
        });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get confidence score', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // GET /api/agents/:id/decisions — decision tree for an agent (roadmap 10.2)
    this.app.get('/api/agents/:id/decisions', (req, res) => {
      try {
        const agentId = req.params.id;
        if (!agentId) {
          return res.status(400).json({ error: 'agentId required in path' });
        }

        if (!this.agentExecutor || !this.agentExecutor.getDecisions) {
          return res.status(500).json({ error: 'Executor not available for decision tracking' });
        }

        const decisions = this.agentExecutor.getDecisions(agentId);
        res.json(decisions);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get decision tree', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // DELETE /api/agents/:id/decisions — clear decision log for an agent (roadmap 10.2)
    this.app.delete('/api/agents/:id/decisions', (req, res) => {
      try {
        const agentId = req.params.id;
        if (!agentId) {
          return res.status(400).json({ error: 'agentId required in path' });
        }

        if (!this.agentExecutor || !this.agentExecutor.clearDecisions) {
          return res.status(500).json({ error: 'Executor not available' });
        }

        this.agentExecutor.clearDecisions(agentId);
        res.json({ ok: true, agentId });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to clear decision log', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Inter-agent messaging endpoint (1-to-1)
    this.app.post('/api/agents/:id/message', async (req, res) => {
      try {
        if (!this.messageRouter) {
          return res.status(500).json({ error: 'Message router not available' });
        }

        const { from, message, timeout = 300, data = null, conversationId = null } = req.body;
        const targetAgentId = req.params.id;

        if (!from || !message) {
          return res.status(400).json({ error: 'Missing required fields: from, message' });
        }

        // Validate agent ID formats (reject garbage/injection attempts)
        const agentIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,49}$/;
        if (!agentIdPattern.test(targetAgentId)) {
          return res.status(400).json({ error: `Invalid target agent ID format: ${targetAgentId.substring(0, 50)}` });
        }
        if (!agentIdPattern.test(from)) {
          return res.status(400).json({ error: `Invalid source agent ID format: ${from.substring(0, 50)}` });
        }

        // Prevent self-messaging (direct + alias resolution)
        if (from === targetAgentId) {
          return res.status(400).json({ error: 'Self-messaging not allowed' });
        }
        // Alias resolution: check if from and target resolve to the same agent
        const resolvedFrom = this.agentManager.getAgent(from);
        const resolvedTarget = this.agentManager.getAgent(targetAgentId);
        if (resolvedFrom && resolvedTarget && resolvedFrom.id === resolvedTarget.id) {
          return res.status(400).json({ error: `Self-messaging not allowed (${from} and ${targetAgentId} resolve to same agent)` });
        }

        // Check if target agent exists
        const agent = this.agentManager.getAgent(targetAgentId);
        if (!agent) {
          return res.status(404).json({ error: `Agent not found: ${targetAgentId}` });
        }

        // Auto-wake target agent if paused (roadmap 7.4)
        try { this.agentManager.touchAgentActivity(targetAgentId); } catch (_) {}

        // Send message via message router
        const result = await this.messageRouter.sendMessage({
          from: from,
          to: targetAgentId,
          message: message,
          timeout: timeout,
          data: data,
          conversationId: conversationId
        });

        res.json(result);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to send inter-agent message', e.message);
        // Use 504 for timeout errors, 500 for everything else
        const status = e.message && e.message.includes('Message timeout') ? 504 : 500;
        res.status(status).json({ error: e.message });
      }
    });

    // Group chat endpoints
    this.app.post('/api/groups', (req, res) => {
      try {
        if (!this.groupChat) {
          return res.status(500).json({ error: 'Group chat not available' });
        }

        const { participants, topic, initiator } = req.body;

        if (!participants || !Array.isArray(participants)) {
          return res.status(400).json({ error: 'participants array required' });
        }

        const group = this.groupChat.createGroup({
          participants,
          topic,
          initiator
        });

        res.json(group);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to create group', e.message);
        res.status(400).json({ error: e.message });
      }
    });

    this.app.get('/api/groups', (req, res) => {
      try {
        if (!this.groupChat) {
          return res.status(500).json({ error: 'Group chat not available' });
        }

        const groups = this.groupChat.listGroups();
        res.json({ groups, count: groups.length });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to list groups', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/groups/:id', (req, res) => {
      try {
        if (!this.groupChat) {
          return res.status(500).json({ error: 'Group chat not available' });
        }

        const group = this.groupChat.getGroup(req.params.id);
        if (!group) {
          return res.status(404).json({ error: 'Group not found' });
        }

        res.json(group);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get group', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/groups/:id/message', async (req, res) => {
      try {
        if (!this.groupChat) {
          return res.status(500).json({ error: 'Group chat not available' });
        }

        const { from, message, waitForReplies = true, timeout = 60 } = req.body;
        const groupId = req.params.id;

        if (!from || !message) {
          return res.status(400).json({ error: 'Missing required fields: from, message' });
        }

        const result = await this.groupChat.sendMessage(groupId, from, message, {
          waitForReplies,
          timeout
        });

        res.json(result);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to send group message', e.message);
        res.status(400).json({ error: e.message });
      }
    });

    this.app.get('/api/groups/:id/history', (req, res) => {
      try {
        if (!this.groupChat) {
          return res.status(500).json({ error: 'Group chat not available' });
        }

        const limit = parseInt(req.query.limit) || 20;
        const history = this.groupChat.getHistory(req.params.id, limit);

        res.json({ history, count: history.length });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get group history', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/groups/:id/close', (req, res) => {
      try {
        if (!this.groupChat) {
          return res.status(500).json({ error: 'Group chat not available' });
        }

        const group = this.groupChat.closeGroup(req.params.id);
        res.json(group);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to close group', e.message);
        res.status(400).json({ error: e.message });
      }
    });

    // Task planning endpoints (Roadmap 5.3: multi-agent task decomposition)
    this.app.post('/api/tasks/plan', async (req, res) => {
      try {
        if (!this.taskPlanner) {
          return res.status(500).json({ error: 'Task planner not available' });
        }

        const { task, fromAgentId = 'master', timeout = 60, dryRun = false, strategy = 'parallel' } = req.body;
        if (!task || typeof task !== 'string' || task.trim().length < 5) {
          return res.status(400).json({ error: 'Task description required (min 5 chars)' });
        }

        const result = await this.taskPlanner.planAndExecute(task.trim(), {
          fromAgentId,
          timeout,
          dryRun,
          strategy
        });

        res.json(result);
      } catch (e) {
        this.logger.error('HTTP', 'Task planning failed', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/tasks', (req, res) => {
      try {
        if (!this.taskPlanner) {
          return res.status(500).json({ error: 'Task planner not available' });
        }

        const plans = this.taskPlanner.listPlans();
        res.json({ plans, count: plans.length });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to list task plans', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/tasks/stats', (req, res) => {
      try {
        if (!this.taskPlanner) {
          return res.status(500).json({ error: 'Task planner not available' });
        }
        res.json(this.taskPlanner.getStats());
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get task planner stats', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/tasks/:id', (req, res) => {
      try {
        if (!this.taskPlanner) {
          return res.status(500).json({ error: 'Task planner not available' });
        }

        const plan = this.taskPlanner.getPlan(req.params.id);
        if (!plan) {
          return res.status(404).json({ error: 'Task plan not found' });
        }

        res.json(plan);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to get task plan', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Shared context endpoints (Roadmap 5.5: shared memory namespace for multi-agent collaboration)
    this.app.get('/api/shared-context', (req, res) => {
      try {
        if (!this.sharedContext) {
          return res.status(500).json({ error: 'Shared context not available' });
        }
        res.json({ namespaces: this.sharedContext.listNamespaces(), stats: this.sharedContext.getStats() });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/shared-context', (req, res) => {
      try {
        if (!this.sharedContext) {
          return res.status(500).json({ error: 'Shared context not available' });
        }
        const { taskDescription, createdBy, participants } = req.body;
        const result = this.sharedContext.create({ taskDescription, createdBy, participants });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/shared-context/:id', (req, res) => {
      try {
        if (!this.sharedContext) {
          return res.status(500).json({ error: 'Shared context not available' });
        }
        const data = this.sharedContext.getAll(req.params.id);
        if (!data) return res.status(404).json({ error: 'Namespace not found' });
        res.json(data);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/shared-context/:id/facts', (req, res) => {
      try {
        if (!this.sharedContext) {
          return res.status(500).json({ error: 'Shared context not available' });
        }
        const { key, value, agentId } = req.body;
        if (!key || value === undefined) {
          return res.status(400).json({ error: 'key and value required' });
        }
        const result = this.sharedContext.set(req.params.id, key, value, agentId || 'api');
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.delete('/api/shared-context/:id', (req, res) => {
      try {
        if (!this.sharedContext) {
          return res.status(500).json({ error: 'Shared context not available' });
        }
        const deleted = this.sharedContext.deleteNamespace(req.params.id);
        res.json({ deleted });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Agent info (for UI sidebar title + welcome message)
    this.app.get('/api/agent-info', (req, res) => {
      res.json({
        isAgent: true,
        name: 'System',
        version: '2.1.0',
        type: 'master'
      });
    });

    // Conversations endpoint
    this.app.get('/api/conversations', (req, res) => {
      try {
        if (this.conversationManager) {
          const wsId = req.query.workspaceId;
          if (wsId) {
            const convs = this.conversationManager.getWorkspaceConversations(wsId);
            res.json({ conversations: convs, currentId: convs[0]?.id || null });
          } else {
            res.json(this.conversationManager.getAllConversations());
          }
        } else {
          res.json({ conversations: [], currentId: null });
        }
      } catch (e) {
        this.logger.error('HTTP', 'Failed to load conversations', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Inter-agent message history (supports ?limit=N, default 50, max 200)
    this.app.get('/api/inter-agent/history', (req, res) => {
      try {
        const logFile = path.join(this.baseDir, 'data', 'inter-agent-messages.jsonl');
        if (!fs.existsSync(logFile)) {
          return res.json({ messages: [], total: 0 });
        }

        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);

        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(l => l.trim());
        const allEntries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

        // Build response lookup map: requestId → response (O(1) instead of O(n) per sent message)
        const responseMap = new Map();
        for (const entry of allEntries) {
          if (entry.type === 'agent_response' && entry.requestId) {
            responseMap.set(entry.requestId, entry);
          }
        }

        const sentMessages = allEntries.filter(e => e.type === 'agent_message');

        // Take only last N sent messages (most recent first) before mapping
        const recentSent = sentMessages.slice(-limit).reverse();

        const conversations = recentSent.map(sent => {
          const response = responseMap.get(sent.id);

          let status = 'pending';
          let reply = null;
          let error = null;

          if (response) {
            if (response.status === 'ok' && response.reply) {
              status = 'completed';
              reply = response.reply;
            } else if (response.status === 'error') {
              status = 'error';
              error = response.error || 'Unknown error';
            }
          }

          return {
            id: sent.id,
            from: sent.from?.agentId || 'unknown',
            to: sent.to?.agentId || 'unknown',
            message: sent.payload?.message || '',
            reply: reply,
            error: error,
            conversationId: response?.conversationId || null,
            startedAt: sent.timestamp,
            completedAt: response?.timestamp || null,
            status: status,
            transport: response?.transport || 'http',
            latency: response?.latency || null
          };
        });

        res.json({ messages: conversations, total: sentMessages.length });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to load inter-agent history', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // End-to-end inter-agent test — send ping to a target agent and measure round-trip
    this.app.get('/api/inter-agent/test', async (req, res) => {
      try {
        const result = await this.runInterAgentTest(req.query.target);
        const status = result.passed ? 200 : 503;
        res.status(status).json(result);
      } catch (e) {
        this.logger.error('HTTP', 'Inter-agent test failed', e.message);
        res.status(500).json({ passed: false, error: e.message });
      }
    });

    // Streaming test endpoint — broadcasts fake streaming chunks to a conversation
    this.app.post('/api/test/streaming', async (req, res) => {
      try {
        const { conversationId, text, chunkSize = 8, delayMs = 80 } = req.body;
        if (!conversationId) {
          return res.status(400).json({ error: 'conversationId required' });
        }
        if (!this.wsServer) {
          return res.status(500).json({ error: 'WebSocket server not available' });
        }

        const content = text || 'Hello! This is a **streaming test** message.\n\nArriving in real-time, chunk by chunk:\n\n1. First item — everything is working\n2. Second item — streaming is operational\n3. Third item — test complete\n\nStreaming pipeline is running **successfully**!';

        // Split into chunks
        const chunks = [];
        for (let i = 0; i < content.length; i += chunkSize) {
          chunks.push(content.substring(i, i + chunkSize));
        }

        res.json({ status: 'streaming', chunks: chunks.length, totalChars: content.length });

        // Send chunks with delay
        for (let i = 0; i < chunks.length; i++) {
          await new Promise(r => setTimeout(r, delayMs));
          this.wsServer.broadcastToConversation(conversationId, {
            type: 'text',
            content: chunks[i]
          });
        }

        // Send complete + done
        await new Promise(r => setTimeout(r, 100));
        this.wsServer.broadcastToConversation(conversationId, {
          type: 'complete',
          response: { confidence: 0.95 }
        });
        await new Promise(r => setTimeout(r, 50));
        this.wsServer.broadcastToConversation(conversationId, {
          type: 'done',
          code: 0
        });

        this.logger.info('HTTP', `Streaming test: ${chunks.length} chunks sent to conv ${conversationId}`);
      } catch (e) {
        this.logger.error('HTTP', 'Streaming test failed', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Memory cleanup endpoint (9.2: Multi-step task memory)
    this.app.post('/api/memory/cleanup', (req, res) => {
      try {
        const workspaceId = req.body.workspaceId;
        const maxAgeDays = req.body.maxAgeDays || 7;

        if (!workspaceId) {
          return res.status(400).json({ error: 'workspaceId required' });
        }

        const memory = this.agentExecutor && this.agentExecutor._getMemoryForWorkspace(workspaceId);
        if (!memory) {
          return res.status(400).json({ error: 'Workspace not found or memory unavailable' });
        }

        const result = memory.cleanupOldSteps(maxAgeDays);
        this.logger.info('HTTP', `Memory cleanup: ${result.cleanedCount} episodes processed, maxAge=${maxAgeDays}d`);
        res.json({ success: !result.error, cleanedCount: result.cleanedCount, error: result.error });
      } catch (e) {
        this.logger.error('HTTP', 'Memory cleanup failed', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Get step history for a task (9.2)
    this.app.get('/api/memory/steps/:workspaceId/:goal', (req, res) => {
      try {
        const { workspaceId, goal } = req.params;
        const memory = this.agentExecutor && this.agentExecutor._getMemoryForWorkspace(workspaceId);
        if (!memory) {
          return res.status(400).json({ error: 'Workspace not found or memory unavailable' });
        }

        const stepHistory = memory.getStepHistory(decodeURIComponent(goal));
        res.json({ goal, stepHistory, count: stepHistory.length });
      } catch (e) {
        this.logger.error('HTTP', 'Step history fetch failed', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Memory usage statistics for dashboard (Roadmap 10.4)
    this.app.get('/api/memory/stats', (req, res) => {
      try {
        if (!this.agentExecutor) {
          return res.status(500).json({ error: 'Agent executor not available' });
        }

        // Get stats from primary memory system (dynamic — never hardcode workspace ID)
        const defaultWs = this.agentExecutor.workspaceManager.getDefaultWorkspace();
        const memory = defaultWs ? this.agentExecutor._getMemoryForWorkspace(defaultWs.id) : null;
        if (!memory) {
          return res.status(500).json({ error: 'Memory system not initialized' });
        }

        const stats = memory.getStats();
        res.json(stats);
      } catch (e) {
        this.logger.error('HTTP', 'Memory stats fetch failed', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/conversations', (req, res) => {
      try {
        if (!this.conversationManager) {
          return res.status(500).json({ error: 'Conversation manager not available' });
        }

        const { title, workspaceId } = req.body;
        // Reject empty creations (e.g., a smoke/e2e test hitting this endpoint with `{}`).
        // Without validation, such requests accumulate as blank "New Conversation"
        // entries under ws=default on every restart — clutters the UI.
        if (!workspaceId || typeof workspaceId !== 'string' || !workspaceId.trim()) {
          return res.status(400).json({ error: 'workspaceId required' });
        }
        const conversation = this.conversationManager.createConversation(
          title || 'New Conversation',
          workspaceId
        );
        res.json(conversation);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to create conversation', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.delete('/api/conversations/:id', (req, res) => {
      try {
        if (!this.conversationManager) {
          return res.status(500).json({ error: 'Conversation manager not available' });
        }

        this.conversationManager.deleteConversation(req.params.id);
        // Always clean up sessions — no orphans left behind
        if (this.agentExecutor) {
          this.agentExecutor.cleanupConversationSessions(req.params.id);
        }
        res.json({ success: true });
      } catch (e) {
        this.logger.error('HTTP', 'Failed to delete conversation', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.patch('/api/conversations/:id', (req, res) => {
      try {
        if (!this.conversationManager) {
          return res.status(500).json({ error: 'Conversation manager not available' });
        }

        const { title } = req.body;
        const conv = this.conversationManager.updateTitle(req.params.id, title);
        res.json(conv);
      } catch (e) {
        this.logger.error('HTTP', 'Failed to update conversation', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    // Security endpoints
    this.app.post('/api/security/rotate-token', (req, res) => {
      if (!this.security) return res.status(500).json({ error: 'Security not available' });
      const newToken = this.security.rotateApiToken();
      this.logger.info('HTTP', 'API token rotated');
      res.json({ token: newToken });
    });

    this.app.post('/api/security/scan', (req, res) => {
      if (!this.security) return res.status(500).json({ error: 'Security not available' });
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });
      const result = this.security.scanForCredentials(text);
      res.json(result);
    });

    // Webhook endpoints (hardened — roadmap 6.3)
    // Public webhook receiver with signature verification + rate limiting
    this.app.post('/webhook/:id', async (req, res) => {
      if (!this.webhookManager) return res.status(500).json({ error: 'Webhooks not available' });

      const hookId = req.params.id;
      const hook = this.webhookManager.get(hookId);
      if (!hook) return res.status(404).json({ error: 'Webhook not found' });

      // Rate limiting by source IP
      const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      if (this.webhookManager.isRateLimited(clientIp)) {
        return res.status(429).json({ error: 'Rate limited', retryAfter: 60 });
      }

      // Signature verification (optional but logged)
      const signature = req.headers['x-webhook-signature'] || req.headers['x-hub-signature-256'];
      const signatureValid = signature
        ? this.webhookManager.verifySignature(hookId, req.body, signature)
        : null; // null = no signature provided

      this.logger.info('Webhook', `Received: ${hookId} (sig: ${signatureValid === null ? 'none' : signatureValid ? 'valid' : 'INVALID'})`);

      // Process delivery (with retry if forwardUrl configured)
      const result = await this.webhookManager.receive(hookId, req.body, {
        ip: clientIp,
        signatureValid
      });

      // Broadcast to WebSocket clients
      if (this.wsServer) {
        this.wsServer.broadcast({ type: 'webhook', id: hookId, data: req.body });
      }

      // Notify via notifyFn
      if (this.notify) {
        this.notify(`Webhook received: ${hookId}`).catch(() => {});
      }

      res.json(result);
    });

    // Webhook management
    this.app.get('/api/webhooks', (req, res) => {
      if (!this.webhookManager) return res.json({ webhooks: [] });
      res.json({ webhooks: this.webhookManager.list() });
    });

    this.app.get('/api/webhook-logs', (req, res) => {
      if (!this.webhookManager) return res.json({ logs: [] });
      const hookId = req.query.hookId || null;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      res.json({ logs: this.webhookManager.getLogs(hookId, limit) });
    });

    this.app.post('/api/webhooks', (req, res) => {
      if (!this.webhookManager) return res.status(500).json({ error: 'Webhooks not available' });
      const { id, description, forwardUrl } = req.body;
      if (!id) return res.status(400).json({ error: 'Webhook id required' });
      if (id.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid webhook id (alphanumeric, max 64 chars)' });
      }
      const hook = this.webhookManager.create(id, { description: description || '', forwardUrl: forwardUrl || null });
      res.json(hook);
    });

    this.app.delete('/api/webhooks/:id', (req, res) => {
      if (!this.webhookManager) return res.status(500).json({ error: 'Webhooks not available' });
      const deleted = this.webhookManager.delete(req.params.id);
      res.json({ success: deleted });
    });

    // ═══════════════ Safe Restart ═══════════════
    // Agents call this instead of direct process restart.
    // If other agents are running, restart is queued until they finish.
    this.app.post('/api/safe-restart', (req, res) => {
      try {
        if (!this.agentExecutor) {
          return res.status(500).json({ error: 'Agent executor not available' });
        }
        const requestedBy = req.body?.requestedBy || 'unknown';
        const result = this.agentExecutor.requestSafeRestart(requestedBy);
        res.json(result);
      } catch (err) {
        this.logger.error('HTTP', `Safe restart error: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    // Status snapshot — lets agents verify whether a restart is currently
    // queued, whether an earlier request has already fired, and how long the
    // server has been up. Without this, an agent that POSTed /api/safe-restart
    // has no way to tell later whether the restart happened — it ends up
    // caching the initial "queued" response and reporting stale info.
    this.app.get('/api/safe-restart/status', (req, res) => {
      try {
        if (!this.agentExecutor) {
          return res.status(500).json({ error: 'Agent executor not available' });
        }
        res.json(this.agentExecutor.getSafeRestartStatus());
      } catch (err) {
        this.logger.error('HTTP', `Safe restart status error: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    // ═══════════════ Session Management ═══════════════
    // Inject/restore a session into executor's in-memory map
    this.app.post('/api/sessions/inject', (req, res) => {
      try {
        if (!this.agentExecutor) {
          return res.status(500).json({ error: 'Agent executor not available' });
        }
        const { workspaceId, conversationId, sessionId } = req.body;
        if (!workspaceId || !conversationId || !sessionId) {
          return res.status(400).json({ error: 'Missing workspaceId, conversationId, or sessionId' });
        }
        const key = `webchat:default:${workspaceId}:${conversationId}`;
        this.agentExecutor.sessions.set(key, {
          lastActivity: new Date().toISOString(),
          resetCount: 0,
          turnCount: 1,
          sessionId
        });
        this.agentExecutor._saveSessions();
        res.json({ success: true, key, sessionId });
      } catch (err) {
        this.logger.error('HTTP', `Session inject error: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });


    // Logger status endpoint
    this.app.get('/api/logs/status', (req, res) => {
      if (this.logger && this.logger.getStatus) {
        res.json(this.logger.getStatus());
      } else {
        res.json({ error: 'Logger status not available' });
      }
    });

    // Channel management endpoints (agent-specific)
    this.app.get('/api/agents/:agentId/channels', (req, res) => {
      if (!this.channelManager) return res.status(500).json({ error: 'Channel manager not available' });
      try {
        res.json({ channels: this.channelManager.getAgentChannels(req.params.agentId) });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    this.app.post('/api/agents/:agentId/channels/:name/add', async (req, res) => {
      if (!this.channelManager) return res.status(500).json({ error: 'Channel manager not available' });
      try {
        const result = await this.channelManager.addAgentChannel(req.params.agentId, req.params.name, req.body.envVars || {});
        res.json({ success: true, message: result.message });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    // Error root cause analysis endpoint (roadmap 9.4)
    this.app.get('/api/agents/:agentId/failure-analysis', (req, res) => {
      const { agentId } = req.params;
      const { limit = 10, workspaceId } = req.query;
      const path = require('path');
      const fs = require('fs');
      const HOME = process.env.HOME || require('os').homedir();
      const FAILURES_FILE = path.join(require('../utils/base-dir'), 'data', 'failures.jsonl');

      try {
        // Read failure records from JSONL file
        if (!fs.existsSync(FAILURES_FILE)) {
          return res.json({ failures: [], total: 0, agentId });
        }

        const failures = [];
        const lines = fs.readFileSync(FAILURES_FILE, 'utf8').split('\n').filter(l => l.trim());

        // Parse JSONL, filter by agentId, and limit results
        for (const line of lines.slice(-parseInt(limit) || 10)) {
          try {
            const record = JSON.parse(line);
            if (record.agentId === agentId || record.agentId === 'unknown') {
              if (!workspaceId || record.workspaceId === workspaceId) {
                failures.unshift(record); // newer first
              }
            }
          } catch (_) { /* skip malformed lines */ }
        }

        res.json({
          agentId,
          failures: failures.slice(0, parseInt(limit) || 10),
          total: failures.length,
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // Error analysis endpoint (roadmap 9.4) — LLM-based root cause diagnosis
    this.app.get('/api/agents/:agentId/error-analysis', (req, res) => {
      const { agentId } = req.params;
      const { limit = 50, type = 'recent' } = req.query; // type: recent, patterns, or specific conversation

      try {
        if (!this.agentExecutor || !this.agentExecutor.errorAnalyzer) {
          return res.status(503).json({ error: 'Error analyzer not available' });
        }

        const analyzer = this.agentExecutor.errorAnalyzer;
        let results = {};

        if (type === 'patterns') {
          // Return failure patterns and common suggestions
          results = analyzer.getFailurePatterns();
        } else if (type === 'recent') {
          // Return recent failures with LLM analysis
          const failures = analyzer.getRecentFailures(parseInt(limit) || 50);
          const forAgent = failures.filter(f => f.agentId === agentId || f.agentId === 'unknown');
          results = {
            agentId,
            failures: forAgent,
            total: forAgent.length,
            timestamp: new Date().toISOString()
          };
        } else {
          // Specific conversation analysis
          const conversationId = type;
          const analyses = analyzer.getAnalysisByConversation(conversationId);
          results = {
            conversationId,
            analyses,
            total: analyses.length,
            timestamp: new Date().toISOString()
          };
        }

        res.json(results);
      } catch (e) {
        this.logger.error('HTTP', `Error analysis failed: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });

    // Global failure patterns endpoint (roadmap 9.4) — failure trends and common root causes
    this.app.get('/api/failures/patterns', (req, res) => {
      const { limit = 100 } = req.query;

      try {
        if (!this.agentExecutor || !this.agentExecutor.errorAnalyzer) {
          return res.status(503).json({ error: 'Error analyzer not available' });
        }

        const analyzer = this.agentExecutor.errorAnalyzer;
        const patterns = analyzer.getFailurePatterns();

        // Enhance with trend analysis
        const allFailures = analyzer.getRecentFailures(parseInt(limit) || 100);
        const avgDuration = allFailures.length > 0
          ? Math.round(allFailures.reduce((sum, f) => sum + (f.duration || 0), 0) / allFailures.length)
          : 0;

        res.json({
          summary: {
            totalFailures: patterns.totalFailures,
            avgDurationMs: avgDuration,
            timestamp: new Date().toISOString()
          },
          patterns: {
            byCategory: patterns.byCategory,
            byAgent: patterns.byAgent
          },
          topRootCauses: patterns.topRootCauses || [],
          recentSuggestions: patterns.recentSuggestions || []
        });
      } catch (e) {
        this.logger.error('HTTP', `Failure patterns endpoint failed: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });

    this.app.delete('/api/agents/:agentId/channels/:name', async (req, res) => {
      if (!this.channelManager) return res.status(500).json({ error: 'Channel manager not available' });
      try {
        const result = await this.channelManager.removeAgentChannel(req.params.agentId, req.params.name);
        res.json({ success: true, message: result.message });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });
  }

  /**
   * Run end-to-end inter-agent test
   * Sends a ping message to a target agent, waits for reply, measures round-trip time.
   * @param {string} [targetHint] - Agent name or ID to test (defaults to first non-master running agent)
   * @returns {Promise<Object>} Test result with passed, latency, details
   */
  async runInterAgentTest(targetHint) {
    const startTime = Date.now();

    // Precondition checks
    if (!this.messageRouter) {
      return { passed: false, error: 'MessageRouter not available', latencyMs: 0 };
    }
    if (!this.agentManager) {
      return { passed: false, error: 'AgentManager not available', latencyMs: 0 };
    }

    // Find target agent
    const agents = this.agentManager.listAgents();
    let target = null;

    let targetHintMissed = false;
    if (targetHint) {
      // Find by name or ID
      target = agents.find(a =>
        (a.id === targetHint || (a.name && a.name.toLowerCase() === targetHint.toLowerCase())) &&
        a.running && !a.isMaster
      );
      if (!target) {
        targetHintMissed = true;
      }
    }

    if (!target) {
      // Default: first non-master running agent
      target = agents.find(a => a.running && !a.isMaster);
    }

    if (!target) {
      return {
        passed: false,
        error: 'No non-master running agent found for test',
        latencyMs: 0,
        availableAgents: agents.map(a => ({ id: a.id, name: a.name, running: a.running }))
      };
    }

    // Send a simple e2e test message
    const testNonce = Math.random().toString(36).substring(2, 8);
    const testMessage = `[E2E-TEST] Ping — reply with "pong-${testNonce}" to confirm. Single word reply only.`;
    const timeout = 60; // 60s max — agent needs time to process via Claude CLI

    this.logger.info('E2E-Test', `Sending ping to agent "${target.name}" (${target.id.substring(0, 8)}), nonce=${testNonce}`);

    try {
      const result = await this.messageRouter.sendMessage({
        from: 'master',
        to: target.id,
        message: testMessage,
        timeout,
        data: null
      });

      const latencyMs = Date.now() - startTime;
      const reply = (result.reply || '').trim();
      const hasReply = reply.length > 0;

      this.logger.info('E2E-Test', `Reply from "${target.name}": "${reply.substring(0, 100)}" (${latencyMs}ms)`);

      const response = {
        passed: hasReply,
        targetAgent: { id: target.id, name: target.name },
        nonce: testNonce,
        reply: reply.substring(0, 500),
        latencyMs,
        messageId: result.messageId,
        timestamp: new Date().toISOString()
      };
      if (targetHintMissed) {
        response.targetHintMissed = true;
        response.requestedTarget = targetHint;
      }
      return response;
    } catch (e) {
      const latencyMs = Date.now() - startTime;
      this.logger.error('E2E-Test', `Test failed for "${target.name}": ${e.message} (${latencyMs}ms)`);
      const errResponse = {
        passed: false,
        targetAgent: { id: target.id, name: target.name },
        nonce: testNonce,
        error: e.message,
        latencyMs,
        timestamp: new Date().toISOString()
      };
      if (targetHintMissed) {
        errResponse.targetHintMissed = true;
        errResponse.requestedTarget = targetHint;
      }
      return errResponse;
    }
  }

  // ===== Roadmap 10.1: Request Tracing ====================================

  /**
   * GET /api/traces/:id — Get full trace with call graph for a request
   */
  _setupTracingRoutes() {
    // NOTE: Register specific routes (stats, cleanup) BEFORE parameterized routes (:requestId)
    // This ensures /api/traces/stats matches before /api/traces/:requestId catches it

    // GET /api/traces/stats — Tracing statistics
    this.app.get('/api/traces/stats', (req, res) => {
      const stats = this.requestTracer.getStats();
      res.json(stats);
    });

    // POST /api/traces/cleanup — Clean old traces
    this.app.post('/api/traces/cleanup', (req, res) => {
      const { maxAgeMs } = req.body;
      this.requestTracer.cleanup(maxAgeMs || 3600000);
      const stats = this.requestTracer.getStats();
      res.json({
        message: 'Cleanup completed',
        stats
      });
    });

    // GET /api/traces/:requestId/formatted — Human-readable trace
    // Register before general :requestId route so it matches first
    this.app.get('/api/traces/:requestId/formatted', (req, res) => {
      const { requestId } = req.params;
      const formatted = this.requestTracer.formatTrace(requestId);

      if (!formatted) {
        return res.status(404).json({ error: `No trace found for ${requestId}` });
      }

      res.json(formatted);
    });

    // GET /api/traces — List all traces with optional filtering
    this.app.get('/api/traces', (req, res) => {
      const { source, status, minDuration } = req.query;
      const filter = {};
      if (source) filter.source = source;
      if (status) filter.status = status;
      if (minDuration) filter.minDuration = parseInt(minDuration, 10);

      const traces = this.requestTracer.getAllTraces(filter);
      const limited = traces.slice(0, 100); // Return latest 100 traces

      res.json({
        count: limited.length,
        total: traces.length,
        traces: limited
      });
    });

    // GET /api/traces/:requestId/graph — Trace visualization (roadmap 10.1)
    // Returns SVG/HTML graph showing request flow and timing
    this.app.get('/api/traces/:requestId/graph', (req, res) => {
      const { requestId } = req.params;
      const trace = this.requestTracer.getFullTrace(requestId);

      if (!trace) {
        return res.status(404).json({
          error: 'Trace not found',
          requestId,
          message: 'Trace may have expired or request ID is invalid'
        });
      }

      // Generate simple HTML visualization
      const html = this._generateTraceGraph(trace);
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    });

    // GET /api/traces/:requestId — Full trace with children (MUST be last)
    this.app.get('/api/traces/:requestId', (req, res) => {
      const { requestId } = req.params;
      const trace = this.requestTracer.getFullTrace(requestId);

      if (!trace) {
        return res.status(404).json({
          error: 'Trace not found',
          requestId,
          message: 'Trace may have expired or request ID is invalid'
        });
      }

      res.json(trace);
    });
  }

  /**
   * Generate HTML/SVG visualization of a trace (roadmap 10.1)
   * @private
   */
  _generateTraceGraph(trace) {
    const baseUrl = trace.metadata?.path || 'request';
    const duration = trace.duration || 0;

    // Simple text-based timeline
    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Trace: ${trace.requestId}</title>
  <style>
    body { font-family: monospace; margin: 20px; }
    .header { background: #f0f0f0; padding: 10px; margin-bottom: 20px; border-radius: 4px; }
    .timeline { position: relative; }
    .call { margin: 10px 0; padding: 10px; border-left: 4px solid #ccc; }
    .call.success { border-left-color: #4caf50; background: #f1f8f4; }
    .call.error { border-left-color: #f44336; background: #fef5f5; }
    .call.pending { border-left-color: #ff9800; background: #fff3f0; }
    .call-header { font-weight: bold; display: flex; justify-content: space-between; }
    .call-time { color: #666; font-size: 0.9em; }
    .call-error { color: #f44336; margin-top: 5px; }
    .stats { background: #f9f9f9; padding: 10px; border-radius: 4px; margin-top: 20px; }
    .children { margin-left: 20px; margin-top: 10px; border-left: 2px dashed #ddd; padding-left: 10px; }
  </style>
</head>
<body>
  <div class="header">
    <h2>Request Trace</h2>
    <p><strong>ID:</strong> ${trace.requestId}</p>
    <p><strong>Source:</strong> ${trace.source} | <strong>Status:</strong> ${trace.status}</p>
    <p><strong>Duration:</strong> ${duration}ms | <strong>Started:</strong> ${new Date(trace.startTime).toISOString()}</p>
    <p><strong>Path:</strong> ${baseUrl}</p>
  </div>

  <div class="timeline">
    <h3>Call Stack</h3>
    ${trace.callStack.map((call, idx) => `
      <div class="call ${call.status}">
        <div class="call-header">
          <span>[${idx + 1}] ${call.layer}/${call.action}</span>
          <span class="call-time">${call.duration || 0}ms</span>
        </div>
        ${call.error ? `<div class="call-error">Error: ${call.error}</div>` : ''}
      </div>
    `).join('')}
  </div>

  ${trace.children && trace.children.length > 0 ? `
    <div class="children">
      <h3>Child Requests</h3>
      ${trace.children.map(child => `
        <div class="call ${child.status}">
          <div class="call-header">
            <span>${child.requestId.substring(0, 8)}</span>
            <span class="call-time">${child.duration || 0}ms</span>
          </div>
        </div>
      `).join('')}
    </div>
  ` : ''}

  <div class="stats">
    <h3>Statistics</h3>
    <p><strong>Total Calls:</strong> ${trace.callStack.length}</p>
    <p><strong>Success:</strong> ${trace.callStack.filter(c => c.status === 'success').length}</p>
    <p><strong>Errors:</strong> ${trace.callStack.filter(c => c.status === 'error').length}</p>
    <p><strong>Child Requests:</strong> ${trace.childRequestIds ? trace.childRequestIds.length : 0}</p>
  </div>
</body>
</html>`;
    return html;
  }

  getApp() {
    return this.app;
  }
}

module.exports = HTTPServer;
