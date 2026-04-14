const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ErrorAnalyzer = require('./error-analyzer');
const PerformanceProfiler = require('../core/performance-profiler');
const SandboxManager = require('../core/sandbox-manager');
const { atomicWriteFileSync } = require('../utils/atomic-write');
const BASE_DIR = require('../utils/base-dir');
const { createProvider, getAvailableProviders, validateAllProviders } = require('./providers');

// Soul file cache (5-min TTL)
const SOUL_CACHE_TTL = 300000; // 5 minutes
// Soul file truncation REMOVED — files are never truncated. Claude context (200K) handles them fully.
const soulCache = new Map(); // key -> { content, timestamp }

// Session management constants
const SESSION_IDLE_TIMEOUT = 7200000; // 2 hours
const SESSION_RESET_HOUR = 4; // 04:00 daily reset

// Token optimization constants
const MAX_TURNS_DEFAULT = 15; // Agentic turn limit per call
const MAX_BUDGET_USD = 1.00; // Max cost per single call
const TOOL_OUTPUT_MAX_CHARS = 30000; // Trim tool outputs beyond this (was 8000 — too aggressive, hid error messages)
const SESSION_PERSIST_FILE = path.join(BASE_DIR, 'data', 'sessions.json');
const ACTIVE_JOBS_FILE = path.join(BASE_DIR, 'data', 'active-jobs.json');
const RESUME_HISTORY_FILE = path.join(BASE_DIR, 'data', 'resume-history.json');
const PENDING_COMPLETIONS_FILE = path.join(BASE_DIR, 'data', 'pending-completions.json');
const MAX_RESUME_PER_CONVERSATION = 25; // Circuit breaker: max resumes per conversation (raised from 10 — long-running agent-to-agent chains need more)

// Log sanitization — prevent log injection via newlines and control chars
function sanitizeForLog(input, maxLen = 200) {
  if (typeof input !== 'string') return String(input);
  // Strip control chars (newlines, tabs, null bytes, etc.) to prevent log line injection
  const sanitized = input.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return sanitized.length > maxLen ? sanitized.substring(0, maxLen) + '...' : sanitized;
}

// Active job cleanup (roadmap 2.3)
const MAX_ACTIVE_JOB_AGE_MS = 3600000; // 1 hour — jobs older than this are discarded on boot

// Reasoning trace storage (roadmap 9.1)
// Maps conversationId -> array of { timestamp, type (text/tool_start/tool_result), content }
// Cleared when conversation ends or after 24 hours
const reasoningTraces = new Map();
const REASONING_TRACE_TTL = 86400000; // 24 hours — auto-cleanup
const reasoningEnabled = new Map(); // Maps conversationId -> boolean (enabled by THINKING.md)

// Confidence scoring storage (roadmap 9.3)
// Maps conversationId -> { contextRelevance, toolSuccessRate, modelConfidence, composite }
// Updated after each response, cleared when conversation ends
const confidenceScores = new Map();
const CONFIDENCE_WEIGHTS = {
  contextRelevance: 0.40,  // 40% — how relevant was context to question
  toolSuccess: 0.35,       // 35% — percentage of tool calls that succeeded
  modelConfidence: 0.25    // 25% — internal model uncertainty signals
};

// Decision tree storage (roadmap 10.2)
// Maps agentId -> array of { timestamp, type (model_choice/tool_selection/context_action), details, rationale }
// Kept in-memory with periodic persistence, auto-cleanup after 48 hours
const decisionLogs = new Map();
const DECISION_LOG_TTL = 172800000; // 48 hours — auto-cleanup
const MAX_DECISIONS_PER_AGENT = 1000; // Keep last 1000 decisions per agent

// Error root cause analysis storage (roadmap 9.4)
// Maps conversationId -> { timestamp, error, context, toolsUsed, rootCauseAnalysis, suggestions }
// Persisted to data/failures.jsonl for analysis and learning
const FAILURES_FILE = path.join(BASE_DIR, 'data', 'failures.jsonl');
const ROOT_CAUSE_CATEGORIES = {
  CONTEXT: 'context',           // Insufficient/irrelevant context, token overflow
  TOOL_LIMITATION: 'tool',      // Tool missing, failed, or timed out
  MODEL_KNOWLEDGE: 'model',     // Model lacks knowledge, hallucination, reasoning error
  CONFIGURATION: 'config',      // Budget/turn limits too low, wrong model choice
  EXTERNAL: 'external',         // Network, API timeout, resource exhaustion
  UNKNOWN: 'unknown'            // Could not determine root cause
};

// Claude CLI graceful degradation: retry on failure (roadmap 2.2)
const CLI_MAX_RETRIES = 2;           // Total 3 attempts for non-rate-limit errors
const CLI_RETRY_DELAY_MS = 3000;     // 3 seconds between retries (non-rate-limit)

// Rate limit specific: extended retry for overnight/autonomous work
const CLI_RATE_LIMIT_MAX_RETRIES = 50;         // Effectively unlimited for rate limits
const CLI_RATE_LIMIT_BASE_DELAY_MS = 5 * 60 * 1000;  // Start at 5 minutes
const CLI_RATE_LIMIT_MAX_DELAY_MS = 30 * 60 * 1000;   // Cap at 30 minutes
const CLI_RATE_LIMIT_MAX_TOTAL_MS = 8 * 60 * 60 * 1000; // Give up after 8 hours total

// Model tiering thresholds
const MODEL_TIER = {
  simple: 'haiku', // Short questions, greetings, yes/no
  standard: 'sonnet', // Normal conversation, moderate tasks
  complex: 'opus' // Long prompts, multi-step reasoning, code
};

// Agent templates for auto-creation (roadmap 5.1)
// Maps common agent types to rich configurations
const AGENT_TEMPLATES = {
  'code-reviewer': {
    matchKeywords: ['code review', 'code reviewer', 'review code'],
    name: 'CodeReviewer',
    personality: { style: 'professional', traits: ['meticulous', 'constructive', 'specialized'] },
    skills: 'code review, refactoring, best practices, security audit, performance analysis',
    firstPrompt: `You are CodeReviewer, a specialized code review agent.

Your core expertise:
- Code quality assessment (readability, maintainability, DRY, SOLID)
- Security vulnerability detection (OWASP top 10, injection, XSS)
- Performance analysis (time/space complexity, bottlenecks)
- Refactoring suggestions with concrete examples
- Best practices enforcement per language/framework

When reviewing code:
1. Start with a high-level summary (good/needs work)
2. List critical issues first (security, bugs)
3. Then suggestions (style, performance, readability)
4. Provide fixed code snippets, not just descriptions
5. Be constructive — explain WHY something is an issue`,
    color: '#ef4444'
  },
  'researcher': {
    matchKeywords: ['research', 'researcher', 'investigate', 'analyze', 'mugo'],
    name: 'MUGO',
    personality: { style: 'detailed', traits: ['thorough', 'analytical', 'specialized'] },
    skills: 'web research, data analysis, summarization, fact-checking, report writing',
    firstPrompt: `You are MUGO, a specialized research and analysis agent.

Your core expertise:
- Deep research on any topic with source verification
- Data analysis and pattern recognition
- Summarization of complex information into clear insights
- Fact-checking and cross-referencing multiple sources
- Structured report writing with citations

When researching:
1. Clarify the research question/scope
2. Gather information from multiple angles
3. Cross-reference and verify facts
4. Synthesize findings into a clear summary
5. Highlight key insights and actionable conclusions`,
    color: '#3b82f6'
  },
  'writer': {
    matchKeywords: ['writer', 'writing', 'content', 'copywriter'],
    name: 'Writer',
    personality: { style: 'friendly', traits: ['creative', 'articulate', 'specialized'] },
    skills: 'content writing, copywriting, editing, storytelling, tone adaptation',
    firstPrompt: `You are Writer, a specialized content creation agent.

Your core expertise:
- Content writing for various formats (blogs, docs, social media)
- Copywriting with persuasive techniques
- Editing for clarity, grammar, and flow
- Tone and voice adaptation per audience
- Storytelling and narrative structure

When writing:
1. Understand the target audience and purpose
2. Match the requested tone and style
3. Structure content with clear flow
4. Use active voice and concrete language
5. Edit ruthlessly — every word must earn its place`,
    color: '#8b5cf6'
  },
  'translator': {
    matchKeywords: ['translator', 'translation', 'translate', 'localization'],
    name: 'Translator',
    personality: { style: 'concise', traits: ['precise', 'culturally-aware', 'specialized'] },
    skills: 'translation, localization, cultural adaptation, terminology management',
    firstPrompt: `You are Translator, a specialized translation and localization agent.

Your core expertise:
- Accurate translation preserving meaning and nuance
- Cultural adaptation (not just word-for-word)
- Technical terminology management
- Localization for different markets
- Maintaining consistent style across translations

When translating:
1. Understand the source text context and intent
2. Translate for meaning, not word-by-word
3. Adapt cultural references when necessary
4. Maintain the original tone and register
5. Flag ambiguous terms for clarification`,
    color: '#06b6d4'
  },
  'data-analyst': {
    matchKeywords: ['data analyst', 'data analysis', 'veri analizi', 'analytics', 'statistics', 'veri analisti'],
    name: 'DataAnalyst',
    personality: { style: 'professional', traits: ['analytical', 'data-driven', 'specialized'] },
    skills: 'data analysis, visualization, statistics, SQL, pattern recognition, reporting',
    firstPrompt: `You are DataAnalyst, a specialized data analysis agent.

Your core expertise:
- Statistical analysis and hypothesis testing
- Data visualization and chart recommendations
- SQL queries and data extraction
- Pattern recognition and trend analysis
- Clear reporting with actionable insights

When analyzing data:
1. Understand the business question behind the data
2. Explore data quality and completeness first
3. Apply appropriate statistical methods
4. Visualize findings clearly
5. Present actionable insights, not just numbers`,
    color: '#10b981'
  },
  'crypto-analyst': {
    matchKeywords: ['crypto', 'token', 'memecoin', 'defi', 'blockchain', 'trading', 'kripto'],
    name: 'CryptoAnalyst',
    personality: { style: 'concise', traits: ['degen-friendly', 'analytical', 'specialized'] },
    skills: 'token analysis, chart reading, on-chain analysis, DeFi protocols, risk assessment',
    firstPrompt: `You are CryptoAnalyst, a specialized crypto/token analysis agent.

Your core expertise:
- Token fundamental analysis (tokenomics, team, utility)
- Technical analysis (chart patterns, indicators, volume)
- On-chain analysis (whale movements, liquidity, holder distribution)
- DeFi protocol evaluation (TVL, yield, risk)
- Risk assessment and position sizing

When analyzing:
1. Check contract address and verify on-chain data
2. Analyze tokenomics (supply, distribution, vesting)
3. Review liquidity and volume patterns
4. Assess community and developer activity
5. Give clear risk rating (1-10) with reasoning`,
    color: '#f59e0b'
  }
};

// Match user-provided skills to the best template
function matchAgentTemplate(skills) {
  if (!skills || skills.length === 0) return null;
  const skillsLower = skills.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;
  for (const [key, template] of Object.entries(AGENT_TEMPLATES)) {
    let score = 0;
    for (const keyword of template.matchKeywords) {
      if (skillsLower.includes(keyword)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { key, template };
    }
  }
  return bestScore > 0 ? bestMatch : null;
}

class AgentExecutor {
  constructor(workspaceManager, logger) {
    this.workspaceManager = workspaceManager;
    this.logger = logger;
    this.activeProcesses = new Map(); // conversationId -> process
    this._activeJobs = new Map(); // conversationId -> { workspaceId, sessionId, userMessage, channel, userId, startedAt }
    this._pendingMessages = new Map(); // conversationId -> [{ message, images, onEvent, onComplete, onError }]
    this._workspaceLocks = new Map(); // workspaceId -> { conversationId, startedAt } — CRITICAL: prevents parallel CLI writes to same workspace
    this._baseDir = BASE_DIR;

    // LLM Provider initialization
    const providerName = process.env.LLM_PROVIDER || 'claude';
    const providerConfig = this._loadProviderConfig(providerName);
    this.provider = createProvider(providerName, providerConfig, logger);
    this.claudePath = this.provider.name === 'claude' ? this.provider.claudePath : null;

    // Error analysis (roadmap 9.4)
    // Pass 'this' so ErrorAnalyzer can use AgentExecutor for LLM analysis
    this.errorAnalyzer = new ErrorAnalyzer(this._baseDir, logger, this);

    // OpenClaw modules (workspace-aware memory system)
    this.workspaceMemories = new Map(); // workspaceId -> CognitiveMemory instance
    this.reflectionEngine = null;
    this.compactor = null;
    this.contextGuard = null;
    this.security = null;
    this.laneQueue = null;
    this.storage = null; // For reminders
    this.agentManager = null; // Injected from index.js
    this.messageRouter = null; // Injected from index.js
    this.autoRouter = null; // Auto-routing for inter-agent messaging
    this.taskPlanner = null; // Multi-agent task planning (roadmap 5.3)
    this.agentStats = null; // Agent performance stats collector (roadmap 7.3)
    this.agentOutputs = null; // Per-agent last work tracking for OUTPUT popup
    this.usageTracker = null; // API usage & budget tracking (roadmap 8.4)
    this.performanceProfiler = new PerformanceProfiler(); // Performance profiling (roadmap 10.3)
    this.sandboxManager = new SandboxManager(logger); // Central sandbox orchestration
    this.pidRegistry = null; // Injected from index.js — tracks child PIDs for orphan cleanup
    this.supervisor = null; // Injected from index.js — circuit breakers + resource monitoring
    this._restartPending = false; // Safe-restart: queued restart waiting for agents to finish
    this._restartRequestedBy = null; // Which workspace requested the restart
    this._shuttingDown = false; // Set to true during graceful shutdown — prevents queue flush

    // Session tracking for idle/daily reset
    this.sessions = this._loadSessions(); // sessionKey -> { lastActivity, resetCount, sessionId }
  }

  // ═══════════════════════════════════════════════════════════
  // LLM PROVIDER MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  _loadProviderConfig(providerName) {
    try {
      const configFile = path.join(this._baseDir, 'config.json');
      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (config.agent && config.agent.providers && config.agent.providers[providerName]) {
          return config.agent.providers[providerName];
        }
      }
    } catch { /* use defaults */ }
    return {};
  }

  /**
   * Get provider status for health checks and API responses
   * @returns {Promise<object>} Provider info including available providers and their status
   */
  async getProviderStatus() {
    const currentProvider = this.provider.name;
    try {
      const configFile = path.join(this._baseDir, 'config.json');
      let providersConfig = {};
      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        providersConfig = (config.agent && config.agent.providers) || {};
      }
      const statuses = await validateAllProviders(providersConfig, this.logger);
      return {
        active: currentProvider,
        supportsAgentic: this.provider.supportsAgentic(),
        supportsResume: this.provider.supportsResume(),
        providers: statuses
      };
    } catch (e) {
      return {
        active: currentProvider,
        supportsAgentic: this.provider.supportsAgentic(),
        supportsResume: this.provider.supportsResume(),
        providers: [{ name: currentProvider, configured: true, error: null }]
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // WORKSPACE-AWARE MEMORY MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  _getMemoryForWorkspace(workspaceId) {
    if (!workspaceId) return null;

    // Check if memory instance already exists
    if (this.workspaceMemories.has(workspaceId)) {
      return this.workspaceMemories.get(workspaceId);
    }

    // Create new CognitiveMemory instance for this workspace
    const CognitiveMemory = require('../memory/cognitive');
    const workspacePath = this.workspaceManager.getWorkspacePath(workspaceId);
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      this.logger.warn('AgentExecutor', `Workspace path not found: ${workspaceId}`);
      return null;
    }

    const memory = new CognitiveMemory(workspacePath, this.logger);
    this.workspaceMemories.set(workspaceId, memory);
    this.logger.info('AgentExecutor', `Created CognitiveMemory for workspace: ${workspaceId.substring(0, 8)}`);

    return memory;
  }

  // ═══════════════════════════════════════════════════════════
  // SESSION PERSISTENCE
  // ═══════════════════════════════════════════════════════════

  _loadSessions() {
    try {
      if (fs.existsSync(SESSION_PERSIST_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_PERSIST_FILE, 'utf8'));
        const map = new Map(Object.entries(data));

        // Stale session pruning on load
        const now = Date.now();
        const STALE_CRON_MS = 2 * 60 * 60 * 1000;   // 2h for cron/agent sessions
        const STALE_USER_MS = 24 * 60 * 60 * 1000;   // 24h for user sessions
        let pruned = 0;
        for (const [key, meta] of map) {
          const age = now - new Date(meta.lastActivity || 0).getTime();
          const isCronOrAgent = key.startsWith('cron:') || key.startsWith('agent:');
          if ((isCronOrAgent && age > STALE_CRON_MS) ||
              (!isCronOrAgent && age > STALE_USER_MS && (meta.turnCount || 0) <= 1)) {
            map.delete(key);
            pruned++;
          }
        }

        // ORPHAN SESSION CLEANUP: Remove sessions pointing to non-existent conversations
        // This prevents ghost sessions from accumulating when conversations are deleted
        const CONV_FILE = path.join(this._baseDir, 'data', 'conversations.json');
        try {
          if (fs.existsSync(CONV_FILE)) {
            const convData = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
            const validConvIds = new Set((convData.conversations || []).map(c => c.id));
            let orphaned = 0;
            for (const [key] of map) {
              // Only check webchat sessions (not job/cron/agent)
              if (!key.startsWith('webchat:')) continue;
              const parts = key.split(':');
              const convId = parts[parts.length - 1];
              if (convId && !validConvIds.has(convId)) {
                map.delete(key);
                orphaned++;
              }
            }
            if (orphaned > 0) {
              pruned += orphaned;
              console.log(`[SessionPrune] Removed ${orphaned} orphan sessions (conversation deleted)`);
            }
          }
        } catch (convErr) {
          // Non-critical — skip orphan check if conversations.json unreadable
        }

        if (pruned > 0) {
          const obj = Object.fromEntries(map);
          atomicWriteFileSync(SESSION_PERSIST_FILE, JSON.stringify(obj, null, 2));
          console.log(`[SessionPrune] Removed ${pruned} stale/orphan sessions on load (${map.size} remaining)`);
        }
        return map;
      }
    } catch (e) { /* ignore */ }
    return new Map();
  }

  _saveSessions() {
    try {
      // Runtime stale pruning — remove expired cron/agent sessions on every save
      const now = Date.now();
      const STALE_CRON_MS = 2 * 60 * 60 * 1000;   // 2h for cron/agent sessions
      const STALE_USER_MS = 24 * 60 * 60 * 1000;   // 24h for low-activity user sessions
      let stalePruned = 0;
      for (const [key, meta] of this.sessions) {
        const age = now - new Date(meta.lastActivity || 0).getTime();
        const isCronOrAgent = key.startsWith('cron:') || key.startsWith('agent:');
        if ((isCronOrAgent && age > STALE_CRON_MS) ||
            (!isCronOrAgent && age > STALE_USER_MS && (meta.turnCount || 0) <= 1)) {
          this.sessions.delete(key);
          stalePruned++;
        }
      }

      // Cap at 50 sessions max — keep most recent by lastActivity
      if (this.sessions.size > 50) {
        const before = this.sessions.size;
        const sorted = [...this.sessions.entries()]
          .sort((a, b) => (b[1].lastActivity || '').localeCompare(a[1].lastActivity || ''));
        this.sessions = new Map(sorted.slice(0, 50));
        stalePruned += before - 50;
      }

      if (stalePruned > 0) {
        this.logger.info('AgentExecutor', `Session prune: ${stalePruned} stale session(s) removed (${this.sessions.size} remaining)`);
      }

      const obj = Object.fromEntries(this.sessions);
      atomicWriteFileSync(SESSION_PERSIST_FILE, JSON.stringify(obj, null, 2));
    } catch (e) { /* ignore */ }
  }

  // Clean up sessions for a deleted conversation
  cleanupConversationSessions(conversationId) {
    let cleaned = 0;
    for (const key of this.sessions.keys()) {
      if (key.endsWith(':' + conversationId)) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this._saveSessions();
      this.logger.info('AgentExecutor', `Cleaned ${cleaned} session(s) for deleted conversation ${conversationId}`);
      this._notifyUI(`Cleaned ${cleaned} orphaned sessions from deleted conversations`, 'info');
    }
  }

  // Send a notification toast to connected UI clients
  _notifyUI(message, level = 'success', duration = 5000) {
    try {
      if (this.wsServer && this.wsServer.broadcast) {
        this.wsServer.broadcast({ type: 'notification', message, level, duration });
      }
    } catch(_) {}
  }

  // ═══════════════════════════════════════════════════════════
  // ACTIVE JOBS PERSISTENCE — survive restarts
  // ═══════════════════════════════════════════════════════════

  _saveActiveJobs() {
    try {
      // Prune stale jobs from in-memory map before saving (roadmap 2.3)
      const now = Date.now();
      for (const [convId, jobInfo] of this._activeJobs) {
        const age = now - new Date(jobInfo.startedAt).getTime();
        if (age > MAX_ACTIVE_JOB_AGE_MS) {
          this.logger.info('AgentExecutor', `Pruning stale active job: ${convId} (age: ${Math.round(age / 60000)}m)`);
          this._activeJobs.delete(convId);
        }
      }

      const jobs = [];
      for (const [convId, jobInfo] of this._activeJobs) {
        // Truncate lastResponse to last 2000 chars to keep active-jobs.json manageable
        const truncResp = jobInfo.lastResponse
          ? (jobInfo.lastResponse.length > 2000 ? '...' + jobInfo.lastResponse.slice(-2000) : jobInfo.lastResponse)
          : null;
        jobs.push({
          conversationId: convId,
          workspaceId: jobInfo.workspaceId,
          sessionId: jobInfo.sessionId,
          userMessage: jobInfo.userMessage,
          channel: jobInfo.channel,
          userId: jobInfo.userId,
          startedAt: jobInfo.startedAt,
          lastResponse: truncResp,
          selfRestarted: jobInfo.selfRestarted || false,
          completed: jobInfo.completed || false,
          parentConversationId: jobInfo.parentConversationId || null
        });
      }
      atomicWriteFileSync(ACTIVE_JOBS_FILE, JSON.stringify(jobs, null, 2));
      this.logger.info('AgentExecutor', `Saved ${jobs.length} active job(s) for resume after restart`);
    } catch (e) { /* ignore */ }
  }

  /**
   * Get active jobs list with agent name resolution.
   * Used by /api/active-jobs endpoint for Activity Dashboard.
   * @param {Function} agentResolver - Function(workspaceId) => agentName
   * @returns {Array}
   */
  getActiveJobs(agentResolver) {
    const jobs = [];
    const now = Date.now();
    for (const [convId, jobInfo] of this._activeJobs) {
      const elapsed = now - new Date(jobInfo.startedAt).getTime();
      // Extract meaningful message — unwrap resume wrapper if present
      let msg = jobInfo.userMessage || '';
      const isSelfImprove = /Self-Improve|AUTONOMOUS TASK/.test(msg);
      const cycleMatch = msg.match(/Self-Improve Cycle #(\d+)/);
      if (cycleMatch) {
        msg = 'Self-Improve Cycle #' + cycleMatch[1];
      } else if (msg.length > 150) {
        msg = msg.substring(0, 150);
      }
      jobs.push({
        conversationId: convId,
        workspaceId: jobInfo.workspaceId,
        agentName: agentResolver ? agentResolver(jobInfo.workspaceId) : jobInfo.workspaceId,
        userMessage: msg,
        channel: jobInfo.channel || 'unknown',
        userId: jobInfo.userId || 'unknown',
        startedAt: jobInfo.startedAt,
        elapsedMs: elapsed,
        isSelfImprove
      });
    }
    return jobs;
  }

  // Resume history: tracks how many times each conversation has been resumed
  // Persists separately from active-jobs.json so it survives _clearActiveJobs()
  _loadResumeHistory() {
    try {
      if (fs.existsSync(RESUME_HISTORY_FILE)) {
        return JSON.parse(fs.readFileSync(RESUME_HISTORY_FILE, 'utf8'));
      }
    } catch (e) { /* ignore */ }
    return {};
  }

  _saveResumeHistory(history) {
    try {
      atomicWriteFileSync(RESUME_HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (e) { /* ignore */ }
  }

  // Clear resume history for a conversation (call when job completes successfully)
  _clearResumeCount(conversationId) {
    const history = this._loadResumeHistory();
    if (history[conversationId]) {
      delete history[conversationId];
      this._saveResumeHistory(history);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // PENDING COMPLETIONS — survive self-restarts
  // When an agent triggers a restart (launchctl kickstart), the onComplete callback
  // may fire but the WebSocket/HTTP connection is already closing. This persists
  // the completion so the new process can deliver it to the UI after boot.
  // ═══════════════════════════════════════════════════════════

  _savePendingCompletion(conversationId, workspaceId, response, channel, userId) {
    try {
      let completions = [];
      if (fs.existsSync(PENDING_COMPLETIONS_FILE)) {
        completions = JSON.parse(fs.readFileSync(PENDING_COMPLETIONS_FILE, 'utf8'));
        if (!Array.isArray(completions)) completions = [];
      }
      // Prevent duplicates for same conversation
      completions = completions.filter(c => c.conversationId !== conversationId);
      completions.push({
        conversationId,
        workspaceId,
        response: typeof response === 'string' ? response.substring(0, 10000) : String(response).substring(0, 10000),
        channel: channel || 'webchat',
        userId: userId || 'default',
        completedAt: new Date().toISOString()
      });
      atomicWriteFileSync(PENDING_COMPLETIONS_FILE, JSON.stringify(completions, null, 2));
      this.logger.info('AgentExecutor', `Saved pending completion for conv ${conversationId} (${(response || '').length} chars)`);
    } catch (e) {
      this.logger.warn('AgentExecutor', `Failed to save pending completion: ${e.message}`);
    }
  }

  _loadPendingCompletions() {
    try {
      if (fs.existsSync(PENDING_COMPLETIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PENDING_COMPLETIONS_FILE, 'utf8'));
        // Clear the file after loading (one-shot delivery)
        atomicWriteFileSync(PENDING_COMPLETIONS_FILE, '[]');
        if (Array.isArray(data) && data.length > 0) {
          // Filter out stale completions (older than 5 minutes)
          const now = Date.now();
          return data.filter(c => {
            const age = now - new Date(c.completedAt || 0).getTime();
            return age < 300000; // 5 minutes
          });
        }
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  _loadActiveJobs() {
    try {
      if (fs.existsSync(ACTIVE_JOBS_FILE)) {
        const rawData = JSON.parse(fs.readFileSync(ACTIVE_JOBS_FILE, 'utf8'));
        if (!Array.isArray(rawData)) return { accepted: [], skipped: [] };

        const now = Date.now();

        // ── Phase 1: Filter out stale jobs (older than MAX_ACTIVE_JOB_AGE_MS) ──
        const freshJobs = [];
        let staleCount = 0;
        for (const job of rawData) {
          const age = now - new Date(job.startedAt || 0).getTime();
          if (age > MAX_ACTIVE_JOB_AGE_MS) {
            staleCount++;
            this.logger.warn('AgentExecutor', `Discarding stale job on boot: ${job.conversationId} (age: ${Math.round(age / 60000)}m, max: ${MAX_ACTIVE_JOB_AGE_MS / 60000}m)`);
          } else {
            freshJobs.push(job);
          }
        }
        if (staleCount > 0) {
          this.logger.info('AgentExecutor', `Cleaned ${staleCount} stale job(s) on boot`);
        }

        // ── Phase 1.5: REMOVED — zombie filter was too aggressive.
        // Jobs without lastResponse are valid (agent interrupted before first output).
        // They should still resume — the resume system will re-execute the user message.
        const dedupedJobs = freshJobs;

        // ── Phase 2: Apply resume circuit breaker (existing logic) ──
        const history = this._loadResumeHistory();
        const accepted = [];
        const skipped = [];

        // Clean stale resume history entries (no active job)
        const activeConvIds = new Set(dedupedJobs.map(j => j.conversationId));
        for (const convId of Object.keys(history)) {
          if (!activeConvIds.has(convId)) {
            this.logger.info('AgentExecutor', `Clearing stale resume history for ${convId} (no active job)`);
            delete history[convId];
          }
        }

        for (const job of dedupedJobs) {
          const convId = job.conversationId;
          const count = history[convId] || 0;

          if (count >= MAX_RESUME_PER_CONVERSATION) {
            this.logger.warn('AgentExecutor', `Circuit breaker: conversation ${convId} already resumed ${count}x (max ${MAX_RESUME_PER_CONVERSATION}) — abandoned`);
            job._resumeCount = count;
            skipped.push(job);
            // Clear the history so future NEW messages on this conversation aren't blocked
            delete history[convId];
          } else {
            history[convId] = count + 1;
            accepted.push(job);
          }
        }

        this._saveResumeHistory(history);
        return { accepted, skipped };
      }
    } catch (e) { /* ignore */ }
    return { accepted: [], skipped: [] };
  }

  _clearActiveJobs() {
    try {
      atomicWriteFileSync(ACTIVE_JOBS_FILE, '[]');
    } catch (e) { /* ignore */ }
    // NOTE: Resume history is NOT cleared here — it persists across restarts
    // to properly track how many times a conversation has been resumed
  }

  // ═══════════════════════════════════════════════════════════
  // MODEL TIERING — route to cheapest sufficient model
  // ═══════════════════════════════════════════════════════════

  _selectModel(message) {
    const len = message.length;
    const lower = message.toLowerCase().trim();

    // Tiered complexity detection (prevents over-triggering opus)
    // HIGH complexity: architecture, implementation, multi-step tasks → opus
    const hasHighComplex = /\b(refactor|implement|debug deploy|migration|architect|create agent|deep analysis|detailed analysis)\b/i.test(lower);
    // MEDIUM complexity: analysis, optimization → sonnet
    const hasMediumComplex = /\b(analyze|compare|optimize|test|fix|block|review)\b/i.test(lower);
    // LOW complexity: common operations → sonnet (NOT opus)
    const hasLowComplex = /\b(write code|read file|write file|run command|function|class|component|api|database)\b/i.test(lower);

    // Short messages (< 60 chars): haiku unless HIGH complexity
    if (len < 60) {
      return hasHighComplex ? MODEL_TIER.complex : MODEL_TIER.simple;
    }

    // Very long messages (> 800 chars): opus (architectural discussions)
    if (len > 800) return MODEL_TIER.complex;

    // Long messages (500-800 chars): opus if HIGH complex, sonnet otherwise
    if (len > 500) {
      return hasHighComplex ? MODEL_TIER.complex : MODEL_TIER.standard;
    }

    // Mid-range (60-500): opus only if HIGH complex, sonnet if MEDIUM/LOW, haiku if none
    if (hasHighComplex) return MODEL_TIER.complex;
    if (hasMediumComplex || hasLowComplex) return MODEL_TIER.standard;
    return MODEL_TIER.simple;
  }

  // ═══════════════════════════════════════════════════════════
  // CLI RETRY — determine if a failed CLI invocation should be retried
  // ═══════════════════════════════════════════════════════════

  _isRetryableCliError(exitCode, stderr) {
    if (exitCode === 143 || exitCode === 137) return false; // intentional kill
    if (exitCode === 0) return false; // success
    if (exitCode === null) return false; // spawn failure (binary missing)

    const stderrLower = (stderr || '').toLowerCase();

    // Non-retryable: config/auth errors that won't fix themselves
    const nonRetryable = ['api key', 'invalid api', 'authentication', 'unauthorized',
      'permission denied', 'not found: claude', 'enoent', 'workspace not found'];
    for (const p of nonRetryable) { if (stderrLower.includes(p)) return false; }

    // Retryable: transient errors
    const retryable = ['rate limit', 'overloaded', 'timeout', 'timed out', 'temporarily',
      'econnreset', 'econnrefused', 'etimedout', 'epipe', 'network', 'server error',
      '529', '503', '502', '500', 'context window'];
    for (const p of retryable) { if (stderrLower.includes(p)) return true; }

    // Exit code 1 is retryable ONLY if stderr is empty/unclear (likely transient)
    // If stderr has content but no specific retryable/non-retryable pattern → NOT retryable
    if (exitCode === 1) {
      // Empty stderr → likely transient crash, retry
      if (!stderr || stderr.trim().length === 0) return true;
      // Stderr exists but doesn't match known patterns → assume non-retryable
      return false;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // SLASH COMMANDS
  // ═══════════════════════════════════════════════════════════

  async handleCommand(text, channel, userId, replyFn, isGroup, workspaceId, conversationId) {
    const cmd = text.split(' ')[0].toLowerCase();
    const args = text.slice(cmd.length).trim();

    // Get memory for default workspace (slash commands are typically used by master agent)
    const defaultWs = this.workspaceManager.getDefaultWorkspace();
    const memory = defaultWs ? this._getMemoryForWorkspace(defaultWs.id) : null;

    switch (cmd) {
      case '/help':
        return replyFn([
          'Anuki — Soul-Injected AI Agent Platform',
          '',
          '/status — System status',
          '/memory — Memory statistics',
          '/recall <topic> — Search memory',
          '/core — Show core memory',
          '/forget <id> — Forget a memory',
          '/reflect — Run manual reflection',
          '/context — Token usage status',
          '/link <channel> <id> — Cross-channel identity linking',
          '/session — Session info',
          '/soul — Soul files status',
          '/clear — Clear session',
        ].join('\n'));

      case '/status': {
        const stats = memory ? memory.getStats() : {};
        const soulFiles = ['SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md', 'SAFETY.md', 'HEARTBEAT.md', 'CODE_PROTOCOL.md', 'MISSION.md', 'PROMPT_PROFILE.md'];
        const statusWsId = defaultWs ? defaultWs.id : null;
        const loaded = statusWsId ? this._loadSoulFilesCached(statusWsId) : {};
        const loadedCount = Object.keys(loaded).filter(k => typeof loaded[k] === 'string').length;
        const lines = [
          'Anuki Online (Soul-Injected)',
          'Soul: ' + loadedCount + '/' + soulFiles.length + ' files loaded',
          'Episodic: ' + (stats.episodic || 0) + ' memories',
          'Semantic: ' + (stats.semantic || 0) + ' facts',
          'Procedural: ' + (stats.procedural || 0) + ' skills',
          'Core memory: ' + (stats.coreMemorySize || 0) + ' byte',
        ];
        if (memory) {
          const linked = memory.getLinkedIdentities ? memory.getLinkedIdentities(channel, userId) : [];
          if (linked.length > 1) lines.push('Bagli kimlikler: ' + linked.join(', '));
        }
        return replyFn(lines.join('\n'));
      }

      case '/memory': {
        const stats = memory ? memory.getStats() : {};
        return replyFn([
          'Memory System',
          '===============',
          'Episodic (experiences): ' + (stats.episodic || 0),
          'Semantic (knowledge): ' + (stats.semantic || 0),
          'Procedural (skills): ' + (stats.procedural || 0),
          '',
          'Oldest memory: ' + (stats.oldestEpisode || 'none'),
          'Newest memory: ' + (stats.newestEpisode || 'none'),
        ].join('\n'));
      }

      case '/recall': {
        if (!args) return replyFn('Usage: /recall <search topic>');
        if (!memory) return replyFn('Memory system not active');
        const results = memory.search(args, { maxResults: 5 });
        if (results.length === 0) return replyFn('Nothing found on this topic.');
        const lines = results.map((r, i) =>
          (i + 1) + '. [' + r.type + ' | importance:' + r.importance + '] ' + (r.content || '').substring(0, 150)
        );
        return replyFn('Sonuclar:\n\n' + lines.join('\n\n'));
      }

      case '/core': {
        if (isGroup) return replyFn('Grup sohbetinde core memory gosterilemez (gizlilik).');
        let core = memory ? memory.getCoreMemory() : '';
        if (this.security) core = this.security.redactCredentials(core);
        return replyFn(core ? core.substring(0, 3000) : 'Core memory bos');
      }

      case '/forget': {
        if (!args) return replyFn('Usage: /forget <memory_id>');
        if (!memory) return replyFn('Memory system not active');
        const result = memory.executeMemoryTool('memory_forget', {
          memoryId: args,
          reason: 'User request'
        });
        return replyFn(result && result.success ? 'Forgotten: ' + args : 'Not found: ' + args);
      }

      case '/reflect': {
        if (!this.reflectionEngine) return replyFn('Reflection engine not active');
        await replyFn('Starting reflection...');
        const result = await this.reflectionEngine.runReflection();
        if (result) {
          return replyFn([
            'Reflection complete',
            'New knowledge: ' + (result.processed ? result.processed.semantic : 0),
            'New skills: ' + (result.processed ? result.processed.procedural : 0),
          ].join('\n'));
        }
        return replyFn('Reflection ran but found nothing to extract.');
      }

      case '/context': {
        if (!this.contextGuard) return replyFn('Context guard not active');
        const status = this.contextGuard.getStatus();
        return replyFn([
          'Context Window Status',
          '========================',
          'Model: ' + status.model,
          'Context limit: ' + status.contextLimit.toLocaleString() + ' tokens',
          'Reserved for response: ' + status.reservedForResponse.toLocaleString() + ' tokens',
          'Warning threshold: ' + status.warningThreshold,
          'Action threshold: ' + status.actionThreshold,
          'Critical threshold: ' + status.criticalThreshold,
        ].join('\n'));
      }

      case '/link': {
        if (!this.cognitiveMemory) return replyFn('Memory system not active');
        if (!args) return replyFn('Usage: /link <channel> <userId>\nExample: /link discord 123456');
        const linkParts = args.split(/\s+/);
        if (linkParts.length < 2) return replyFn('Usage: /link <channel> <userId>');
        const targetChannel = linkParts[0];
        const targetUserId = linkParts[1];
        if (!this.cognitiveMemory.linkIdentity) return replyFn('linkIdentity not supported');
        const gId = this.cognitiveMemory.linkIdentity(channel, userId, targetChannel, targetUserId);
        const allLinked = this.cognitiveMemory.getLinkedIdentities(channel, userId);
        return replyFn([
          'Identity linked',
          'Group: ' + gId,
          'Linked identities: ' + allLinked.join(', ')
        ].join('\n'));
      }

      case '/session': {
        // Find current session using full key format (with workspace + conversation)
        const prefix = channel + ':' + userId + ':';
        let sess = {};
        let matchedKey = '';
        // Try exact match first (with workspaceId + conversationId)
        if (workspaceId && conversationId) {
          const exactKey = prefix + workspaceId + ':' + conversationId;
          if (this.sessions.has(exactKey)) {
            sess = this.sessions.get(exactKey);
            matchedKey = exactKey;
          }
        }
        // Fallback: find most recent session for this user
        if (!matchedKey) {
          let latest = null;
          for (const [key, val] of this.sessions.entries()) {
            if (key.startsWith(prefix)) {
              if (!latest || (val.lastActivity || '') > (latest.val.lastActivity || '')) {
                latest = { key, val };
              }
            }
          }
          if (latest) { sess = latest.val; matchedKey = latest.key; }
        }
        // Count total sessions for this user
        let totalSessions = 0;
        for (const key of this.sessions.keys()) {
          if (key.startsWith(prefix)) totalSessions++;
        }
        return replyFn([
          'Session Info',
          '============',
          'Session ID: ' + (sess.sessionId || 'none (new session)'),
          'Last activity: ' + (sess.lastActivity ? new Date(sess.lastActivity).toISOString() : 'unknown'),
          'Turn count: ' + (sess.turnCount || 0),
          'Reset count: ' + (sess.resetCount || 0),
          'Total sessions: ' + totalSessions,
          'Idle timeout: 2 hours',
          'Daily reset: 04:00 UTC',
          '',
          'Token Optimization',
          '==================',
          'Max turns: ' + MAX_TURNS_DEFAULT,
          'Max budget: $' + MAX_BUDGET_USD,
          'Tool output limit: ' + TOOL_OUTPUT_MAX_CHARS + ' chars',
          'Model tiering: haiku/sonnet/opus',
          'Bootstrap skip on resume: ' + (sess.sessionId ? 'active' : 'N/A')
        ].join('\n'));
      }

      case '/soul': {
        const soulFileNames = ['IDENTITY.md', 'SOUL.md', 'MISSION.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'SAFETY.md', 'CODE_PROTOCOL.md', 'PROMPT_PROFILE.md', 'HEARTBEAT.md'];
        const soulWs = this.workspaceManager.getDefaultWorkspace();
        const soulWsId = soulWs ? soulWs.id : workspaceId;
        const loaded = this._loadSoulFilesCached(soulWsId);
        const lines = ['Soul Files', '=========='];
        for (const f of soulFileNames) {
          const content = loaded[f];
          const status = content ? (content.length + ' chars') : 'not loaded';
          lines.push(f + ': ' + status);
        }
        return replyFn(lines.join('\n'));
      }

      case '/clear': {
        // Clear ALL sessions matching this user+channel (any workspace/conversation)
        const prefix = channel + ':' + userId + ':';
        let cleared = 0;
        for (const key of [...this.sessions.keys()]) {
          if (key.startsWith(prefix) || key === channel + ':' + userId) {
            this.sessions.delete(key);
            cleared++;
          }
        }
        this._saveSessions();
        if (memory && memory.persistSession) {
          memory.persistSession(channel, userId, {
            messages: [],
            created: new Date().toISOString(),
            lastActivity: new Date().toISOString()
          });
        }
        return replyFn(`${cleared} session(s) cleared (memory preserved)`);
      }

      default:
        return replyFn('Unknown command. Use /help to see available commands.');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // REASONING TRACE HELPERS (Roadmap 9.1)
  // ═══════════════════════════════════════════════════════════

  _recordReasoningEvent(conversationId, type, content, metadata = {}) {
    if (!conversationId) return;

    // Check if thinking is enabled for this conversation (roadmap 9.1)
    if (!reasoningEnabled.get(conversationId)) {
      return; // Thinking disabled, skip recording
    }

    if (!reasoningTraces.has(conversationId)) {
      reasoningTraces.set(conversationId, {
        events: [],
        startedAt: Date.now(),
        ttlTimeout: null
      });
    }

    const trace = reasoningTraces.get(conversationId);
    const event = {
      timestamp: new Date().toISOString(),
      type,
      content
    };

    // Add optional metadata: rationale, model, context, risk level, confidence (roadmap 9.1: richer context)
    if (metadata && typeof metadata === 'object') {
      if (metadata.rationale) event.rationale = metadata.rationale;
      if (metadata.model) event.model = metadata.model;
      if (metadata.contextSummary) event.contextSummary = metadata.contextSummary;
      if (metadata.riskLevel !== undefined) event.riskLevel = metadata.riskLevel;
      if (metadata.confidence !== undefined) event.confidence = metadata.confidence;
    }

    trace.events.push(event);

    // Auto-cleanup: set TTL if not already set
    if (!trace.ttlTimeout) {
      trace.ttlTimeout = setTimeout(() => {
        reasoningTraces.delete(conversationId);
      }, REASONING_TRACE_TTL);
    }
  }

  getReasoningTrace(conversationId) {
    if (!reasoningTraces.has(conversationId)) {
      return { conversationId, events: [] };
    }
    const trace = reasoningTraces.get(conversationId);
    return {
      conversationId,
      startedAt: new Date(trace.startedAt).toISOString(),
      events: trace.events,
      eventCount: trace.events.length
    };
  }

  clearReasoningTrace(conversationId) {
    const trace = reasoningTraces.get(conversationId);
    if (trace && trace.ttlTimeout) {
      clearTimeout(trace.ttlTimeout);
    }
    reasoningTraces.delete(conversationId);
    reasoningEnabled.delete(conversationId);
  }

  // Calculate confidence score for response (roadmap 9.3)
  // Combines: context relevance (40%), tool success rate (35%), model uncertainty (25%)
  // Signature: _calculateConfidence({ userMessage, fullResponse, toolUseCount, toolSuccessCount, modelUncertainty })
  _calculateConfidence(options = {}) {
    const { userMessage = '', fullResponse = '', toolUseCount = 0, toolSuccessCount = 0, modelUncertainty = 0 } = options;

    let contextRelevance = 0.7; // Default neutral
    let toolSuccessRate = 1.0;  // Default all succeeded
    let modelConfidence = 0.75; // Default moderate

    // 1. CONTEXT RELEVANCE — estimate from message length/complexity
    if (userMessage.length > 500) {
      contextRelevance = 0.85; // Long message likely has more context
    } else if (userMessage.length > 200) {
      contextRelevance = 0.75;
    } else if (userMessage.length < 30) {
      contextRelevance = 0.55; // Very short message
    }

    // 2. TOOL SUCCESS RATE — from explicit counts passed in
    if (toolUseCount > 0) {
      toolSuccessRate = Math.max(0, toolSuccessCount / toolUseCount);
    }

    // 3. MODEL UNCERTAINTY — from explicit parameter + response analysis
    modelConfidence = 1.0 - Math.max(0, Math.min(1, modelUncertainty));

    // Adjust based on response content
    if (/i'm not sure|i don't know|i cannot|bilemiyorum|emin deg|konusunda/i.test(fullResponse)) {
      modelConfidence *= 0.7; // Reduce confidence for uncertain statements
    } else if (/however|but|on the other hand|ancak|fakat|ama/i.test(fullResponse)) {
      modelConfidence *= 0.85; // Slight reduction for caveated statements
    } else if (fullResponse.length > 500 && /^##|^###|^####|\n\*\*|\n-/.test(fullResponse)) {
      modelConfidence = Math.min(0.95, modelConfidence * 1.1); // Boost for structured, detailed response
    }

    modelConfidence = Math.max(0, Math.min(1, modelConfidence));

    // Composite confidence (weighted average)
    const composite =
      (contextRelevance * CONFIDENCE_WEIGHTS.contextRelevance) +
      (toolSuccessRate * CONFIDENCE_WEIGHTS.toolSuccess) +
      (modelConfidence * CONFIDENCE_WEIGHTS.modelConfidence);

    return {
      contextRelevance: Math.round(contextRelevance * 100) / 100,
      toolSuccessRate: Math.round(toolSuccessRate * 100) / 100,
      modelConfidence: Math.round(modelConfidence * 100) / 100,
      confidence: Math.round(composite * 100) / 100,
      composite: Math.round(composite * 100) / 100
    };
  }

  getConfidenceScore(conversationId) {
    return confidenceScores.get(conversationId) || {
      contextRelevance: 0.7,
      toolSuccessRate: 1.0,
      modelConfidence: 0.75,
      composite: 0.78,
      timestamp: new Date().toISOString()
    };
  }

  clearConfidenceScore(conversationId) {
    confidenceScores.delete(conversationId);
  }

  // Record a decision point for decision tree tracking (roadmap 10.2)
  recordDecision(workspaceId, type, details, rationale = '') {
    if (!workspaceId) return;

    if (!decisionLogs.has(workspaceId)) {
      decisionLogs.set(workspaceId, {
        decisions: [],
        startedAt: Date.now(),
        ttlTimeout: null
      });
    }

    const log = decisionLogs.get(workspaceId);
    const decision = {
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      type, // model_choice, tool_selection, context_action, budget_throttle, etc.
      details, // { model, reason } or { tool, input, purpose } or { action, reason }
      rationale
    };

    log.decisions.push(decision);

    // Keep only last N decisions per agent (FIFO on overflow)
    if (log.decisions.length > MAX_DECISIONS_PER_AGENT) {
      log.decisions = log.decisions.slice(-MAX_DECISIONS_PER_AGENT);
    }

    // Auto-cleanup: set TTL if not already set
    if (!log.ttlTimeout) {
      log.ttlTimeout = setTimeout(() => {
        decisionLogs.delete(workspaceId);
      }, DECISION_LOG_TTL);
    }
  }

  getDecisions(agentId) {
    if (!decisionLogs.has(agentId)) {
      return { agentId, decisions: [], decisionCount: 0 };
    }
    const log = decisionLogs.get(agentId);
    return {
      agentId,
      startedAt: new Date(log.startedAt).toISOString(),
      decisions: log.decisions,
      decisionCount: log.decisions.length
    };
  }

  clearDecisions(agentId) {
    const log = decisionLogs.get(agentId);
    if (log && log.ttlTimeout) {
      clearTimeout(log.ttlTimeout);
    }
    decisionLogs.delete(agentId);
  }

  // Helper: Infer tool purpose from tool name and input (roadmap 9.1)
  _inferToolPurpose(toolName, input) {
    const toolPurposes = {
      'Read': 'read and understand file contents',
      'Write': 'write or create file content',
      'Edit': 'modify existing file content',
      'Bash': 'execute system commands',
      'Glob': 'find files by pattern',
      'Grep': 'search file contents',
      'Task': 'delegate work to specialized agent',
      'WebFetch': 'retrieve web content',
      'WebSearch': 'search the web',
      'Skill': 'invoke a specialized skill',
      'NotebookEdit': 'modify Jupyter notebook cells'
    };
    return toolPurposes[toolName] || `execute ${toolName}`;
  }

  // ═══════════════════════════════════════════════════════════
  // MAIN EXECUTE
  // ═══════════════════════════════════════════════════════════

  async execute(options) {
    const {
      workspaceId,
      conversationId,
      userMessage,
      images = [],
      sessionId = null,
      channel = 'webchat',
      userId = 'default',
      isGroup = false,
      botMentioned = false,
      isResumedJob = false, // Don't persist to active-jobs.json if this is a resumed job
      _retryCount = 0,     // Internal: current retry attempt (0 = first try)
      maxTurns = null,     // Optional: max agentic turns (e.g., 200 for self-improve)
      requestId = null,    // Optional: request ID for structured logging (generated by HTTP/WS layer)
      requestTracer = null, // Optional: RequestTracer instance for tracing (roadmap 10.1)
      delegationContext = null, // Optional: delegation chain context from message-router (roadmap 5.4)
      parentConversationId = null, // Optional: parent job's conversationId for restart resume linking
      forceModel = null, // Optional: override model selection (e.g., 'sonnet' for self-improve)
      onEvent,
      onComplete,
      onError
    } = options;

    // Log retry attempts for diagnostics
    if (_retryCount > 0) {
      this.logger.info('AgentExecutor', `CLI retry attempt ${_retryCount + 1}/${CLI_MAX_RETRIES + 1} for conversation ${conversationId}`);
    }

    // KRITIK-3: Group activation — in groups, only respond to @mention or /commands
    if (isGroup && !botMentioned && !userMessage.startsWith('/')) {
      this.logger.info('AgentExecutor', `[Group] Skipped (no mention): ${userMessage.substring(0, 40)}`);
      return;
    }

    // MESSAGE QUEUE: If a process is already running for this conversation OR workspace,
    // queue the new message to be sent via --resume after the current process completes.
    // This prevents cancelling active work when user sends follow-up messages,
    // AND prevents parallel processes when BRRR/cron uses different conversationId than UI.
    const _queueConvId = conversationId; // queue key = this conversation

    // STALE STATE CLEANUP: If activeProcesses has an entry but the process is dead,
    // clean it up before checking busy. Prevents "stuck busy" desync after process
    // crash/SIGTERM where exit handler didn't fire (user messages would queue forever).
    const _staleProc = this.activeProcesses.get(conversationId);
    if (_staleProc && _staleProc.pid) {
      try {
        process.kill(_staleProc.pid, 0); // probe — alive?
      } catch (_) {
        // Process is dead — clean up stale state
        this.logger.warn('AgentExecutor', `Cleaned stale activeProcess for conv ${conversationId} (PID ${_staleProc.pid} dead)`);
        this.activeProcesses.delete(conversationId);
        this._activeJobs.delete(conversationId);
        if (this._workspaceLocks.get(workspaceId)?.conversationId === conversationId) {
          this._workspaceLocks.delete(workspaceId);
        }
      }
    }
    // Also clean stale workspace locks (different conv but its process is dead)
    const _staleLock = this._workspaceLocks.get(workspaceId);
    if (_staleLock && _staleLock.conversationId !== conversationId) {
      const _lockProc = this.activeProcesses.get(_staleLock.conversationId);
      if (_lockProc && _lockProc.pid) {
        try {
          process.kill(_lockProc.pid, 0);
        } catch (_) {
          this.logger.warn('AgentExecutor', `Cleaned stale workspaceLock for ${workspaceId} (conv ${_staleLock.conversationId} PID ${_lockProc.pid} dead)`);
          this.activeProcesses.delete(_staleLock.conversationId);
          this._activeJobs.delete(_staleLock.conversationId);
          this._workspaceLocks.delete(workspaceId);
        }
      } else if (!_lockProc) {
        // Lock without process entry — definitely stale
        this.logger.warn('AgentExecutor', `Cleaned orphan workspaceLock for ${workspaceId} (no process entry)`);
        this._workspaceLocks.delete(workspaceId);
      }
    }

    const _wsLockCheck = this._workspaceLocks.get(workspaceId);
    const _isBusyConv = this.activeProcesses.has(conversationId);
    const _isBusyWorkspace = _wsLockCheck && _wsLockCheck.conversationId !== conversationId;

    if ((_isBusyConv || _isBusyWorkspace) && !options._isResumeFromQueue && channel !== 'cron') {
      const busyConvId = _isBusyWorkspace ? _wsLockCheck.conversationId : conversationId;
      const reason = _isBusyWorkspace ? 'workspace busy (other conv: ' + busyConvId.substring(0, 30) + ')' : 'conversation busy';
      this.logger.info('AgentExecutor', `[QUEUE] ${reason} — queueing message for workspace ${workspaceId}`);

      // Queue under the BUSY conversation's ID so it gets flushed when that process completes
      const queueKey = busyConvId;
      if (!this._pendingMessages.has(queueKey)) {
        this._pendingMessages.set(queueKey, []);
      }
      const queue = this._pendingMessages.get(queueKey);
      // Accumulate ALL pending messages — merge into single message when flushed
      // Previous behavior dropped earlier messages, causing message loss
      queue.push({ message: userMessage, images, onEvent, onComplete, onError, options });
      this.logger.info('AgentExecutor', `[QUEUE] ${queue.length} message(s) pending for ${queueKey}`);
      // Notify caller that message was queued
      if (onEvent) {
        onEvent({ type: 'system', content: `📎 Message queued (#${queue.length}) — agent is busy. Will be delivered when done.` });
      }
      return;
    }

    // Auto-routing: Check if message should be routed to another agent
    // Skip auto-routing for inter-agent messages (channel === 'agent') and cron tasks to prevent loops
    if (channel !== 'agent' && channel !== 'cron' && this.autoRouter && this.messageRouter && this.agentManager) {
      const routing = this.autoRouter.route(userMessage, workspaceId);
      if (routing.shouldRoute && routing.targetAgent && routing.targetAgent !== workspaceId) {
        this.logger.info('AgentExecutor', `Auto-routing to ${routing.targetAgent}: ${routing.reason} (confidence: ${routing.confidence})`);

        // Send to target agent via messageRouter
        const agentName = this.agentManager.getAgent(routing.targetAgent)?.name || routing.targetAgent;
        try {
          const result = await this.messageRouter.sendMessage({
            from: workspaceId,
            to: routing.targetAgent,
            message: userMessage,
            timeout: 120,
            conversationId: conversationId
          });

          // Return routed response
          if (result.reply) {
            const routedResponse = `[Auto-routed to ${agentName}]\n\n${result.reply}`;
            if (onEvent) onEvent({ type: 'text', content: routedResponse });
            if (onComplete) onComplete({ response: routedResponse, sessionId: null, cost: 0, duration: 0, routed: true });
          } else {
            // Reply empty — still notify UI to stop "Thinking..." indicator
            const emptyRouteMsg = `[Message was routed to ${agentName} but no response was received. Check the Agent-to-Agent panel for details.]`;
            if (onEvent) onEvent({ type: 'text', content: emptyRouteMsg });
            if (onComplete) onComplete({ response: emptyRouteMsg, sessionId: null, cost: 0, duration: 0, routed: true });
          }
          return;
        } catch (e) {
          // CRITICAL: Do NOT fall back to local execution — that causes master to
          // restart itself and creates infinite loop. Instead, inform user and finish.
          this.logger.warn('AgentExecutor', `Auto-routing to ${agentName} failed: ${e.message}`);
          const errorMsg = `[${agentName} agent could not respond: ${e.message}. Please try again or ask your question directly.]`;
          if (onEvent) onEvent({ type: 'text', content: errorMsg });
          if (onComplete) onComplete({ response: errorMsg, sessionId: null, cost: 0, duration: 0, routed: true });
          return;
        }
      }
    }

    // Slash commands
    // Only treat as command if starts with / followed by a letter (not /Users/... paths)
    if (userMessage.startsWith('/') && /^\/[a-zA-Z]/.test(userMessage) && !userMessage.startsWith('/Users') && !userMessage.startsWith('/home') && !userMessage.startsWith('/tmp')) {
      const replyFn = (text) => {
        if (onEvent) onEvent({ type: 'text', content: text });
        onComplete({ response: text, sessionId: null, cost: 0, duration: 0 });
      };
      return this.handleCommand(userMessage, channel, userId, replyFn, isGroup, workspaceId, conversationId);
    }

    // Load workspace (fallback to default if 'default' string is passed)
    // Reload from file to catch newly created agents
    const allWorkspaces = this.workspaceManager.listWorkspaces();
    this.logger.info('AgentExecutor', `[WORKSPACE] Looking for "${workspaceId}" among ${allWorkspaces.length} workspaces`, { requestId });
    let workspace = allWorkspaces.find(w => w.id === workspaceId);
    // Also try matching by name (case-insensitive) — UI sometimes sends name instead of UUID
    if (!workspace) {
      workspace = allWorkspaces.find(w => w.name && w.name.toLowerCase() === (workspaceId || '').toLowerCase());
    }
    if (!workspace) {
      this.logger.warn('AgentExecutor', `[WORKSPACE] NOT FOUND: "${workspaceId}", using default`);
      workspace = this.workspaceManager.getDefaultWorkspace();
    } else {
      this.logger.info('AgentExecutor', `[WORKSPACE] FOUND: "${workspace.name}" (${workspace.id})`);
    }
    if (!workspace) {
      const error = new Error('Workspace not found');
      if (requestId && requestTracer) {
        requestTracer.endTrace(requestId, 'error');
      }
      onError(error);
      return;
    }
    const effectiveWorkspaceId = workspace.id;

    // WORKSPACE CONCURRENCY (2026-04-02): Allow parallel CLI processes on same workspace.
    // Old system: exclusive lock → only 1 process per workspace → agents queue behind each other.
    // New system: concurrent execution allowed. Each CLI process gets its own sandbox for writes.
    // Conversation-level queue (above) already prevents duplicate work on same conversation.
    // File writes go through SandboxManager (ephemeral /tmp/anuki-sandbox-*/) — no corruption risk.
    // Only log for awareness, don't block.
    const wsLock = this._workspaceLocks.get(effectiveWorkspaceId);
    if (wsLock && wsLock.conversationId !== conversationId) {
      // Track concurrent executions for this workspace
      if (!this._workspaceConcurrency) this._workspaceConcurrency = new Map();
      const concurrent = (this._workspaceConcurrency.get(effectiveWorkspaceId) || 0) + 1;
      this._workspaceConcurrency.set(effectiveWorkspaceId, concurrent);
      this.logger.info('AgentExecutor', `[CONCURRENT] Workspace ${effectiveWorkspaceId} has ${concurrent + 1} parallel processes (conv: ${conversationId}, also: ${wsLock.conversationId})`);
    }

    // Session idle/daily/turn-count reset + SESSION PERSISTENCE
    // Session key includes conversationId so each conversation gets its own session
    // Without conversationId, all conversations share ONE Claude session — causing
    // wrong context, missing messages, and cross-conversation contamination
    const sessionKey = channel + ':' + userId + ':' + effectiveWorkspaceId + ':' + (conversationId || 'new');
    const sessionMeta = this.sessions.get(sessionKey) || { lastActivity: null, resetCount: 0, turnCount: 0 };

    // Use provided sessionId, or fall back to persisted sessionId
    // _forceNewSession flag = true means: skip persisted session (used after retry failures)
    let effectiveSessionId = options._forceNewSession ? null : (sessionId || sessionMeta.sessionId || null);

    if (effectiveSessionId && sessionMeta.lastActivity) {
      const now = new Date();
      const lastActivity = new Date(sessionMeta.lastActivity);
      const idleMs = now.getTime() - lastActivity.getTime();

      // Idle reset: 2 hours
      if (idleMs > SESSION_IDLE_TIMEOUT) {
        this.logger.info('AgentExecutor', `Session idle reset (${Math.round(idleMs / 60000)}m idle)`);
        effectiveSessionId = null;
        sessionMeta.resetCount++;
        sessionMeta.turnCount = 0;
      }

      // Daily reset: 04:00 boundary
      const resetTime = new Date(now);
      resetTime.setHours(SESSION_RESET_HOUR, 0, 0, 0);
      if (now >= resetTime && lastActivity < resetTime) {
        this.logger.info('AgentExecutor', 'Session daily reset (04:00 boundary)');
        effectiveSessionId = null;
        sessionMeta.resetCount++;
        sessionMeta.turnCount = 0;
      }

      // Turn-count reset: start fresh session to prevent context bloat
      // 100 turns allows autonomous agents to complete complex multi-step work without losing context
      // Claude 200K token context can handle 100+ turns — prompt size stays under 80K chars typically
      const SESSION_MAX_TURNS = 100;
      if (sessionMeta.turnCount >= SESSION_MAX_TURNS) {
        this.logger.info('AgentExecutor', `Session turn-count reset (${sessionMeta.turnCount} turns, max ${SESSION_MAX_TURNS})`);
        effectiveSessionId = null;
        sessionMeta.resetCount++;
        sessionMeta.turnCount = 0;
      }
    }

    // Track if session was just rotated (for conversation recap injection)
    const sessionWasRotated = !effectiveSessionId && sessionMeta.resetCount > 0;

    // Increment turn counter
    sessionMeta.turnCount = (sessionMeta.turnCount || 0) + 1;
    sessionMeta.lastActivity = new Date().toISOString();
    this.sessions.set(sessionKey, sessionMeta);

    // COMPACTION: Compact long conversations before building recap
    if (this.compactor && conversationId && this.conversationManager) {
      try {
        const conv = this.conversationManager.getConversation(conversationId);
        if (conv && conv.messages && conv.messages.length > 0) {
          const session = { messages: conv.messages, compactionCount: conv.compactionCount || 0 };
          if (this.compactor.needsCompaction(session, '')) {
            this.logger.info('AgentExecutor', `Compacting conversation ${conversationId} (${conv.messages.length} msgs)`, { requestId });
            const compacted = await this.compactor.compact(session, '');
            conv.messages = compacted.messages;
            conv.compactionCount = compacted.compactionCount;
            this.conversationManager.updateConversation(conversationId, { messages: conv.messages });
            this.logger.info('AgentExecutor', `Compacted: ${conv.messages.length} msgs remaining`, { requestId });
          }
        }
      } catch (e) {
        this.logger.warn('AgentExecutor', `Compaction failed: ${e.message}`);
      }
    }

    // SESSION ROTATION CONTEXT BRIDGE: When session resets OR resumes, inject recent history.
    // Recap applies to BOTH new sessions (rotation) AND resumed sessions (context-only prompt).
    let conversationRecap = '';
    if (conversationId && this.conversationManager) {
      try {
        const conv = this.conversationManager.getConversation(conversationId);
        if (conv && conv.messages && conv.messages.length > 0) {
          const RECAP_MSG_COUNT = 30;
          const RECAP_MSG_MAX_CHARS = 2000; // Per-message limit for older messages
          const RECAP_RECENT_FULL = 5; // Last N messages get FULL content (no truncation)
          const recentMsgs = conv.messages.slice(-RECAP_MSG_COUNT);
          const totalMsgs = recentMsgs.length;
          const recapLines = recentMsgs.map((m, idx) => {
            const role = m.role === 'user' ? 'User' : 'Agent';
            const isRecent = idx >= totalMsgs - RECAP_RECENT_FULL;
            // Last 5 messages: full content (critical for continuity)
            // Older messages: truncated to 2000 chars
            const content = isRecent
              ? (m.content || '')
              : (m.content || '').substring(0, RECAP_MSG_MAX_CHARS);
            return `${role}: ${content}`;
          });
          const rotationNote = effectiveSessionId === null
            ? '\n⚠️ SESSION ROTATION: Turn limit reached, new session started. Review recent messages — continue any unfinished work.\n'
            : '';
          conversationRecap = '\n\n=== RECENT CONVERSATION HISTORY (preserve context) ===' + rotationNote + '\n' + recapLines.join('\n---\n');
          this.logger.info('AgentExecutor', `Context bridge: injecting ${recentMsgs.length} message recap (${RECAP_RECENT_FULL} full, ${totalMsgs - RECAP_RECENT_FULL} truncated)`, { requestId });
        }
      } catch (e) {
        this.logger.warn('AgentExecutor', `Failed to build conversation recap: ${e.message}`);
      }
    }

    // PERFORMANCE PROFILING: Mark context assembly start (roadmap 10.3)
    const contextAssemblyStart = Date.now();

    // Credential scanning on input
    let safeMessage = userMessage;
    if (this.security && this.security.scanForCredentials) {
      const scanResult = this.security.scanForCredentials(userMessage);
      if (scanResult && !scanResult.clean) {
        this.logger.warn('AgentExecutor', `Credentials detected in input (${scanResult.findings.map(f => f.type).join(', ')}), redacting`);
        safeMessage = this.security.redactCredentials(userMessage);
      }
    }

    // TOKEN OPTIMIZATION: Model tiering
    // Workspace-level model override (e.g., SAFU → opus for instruction compliance)
    const wsModelOverride = workspace && workspace.modelOverride ? workspace.modelOverride : null;
    let selectedModel = forceModel || wsModelOverride || this._selectModel(safeMessage);
    this.logger.info('AgentExecutor', `Model tier: ${selectedModel}${forceModel ? ' (forced)' : ''} (msg: ${safeMessage.length} chars)`, { requestId });

    // DECISION TRACKING: Record model choice (roadmap 10.2)
    if (workspaceId) {
      this.recordDecision(workspaceId, 'model_choice', {
        model: selectedModel,
        messageLength: safeMessage.length,
        hasComplexKeywords: /\b(refactor|implement|debug|deploy|migration|architect|analyze|compare|optimize|write code|function|class|component|api|database|docker|kubernetes|read file|write file|run command)\b/i.test(safeMessage.toLowerCase())
      }, `Selected ${selectedModel} model for ${safeMessage.length}-char message`);
    }

    // BUDGET CHECK: DISABLED — using flat-rate package, no per-token cost
    // Budget throttle removed. Each agent runs at its own model tier.

    // TOKEN OPTIMIZATION: Bootstrap skip on resume
    // Resume sessions already have system prompt in context — only send lightweight context update
    const isResume = !!effectiveSessionId;

    // Always load soul files (needed for both new and resume sessions)
    const soulFiles = this._loadSoulFilesCached(effectiveWorkspaceId);
    this.logger.info('AgentExecutor', `Loaded ${Object.keys(soulFiles).length} soul files for ${workspace.name}`);

    // Set reasoning trace enabled flag (roadmap 9.1)
    const thinkingEnabled = soulFiles._thinkingEnabled === true;
    reasoningEnabled.set(conversationId, thinkingEnabled);
    if (thinkingEnabled) {
      this.logger.info('AgentExecutor', `Reasoning trace enabled for ${conversationId}`);
      // Record session start with context and model choice
      this._recordReasoningEvent(conversationId, 'session_start', {
        userMessage: safeMessage.substring(0, 200),
        channel,
        userId
      }, {
        model: selectedModel,
        rationale: `Selected ${selectedModel} model for ${safeMessage.length}-char message`
      });
    }

    let systemPrompt;
    if (isResume) {
      // RESUME: Send identity anchor from soul files + runtime context + RECAP
      systemPrompt = this._buildContextOnlyPrompt(safeMessage, channel, userId, isGroup, soulFiles, workspace);
      // FIX: Add recap to resume too — prevent context loss
      if (conversationRecap) {
        systemPrompt += conversationRecap;
      }
      this.recordDecision(workspaceId, 'context_action', {
        action: 'use_context_only',
        sessionDuration: `${Math.round((Date.now() - new Date(sessionMeta?.lastActivity || Date.now()).getTime()) / 1000)}s`,
        promptSize: systemPrompt.length,
        hasRecap: !!conversationRecap,
        reason: 'Session resume'
      }, 'Resuming existing session with context-only prompt + conversation recap');
      this.logger.info('AgentExecutor', `Resume mode: context-only prompt (${systemPrompt.length} chars${conversationRecap ? ' + recap' : ''})`, { requestId });
    } else {
      // NEW SESSION: Full bootstrap with all soul files
      systemPrompt = this._buildFullSystemPrompt(soulFiles, safeMessage, channel, userId, isGroup, workspace);

      // SESSION ROTATION CONTEXT BRIDGE: Append conversation recap to system prompt
      // This ensures agent knows what was discussed before session rotation
      if (conversationRecap) {
        systemPrompt += conversationRecap;
        this.logger.info('AgentExecutor', `Session rotation: appended ${conversationRecap.length} char recap to system prompt`, { requestId });
      }

      this.recordDecision(workspaceId, 'context_action', {
        action: 'use_full_bootstrap',
        promptSize: systemPrompt.length,
        reason: conversationRecap ? 'Session rotation (with recap)' : 'New session'
      }, 'Creating new session with full soul file bootstrap for complete context initialization');
      this.logger.info('AgentExecutor', `New session: full prompt (${systemPrompt.length} chars)`, { requestId });
    }

    // Session resumption — only for providers that support it
    // Validate session file exists on disk before attempting resume — prevents code 1 crash
    // when session belongs to a different workspace (cross-workspace session contamination)
    if (effectiveSessionId && this.provider.supportsResume()) {
      const cwdOverride = workspace.cwdOverride ? workspace.cwdOverride.replace(/^~/, process.env.HOME) : null;
      const projectDirName = '-' + (cwdOverride || workspaceDir).replace(/[/.]/g, '-').replace(/^-/, '');
      const sessionFile = path.join(process.env.HOME, '.claude', 'projects', projectDirName, effectiveSessionId + '.jsonl');
      if (!fs.existsSync(sessionFile)) {
        this.logger.warn('AgentExecutor', `Session file missing, starting new session (was: ${effectiveSessionId}, expected: ${sessionFile})`);
        effectiveSessionId = null;
        if (sessionMeta) sessionMeta.sessionId = null;
      } else {
        this.logger.info('AgentExecutor', `Resuming session: ${effectiveSessionId}`);
      }
    } else if (effectiveSessionId && !this.provider.supportsResume()) {
      this.logger.info('AgentExecutor', `Provider '${this.provider.name}' does not support session resume — starting new session`);
      effectiveSessionId = null;
      if (sessionMeta) sessionMeta.sessionId = null;
    }

    // Build provider-specific spawn config
    const spawnConfig = this.provider.buildArgs({
      message: safeMessage,
      systemPrompt,
      model: selectedModel,
      sessionId: effectiveSessionId,
      maxTurns,
      images,
      workspaceDir
    });

    this.logger.info('AgentExecutor', `Executing ${this.provider.name} for workspace ${effectiveWorkspaceId}`, { requestId });

    // PERFORMANCE PROFILING: Record context assembly time (roadmap 10.3)
    const contextAssemblyTime = Date.now() - contextAssemblyStart;
    this.performanceProfiler.recordLatency('context_assembly', contextAssemblyTime, {
      conversationId,
      model: selectedModel,
      isResume,
      messageLength: safeMessage.length,
      promptSize: systemPrompt.length
    });

    // Spawn Claude process - ensure cwd exists
    // cwdOverride sets the working directory for the Claude CLI process
    let workspaceDir = this.workspaceManager.getWorkspacePath
      ? this.workspaceManager.getWorkspacePath(effectiveWorkspaceId)
      : process.env.HOME;

    // Check for cwdOverride in workspace config (agent isolation)
    const wsConfig = this.workspaceManager.getWorkspace
      ? this.workspaceManager.getWorkspace(effectiveWorkspaceId)
      : null;
    if (wsConfig && wsConfig.cwdOverride) {
      const overrideDir = wsConfig.cwdOverride.replace(/^~/, process.env.HOME);

      // AUTO-SYNC: Delegate to SandboxManager (soul-file-safe, lock-aware)
      const syncResult = this.sandboxManager.preExecutionSync(overrideDir, wsConfig.name || effectiveWorkspaceId);
      if (syncResult.synced) {
        this.logger.info('AgentExecutor', `[SANDBOX-SYNC] Pre-execution sync via SandboxManager: OK`);
      }

      if (fs.existsSync(overrideDir)) {
        this.logger.info('AgentExecutor', `[CWD] Using cwdOverride for ${wsConfig.name || effectiveWorkspaceId}: ${overrideDir}`);
        workspaceDir = overrideDir;
      } else {
        // Create the override directory if it doesn't exist
        try {
          fs.mkdirSync(overrideDir, { recursive: true });
          this.logger.info('AgentExecutor', `[CWD] Created cwdOverride dir: ${overrideDir}`);
          workspaceDir = overrideDir;
        } catch (e) {
          this.logger.warn('AgentExecutor', `[CWD] Failed to create cwdOverride dir: ${e.message}`);
        }
      }
    }

    // Fallback to HOME if workspace directory doesn't exist
    if (!workspaceDir || !fs.existsSync(workspaceDir)) {
      this.logger.warn('AgentExecutor', `Workspace dir not found: ${workspaceDir}, using HOME`);
      workspaceDir = process.env.HOME;
    }

    // Circuit breaker check — prevent spawning if agent is in failure loop
    if (this.supervisor) {
      const check = this.supervisor.canExecute(effectiveWorkspaceId);
      if (!check.allowed) {
        this.logger.warn('AgentExecutor', `Circuit breaker OPEN for ${effectiveWorkspaceId}: ${check.reason} (retry in ${check.retryAfterMs}ms)`);
        const error = new Error(`Agent ${effectiveWorkspaceId} temporarily disabled (circuit breaker open). Retry in ${Math.round((check.retryAfterMs || 30000) / 1000)}s.`);
        error.code = 'CIRCUIT_OPEN';
        if (requestId && requestTracer) requestTracer.endTrace(requestId, 'circuit_open');
        onError(error);
        return;
      }
    }

    // Spawn LLM process via provider
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE; // Prevent nested session error for Claude CLI

    const spawnResult = this.provider.spawnProcess(spawnConfig, workspaceDir, cleanEnv);
    const claudeProcess = spawnResult.process;

    if (!claudeProcess.stdout || !claudeProcess.stderr) {
      this.logger.error('AgentExecutor', `Failed to spawn ${this.provider.name} process (stdout/stderr null)`);
      const error = new Error(`Failed to spawn ${this.provider.name} process`);
      if (requestId && requestTracer) {
        requestTracer.endTrace(requestId, 'error');
      }
      onError(error);
      return;
    }

    this.activeProcesses.set(conversationId, claudeProcess);

    // Register in PID registry for orphan tracking
    if (this.pidRegistry && claudeProcess.pid) {
      this.pidRegistry.register(claudeProcess.pid, { conversationId, workspaceId: effectiveWorkspaceId });
    }

    // Register with supervisor for circuit breaker + resource monitoring
    if (this.supervisor && claudeProcess.pid) {
      this.supervisor.registerAgent(effectiveWorkspaceId, claudeProcess.pid, { conversationId, workspaceId: effectiveWorkspaceId });
    }

    // WORKSPACE LOCK ACQUIRE (2026-03-31): Mark workspace as busy
    this._workspaceLocks.set(effectiveWorkspaceId, { conversationId, startedAt: new Date().toISOString() });

    // Track execution start time for elapsed calculations in tryFinalize and error handlers
    const startTime = Date.now();

    // Track active job for restart resume
    this._activeJobs.set(conversationId, {
      workspaceId: effectiveWorkspaceId,
      sessionId: effectiveSessionId,
      userMessage: safeMessage,
      channel,
      userId,
      startedAt: new Date().toISOString(),
      isResumedJob,
      parentConversationId: parentConversationId || null  // Link to parent job for orphan detection on restart
    });
    // Always persist active jobs to disk — even resumed jobs.
    // Without this, a crash during a resumed job loses the job entirely
    // while the resume counter still increments → phantom circuit breaker.
    this._saveActiveJobs();

    // Broadcast job-start for Activity Dashboard
    if (this.wsServer && this.wsServer.broadcast) {
      this.wsServer.broadcast({ type: 'job-activity', action: 'start', conversationId, workspaceId: effectiveWorkspaceId, channel, startedAt: new Date().toISOString() });
    }

    let fullResponse = '';
    let capturedSessionId = null;
    let totalCost = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let duration = null;
    const claudeWaitStart = Date.now(); // PERFORMANCE PROFILING (roadmap 10.3)

    // Confidence scoring tracking (roadmap 9.3)
    let toolUseCount = 0;
    let toolSuccessCount = 0;
    let modelUncertainty = 0.0;

    // Live progress tracking (Session 4 feature)
    let turnCount = 0;
    const progressStartTime = Date.now();
    let lastToolName = null;
    let lastToolPurpose = null;
    const turnTimestamps = []; // Track timing for ETA calculation

    claudeProcess.stdout.setEncoding('utf8');
    claudeProcess.stderr.setEncoding('utf8');

    const rl = readline.createInterface({ input: claudeProcess.stdout });

    rl.on('line', (line) => {
      if (!line.trim()) return;

      try {
        // Performance profiling: Response parse latency (roadmap 10.3)
        const parseStart = Date.now();
        const event = JSON.parse(line);
        const parseDuration = Date.now() - parseStart;
        if (parseDuration > 0) {
          this.performanceProfiler.recordLatency('response_parse', parseDuration, {
            conversationId,
            eventType: event.type,
            lineLength: line.length
          });
        }

        switch (event.type) {
          case 'system':
            if (event.session_id) {
              capturedSessionId = event.session_id;
            }
            if (onEvent) {
              onEvent({
                type: 'system',
                session_id: event.session_id,
                model: event.model
              });
            }
            break;

          case 'assistant':
            // Track turns for live progress (Session 4 feature)
            turnCount++;
            turnTimestamps.push(Date.now());

            // Emit progress event
            if (onEvent) {
              const elapsedMs = Date.now() - progressStartTime;
              const effectiveMaxTurns = maxTurns || 200;
              const percentage = Math.min(99, Math.round((turnCount / effectiveMaxTurns) * 100));
              // ETA: average time per turn × remaining turns
              const avgTurnMs = turnTimestamps.length > 1
                ? (turnTimestamps[turnTimestamps.length - 1] - turnTimestamps[0]) / (turnTimestamps.length - 1)
                : elapsedMs;
              const remainingTurns = effectiveMaxTurns - turnCount;
              const estimatedRemainingMs = Math.round(avgTurnMs * remainingTurns);

              onEvent({
                type: 'progress',
                turn: turnCount,
                maxTurns: effectiveMaxTurns,
                percentage,
                elapsedMs,
                estimatedRemainingMs,
                avgTurnMs: Math.round(avgTurnMs),
                currentTool: lastToolName,
                currentAction: lastToolPurpose
              });
            }

            // With --include-partial-messages, text already arrived via stream_event deltas.
            // Assistant event contains the COMPLETE message — skip text to avoid duplication.
            // Only process tool_use blocks here (they have complete input JSON).
            if (event.message && event.message.content) {
              for (const block of event.message.content) {
                if (block.type === 'text') {
                  // Skip: already sent via stream_event content_block_delta
                } else if (block.type === 'tool_use') {
                  // Track current tool for live progress (Session 4)
                  lastToolName = block.name;
                  lastToolPurpose = this._inferToolPurpose(block.name, block.input);

                  // SELF-RESTART DETECTION: Flag if agent runs launchctl kickstart
                  if (block.name === 'Bash' && block.input && typeof block.input.command === 'string' && block.input.command.includes('launchctl kickstart')) {
                    this._selfRestartTriggered = this._selfRestartTriggered || new Set();
                    this._selfRestartTriggered.add(conversationId);
                  }

                  const toolEvent = {
                    type: 'tool_start',
                    tool: block.name,
                    id: block.id,
                    input: block.input
                  };
                  if (onEvent) {
                    onEvent(toolEvent);
                  }
                  // Record for reasoning trace (roadmap 9.1) with rationale
                  this._recordReasoningEvent(conversationId, 'tool_start', {
                    tool: block.name,
                    id: block.id,
                    input: block.input
                  }, {
                    rationale: `Using ${block.name} to ${this._inferToolPurpose(block.name, block.input)}`,
                    confidence: 0.9
                  });

                  // DECISION TRACKING: Record tool selection (roadmap 10.2)
                  if (workspaceId) {
                    this.recordDecision(workspaceId, 'tool_selection', {
                      tool: block.name,
                      id: block.id,
                      inputKeys: typeof block.input === 'object' ? Object.keys(block.input) : []
                    }, `Using ${block.name} to ${this._inferToolPurpose(block.name, block.input)}`);
                  }
                }
              }
            }
            break;

          case 'user':
            if (event.message && event.message.content) {
              for (const block of event.message.content) {
                if (block.type === 'tool_result') {
                  let output = typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content);
                  // TOKEN OPTIMIZATION: Trim large tool outputs
                  if (output.length > TOOL_OUTPUT_MAX_CHARS) {
                    output = output.substring(0, TOOL_OUTPUT_MAX_CHARS) + '\n... [truncated: ' + output.length + ' chars]';
                  }
                  const resultEvent = {
                    type: 'tool_result',
                    success: !block.is_error,
                    tool_use_id: block.tool_use_id,
                    output: output
                  };
                  if (onEvent) {
                    onEvent(resultEvent);
                  }
                  // Track tool success for confidence scoring (roadmap 9.3)
                  if (!block.is_error) {
                    toolSuccessCount++;
                  }
                  // Record for reasoning trace (roadmap 9.1) with success/error analysis
                  this._recordReasoningEvent(conversationId, 'tool_result', {
                    tool_use_id: block.tool_use_id,
                    success: !block.is_error,
                    outputLength: output.length,
                    outputPreview: output.substring(0, 100)
                  }, {
                    confidence: block.is_error ? 0.3 : 0.95
                  });
                }
              }
            }
            break;

          case 'stream_event':
            // Real-time streaming from --include-partial-messages
            if (event.event) {
              const streamEvt = event.event;
              if (streamEvt.type === 'content_block_delta') {
                if (streamEvt.delta && streamEvt.delta.type === 'text_delta' && streamEvt.delta.text) {
                  fullResponse += streamEvt.delta.text;
                  // Update lastResponse in active job for graceful shutdown resume
                  { const _aj = this._activeJobs.get(conversationId); if (_aj) _aj.lastResponse = fullResponse; }
                  if (onEvent) {
                    onEvent({ type: 'text', content: streamEvt.delta.text });
                  }
                  // Record reasoning/thinking (roadmap 9.1)
                  this._recordReasoningEvent(conversationId, 'text', {
                    preview: streamEvt.delta.text.substring(0, 100)
                  });
                }
              } else if (streamEvt.type === 'content_block_start') {
                if (streamEvt.content_block && streamEvt.content_block.type === 'tool_use') {
                  // Track current tool for live progress (Session 4)
                  lastToolName = streamEvt.content_block.name;
                  lastToolPurpose = `using ${streamEvt.content_block.name}`;

                  const toolEvent = {
                    type: 'tool_start',
                    tool: streamEvt.content_block.name,
                    id: streamEvt.content_block.id,
                    input: {}
                  };
                  if (onEvent) {
                    onEvent(toolEvent);
                    // Also emit progress on tool_start so UI updates between turns
                    const elapsedMs = Date.now() - progressStartTime;
                    const effectiveMaxTurns = maxTurns || 200;
                    const percentage = Math.min(99, Math.round((turnCount / effectiveMaxTurns) * 100));
                    const avgTurnMs = turnTimestamps.length > 1
                      ? (turnTimestamps[turnTimestamps.length - 1] - turnTimestamps[0]) / (turnTimestamps.length - 1)
                      : elapsedMs || 1;
                    const remainingTurns = effectiveMaxTurns - turnCount;
                    const estimatedRemainingMs = Math.round(avgTurnMs * remainingTurns);
                    onEvent({
                      type: 'progress',
                      turn: turnCount,
                      maxTurns: effectiveMaxTurns,
                      percentage,
                      elapsedMs,
                      estimatedRemainingMs,
                      avgTurnMs: Math.round(avgTurnMs),
                      currentTool: lastToolName,
                      currentAction: lastToolPurpose
                    });
                  }
                  // Track tool use for confidence scoring (roadmap 9.3)
                  toolUseCount++;
                  // Record for reasoning trace (roadmap 9.1)
                  this._recordReasoningEvent(conversationId, 'tool_start', {
                    tool: streamEvt.content_block.name,
                    id: streamEvt.content_block.id
                  });
                }
              }
              // content_block_stop and message_start/stop: lifecycle, ignore
            }
            break;

          case 'result':
            // Capture token usage from result event (include cache tokens for accurate totals)
            if (event.usage) {
              totalInputTokens = (event.usage.input_tokens || 0)
                + (event.usage.cache_creation_input_tokens || 0)
                + (event.usage.cache_read_input_tokens || 0);
              totalOutputTokens = event.usage.output_tokens || 0;
            }
            // Log result events for debugging
            this.logger.info('AgentExecutor', `Result event: subtype=${event.subtype}, cost=${event.total_cost_usd || 'n/a'}, turns=${event.num_turns || 'n/a'}, tokens=${totalInputTokens}in+${totalOutputTokens}out, reason=${event.stop_reason || event.subtype || 'unknown'}`);

            // ZOMBIE GUARD: Start timeout after result event — if process doesn't exit within 30s, kill it
            if (!_zombieTimer) {
              const ZOMBIE_TIMEOUT = 30000;
              _zombieTimer = setTimeout(() => {
                if (claudeProcess && !claudeProcess.killed && !processClosed) {
                  this.logger.warn('AgentExecutor', `Zombie guard: process ${claudeProcess.pid} still alive ${ZOMBIE_TIMEOUT}ms after result event — sending SIGTERM`);
                  try { claudeProcess.kill('SIGTERM'); } catch (_) {}
                  // Fallback SIGKILL after 5s
                  setTimeout(() => {
                    if (!processClosed) {
                      this.logger.warn('AgentExecutor', `Zombie guard: SIGKILL for process ${claudeProcess.pid}`);
                      try { claudeProcess.kill('SIGKILL'); } catch (_) {}
                    }
                  }, 5000);
                }
              }, ZOMBIE_TIMEOUT);
            }

            if (event.subtype === 'success') {
              if (event.result && !fullResponse) {
                fullResponse = event.result;
                if (onEvent) {
                  onEvent({ type: 'text', content: event.result });
                }
              }
              if (event.total_cost_usd) {
                totalCost = event.total_cost_usd;
                duration = event.duration_ms;
                if (onEvent) {
                  onEvent({ type: 'cost', cost: totalCost, duration: duration });
                }
              }
            } else if (event.subtype === 'error_max_turns') {
              // Turn limit hit — treat as success, deliver partial response
              this.logger.warn('AgentExecutor', `Turn limit reached (${event.num_turns || '?'} turns). Treating as complete.`);
              if (event.total_cost_usd) {
                totalCost = event.total_cost_usd;
                duration = event.duration_ms;
              }
              // Don't show error to user — response was already streamed
            } else if (event.subtype === 'error_max_budget_usd') {
              // Budget exceeded — treat as success, don't block the response
              this.logger.warn('AgentExecutor', `Budget exceeded ($${event.total_cost_usd || '?'}). Treating partial response as complete.`);
              if (event.total_cost_usd) {
                totalCost = event.total_cost_usd;
                duration = event.duration_ms;
              }
              // Response was already streamed, just let it complete normally
            } else if (event.subtype === 'error') {
              this.logger.error('AgentExecutor', `Result error: ${event.error || JSON.stringify(event).substring(0, 200)}`);
              // Analyze root cause (roadmap 9.4)
              this._analyzeFailure({
                conversationId,
                agentId: effectiveWorkspaceId,
                workspaceId: effectiveWorkspaceId,
                error: event.error || 'Unknown error',
                selectedModel,
                totalCost,
                duration: Date.now() - startTime,
                retryCount: _retryCount
              }).catch(e => this.logger.warn('AgentExecutor', `Error analysis failed: ${e.message}`));
              if (onEvent) {
                onEvent({ type: 'error', content: event.error });
              }
            }
            break;
        }
      } catch (e) {
        this.logger.warn('AgentExecutor', `Non-JSON output: ${line.substring(0, 100)}`);
      }
    });

    // Accumulate stderr for error reporting (capped at 2KB)
    let stderrAccum = '';
    claudeProcess.stderr.on('data', (data) => {
      const stderrMsg = data.toString();
      if (stderrAccum.length < 2048) {
        stderrAccum += stderrMsg.substring(0, 2048 - stderrAccum.length);
      }
      this.logger.warn('AgentExecutor', `Claude stderr: ${stderrMsg.substring(0, 500)}`);
      if (stderrMsg.length > 500) {
        this.logger.warn('AgentExecutor', `Claude stderr (continued): ${stderrMsg.substring(500, 1000)}`);
      }
    });

    return new Promise((resolve, reject) => {
      let exitCode = null;
      let rlClosed = false;
      let processClosed = false;
      let _zombieTimer = null;

      // Wait for BOTH readline close AND process close before completing.
      // This prevents race condition where process exits before all stdout lines are parsed.
      const tryFinalize = async () => {
        if (!rlClosed || !processClosed) return; // Wait for both

        // Clear zombie guard timer — process exited normally
        if (_zombieTimer) { clearTimeout(_zombieTimer); _zombieTimer = null; }

        this.activeProcesses.delete(conversationId);
        // Unregister from PID registry
        if (this.pidRegistry && claudeProcess && claudeProcess.pid) {
          this.pidRegistry.unregister(claudeProcess.pid);
        }
        // WORKSPACE LOCK RELEASE: Free workspace tracking
        if (this._workspaceLocks.get(effectiveWorkspaceId)?.conversationId === conversationId) {
          this._workspaceLocks.delete(effectiveWorkspaceId);
        }
        // Decrement concurrency counter
        if (this._workspaceConcurrency) {
          const cnt = (this._workspaceConcurrency.get(effectiveWorkspaceId) || 1) - 1;
          if (cnt <= 0) this._workspaceConcurrency.delete(effectiveWorkspaceId);
          else this._workspaceConcurrency.set(effectiveWorkspaceId, cnt);
        }

        // CRITICAL: Kill orphaned child processes (vitest workers, npm, etc.)
        // When Claude CLI exits, its child processes (like vitest workers) can
        // become orphaned (ppid=1) and leak RAM indefinitely. This cleanup
        // kills any remaining processes in the same process group.
        if (claudeProcess && claudeProcess.pid) {
          try {
            // Kill entire process group (negative PID) — catches all descendants
            process.kill(-claudeProcess.pid, 'SIGTERM');
          } catch (e) {
            // ESRCH = no such process (already dead) — this is fine
            if (e.code !== 'ESRCH') {
              this.logger.warn('AgentExecutor', `Failed to cleanup child processes for PID ${claudeProcess.pid}: ${e.message}`);
            }
          }
        }

        const elapsed = Date.now() - startTime;

        if (exitCode === 143 || exitCode === 137) {
          // SIGTERM/SIGKILL — process killed externally (server restart, abort, etc.)

          // SELF-RESTART DETECTION: If Anuki triggered restart itself (launchctl kickstart in response),
          // the job is DONE — don't save for resume (prevents infinite restart→resume loop).
          const selfRestarted = fullResponse.includes('launchctl kickstart') || fullResponse.includes('launchctl kick');
          if (selfRestarted) {
            this.logger.info('AgentExecutor', `Claude process was killed by SELF-RESTART (agent ran launchctl kickstart) — job completed, NOT preserving for resume`);
            this._activeJobs.delete(conversationId);
            this._saveActiveJobs();

            // Still deliver partial response (self-restart — no delegation resume)
            if (fullResponse.trim()) {
              const tagResult = await this._processToolTags(fullResponse, channel, userId, workspaceId, delegationContext, conversationId);
              const finalResponse = (tagResult.cleaned + (tagResult.agentReplies.length > 0 ? tagResult.agentReplies.join('') : '') || fullResponse).trim();

              // PERSIST completion to disk — WS may be closing during gracefulShutdown,
              // so onComplete callback might not reach the UI. New process will pick this up.
              this._savePendingCompletion(conversationId, effectiveWorkspaceId, finalResponse, channel, userId);

              onComplete({
                response: finalResponse,
                sessionId: capturedSessionId,
                cost: totalCost,
                duration: duration,
                confidence: 0.8
              });
            }
            resolve();
            return;
          }

          // Normal SIGTERM (external kill, not self-restart) — preserve for resume
          this.logger.info('AgentExecutor', `Claude process was cancelled (signal ${exitCode === 143 ? 'SIGTERM' : 'SIGKILL'}), preserving job for resume`);

          // Mark job as NOT completed — agent was interrupted, must continue work on resume
          { const _aj = this._activeJobs.get(conversationId); if (_aj) _aj.completed = false; }
          this._saveActiveJobs();

          // Persist session for resume after restart
          if (capturedSessionId) {
            sessionMeta.sessionId = capturedSessionId;
            this.sessions.set(sessionKey, sessionMeta);
            this._saveSessions();
          }

          // If we have partial response, deliver it
          if (fullResponse.trim()) {
            const tagResult = await this._processToolTags(fullResponse, channel, userId, workspaceId, delegationContext, conversationId);
            const cleanedResponse = tagResult.cleaned + (tagResult.agentReplies.length > 0 ? tagResult.agentReplies.join('') : '');
            // Lower confidence for cancelled/partial responses
            const confidenceResult = this._calculateConfidence({
              userMessage,
              fullResponse: (cleanedResponse || fullResponse).trim(),
              toolUseCount,
              toolSuccessCount,
              modelUncertainty: 0.3 // Slightly uncertain since response was cut off
            });
            const reducedConfidence = Math.max(0.3, confidenceResult.confidence * 0.8); // Reduce confidence for partial
            // Store confidence for later retrieval via /api/agents/:id/confidence
            confidenceScores.set(conversationId, {
              ...confidenceResult,
              confidence: reducedConfidence,
              composite: reducedConfidence,
              timestamp: new Date().toISOString()
            });
            onComplete({
              response: (cleanedResponse || fullResponse).trim() + '\n\n_(operation cancelled)_',
              sessionId: capturedSessionId,
              cost: totalCost,
              duration: duration,
              confidence: reducedConfidence,
              hasPendingMessage: this.hasPendingMessages(conversationId)
            });
          } else {
            // Store very low confidence for empty cancelled response
            confidenceScores.set(conversationId, {
              contextRelevance: 0.5,
              toolSuccessRate: 0,
              modelConfidence: 0.2,
              confidence: 0.2,
              composite: 0.2,
              timestamp: new Date().toISOString()
            });
            onComplete({
              response: '_(operation cancelled)_',
              sessionId: capturedSessionId,
              cost: null,
              duration: null,
              confidence: 0.2, // Very low confidence for empty cancelled response
              hasPendingMessage: this.hasPendingMessages(conversationId)
            });
          }

          // FLUSH PENDING QUEUE: Process queued messages even after SIGTERM
          // (only if this is NOT a full server restart — during restart the process is dying)
          if (this.hasPendingMessages(conversationId)) {
            const resumeSessionId = capturedSessionId || effectiveSessionId;
            // Small delay to let the current shutdown/cleanup settle
            setTimeout(() => {
              // Only flush if server is still alive (not in graceful shutdown)
              if (!this._shuttingDown) {
                this._flushPendingQueue(conversationId, resumeSessionId, onEvent, onComplete, onError);
              } else {
                this.logger.info('AgentExecutor', `[QUEUE] Server shutting down — pending messages for ${conversationId} will be processed after restart`);
              }
            }, 500);
          }

          resolve();
          return;
        }

        // Normal completion or error — safe to clear active job
        this._activeJobs.delete(conversationId);
        this._saveActiveJobs(); // Persist immediately

        // Supervisor: record success or failure
        // NOTE: Don't record failure yet if we're going to retry (rate limit).
        // Failure is recorded only after all retries are exhausted.
        if (this.supervisor) {
          if (exitCode === 0) {
            this.supervisor.recordSuccess(effectiveWorkspaceId);
            this.supervisor.unregisterAgent(effectiveWorkspaceId);
          } else {
            const _stderrForCheck = stderrAccum.trim().toLowerCase();
            const _willRetryRateLimit = _stderrForCheck.match(/rate.limit|429|too many requests|overloaded/) && _retryCount < CLI_RATE_LIMIT_MAX_RETRIES;
            const _willRetryOther = this._isRetryableCliError(exitCode, stderrAccum.trim()) && _retryCount < CLI_MAX_RETRIES;
            if (!_willRetryRateLimit && !_willRetryOther) {
              // Final failure — no more retries
              this.supervisor.recordFailure(effectiveWorkspaceId, `exit_code_${exitCode}`);
            }
            this.supervisor.unregisterAgent(effectiveWorkspaceId);
          }
        }

        // Broadcast job-end for Activity Dashboard
        if (this.wsServer && this.wsServer.broadcast) {
          this.wsServer.broadcast({ type: 'job-activity', action: 'end', conversationId, workspaceId: effectiveWorkspaceId, exitCode: exitCode || 0 });
        }

        if (exitCode === 0) {
          this.logger.success('AgentExecutor', `Claude completed (${elapsed}ms, model:${selectedModel}, ${fullResponse.length} chars)`, { requestId });

          // POST-EXECUTION DEPLOY: Delegate to SandboxManager (3-gate validation + soul protection)
          const deployResult = this.sandboxManager.postExecutionDeploy(workspaceDir, wsConfig?.name || effectiveWorkspaceId);
          if (deployResult.deployed) {
            this.logger.info('AgentExecutor', `[SANDBOX-SYNC] Deploy via SandboxManager: OK (gates: ${JSON.stringify(deployResult.gates)})`);
          } else if (deployResult.reason !== 'not-sandbox-persistent') {
            this.logger.error('AgentExecutor', `[SANDBOX-SYNC] Deploy BLOCKED: ${deployResult.reason} (gates: ${JSON.stringify(deployResult.gates)})`);
          }

          // PERFORMANCE PROFILING: Record Claude CLI wait time (roadmap 10.3)
          const claudeWaitTime = Date.now() - claudeWaitStart;
          this.performanceProfiler.recordLatency('claude_wait', claudeWaitTime, {
            conversationId,
            model: selectedModel,
            responseLength: fullResponse.length,
            toolUseCount,
            exitCode
          });

          // Clear resume history on successful completion
          this._clearResumeCount(conversationId);

          // SESSION PERSISTENCE: Save captured session ID for future resume
          if (capturedSessionId) {
            sessionMeta.sessionId = capturedSessionId;
            this.sessions.set(sessionKey, sessionMeta);
            this._saveSessions();
            this.logger.info('AgentExecutor', `Session persisted: ${capturedSessionId} for ${sessionKey}`);
          }

          // Process tool tags and clean response
          const tagResult = await this._processToolTags(fullResponse, channel, userId, workspaceId, delegationContext, conversationId);
          const agentReplies = tagResult.agentReplies || [];

          // MULTI-TURN DELEGATION: If agent sent AGENT_MESSAGE and got replies,
          // resume the agent with the delegation replies so it can make decisions based on them.
          // Agent naturally stops when it no longer emits AGENT_MESSAGE tags.
          if (agentReplies.length > 0 && capturedSessionId) {
            const delegationReply = agentReplies.map(r => r.trim()).join('\n\n');
            this.logger.info('AgentExecutor', `[DELEGATION] ${agentReplies.length} agent reply(s) received — resuming agent ${effectiveWorkspaceId.substring(0, 8)} with delegation results`);

            // Store episode for the delegation exchange
            this._storeEpisode(userMessage, fullResponse, channel, userId, workspaceId);

            // Queue delegation reply as pending message — will resume via --resume with capturedSessionId
            if (!this._pendingMessages.has(conversationId)) {
              this._pendingMessages.set(conversationId, []);
            }
            this._pendingMessages.get(conversationId).push({
              message: `The delegated agent has responded. Continue based on this reply, delegate again if needed:\n\n${delegationReply}`,
              images: [],
              onEvent,
              onComplete,
              onError,
              options: { workspaceId, channel, userId, sessionId: capturedSessionId, delegationContext }
            });

            // Flush pending queue — this calls execute() with --resume
            this._flushPendingQueue(conversationId, capturedSessionId);
            resolve();
            return; // Exit this iteration — pending queue continues the agent
          }

          // No delegation — normal completion path
          const cleanedResponse = tagResult.cleaned;

          // Store episode in cognitive memory
          this._storeEpisode(userMessage, fullResponse, channel, userId, workspaceId);

          // Credential scanning on output
          let safeResponse = (cleanedResponse || fullResponse).trim();
          if (this.security && this.security.scanForCredentials) {
            const scanResult = this.security.scanForCredentials(safeResponse);
            if (scanResult && !scanResult.clean) {
              this.logger.warn('AgentExecutor', `Credentials detected in output, redacting`);
              safeResponse = this.security.redactCredentials(safeResponse);
            }
          }

          // Calculate confidence score (roadmap 9.3)
          const confidenceResult = this._calculateConfidence({
            userMessage,
            fullResponse: safeResponse,
            toolUseCount,
            toolSuccessCount,
            modelUncertainty
          });

          // Store confidence for later retrieval via /api/agents/:id/confidence
          confidenceScores.set(conversationId, {
            ...confidenceResult,
            timestamp: new Date().toISOString()
          });

          // Check if there's a pending message BEFORE calling onComplete
          // so we can tell the WS layer not to send 'done' (user's follow-up is about to start)
          const hasPendingMessage = this._pendingMessages.has(conversationId) &&
            this._pendingMessages.get(conversationId).length > 0;

          // SELF-RESTART SAFETY NET: If this agent triggered a restart (delayed launchctl kickstart),
          // persist the completion to disk. The SIGTERM will arrive in ~1s and kill the WS connection.
          // New process will pick this up and inject into conversation history.
          const isSelfRestartPending = this._selfRestartTriggered && this._selfRestartTriggered.has(conversationId);
          if (isSelfRestartPending && safeResponse) {
            this._savePendingCompletion(conversationId, effectiveWorkspaceId, safeResponse, channel, userId);
            this.logger.info('AgentExecutor', `Self-restart pending — completion persisted for conv ${conversationId}`);
          }

          onComplete({
            response: safeResponse,
            sessionId: capturedSessionId,
            cost: totalCost,
            duration: duration,
            confidence: confidenceResult.confidence,
            hasPendingMessage  // Signal to WS: don't send 'done' if true
          });

          // End trace with success status (roadmap 10.1)
          if (requestId && requestTracer) {
            requestTracer.endTrace(requestId, 'success');
          }

          // Record success stats (roadmap 7.3)
          if (this.agentStats) {
            this.agentStats.record(effectiveWorkspaceId, {
              model: selectedModel,
              cost: totalCost,
              duration: duration || elapsed,
              success: true,
              turns: 0,
              responseLength: safeResponse.length,
              channel: channel,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens
            });
          }

          // Record agent output for OUTPUT popup (per-agent last work tracking)
          if (this.agentOutputs) {
            this.agentOutputs.record(effectiveWorkspaceId, workspace.name, {
              userMessage,
              response: safeResponse,
              channel,
              duration: duration || elapsed,
              model: selectedModel,
              cost: totalCost
            });
          }

          // SAFE-RESTART: Check if a restart was queued while this agent was running
          this._checkAndExecutePendingRestart(conversationId);

          // Record usage for tracking only (budget DISABLED — flat-rate package)
          if (this.usageTracker && totalCost) {
            this.usageTracker.record(totalCost, selectedModel, channel, totalInputTokens, totalOutputTokens);
          }

          // PENDING MESSAGE QUEUE: If user sent a follow-up while we were processing,
          // resume the session with their queued message instead of ending.
          if (hasPendingMessage) {
            const resumeSessionId = capturedSessionId || effectiveSessionId;
            this._flushPendingQueue(conversationId, resumeSessionId, onEvent, onComplete, onError);
          }

          resolve();
        } else {
          // PERFORMANCE PROFILING: Record error (roadmap 10.3)
          const claudeWaitTime = Date.now() - claudeWaitStart;
          this.performanceProfiler.recordLatency('claude_wait', claudeWaitTime, {
            conversationId,
            model: selectedModel,
            exitCode,
            error: true
          });
          this.performanceProfiler.recordError('claude_wait', { conversationId, exitCode });

          // Include stderr context for better error diagnosis
          const stderrHint = stderrAccum.trim();
          if (stderrHint) {
            this.logger.error('AgentExecutor', `Claude exited with code ${exitCode}: ${stderrHint.substring(0, 500)}`);
          } else {
            this.logger.error('AgentExecutor', `Claude exited with code ${exitCode}`);
          }

          // Graceful degradation: retry on transient CLI failure
          if (this._isRetryableCliError(exitCode, stderrHint)) {
            const isRateLimit = (stderrHint || '').toLowerCase().match(/rate.limit|429|too many requests|overloaded/);
            const maxRetries = isRateLimit ? CLI_RATE_LIMIT_MAX_RETRIES : CLI_MAX_RETRIES;

            if (_retryCount < maxRetries) {
              const nextRetry = _retryCount + 1;

              // Rate limit: progressive backoff (5m → 10m → 15m → ... → 30m cap)
              // Other errors: standard 3s delay
              let delayMs, delayLabel;
              if (isRateLimit) {
                delayMs = Math.min(
                  CLI_RATE_LIMIT_BASE_DELAY_MS * nextRetry,  // 5m, 10m, 15m, 20m...
                  CLI_RATE_LIMIT_MAX_DELAY_MS                // cap at 30m
                );
                // Check total elapsed time — give up after 8 hours
                const _rateLimitStartTime = options._rateLimitStartTime || Date.now();
                const totalElapsed = Date.now() - _rateLimitStartTime;
                if (totalElapsed > CLI_RATE_LIMIT_MAX_TOTAL_MS) {
                  this.logger.error('AgentExecutor', `Rate limit retry exhausted after ${Math.round(totalElapsed / 3600000)}h total — giving up`);
                  // Fall through to error handling below
                } else {
                  delayLabel = `${Math.round(delayMs / 60000)}m (rate limit, ${nextRetry}/${maxRetries})`;
                  this.logger.warn('AgentExecutor', `Rate limit hit, waiting ${delayLabel}. Total elapsed: ${Math.round(totalElapsed / 60000)}m`);
                  if (onEvent) {
                    onEvent({ type: 'text', content: `\n\n_(Rate limit — waiting ${Math.round(delayMs / 60000)}m, attempt ${nextRetry}. Total elapsed: ${Math.round(totalElapsed / 60000)}m)_\n` });
                  }
                  this._activeJobs.delete(conversationId);
                  this._saveActiveJobs();
                  await new Promise(r => setTimeout(r, delayMs));
                  try {
                    await this.execute({ ...options, sessionId: null, _forceNewSession: true, _retryCount: nextRetry, _rateLimitStartTime });
                  } catch (retryErr) { /* handled inside recursive call */ }
                  resolve();
                  return;
                }
              } else {
                delayMs = CLI_RETRY_DELAY_MS;
                delayLabel = `${CLI_RETRY_DELAY_MS}ms`;
                this.logger.warn('AgentExecutor', `CLI exited with code ${exitCode} (retryable), attempt ${nextRetry + 1}/${maxRetries + 1} in ${delayLabel}...`);
                if (onEvent) {
                  onEvent({ type: 'text', content: `\n\n_(Error occurred, retrying... attempt ${nextRetry + 1}/${maxRetries + 1})_\n` });
                }
                this._activeJobs.delete(conversationId);
                this._saveActiveJobs();
                await new Promise(r => setTimeout(r, delayMs));
                try {
                  await this.execute({ ...options, sessionId: null, _forceNewSession: true, _retryCount: nextRetry });
                } catch (retryErr) { /* handled inside recursive call */ }
                resolve();
                return;
              }
            }
          }

          // All retries exhausted (or non-retryable error) — report final error
          this._clearResumeCount(conversationId);

          // Invalidate the corrupted session so next message starts fresh
          if (sessionMeta && sessionMeta.sessionId) {
            this.logger.warn('AgentExecutor', `[SESSION] Invalidating corrupted session ${sessionMeta.sessionId} for ${sessionKey} after ${CLI_MAX_RETRIES + 1} failures`);
            sessionMeta.sessionId = null;
            sessionMeta.turnCount = 0;
            this.sessions.set(sessionKey, sessionMeta);
            this._saveSessions();
          }

          // Store very low confidence for error case
          confidenceScores.set(conversationId, {
            contextRelevance: 0.5,
            toolSuccessRate: 0,
            modelConfidence: 0.1,
            confidence: 0.2,
            composite: 0.2,
            timestamp: new Date().toISOString(),
            errorExit: exitCode
          });

          // Build informative error message with stderr context
          let errorMsg = `Claude process failed with code ${exitCode}`;
          if (stderrHint) {
            // Extract first meaningful line from stderr for user-facing message
            const firstLine = stderrHint.split('\n').find(l => l.trim()) || '';
            if (firstLine) {
              errorMsg += `: ${firstLine.substring(0, 200)}`;
            }
          }
          if (_retryCount > 0) {
            errorMsg += ` (${_retryCount + 1} attempts)`;
          }
          const err = new Error(errorMsg);
          if (requestId && requestTracer) {
            requestTracer.endTrace(requestId, 'error');
          }
          onError(err);

          // Analyze root cause of CLI failure (roadmap 9.4)
          this._analyzeFailure({
            conversationId,
            agentId: effectiveWorkspaceId,
            workspaceId: effectiveWorkspaceId,
            error: errorMsg,
            errorCode: exitCode,
            errorContext: stderrHint,
            selectedModel,
            totalCost,
            duration: elapsed,
            retryCount: _retryCount
          }).catch(e => this.logger.warn('AgentExecutor', `Error analysis failed: ${e.message}`));

          // Record failure stats (roadmap 7.3)
          if (this.agentStats) {
            this.agentStats.record(effectiveWorkspaceId, {
              model: selectedModel,
              cost: totalCost,
              duration: elapsed,
              success: false,
              turns: 0,
              responseLength: 0,
              channel: channel,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens
            });
          }

          // Record usage for budget tracking even on failure (roadmap 8.4)
          if (this.usageTracker && totalCost) {
            this.usageTracker.record(totalCost, selectedModel, channel, totalInputTokens, totalOutputTokens);
          }

          // FLUSH PENDING QUEUE: Process queued messages even after error exit
          if (this.hasPendingMessages(conversationId)) {
            const resumeSessionId = capturedSessionId || effectiveSessionId;
            this._flushPendingQueue(conversationId, resumeSessionId, onEvent, onComplete, onError);
          }

          resolve(); // resolve not reject - error already handled via onError callback
        }
      };

      rl.on('close', () => {
        rlClosed = true;
        tryFinalize().catch(e => this.logger.error('AgentExecutor', `tryFinalize error (rl close): ${e.message}`));
      });

      claudeProcess.on('close', (code) => {
        exitCode = code;
        processClosed = true;
        tryFinalize().catch(e => this.logger.error('AgentExecutor', `tryFinalize error (process close): ${e.message}`));
      });

      claudeProcess.on('error', async (error) => {
        this.logger.error('AgentExecutor', 'Process spawn error', error.message);
        this.activeProcesses.delete(conversationId);
        // Unregister from PID registry on error
        if (this.pidRegistry && claudeProcess && claudeProcess.pid) {
          this.pidRegistry.unregister(claudeProcess.pid);
        }
        // Supervisor: record spawn error
        if (this.supervisor) {
          this.supervisor.recordFailure(effectiveWorkspaceId, `spawn_error: ${error.message}`);
          this.supervisor.unregisterAgent(effectiveWorkspaceId);
        }
        // WORKSPACE LOCK RELEASE on error
        if (this._workspaceLocks.get(effectiveWorkspaceId)?.conversationId === conversationId) {
          this._workspaceLocks.delete(effectiveWorkspaceId);
        }
        if (this._workspaceConcurrency) {
          const cnt = (this._workspaceConcurrency.get(effectiveWorkspaceId) || 1) - 1;
          if (cnt <= 0) this._workspaceConcurrency.delete(effectiveWorkspaceId);
          else this._workspaceConcurrency.set(effectiveWorkspaceId, cnt);
        }
        this._activeJobs.delete(conversationId);
        this._saveActiveJobs();

        // Broadcast job-end (spawn error) for Activity Dashboard
        if (this.wsServer && this.wsServer.broadcast) {
          this.wsServer.broadcast({ type: 'job-activity', action: 'end', conversationId, workspaceId: effectiveWorkspaceId, exitCode: 1 });
        }

        // Spawn errors: ENOENT (binary missing) and EACCES (permission) are NOT retryable.
        // EPIPE, ECONNRESET, etc. could be transient — check via _isRetryableCliError.
        const spawnRetryable = this._isRetryableCliError(1, error.message);
        if (_retryCount < CLI_MAX_RETRIES && spawnRetryable) {
          const nextRetry = _retryCount + 1;
          const totalAttempts = CLI_MAX_RETRIES + 1;
          this.logger.warn('AgentExecutor', `CLI spawn failed (retryable), attempt ${nextRetry + 1}/${totalAttempts} in ${CLI_RETRY_DELAY_MS}ms...`);
          if (onEvent) {
            onEvent({ type: 'text', content: `\n\n_(Error occurred, retrying... attempt ${nextRetry + 1}/${totalAttempts})_\n` });
          }
          await new Promise(r => setTimeout(r, CLI_RETRY_DELAY_MS));
          try {
            await this.execute({ ...options, sessionId: null, _retryCount: nextRetry });
          } catch (retryErr) {
            // Retry also failed — error already handled inside recursive call
          }
          resolve();
          return;
        }

        // Non-retryable or retries exhausted
        // Store very low confidence for spawn error case
        confidenceScores.set(conversationId, {
          contextRelevance: 0.5,
          toolSuccessRate: 0,
          modelConfidence: 0.0,
          confidence: 0.1,
          composite: 0.1,
          timestamp: new Date().toISOString(),
          spawnError: true
        });

        if (_retryCount > 0) {
          error = new Error(`${error.message} (${_retryCount + 1} attempts)`);
        }
        if (requestId && requestTracer) {
          requestTracer.endTrace(requestId, 'error');
        }
        onError(error);

        // Analyze root cause of spawn error (roadmap 9.4)
        this._analyzeFailure({
          conversationId,
          agentId: effectiveWorkspaceId,
          workspaceId: effectiveWorkspaceId,
          error: error.message,
          errorCode: null,
          errorContext: error.code || 'spawn',
          selectedModel,
          totalCost,
          duration: Date.now() - startTime,
          retryCount: _retryCount
        }).catch(e => this.logger.warn('AgentExecutor', `Error analysis failed: ${e.message}`));

        resolve(); // resolve not reject - error already handled via onError callback
      });
    });
  }

  // ═══════════════════════════════════════════════════════════
  // SOUL FILE CACHING (from Gateway handler.js)
  // ═══════════════════════════════════════════════════════════

  _loadSoulFilesCached(workspaceId) {
    const cacheKey = `soul_${workspaceId}`;
    const cached = soulCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < SOUL_CACHE_TTL) {
      return cached.content;
    }

    const soulFiles = this.workspaceManager.loadSoulFiles(workspaceId);

    // Pass through soul files (skip non-string metadata like _thinkingEnabled)
    // No truncation — soul files are critical and Claude context (200K) can handle them
    const cleaned = {};
    for (const [key, value] of Object.entries(soulFiles)) {
      cleaned[key] = value;
    }

    soulCache.set(cacheKey, { content: cleaned, timestamp: Date.now() });
    return cleaned;
  }

  // ═══════════════════════════════════════════════════════════
  // BUILD DYNAMIC AGENT REGISTRY (Runtime injection for cross-agent awareness)
  // ═══════════════════════════════════════════════════════════

  _buildAgentRegistry(currentAgentId) {
    if (!this.agentManager) return null;
    const agents = this.agentManager.listAgents();
    if (!agents || agents.length === 0) return null;

    const rows = agents.map(a => {
      const isSelf = (a.id === currentAgentId) ||
        (a.isMaster && currentAgentId === '7ff9447e-3e86-4f38-8129-43fadfff4986');
      const name = a.name || a.id;
      const idShort = (a.id || '').substring(0, 12);

      // Extract role/description compactly
      let role = '';
      if (a.capabilities?.description) {
        role = (a.capabilities.description.split('—')[1] || a.capabilities.description).trim().substring(0, 60);
      } else if (a.interests?.areas) {
        role = a.interests.areas.substring(0, 60);
      }

      // Compact skills
      let skills = '';
      if (Array.isArray(a.capabilities?.skillsSimple)) {
        skills = a.capabilities.skillsSimple.slice(0, 3).join(', ');
      } else if (Array.isArray(a.capabilities)) {
        skills = a.capabilities.slice(0, 3).join(', ');
      }

      const selfMark = isSelf ? ' (you)' : '';
      return `| ${name}${selfMark} | ${idShort} | ${role} |`;
    });

    return `=== ACTIVE AGENTS (auto-discovered) ===
All agents in the ecosystem — you can message them by name:
| Agent | ID | Role |
|-------|-----|------|
${rows.join('\n')}

To send a message: [AGENT_MESSAGE:agentName:message:timeout]
Example: [AGENT_MESSAGE:ENKI:research this topic:90]`;
  }

  // ═══════════════════════════════════════════════════════════
  // CONTEXT-ONLY PROMPT (for resumed sessions — saves ~93% tokens)
  // Only sends: date, channel, fresh memories, active reminders
  // ═══════════════════════════════════════════════════════════

  _buildContextOnlyPrompt(userMessage, channel, userId, isGroup, soulFiles = {}, workspace = null) {
    const sections = [];

    // IDENTITY ANCHOR — agent-specific, read from soul files
    // Use IDENTITY + SOUL from soul files as identity anchor
    const identityParts = [];
    if (soulFiles['IDENTITY.md']) {
      identityParts.push(soulFiles['IDENTITY.md']);
    }
    if (soulFiles['SOUL.md']) {
      identityParts.push(soulFiles['SOUL.md']);
    }
    if (identityParts.length > 0) {
      sections.push(identityParts.join('\n\n'));
    } else {
      sections.push(`You are ${workspace?.name || 'an AI assistant'}. Focus on your assigned role.`);
    }

    // Runtime context (always needed — date changes, channel may differ)
    sections.push(`Date: ${new Date().toISOString()}
Channel: ${channel}
User: ${userId}`);

    // AGENTS.md — Critical rules (sync, no questions, etc.) — MUST be in resume!
    if (soulFiles['AGENTS.md']) {
      sections.push('OPERATION RULES:\n' + soulFiles['AGENTS.md']);
    }

    // Dynamic agent registry (runtime injection) — enables cross-agent awareness
    const agentRegistry = this._buildAgentRegistry(workspace?.id);
    if (agentRegistry) {
      sections.push(agentRegistry);
    }

    // TOOLS.md — Available tools (including AGENT_MESSAGE) — MUST be in resume!
    if (soulFiles['TOOLS.md']) {
      sections.push('YOUR TOOLS:\n' + soulFiles['TOOLS.md']);
    } else {
      // Fallback tool tags if TOOLS.md missing
      sections.push(`YOUR TOOLS:
- [REMINDER:duration:message] — Set a reminder (e.g., [REMINDER:5m:Meeting], [REMINDER:1h:Check])
- [MEMORY_STORE:semantic:content] — Save important information
- [MEMORY_STORE:procedural:content] — Save a learned skill
- [AGENT_CREATE:AgentName:skills:personality] — Create a new agent (PROPOSE TO USER FIRST, USE ONLY AFTER APPROVAL)
- [TASK_PLAN:task description] — Break complex task into subtasks, assign to appropriate agents
- [SHARED_CONTEXT:namespaceId:key:value] — Share information with other agents in a shared task
- [SHARED_CONTEXT_GET:namespaceId] — Read shared information from a shared task
Include these tags in your response — the system extracts them automatically.`);
    }

    // MISSION.md — Agent mission MUST persist through resume (prevents mission loss)
    if (soulFiles['MISSION.md']) {
      sections.push('=== MISSION ===\n' + soulFiles['MISSION.md']);
    }

    // PROMPT_PROFILE.md — Agent-specific prompt style & constraints
    if (soulFiles['PROMPT_PROFILE.md']) {
      sections.push('=== PROMPT PROFILE ===\n' + soulFiles['PROMPT_PROFILE.md']);
    }

    // SAFETY.md — SSOT rules MUST be in every prompt including context-only resume
    if (soulFiles['SAFETY.md']) {
      sections.push('=== SAFETY RULES ===\n' + soulFiles['SAFETY.md']);
    }

    // CODE_PROTOCOL.md — Must ALWAYS be in context (prevents code-breaking on resume)
    if (soulFiles['CODE_PROTOCOL.md']) {
      sections.push('=== CODE PROTOCOL ===\n' + soulFiles['CODE_PROTOCOL.md']);
    } else {
      // Hardcoded fallback — critical rules that can never be lost even if soul file is missing
      sections.push(`=== CODE CHANGE RULES (MANDATORY) ===
6 MANDATORY STEPS BEFORE CHANGING CODE:
1. RESEARCH: Read ALL relevant files completely (Read tool). No assumptions.
2. PLAN: List affected files, evaluate side effects.
3. CODE: Write consistent with existing style. Verify every variable name — is it defined?
4. VERIFY: Re-read the changed file. Syntax check: node -c file.js
5. TEST: curl localhost:3000/api/health + test relevant endpoints.
6. CLEANUP: Remove test files, temp files, debug code.

CERTAINTY PRINCIPLE:
- Never ask questions — instead research, test, verify
- "I'm not sure" is NOT an excuse — keep working until you are sure
- Every uncertainty has an answer — find it YOURSELF

NEVER DO:
- Change files without reading them first
- Restart without testing
- Use undefined variables
- Say "it probably works" — BE CERTAIN
- Ask questions when uncertain — research instead`);
    }

    // Fresh contextual memories (workspace-specific)
    // TOKEN SAVER: Skip memory retrieval for cron (self-improve) channel
    if (channel !== 'cron') {
      const memory = workspace ? this._getMemoryForWorkspace(workspace.id) : null;
      if (memory) {
        const coreMemory = memory.getCoreMemory();
        if (coreMemory) {
          // Increased from 2000 to 10000 — critical rules are at the end of MEMORY.md
          sections.push('CORE MEMORY:\n' + coreMemory.substring(0, 10000));
        }
        try {
          const memories = memory.getContextualMemories(userMessage);
          if (memories && memories.relevant && memories.relevant.length > 0) {
            const memoryText = memories.relevant
              .slice(0, 3)
              .map(m => `- [${m.type}] ${(m.content || '').substring(0, 100)}`)
              .join('\n');
            sections.push('RELEVANT MEMORIES:\n' + memoryText);
          }
        } catch (e) { /* skip */ }
      }
    }

    // Active reminders
    if (this.storage && this.storage.getReminders) {
      try {
        const reminders = this.storage.getReminders(userId);
        if (reminders && reminders.length > 0) {
          const remText = reminders.map(r => `- ${r.text} (${new Date(r.triggerTime).toISOString()})`).join('\n');
          sections.push('ACTIVE REMINDERS:\n' + remText);
        }
      } catch (e) { /* skip */ }
    }

    if (isGroup) {
      sections.push('NOTE: Do not share confidential information in group chats.');
    }

    return sections.join('\n\n');
  }

  // ═══════════════════════════════════════════════════════════
  // FULL SYSTEM PROMPT (OpenClaw-style with all bootstrap files + memory)
  // ═══════════════════════════════════════════════════════════

  _buildFullSystemPrompt(soulFiles, userMessage, channel, userId, isGroup = false, workspace = null) {
    const sections = [];

    // === IDENTITY (Bootstrap file) ===
    if (soulFiles['IDENTITY.md']) {
      sections.push('=== IDENTITY ===\n' + soulFiles['IDENTITY.md']);
    }

    // === SOUL (Personality & behavior) ===
    if (soulFiles['SOUL.md']) {
      sections.push('=== PERSONALITY (SOUL) ===\n' + soulFiles['SOUL.md']);
      sections.push('Embody this personality fully. Avoid robotic, generic responses.');
    }

    // === AGENTS (Operation rules) ===
    if (soulFiles['AGENTS.md']) {
      sections.push('=== OPERATION RULES (AGENTS) ===\n' + soulFiles['AGENTS.md']);
    }

    // Dynamic agent registry (runtime injection) — enables cross-agent awareness
    const agentRegistry = this._buildAgentRegistry(workspace?.id);
    if (agentRegistry) {
      sections.push(agentRegistry);
    }

    // === USER (User profile) ===
    if (soulFiles['USER.md']) {
      sections.push('=== USER PROFILE ===\n' + soulFiles['USER.md']);
    }

    // === SAFETY ===
    if (soulFiles['SAFETY.md']) {
      sections.push('=== SAFETY RULES ===\n' + soulFiles['SAFETY.md']);
    }

    // === CODE PROTOCOL (prevents code-breaking — always injected) ===
    if (soulFiles['CODE_PROTOCOL.md']) {
      sections.push('=== KOD DEGISIKLIK PROTOKOLU ===\n' + soulFiles['CODE_PROTOCOL.md']);
    }

    // === TOOLS (Tool usage guide) ===
    if (soulFiles['TOOLS.md']) {
      sections.push('=== ARAC KILAVUZU ===\n' + soulFiles['TOOLS.md']);
    }

    // === HEARTBEAT ===
    if (soulFiles['HEARTBEAT.md']) {
      sections.push('=== HEARTBEAT ===\n' + soulFiles['HEARTBEAT.md']);
    }

    // === MISSION (Self-improvement & self-knowledge) ===
    if (soulFiles['MISSION.md']) {
      sections.push('=== MISSION ===\n' + soulFiles['MISSION.md']);
    }

    // === PROMPT PROFILE (Agent-specific prompt style & constraints) ===
    if (soulFiles['PROMPT_PROFILE.md']) {
      sections.push('=== PROMPT PROFILE ===\n' + soulFiles['PROMPT_PROFILE.md']);
    }

    // === TOOL TAGS (OpenClaw memory management) ===
    // TOKEN SAVER: Skip memory tools + agent creation protocol for self-improve (cron) channel
    // These are only useful for interactive user conversations, not autonomous cycles
    if (channel !== 'cron') {
      sections.push(`=== MEMORY TOOLS ===
You can use these special tags in your responses to manage memory:
- [MEMORY_STORE:semantic:content] — Save important information
- [MEMORY_STORE:procedural:content] — Save a learned skill
- [MEMORY_SEARCH:query] — Search memory for relevant information
- [MEMORY_FORGET:description] — Forget a specific memory
- [CORE_UPDATE:section:content] — Update a section in MEMORY.md
- [REMINDER:duration:message] — Set a reminder (e.g., [REMINDER:1h:Check meeting])
- [AGENT_CREATE:AgentName:skills:personality] — Create a new agent
- [TASK_PLAN:task description] — Break complex task into subtasks, assign to appropriate agents, merge results
- [SHARED_CONTEXT:namespaceId:key:value] — Share information with other agents in a shared task (key-value fact)
- [SHARED_CONTEXT_GET:namespaceId] — Read all shared information from a shared task

=== AGENT AUTO-CREATION PROTOCOL ===
When the user implies they want a new agent (example patterns):
- "I need a code reviewer"
- "Can you create an agent for..."
- "I need an assistant for..."

READY-MADE TEMPLATES (auto-matched, creates rich profiles):
- code-reviewer: Code review, refactoring, security analysis
- researcher: Research, data analysis, reporting
- writer: Content creation, copywriting, editing
- translator: Translation, localization, cultural adaptation
- data-analyst: Data analysis, statistics, SQL, visualization
- crypto-analyst: Token analysis, chart reading, on-chain analysis, DeFi
If skills don't match a template, a general profile is created.

MANDATORY STEPS:
1. PROPOSE FIRST (DON'T USE AGENT_CREATE YET):
   - Summarize the agent's name, skills, and personality
   - If a template matches, mention it: "I'll create a rich profile using the code-reviewer template"
   - Example: "I can create CodeReviewer — an expert in code review and refactoring, with a professional style (code-reviewer template). Shall I proceed?"
2. IF USER APPROVES ("yes", "ok", "sure", "create", "go ahead"):
   - Use the [AGENT_CREATE:AgentName:skills:personality] tag
3. IF USER REQUESTS CHANGES:
   - Update the proposal accordingly, ask again
4. IF USER DECLINES:
   - "OK, not creating it"

Personality options: professional, friendly, humorous, concise, detailed
Example: [AGENT_CREATE:CodeReviewer:code review, refactoring, best practices:professional]
NEVER use AGENT_CREATE without user approval — don't surprise users with unexpected agents.`);
    }

    // === CONTEXT (Runtime metadata) ===
    sections.push(`=== CONTEXT ===
Date: ${new Date().toISOString()}
Channel: ${channel}
User: ${userId}
Platform: ${process.platform}`);

    // === CORE MEMORY (MEMORY.md - workspace-specific) ===
    // TOKEN SAVER: Skip memory retrieval for cron (self-improve) channel — agents read their own files
    if (workspace && channel !== 'cron') {
      const memory = this._getMemoryForWorkspace(workspace.id);
      if (memory) {
        const coreMemory = memory.getCoreMemory();
        if (coreMemory) {
          sections.push('=== CORE MEMORY (MEMORY.md) ===\n' + coreMemory);
        }

        // === CONTEXTUAL MEMORIES (retrieved by relevance) ===
        try {
          const memories = memory.getContextualMemories(userMessage);
          if (memories && memories.relevant && memories.relevant.length > 0) {
            const memoryText = memories.relevant
              .slice(0, 5)
              .map(m => `- [${m.type}] ${m.content || m.input || ''} (importance: ${m.importance})`)
              .join('\n');
            sections.push('=== RELEVANT MEMORIES ===\n' + memoryText);
          }

          // === APPLICABLE PROCEDURES ===
          if (memories && memories.procedures && memories.procedures.length > 0) {
            const procText = memories.procedures
              .slice(0, 3)
              .map(p => `- ${p.name}: ${p.description}`)
              .join('\n');
            sections.push('=== RELEVANT SKILLS ===\n' + procText);
          }
        } catch (e) {
          this.logger.warn('AgentExecutor', `Memory retrieval error: ${e.message}`);
        }

        // === CROSS-CHANNEL CONTEXT ===
        if (channel && userId && !isGroup && memory.loadCrossChannelContext) {
          try {
            const crossCtx = memory.loadCrossChannelContext(channel, userId);
            if (crossCtx && crossCtx.length > 0) {
              const ctxText = crossCtx.map(ctx =>
                '[' + ctx.channel + '] Last activity: ' + ctx.lastActivity + ', ' + ctx.messageCount + ' messages' +
                (ctx.recentTopics && ctx.recentTopics.length > 0 ? '\n  Recent topics: ' + ctx.recentTopics.join(' | ') : '')
              ).join('\n');
              sections.push('=== CROSS-CHANNEL CONTEXT ===\n' + ctxText);
            }
          } catch (e) {
            // Cross-channel context not available, skip
          }
        }
      }
    }

    // === REMINDERS ===
    if (this.storage && this.storage.getReminders) {
      try {
        const reminders = this.storage.getReminders(userId);
        if (reminders && reminders.length > 0) {
          const remText = reminders.map(r => `- ${r.text} (${new Date(r.triggerTime).toISOString()})`).join('\n');
          sections.push('=== ACTIVE REMINDERS ===\n' + remText);
        }
      } catch (e) {
        // No reminders or method not available
      }
    }

    // === MEMORY MANAGEMENT INSTRUCTIONS ===
    sections.push(`=== MEMORY MANAGEMENT ===
When you learn important information, save it to memory automatically.
If the user says "remember", "save", or "forget", act accordingly.
ALWAYS save user preferences, decisions, and important information.`);

    // === RULES ===
    sections.push(`=== RULES ===
- Maintain context using previous messages and memory
- Give concise and clear responses
- Use web search, file read/write, and command execution when needed` +
      (isGroup ? '\n- In groups: Do NOT share personal information, keep it private\n- In groups: Keep responses short and clear' : ''));

    return sections.join('\n\n');
  }

  // ═══════════════════════════════════════════════════════════
  // LEGACY PROMPT BUILDER (kept for compatibility)
  // ═══════════════════════════════════════════════════════════

  _buildSystemPrompt(soulFiles) {
    // Legacy method: assume default workspace
    const defaultWs = this.workspaceManager.getDefaultWorkspace();
    return this._buildFullSystemPrompt(soulFiles, '', 'webchat', 'default', false, defaultWs);
  }

  // ═══════════════════════════════════════════════════════════
  // TOOL TAG PROCESSING
  // Returns cleaned response with tags stripped
  // ═══════════════════════════════════════════════════════════

  async _processToolTags(response, channel, userId, workspaceId = null, delegationContext = null, conversationId = null) {
    // Get workspace-specific memory (may be null — tag processing still continues)
    const memory = workspaceId ? this._getMemoryForWorkspace(workspaceId) : null;

    let cleaned = response;

    // [REMINDER:time:message]
    const reminderRegex = /\[REMINDER:([^:]+):([^\]]+)\]/gi;
    let match;
    while ((match = reminderRegex.exec(response)) !== null) {
      const timeStr = match[1].trim();
      const reminderText = match[2].trim();

      let seconds = parseInt(timeStr);
      if (isNaN(seconds)) {
        seconds = this._parseTimeExpression(timeStr);
      }

      if (seconds > 0 && this.storage && this.storage.addReminder) {
        const reminderTime = new Date(Date.now() + seconds * 1000);
        this.storage.addReminder(userId, reminderText, reminderTime.toISOString(), channel);
        this.logger.info('ToolTag', `Reminder set: "${reminderText}" in ${seconds}s for ${userId}`);
      }

      cleaned = cleaned.replace(match[0], '');
    }

    // [MEMORY_STORE:type:content] — requires memory
    if (memory) {
      const storeRegex = /\[MEMORY_STORE:(semantic|procedural):([^\]]+)\]/gi;
      while ((match = storeRegex.exec(response)) !== null) {
        const [, type, content] = match;
        if (type === 'semantic') {
          memory.storeSemantic({ content, importance: 7, source: 'agent_auto', tags: ['auto_stored'] });
          this.logger.info('ToolTag', `[${workspaceId.substring(0, 8)}] Stored semantic: ${content.substring(0, 60)}`);
        } else if (type === 'procedural') {
          memory.storeProcedural({ content, importance: 7, source: 'agent_auto', tags: ['auto_stored'] });
          this.logger.info('ToolTag', `[${workspaceId.substring(0, 8)}] Stored procedural: ${content.substring(0, 60)}`);
        }
        cleaned = cleaned.replace(match[0], '');
      }

      // [MEMORY_SEARCH:query] — requires memory
      const searchRegex = /\[MEMORY_SEARCH:([^\]]+)\]/gi;
      while ((match = searchRegex.exec(response)) !== null) {
        const query = match[1].trim();
        const results = memory.search(query, { maxResults: 3 });
        if (results.length > 0) {
          const resultText = results.map((r, i) =>
            (i + 1) + '. [' + r.type + '] ' + (r.content || '').substring(0, 100)
          ).join('\n');
          this.logger.info('ToolTag', `[${workspaceId.substring(0, 8)}] Memory search: "${query}" -> ${results.length} results`);
          cleaned = cleaned.replace(match[0], '\nMemory search ("' + query + '"):\n' + resultText + '\n');
        } else {
          cleaned = cleaned.replace(match[0], '');
        }
      }

      // [MEMORY_FORGET:description] — requires memory
      const forgetRegex = /\[MEMORY_FORGET:([^\]]+)\]/gi;
      while ((match = forgetRegex.exec(response)) !== null) {
        const description = match[1].trim();
        const results = memory.search(description, { maxResults: 1 });
        if (results.length > 0 && results[0].id && memory.executeMemoryTool) {
          memory.executeMemoryTool('memory_forget', { memoryId: results[0].id, reason: 'Agent unuttu: ' + description });
          this.logger.info('ToolTag', `[${workspaceId.substring(0, 8)}] Memory forgotten: "${description}"`);
        }
        cleaned = cleaned.replace(match[0], '');
      }
    } else {
      // Strip memory tags even without memory (don't show raw tags to user)
      cleaned = cleaned.replace(/\[MEMORY_STORE:[^\]]+\]/gi, '');
      cleaned = cleaned.replace(/\[MEMORY_SEARCH:[^\]]+\]/gi, '');
      cleaned = cleaned.replace(/\[MEMORY_FORGET:[^\]]+\]/gi, '');
    }

    // [CORE_UPDATE:section:content] — write directly to workspace MEMORY.md
    const coreRegex = /\[CORE_UPDATE:([^:]+):([^\]]+)\]/gi;
    while ((match = coreRegex.exec(response)) !== null) {
      const [, section, content] = match;
      try {
        if (!workspaceId) { cleaned = cleaned.replace(match[0], ''); continue; }
        const workspacePath = this.workspaceManager.getWorkspacePath(workspaceId);
        const memoryPath = path.join(workspacePath, 'MEMORY.md');
        let existing = '';
        if (fs.existsSync(memoryPath)) {
          existing = fs.readFileSync(memoryPath, 'utf8');
        }
        const sectionHeader = '## ' + section;
        const sectionRegex = new RegExp('## ' + section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n[\\s\\S]*?(?=\\n## |$)', 'i');
        if (sectionRegex.test(existing)) {
          existing = existing.replace(sectionRegex, sectionHeader + '\n' + content);
        } else {
          existing = existing.trimEnd() + '\n\n' + sectionHeader + '\n' + content + '\n';
        }
        fs.writeFileSync(memoryPath, existing);
        this.logger.info('ToolTag', `Core updated: [${sanitizeForLog(section, 30)}] ${sanitizeForLog(content, 60)}`);
      } catch (e) {
        this.logger.error('ToolTag', 'Core update error: ' + e.message);
      }
      cleaned = cleaned.replace(match[0], '');
    }

    // [AGENT_MESSAGE:targetAgentId:message:timeout] — Inter-agent communication
    // Strict regex: target must start with letter/digit, then alphanumeric/hyphen/underscore/dot (2-50 chars)
    // Scans codeBlockSafe (code blocks stripped) to prevent false positives
    const agentMsgRegex = /\[AGENT_MESSAGE:([a-zA-Z0-9][a-zA-Z0-9_.-]{1,49}):([^:\]]{2,})(?::(\d+))?\]/gi;
    const agentReplies = []; // Collect replies to append to response

    // Strip code blocks BEFORE matching AGENT_MESSAGE tags to prevent false positives.
    // Agent responses may contain code examples, documentation, or markdown that includes
    // [AGENT_MESSAGE:...] as illustration — these must NOT be executed.
    // Replace fenced (```...```) and inline (`...`) code with same-length spaces
    // so match positions stay aligned with the original `cleaned` string.
    const codeBlockSafe = cleaned
      .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))  // fenced code blocks
      .replace(/`[^`]+`/g, (m) => ' '.repeat(m.length));          // inline code

    while ((match = agentMsgRegex.exec(codeBlockSafe)) !== null) {
      const targetAgentId = match[1].trim();
      const message = match[2].trim();
      const timeout = match[3] ? parseInt(match[3]) : 300;

      // Extract the original tag from `cleaned` at the same position
      const originalTag = cleaned.substring(match.index, match.index + match[0].length);

      // Validate target agent ID format: must start with letter or digit, 2-50 chars total
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,49}$/.test(targetAgentId)) {
        this.logger.info('ToolTag', `Skipping invalid agent ID format: "${sanitizeForLog(targetAgentId, 50)}"`);
        cleaned = cleaned.replace(originalTag, '');
        continue;
      }

      // Prevent self-messaging loop (3 layers of protection):
      // Layer 1: Direct string comparison (fastest path)
      if (targetAgentId === workspaceId) {
        this.logger.info('ToolTag', `Skipping self-message (direct match): ${sanitizeForLog(targetAgentId, 50)}`);
        cleaned = cleaned.replace(originalTag, '');
        continue;
      }
      // Layer 2: Alias resolution via agentManager (catches name/UUID/alias matches)
      if (this.agentManager) {
        const resolvedTarget = this.agentManager.getAgent(targetAgentId);
        const resolvedSelf = this.agentManager.getAgent(workspaceId);
        if (resolvedTarget && resolvedSelf && resolvedTarget.id === resolvedSelf.id) {
          this.logger.info('ToolTag', `Skipping self-message (alias): ${sanitizeForLog(targetAgentId, 50)} → same as ${workspaceId.substring(0, 8)}`);
          cleaned = cleaned.replace(originalTag, '');
          continue;
        }
      } else {
        // Layer 3: Fallback when agentManager unavailable — check known master aliases
        const MASTER_UUID = 'default-master';
        const masterAliases = ['master', 'anuki', MASTER_UUID];
        const targetLower = targetAgentId.toLowerCase();
        const selfLower = (workspaceId || '').toLowerCase();
        if (masterAliases.includes(targetLower) && masterAliases.includes(selfLower)) {
          this.logger.info('ToolTag', `Skipping self-message (fallback): ${sanitizeForLog(targetAgentId, 50)}`);
          cleaned = cleaned.replace(originalTag, '');
          continue;
        }
      }

      const delegationInfo = delegationContext ? ` (delegation depth: ${delegationContext.chainDepth}, chain: ${delegationContext.chainPath.map(id => id.substring(0, 8)).join('→')})` : '';
      this.logger.info('ToolTag', `AGENT_MESSAGE tag detected: ${sanitizeForLog(targetAgentId, 50)} / message: "${sanitizeForLog(message, 100)}" / timeout: ${timeout}${delegationInfo}`);

      if (this.messageRouter && workspaceId) {
        // Early validation: check if target agent exists before sending
        const targetAgent = this.agentManager?.getAgent(targetAgentId);
        if (!targetAgent) {
          const safeTarget = sanitizeForLog(targetAgentId, 50);
          const availableAgents = (this.agentManager?.listAgents() || [])
            .map(a => `${a.name}(${(a.id || '').substring(0, 8)})`)
            .join(', ');
          this.logger.warn('ToolTag', `[${workspaceId.substring(0, 8)}] Agent not found: "${safeTarget}". Available: [${availableAgents}]`);
          agentReplies.push(`\n\n**Error:** Agent "${safeTarget}" not found. Available agents: ${availableAgents}`);
          cleaned = cleaned.replace(originalTag, '');
          continue;
        }

        try {
          // AWAIT the reply (blocking mode)
          // Pass delegation context so child agents inherit the chain (roadmap 5.4)
          const result = await this.messageRouter.sendMessage({
            from: workspaceId,
            to: targetAgentId,
            message: message,
            timeout: timeout,
            conversationId: null,
            delegation: delegationContext || null,
            parentConversationId: conversationId  // Link child job to parent for restart resume
          });

          this.logger.info('ToolTag', `[${workspaceId.substring(0, 8)}] Agent message sent: ${workspaceId.substring(0, 8)} → ${sanitizeForLog(targetAgentId, 50)}: "${sanitizeForLog(message, 100)}"`);

          if (result.reply) {
            this.logger.info('ToolTag', `[${workspaceId.substring(0, 8)}] Agent reply received: ${sanitizeForLog(result.reply, 200)}`);
            // Collect reply to show user
            agentReplies.push(`\n\n**Reply (${targetAgent.name || targetAgentId}):**\n${result.reply}`);
          }
        } catch (err) {
          this.logger.warn('ToolTag', `[${workspaceId.substring(0, 8)}] Agent message failed: ${sanitizeForLog(err.message, 200)}`);
          // Show error to user — sanitize targetAgentId to prevent markdown injection
          const safeTarget = sanitizeForLog(targetAgentId, 50);
          const safeErr = sanitizeForLog(err.message, 200);
          agentReplies.push(`\n\n**Error:** Failed to send message to ${safeTarget}: ${safeErr}`);
        }
      } else {
        this.logger.warn('ToolTag', 'MessageRouter not available or workspaceId missing, skipping agent message');
        agentReplies.push(`\n\n**Error:** MessageRouter not available`);
      }

      cleaned = cleaned.replace(originalTag, '');
    }

    // [TASK_PLAN:description] — Multi-agent task planning (roadmap 5.3)
    // Decomposes a complex task into subtasks, assigns to best-fit agents, executes, synthesizes results
    // Strip code blocks to prevent false positives (same approach as AGENT_MESSAGE)
    const taskPlanSafe = cleaned
      .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
      .replace(/`[^`]+`/g, (m) => ' '.repeat(m.length));

    const taskPlanRegex = /\[TASK_PLAN:([^\]]{5,500})\]/gi;
    while ((match = taskPlanRegex.exec(taskPlanSafe)) !== null) {
      const taskDescription = match[1].trim();
      const originalTaskTag = cleaned.substring(match.index, match.index + match[0].length);

      this.logger.info('ToolTag', `TASK_PLAN tag detected: "${sanitizeForLog(taskDescription, 100)}"`);

      if (this.taskPlanner) {
        try {
          const result = await this.taskPlanner.planAndExecute(taskDescription, {
            fromAgentId: workspaceId || 'master',
            timeout: 60,
            parentConversationId: conversationId  // Link child jobs to parent for restart resume
          });

          if (result.status === 'no_subtasks') {
            agentReplies.push(`\n\n**Task Plan:** Task could not be decomposed into subtasks — processing as a single task.`);
          } else if (result.synthesis) {
            agentReplies.push(`\n\n${result.synthesis.summary}`);
          }

          this.logger.info('ToolTag', `TASK_PLAN completed: ${result.subtasks?.length || 0} subtasks, status=${result.status}`);
        } catch (err) {
          this.logger.error('ToolTag', `TASK_PLAN failed: ${sanitizeForLog(err.message, 200)}`);
          agentReplies.push(`\n\n**Task Plan Error:** ${sanitizeForLog(err.message, 200)}`);
        }
      } else {
        this.logger.warn('ToolTag', 'TASK_PLAN: TaskPlanner not available');
        agentReplies.push(`\n\n**Error:** TaskPlanner not available`);
      }

      cleaned = cleaned.replace(originalTaskTag, '');
    }

    // [SUBGOAL_PROPOSE:description:successCriteria] — Propose new subgoal during task execution (roadmap 9.5)
    // Format: [SUBGOAL_PROPOSE:goal description:criteria1,criteria2,criteria3]
    // Agent can propose new subgoals mid-task if original decomposition is incomplete
    const subgoalSafe = cleaned
      .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
      .replace(/`[^`]+`/g, (m) => ' '.repeat(m.length));

    const subgoalRegex = /\[SUBGOAL_PROPOSE:([^:]{5,300}):([^\]]*)\]/gi;
    while ((match = subgoalRegex.exec(subgoalSafe)) !== null) {
      const description = match[1].trim();
      const criteriaStr = match[2]?.trim() || '';
      const successCriteria = criteriaStr
        ? criteriaStr.split(',').map(c => c.trim()).filter(c => c.length > 0)
        : [];
      const originalSubgoalTag = cleaned.substring(match.index, match.index + match[0].length);

      this.logger.info('ToolTag', `SUBGOAL_PROPOSE tag detected: "${sanitizeForLog(description, 100)}" with ${successCriteria.length} criteria`);

      if (this.taskPlanner && delegationContext?.planId) {
        try {
          const result = this.taskPlanner.proposeSubgoal(
            delegationContext.planId,
            description,
            workspaceId || 'master',
            successCriteria
          );

          if (result.error) {
            this.logger.warn('ToolTag', `SUBGOAL_PROPOSE failed: ${result.error}`);
            agentReplies.push(`\n\n**Subgoal Proposal Error:** ${sanitizeForLog(result.reason || result.error, 150)}`);
          } else {
            this.logger.info('ToolTag', `SUBGOAL_PROPOSE approved: goalId=${result.goalId}, depth=${result.depth}`);
            agentReplies.push(`\n\n**Subgoal Proposal:** Accepted (ID: ${result.goalId}, depth: ${result.depth})`);
          }
        } catch (err) {
          this.logger.error('ToolTag', `SUBGOAL_PROPOSE exception: ${sanitizeForLog(err.message, 200)}`);
          agentReplies.push(`\n\n**Subgoal Error:** ${sanitizeForLog(err.message, 150)}`);
        }
      } else {
        this.logger.warn('ToolTag', 'SUBGOAL_PROPOSE: TaskPlanner not available or not in task context');
        agentReplies.push(`\n\n**Error:** Task context required for subgoal proposals`);
      }

      cleaned = cleaned.replace(originalSubgoalTag, '');
    }

    // [SHARED_CONTEXT:namespaceId:key:value] — Write to shared memory namespace (roadmap 5.5)
    // Agents use this tag to share key facts with collaborating agents on the same task
    // Strip code blocks to prevent false positives (same approach as AGENT_MESSAGE)
    const sharedCtxSafe = cleaned
      .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
      .replace(/`[^`]+`/g, (m) => ' '.repeat(m.length));
    const sharedCtxRegex = /\[SHARED_CONTEXT:([^:]{2,50}):([^:]{1,100}):([^\]]{1,5000})\]/gi;
    while ((match = sharedCtxRegex.exec(sharedCtxSafe)) !== null) {
      const nsId = match[1].trim();
      const factKey = match[2].trim();
      const factValue = match[3].trim();
      const originalSharedTag = cleaned.substring(match.index, match.index + match[0].length);

      if (this.sharedContext) {
        const result = this.sharedContext.set(nsId, factKey, factValue, workspaceId || 'unknown');
        if (result.success) {
          this.logger.info('ToolTag', `SHARED_CONTEXT: set ${nsId.substring(0, 12)}/${factKey} (${factValue.length} chars)`);
        } else {
          this.logger.warn('ToolTag', `SHARED_CONTEXT: failed — ${result.error}`);
        }
      } else {
        this.logger.warn('ToolTag', 'SHARED_CONTEXT: SharedContext not available');
      }

      cleaned = cleaned.replace(originalSharedTag, '');
    }

    // [SHARED_CONTEXT_GET:namespaceId] — Read all facts from shared context namespace (roadmap 5.5)
    // Returns facts inline so the agent can use them in its response
    const sharedGetSafe = response
      .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
      .replace(/`[^`]+`/g, (m) => ' '.repeat(m.length));
    const sharedGetRegex = /\[SHARED_CONTEXT_GET:([^\]]{2,50})\]/gi;
    while ((match = sharedGetRegex.exec(sharedGetSafe)) !== null) {
      const nsId = match[1].trim();
      const originalGetTag = response.substring(match.index, match.index + match[0].length);

      if (this.sharedContext) {
        const summary = this.sharedContext.getSummary(nsId);
        if (summary) {
          this.logger.info('ToolTag', `SHARED_CONTEXT_GET: read ${nsId.substring(0, 12)} (${summary.length} chars)`);
          agentReplies.push(`\n\n${summary}`);
        } else {
          this.logger.info('ToolTag', `SHARED_CONTEXT_GET: namespace ${nsId.substring(0, 12)} empty or not found`);
        }
      } else {
        this.logger.warn('ToolTag', 'SHARED_CONTEXT_GET: SharedContext not available');
      }

      cleaned = cleaned.replace(originalGetTag, '');
    }

    // [AGENT_CREATE:name:skills:personality] — Auto-create agent (roadmap 5.1)
    // Format: [AGENT_CREATE:AgentName:comma-separated skills:personality style]
    // Example: [AGENT_CREATE:CodeReviewer:code review, refactoring:professional]
    const agentCreateRegex = /\[AGENT_CREATE:([^:]+):([^:]*):([^\]]*)\]/gi;
    while ((match = agentCreateRegex.exec(response)) !== null) {
      const agentName = match[1].trim();
      const skills = match[2].trim();
      const personality = match[3].trim();

      if (!agentName || agentName.length < 2 || agentName.length > 50) {
        this.logger.warn('ToolTag', `AGENT_CREATE: Invalid name "${sanitizeForLog(agentName, 50)}"`);
        cleaned = cleaned.replace(match[0], '');
        continue;
      }

      if (!this.agentManager) {
        this.logger.warn('ToolTag', 'AGENT_CREATE: agentManager not available');
        agentReplies.push(`\n\n**Error:** Cannot create agent — agentManager not available.`);
        cleaned = cleaned.replace(match[0], '');
        continue;
      }

      // Check if agent with same name already exists
      const existingAgents = this.agentManager.listAgents();
      const duplicate = existingAgents.find(a => a.name && a.name.toLowerCase() === agentName.toLowerCase());
      if (duplicate) {
        this.logger.info('ToolTag', `AGENT_CREATE: Agent "${agentName}" already exists (${duplicate.id})`);
        agentReplies.push(`\n\n**Info:** An agent named "${agentName}" already exists (ID: ${duplicate.id.substring(0, 8)}...).`);
        cleaned = cleaned.replace(match[0], '');
        continue;
      }

      // Map personality string to known styles
      const personalityMap = {
        'professional': 'professional',
        'friendly': 'friendly',
        'humorous': 'humorous',
        'concise': 'concise',
        'detailed': 'detailed',
        'casual': 'friendly',
        'formal': 'professional',
        'fun': 'humorous',
        'brief': 'concise',
        'thorough': 'detailed'
      };
      const mappedStyle = personalityMap[personality.toLowerCase()] || 'professional';

      // Build traits from skills
      const skillList = skills.split(',').map(s => s.trim()).filter(s => s.length > 0);
      const traits = ['helpful', 'focused'];
      if (skillList.length > 0) traits.push('specialized');

      // Try to match a template for richer agent configuration (roadmap 5.1)
      const templateMatch = matchAgentTemplate(skills);
      let finalFirstPrompt = null;
      let finalTraits = traits;
      let finalStyle = mappedStyle;
      let finalSkills = skills || 'general';
      let finalColor = '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
      let templateUsed = null;

      if (templateMatch) {
        // Use template for richer configuration
        const tpl = templateMatch.template;
        templateUsed = templateMatch.key;
        finalFirstPrompt = tpl.firstPrompt;
        finalTraits = tpl.personality.traits;
        finalStyle = personality.toLowerCase() !== '' ? mappedStyle : tpl.personality.style;
        finalSkills = tpl.skills;
        finalColor = tpl.color;
        this.logger.info('ToolTag', `AGENT_CREATE: Matched template "${templateUsed}" for skills "${skills}"`);
      } else {
        // Generic: build firstPrompt from skill list
        if (skillList.length > 0) {
          const skillBullets = skillList.map(s => `- ${s}`).join('\n');
          finalFirstPrompt = `You are ${agentName}, a specialized AI agent.\n\nYour core skills:\n${skillBullets}\n\nFocus on these areas and provide expert-level assistance. When asked about topics outside your expertise, be honest about your limitations but still try to help.`;
        }
      }

      try {
        const agentConfig = {
          name: agentName,
          nickname: agentName,
          personality: { style: finalStyle, traits: finalTraits },
          interests: { areas: finalSkills },
          firstPrompt: finalFirstPrompt,
          appearance: { color: finalColor, avatarUrl: null },
          memory: { enabled: true, maxSize: -1 },
          workStyle: { proactive: false, heartbeat: false },
          templateKey: templateUsed || null
        };

        const agent = this.agentManager.createAgent(agentConfig, {
          workspaceManager: this.workspaceManager
        });

        const templateNote = templateUsed ? ` (template: ${templateUsed})` : '';
        this.logger.success('ToolTag', `AGENT_CREATE: Created agent "${agentName}" (${agent.id}) — skills: ${finalSkills}, style: ${finalStyle}${templateNote}`);
        agentReplies.push(`\n\n**Agent created:** "${agentName}" (ID: ${agent.id.substring(0, 8)}...)${templateNote} — Skills: ${finalSkills}, Style: ${finalStyle}`);

        // Register skills from soul files for the new agent (roadmap 5.2)
        if (this.skillRegistry) {
          this.skillRegistry.refreshAgent(agent.id);
        }
        // Refresh skill cache if available
        if (this.autoRouter && this.autoRouter.skillCache) {
          this.autoRouter.skillCache.refreshNow();
        }
      } catch (err) {
        this.logger.error('ToolTag', `AGENT_CREATE failed: ${err.message}`);
        agentReplies.push(`\n\n**Error:** Failed to create agent: ${sanitizeForLog(err.message, 200)}`);
      }

      cleaned = cleaned.replace(match[0], '');
    }

    // Clean up extra blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    // Return both cleaned response and agent replies separately
    // Caller decides: append to response (old behavior) or resume with delegation (new behavior)
    return { cleaned, agentReplies };
  }

  // ═══════════════════════════════════════════════════════════
  // TIME EXPRESSION PARSER (from Gateway handler.js)
  // Supports natural language: "1 hour", "90 min", "2 hours 30 minutes"
  // ═══════════════════════════════════════════════════════════

  _parseTimeExpression(expr) {
    const lower = expr.toLowerCase().trim();

    const directNum = parseInt(lower);
    if (!isNaN(directNum) && String(directNum) === lower) return directNum;

    let total = 0;
    const patterns = [
      { regex: /(\d+)\s*(sec|second|seconds)/i, mult: 1 },
      { regex: /(\d+)\s*(min|minute|minutes)/i, mult: 60 },
      { regex: /(\d+)\s*(hr|hour|hours)/i, mult: 3600 },
      { regex: /(\d+)\s*(day|days)/i, mult: 86400 },
    ];

    for (const p of patterns) {
      const m = lower.match(p.regex);
      if (m) {
        total += parseInt(m[1]) * p.mult;
      }
    }

    return total;
  }

  // ═══════════════════════════════════════════════════════════
  // EPISODIC MEMORY STORAGE (uses reflectionEngine)
  // ═══════════════════════════════════════════════════════════

  _storeEpisode(userMessage, response, channel, userId, workspaceId, taskContext = null) {
    const memory = workspaceId ? this._getMemoryForWorkspace(workspaceId) : null;
    if (!memory) return;

    // Use reflectionEngine.scoreImportance if available, else inline
    let importance;
    if (this.reflectionEngine && this.reflectionEngine.scoreImportance) {
      importance = this.reflectionEngine.scoreImportance(userMessage, response);
    } else {
      importance = 5;
      if (userMessage.length > 200) importance++;
      if (response.length > 500) importance++;
      if (/remember|save|don't forget|important/i.test(userMessage)) importance += 2;
      if (/my name|i live|i work|i am/i.test(userMessage)) importance += 2;
      if (/decision|preference|choose|prefer/i.test(userMessage)) importance++;
      if (/error|bug|fix|issue|problem/i.test(userMessage)) importance++;
      if (/crypto|token|coin|sol|eth|btc/i.test(userMessage)) importance++;
      if (/hello|hi|hey|greetings/i.test(userMessage) && userMessage.length < 30) importance = 2;
      if (/^(yes|no|ok|sure|got it|understood)$/i.test(userMessage.trim())) importance = 2;
      importance = Math.max(1, Math.min(10, importance));
    }

    // Use reflectionEngine.detectSentiment if available, else inline
    let sentiment;
    if (this.reflectionEngine && this.reflectionEngine.detectSentiment) {
      sentiment = this.reflectionEngine.detectSentiment(userMessage);
    } else {
      sentiment = 'neutral';
      if (/thanks|great|awesome|amazing|perfect|excellent/i.test(userMessage)) sentiment = 'positive';
      if (/bad|wrong|terrible|angry|annoyed|broken/i.test(userMessage)) sentiment = 'negative';
      if (/urgent|asap|immediately|quick|hurry/i.test(userMessage)) sentiment = 'urgent';
      if (/how|why|what|explain|curious/i.test(userMessage)) sentiment = 'curious';
    }

    try {
      const episodeData = {
        type: 'conversation',
        channel: channel,
        user: userId,
        input: userMessage.substring(0, 500),
        output: response.substring(0, 500),
        importance: importance,
        emotions: sentiment,
        tags: [],
        goal: taskContext?.goal || null,      // Task goal (9.2)
        steps: taskContext?.steps || []       // Task steps (9.2)
      };

      const episodeId = memory.storeEpisode(episodeData);

      // If task context with steps was provided, add them to the episode (9.2)
      if (taskContext?.steps && taskContext.steps.length > 0 && episodeId) {
        for (const step of taskContext.steps) {
          memory.addStep(episodeId, step);
        }
      }

      this.logger.info('AgentExecutor', `[${workspaceId.substring(0, 8)}] Episode stored (importance: ${importance}${taskContext?.steps ? ', ' + taskContext.steps.length + ' steps' : ''})`);
    } catch (e) {
      this.logger.warn('AgentExecutor', `[${workspaceId.substring(0, 8)}] Episode store failed: ${e.message}`);
    }
  }

  abort(conversationId, { cancelledByUser = false } = {}) {
    const proc = this.activeProcesses.get(conversationId);
    if (proc) {
      this.logger.info('AgentExecutor', `Aborting conversation: ${conversationId} (user: ${cancelledByUser})`);
      // Mark as user-cancelled so tryFinalize won't attempt resume
      const jobInfo = this._activeJobs.get(conversationId);
      if (jobInfo && cancelledByUser) jobInfo.cancelledByUser = true;
      // Kill process group (detached:true) for clean termination
      try { process.kill(-proc.pid, 'SIGTERM'); } catch (e) {
        if (e.code !== 'ESRCH') { try { proc.kill('SIGTERM'); } catch (_) {} }
      }
      this.activeProcesses.delete(conversationId);
      // Unregister from PID registry on abort
      if (this.pidRegistry && proc && proc.pid) {
        this.pidRegistry.unregister(proc.pid);
      }
      this._activeJobs.delete(conversationId);
      this._pendingMessages.delete(conversationId); // Clear queued messages on abort
      this._saveActiveJobs();
      // Broadcast cancellation
      if (this.wsServer && this.wsServer.broadcast) {
        this.wsServer.broadcast({ type: 'job-activity', action: 'cancelled', conversationId, workspaceId: jobInfo?.workspaceId });
      }
      return true;
    }
    return false;
  }

  isRunning(conversationId) {
    return this.activeProcesses.has(conversationId);
  }

  // Aliases for MessageRouter retry logic
  isProcessActive(conversationId) {
    return this.activeProcesses.has(conversationId);
  }

  abortProcess(conversationId) {
    return this.abort(conversationId, { cancelledByUser: false });
  }

  hasPendingMessages(conversationId) {
    const queue = this._pendingMessages.get(conversationId);
    return queue && queue.length > 0;
  }

  /**
   * Flush pending message queue for a conversation.
   * Called after agent completes (any exit path) to process queued user messages.
   * @param {string} conversationId
   * @param {string} sessionId - session to resume with
   * @param {Function} fallbackOnEvent - fallback event handler
   * @param {Function} fallbackOnComplete - fallback completion handler
   * @param {Function} fallbackOnError - fallback error handler
   */
  _flushPendingQueue(conversationId, sessionId, fallbackOnEvent, fallbackOnComplete, fallbackOnError) {
    if (!this.hasPendingMessages(conversationId)) return false;

    const queue = this._pendingMessages.get(conversationId);
    const pending = queue.shift();
    if (queue.length === 0) this._pendingMessages.delete(conversationId);

    this.logger.info('AgentExecutor', `[QUEUE] Flushing pending message for ${conversationId} via --resume ${sessionId}`);

    if (pending.onEvent) {
      pending.onEvent({ type: 'system', content: '📎 Processing queued message...' });
    }

    this.execute({
      ...pending.options,
      userMessage: pending.message,
      images: pending.images || [],
      sessionId: sessionId,
      onEvent: pending.onEvent || fallbackOnEvent,
      onComplete: pending.onComplete || fallbackOnComplete,
      onError: pending.onError || fallbackOnError,
      _isResumeFromQueue: true,
      _retryCount: 0
    }).catch(e => {
      this.logger.error('AgentExecutor', `[QUEUE] Resume execute failed: ${e.message}`);
      if (pending.onError) pending.onError(e);
    });

    return true;
  }

  getActiveCount() {
    return this.activeProcesses.size;
  }

  /**
   * CONFIDENCE SCORING (roadmap 9.3)
   * Calculate confidence (0.0-1.0) based on:
   * - Context relevance: how well the context matches the query
   * - Tool success rate: percentage of tool calls that succeeded
   * - Model uncertainty: uncertainty signal from Claude's response
   *
   * Returns: { confidence: 0.0-1.0, breakdown: { contextRelevance, toolSuccess, modelConfidence } }
   */
  _calculateConfidence(options = {}) {
    const {
      userMessage = '',
      fullResponse = '',
      context = {},
      toolUseCount = 0,
      toolSuccessCount = 0,
      modelUncertainty = 0.0  // 0.0 (confident) to 1.0 (very uncertain)
    } = options;

    // 1. Context Relevance (0.0-1.0)
    // Based on: is response addressing user message, does it reference provided context
    let contextRelevance = 0.5; // Default neutral

    if (userMessage && fullResponse) {
      // Very simple: does response seem to address the question?
      // Check for key words from user message appearing in response
      const userWords = userMessage.toLowerCase().split(/\s+/).slice(0, 5); // First 5 words
      const responseWords = fullResponse.toLowerCase();

      let matchedWords = 0;
      for (const word of userWords) {
        if (word.length > 3 && responseWords.includes(word)) {
          matchedWords++;
        }
      }

      const matchRatio = matchedWords / Math.max(userWords.filter(w => w.length > 3).length, 1);
      contextRelevance = Math.min(1.0, 0.3 + (matchRatio * 0.7)); // 0.3-1.0 range

      // Boost if response is substantial (not "I don't know" answers)
      if (fullResponse.length > 100 && !fullResponse.match(/i don't know|no information|sorry|unable to/i)) {
        contextRelevance = Math.min(1.0, contextRelevance + 0.15);
      }
    }

    // 2. Tool Success Rate (0.0-1.0)
    // Based on: ratio of successful tool calls
    let toolSuccess = 1.0; // Default: full confidence if no tools used

    if (toolUseCount > 0) {
      const successRatio = toolSuccessCount / toolUseCount;
      // Map: 0% success = 0.3, 100% success = 1.0 (tools are not always reliable)
      toolSuccess = 0.3 + (successRatio * 0.7);
    }

    // 3. Model Confidence (0.0-1.0)
    // Based on: model uncertainty (inverse of uncertainty parameter)
    // High uncertainty → lower confidence
    const modelConfidence = Math.max(0.0, 1.0 - modelUncertainty);

    // 4. Weighted average (with weights that sum to 1.0)
    // Give equal weight to all three factors for now
    const weights = {
      contextRelevance: 0.4,  // How well response matches query
      toolSuccess: 0.3,       // Tool reliability
      modelConfidence: 0.3    // Claude's own confidence
    };

    const confidence =
      (contextRelevance * weights.contextRelevance) +
      (toolSuccess * weights.toolSuccess) +
      (modelConfidence * weights.modelConfidence);

    return {
      confidence: Math.max(0.0, Math.min(1.0, confidence)), // Clamp to 0.0-1.0
      breakdown: {
        contextRelevance: Math.round(contextRelevance * 100) / 100,
        toolSuccess: Math.round(toolSuccess * 100) / 100,
        modelConfidence: Math.round(modelConfidence * 100) / 100
      },
      weights
    };
  }

  /**
   * Error root cause analysis (roadmap 9.4)
   * Analyzes a failed task to determine if failure was due to:
   * - Context (insufficient/irrelevant context, token overflow)
   * - Tool (tool missing, failed, timed out)
   * - Model (model lacks knowledge, hallucination, reasoning error)
   * - Configuration (budget/turn limits too low, wrong model)
   * - External (network, timeout, resource exhaustion)
   * - Unknown (couldn't determine)
   *
   * Results are logged to data/failures.jsonl and can be queried via /api/agents/:id/failure-analysis
   */
  async _analyzeFailure(options = {}) {
    const {
      conversationId,
      agentId,
      workspaceId,
      error,                   // Error object or message
      errorCode,                // Exit code if process error
      errorContext,            // Additional context about the error
      userMessage = '',        // What user asked
      fullResponse = '',       // What agent returned (if any)
      toolsUsed = [],          // Array of tool names that were attempted
      toolFailures = [],       // Array of { tool, reason }
      selectedModel = 'sonnet',
      totalCost = 0,
      duration = 0,
      retryCount = 0
    } = options;

    // Don't analyze if no error (shouldn't happen, but safety check)
    if (!error && !errorCode) return null;

    // CRITICAL: Skip error analysis for error-analysis conversations to prevent recursive cascade
    // Without this guard, a failed error-analysis spawns another error-analysis → exponential growth
    if (conversationId && (
      conversationId.startsWith('error-analysis-') ||
      conversationId.startsWith('cron:system:')
    )) {
      return null;
    }

    const timestamp = new Date().toISOString();
    const errorMsg = typeof error === 'string' ? error : (error?.message || String(error));

    // Determine root cause category
    let rootCauseCategory = ROOT_CAUSE_CATEGORIES.UNKNOWN;
    let confidence = 0.5;
    let analysis = '';

    // Heuristic analysis (quick, no LLM call)
    if (errorMsg.includes('max_turns') || errorMsg.includes('Turn limit')) {
      rootCauseCategory = ROOT_CAUSE_CATEGORIES.CONFIGURATION;
      confidence = 0.95;
      analysis = 'Agent exhausted turn limit. Increase MAX_TURNS_DEFAULT or break task into smaller steps.';
    } else if (errorMsg.includes('max_budget') || errorMsg.includes('Budget exceeded')) {
      rootCauseCategory = ROOT_CAUSE_CATEGORIES.CONFIGURATION;
      confidence = 0.95;
      analysis = 'Agent exceeded budget limit. Increase MAX_BUDGET_USD or use cheaper model (haiku instead of opus).';
    } else if (errorMsg.includes('token') || errorMsg.includes('context')) {
      rootCauseCategory = ROOT_CAUSE_CATEGORIES.CONTEXT;
      confidence = 0.85;
      analysis = 'Context window overflow or malformed. Reduce conversation history or use context-guard to trim.';
    } else if (errorMsg.includes('tool') || errorMsg.includes('function')) {
      rootCauseCategory = ROOT_CAUSE_CATEGORIES.TOOL_LIMITATION;
      confidence = 0.8;
      analysis = `Tool limitation detected (${toolFailures.length > 0 ? toolFailures.map(t => t.tool).join(', ') : 'unknown'}). Check tool availability or implement missing tool.`;
    } else if (errorMsg.includes('network') || errorMsg.includes('ECONNREFUSED') || errorMsg.includes('ETIMEDOUT')) {
      rootCauseCategory = ROOT_CAUSE_CATEGORIES.EXTERNAL;
      confidence = 0.9;
      analysis = 'Network/external service failure. Check API availability, retry with backoff.';
    } else if (errorCode === 1 && errorMsg.includes('model')) {
      rootCauseCategory = ROOT_CAUSE_CATEGORIES.MODEL_KNOWLEDGE;
      confidence = 0.7;
      analysis = 'Model may lack necessary knowledge for this task. Try different model or provide more examples.';
    } else if (errorMsg.length < 10) {
      // Very short error = likely system/resource error
      rootCauseCategory = ROOT_CAUSE_CATEGORIES.EXTERNAL;
      confidence = 0.6;
      analysis = 'System/resource error. Check disk space, memory, and file permissions.';
    }

    // Build suggestions based on root cause
    const suggestions = [];
    switch (rootCauseCategory) {
      case ROOT_CAUSE_CATEGORIES.CONTEXT:
        suggestions.push('Reduce context size (summarize old messages)');
        suggestions.push('Use separate conversations for unrelated topics');
        suggestions.push('Enable context-guard to auto-trim');
        break;
      case ROOT_CAUSE_CATEGORIES.TOOL_LIMITATION:
        suggestions.push('Check required tools are registered and available');
        suggestions.push('Implement missing tools in TOOLS.md');
        suggestions.push('Add tool timeout/retry logic');
        break;
      case ROOT_CAUSE_CATEGORIES.MODEL_KNOWLEDGE:
        suggestions.push('Try higher-tier model (haiku → sonnet → opus)');
        suggestions.push('Provide concrete examples in prompt');
        suggestions.push('Break task into simpler subtasks');
        break;
      case ROOT_CAUSE_CATEGORIES.CONFIGURATION:
        suggestions.push('Increase MAX_TURNS_DEFAULT or MAX_BUDGET_USD');
        suggestions.push('Use cheaper model (haiku) for simple tasks');
        suggestions.push('Split large task into smaller sub-tasks');
        break;
      case ROOT_CAUSE_CATEGORIES.EXTERNAL:
        suggestions.push('Retry with exponential backoff');
        suggestions.push('Check external API health (Claude API, tool endpoints)');
        suggestions.push('Monitor network connectivity and timeouts');
        break;
      default:
        suggestions.push('Enable verbose logging to debug');
        suggestions.push('Check system logs (logs/master.log)');
    }

    // Persist failure analysis
    const failureRecord = {
      timestamp,
      conversationId,
      agentId: agentId || 'unknown',
      workspaceId: workspaceId || 'unknown',
      error: errorMsg.substring(0, 500),
      errorCode: errorCode || null,
      userMessage: userMessage.substring(0, 200),
      responseLength: fullResponse.length,
      toolsAttempted: toolsUsed.length,
      toolFailures: toolFailures.length,
      selectedModel,
      retryCount,
      duration,
      cost: totalCost,
      rootCauseCategory,
      confidence: Math.round(confidence * 100) / 100,
      analysis,
      suggestions
    };

    // Log to failures.jsonl (async, non-blocking)
    try {
      const line = JSON.stringify(failureRecord) + '\n';
      fs.appendFileSync(FAILURES_FILE, line);
    } catch (e) {
      this.logger.warn('AgentExecutor', `Failed to log failure analysis: ${e.message}`);
    }

    // Also log to main logger
    this.logger.info('AgentExecutor', `Failure analysis: ${rootCauseCategory} (confidence ${confidence}): ${analysis.substring(0, 100)}`);

    // Enhanced analysis via ErrorAnalyzer (roadmap 9.4) — async, non-blocking
    if (this.errorAnalyzer) {
      this.errorAnalyzer.logFailure({
        conversationId,
        agentId: agentId || 'unknown',
        taskDescription: userMessage.substring(0, 300),
        failureReason: errorMsg,
        failureCategory: rootCauseCategory,
        toolsAttempted: toolsUsed.map(t => ({ name: t, success: false })), // Simplified; could be enhanced with actual success/failure
        confidence,
        duration
      }).catch(e => this.logger.warn('AgentExecutor', `ErrorAnalyzer failed: ${e.message}`));
    }

    return failureRecord;
  }

  // ═══════════════════════════════════════════════════════════
  // SAFE RESTART — Prevents killing other agents during restart
  // ═══════════════════════════════════════════════════════════

  /**
   * Request a safe restart. If no other agents are running, restart immediately.
   * If agents are running, queue the restart — it will execute when the last agent finishes.
   * @param {string} requestedBy - workspace name or ID that requested the restart
   * @returns {{ queued: boolean, activeAgents: number, message: string }}
   */
  requestSafeRestart(requestedBy) {
    // Count active agents EXCLUDING the one requesting restart
    const activeCount = this._activeJobs.size;

    if (activeCount === 0) {
      // No agents running — restart immediately
      this.logger.info('AgentExecutor', `[SAFE-RESTART] No active agents — restarting now (requested by: ${requestedBy})`);
      this._executeSafeRestart(requestedBy);
      return { queued: false, activeAgents: 0, message: 'Restarting immediately — no active agents' };
    }

    // Queue the restart
    this._restartPending = true;
    this._restartRequestedBy = requestedBy;
    this.logger.info('AgentExecutor', `[SAFE-RESTART] Restart queued — waiting for ${activeCount} active agent(s) to finish (requested by: ${requestedBy})`);

    // Broadcast to UI
    if (this.wsServer && this.wsServer.broadcast) {
      this.wsServer.broadcast({
        type: 'safe-restart-queued',
        activeAgents: activeCount,
        requestedBy
      });
    }

    return { queued: true, activeAgents: activeCount, message: `Restart queued — ${activeCount} agent(s) still running` };
  }

  /**
   * Called from tryFinalize after each agent completes.
   * If restart is pending and no more agents running, execute it.
   */
  _checkAndExecutePendingRestart(completedConversationId) {
    if (!this._restartPending) return;

    const remaining = this._activeJobs.size;
    if (remaining > 0) {
      this.logger.info('AgentExecutor', `[SAFE-RESTART] Agent finished (conv: ${completedConversationId}) — ${remaining} agent(s) still active, waiting...`);
      return;
    }

    this.logger.info('AgentExecutor', `[SAFE-RESTART] All agents finished — executing queued restart (requested by: ${this._restartRequestedBy})`);
    this._executeSafeRestart(this._restartRequestedBy);
  }

  /**
   * Execute the actual restart with delayed kickstart.
   */
  _executeSafeRestart(requestedBy) {
    this._restartPending = false;
    this._restartRequestedBy = null;

    const { execSync } = require('child_process');
    const uid = execSync('id -u').toString().trim();

    // Save all state before restart
    this._saveActiveJobs();
    this._saveSessions();

    // Delayed kickstart — gives time for response delivery
    const cmd = `nohup bash -c "sleep 2 && launchctl kickstart -k gui/${uid}/com.anuki.master" > /dev/null 2>&1 &`;
    require('child_process').exec(cmd);
    this.logger.info('AgentExecutor', `[SAFE-RESTART] Delayed kickstart triggered (2s delay, requested by: ${requestedBy})`);
  }
}

AgentExecutor.AGENT_TEMPLATES = AGENT_TEMPLATES;
module.exports = AgentExecutor;
