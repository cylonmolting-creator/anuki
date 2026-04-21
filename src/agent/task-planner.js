const { v4: uuidv4 } = require('uuid');
const { sanitizeForLog } = require('../utils/helpers');

/**
 * TaskPlanner — Multi-Agent Task Planning & Execution
 *
 * Roadmap 5.3: Complex task → break into subtasks → assign to best-fit agents → collect/synthesize results
 *
 * Architecture:
 * - Pattern-based task decomposition (no LLM call for planning — fast, deterministic)
 * - SkillCache-driven agent assignment (uses existing skill index)
 * - Parallel execution with configurable concurrency via Promise.allSettled
 * - Sequential fallback when subtasks depend on each other
 * - Result synthesis with status tracking
 *
 * Usage:
 * - HTTP: POST /api/tasks/plan { task: "...", strategy: "parallel" }
 * - Tool tag: [TASK_PLAN:description]
 */

class TaskPlanner {
  constructor(options = {}) {
    this.skillCache = options.skillCache;
    this.messageRouter = options.messageRouter;
    this.sharedContext = options.sharedContext; // Roadmap 5.5: shared memory namespace
    this.logger = options.logger;

    // Execution config
    this.maxConcurrency = options.maxConcurrency || 3;
    this.defaultTimeout = options.defaultTimeout || 60; // seconds per subtask
    this.maxSubtasks = options.maxSubtasks || 8;

    // Active plans tracking (planId -> plan state)
    this.activePlans = new Map();

    // Stats
    this._stats = {
      totalPlans: 0,
      completedPlans: 0,
      failedPlans: 0,
      totalSubtasks: 0,
      successfulSubtasks: 0,
      failedSubtasks: 0,
      skippedSubtasks: 0
    };

    // Task decomposition patterns: keyword → skill category mapping
    this.SKILL_PATTERNS = [
      { pattern: /\b(code|program|implement|refactor|debug|fix bug|write function|API|endpoint)\b/i, skill: 'code', category: 'development' },
      { pattern: /\b(review|audit|check quality|best practices|lint)\b/i, skill: 'code-review', category: 'review' },
      { pattern: /\b(test|QA|unit test|integration test|smoke test|verify|validate)\b/i, skill: 'testing', category: 'testing' },
      { pattern: /\b(math|calculate|compute|formula|equation|statistics)\b/i, skill: 'mathematics', category: 'math' },
      { pattern: /\b(research|investigate|analyze|find out|look up|search)\b/i, skill: 'research', category: 'research' },
      { pattern: /\b(translate|localize|i18n)\b/i, skill: 'translation', category: 'language' },
      { pattern: /\b(write|draft|compose|copywrite|blog|article|document)\b/i, skill: 'writing', category: 'content' },
      { pattern: /\b(data|dataset|CSV|SQL|query|visualize|chart|graph)\b/i, skill: 'data-analysis', category: 'data' },
      { pattern: /\b(crypto|token|blockchain|defi|memecoin|on-chain)\b/i, skill: 'crypto-analysis', category: 'crypto' },
      { pattern: /\b(fraud|security|vulnerability|exploit|scan)\b/i, skill: 'security', category: 'security' },
      { pattern: /\b(summarize|brief|summary|digest)\b/i, skill: 'summarization', category: 'content' },
      { pattern: /\b(plan|organize|schedule|prioritize|roadmap)\b/i, skill: 'planning', category: 'planning' }
    ];

    this.logger.info('TaskPlanner', 'Initialized (concurrency: ' + this.maxConcurrency + ')');
  }

  /**
   * Plan and execute a complex task
   *
   * @param {string} taskDescription - Natural language task description
   * @param {Object} options
   * @param {string} [options.fromAgentId='master'] - Requesting agent ID
   * @param {number} [options.timeout=60] - Per-subtask timeout in seconds
   * @param {boolean} [options.dryRun=false] - If true, return plan without executing
   * @param {string} [options.strategy='parallel'] - 'parallel' or 'sequential'
   * @returns {Promise<Object>} Plan with results
   */
  async planAndExecute(taskDescription, options = {}) {
    const {
      fromAgentId = 'master',
      timeout = this.defaultTimeout,
      dryRun = false,
      strategy = 'parallel',
      parentConversationId = null  // Link child jobs to parent for restart resume
    } = options;

    const planId = uuidv4();
    const startTime = Date.now();

    this.logger.info('TaskPlanner', `Creating plan ${planId.substring(0, 8)}: "${sanitizeForLog(taskDescription, 100)}" [strategy=${strategy}]`);
    this._stats.totalPlans++;

    // Step 1: Decompose task into subtasks
    const subtasks = this._decompose(taskDescription);

    if (subtasks.length === 0) {
      return {
        planId,
        status: 'no_subtasks',
        task: taskDescription,
        subtasks: [],
        message: 'Task could not be decomposed into agent-assignable subtasks. Handle as a single task.'
      };
    }

    // Step 2: Assign agents to subtasks via SkillCache
    const assignments = this._assignAgents(subtasks, fromAgentId);

    // Step 2.5: Create shared context namespace for this plan (Roadmap 5.5)
    let sharedNamespaceId = null;
    if (this.sharedContext) {
      const participantIds = assignments
        .filter(a => a.assignedAgent)
        .map(a => a.assignedAgent.agentId);
      const result = this.sharedContext.create({
        namespaceId: planId, // reuse planId as namespace
        taskDescription: taskDescription.substring(0, 500),
        createdBy: fromAgentId,
        participants: participantIds
      });
      sharedNamespaceId = result.namespaceId;
      this.logger.info('TaskPlanner', `Shared context namespace created: ${sharedNamespaceId.substring(0, 12)} (${participantIds.length} participants)`);
    }

    const plan = {
      planId,
      task: taskDescription,
      subtasks: assignments,
      sharedNamespaceId,
      status: 'planned',
      strategy,
      createdAt: new Date().toISOString(),
      fromAgentId
    };

    this.activePlans.set(planId, plan);

    if (dryRun) {
      this.logger.info('TaskPlanner', `Dry run plan ${planId.substring(0, 8)}: ${assignments.length} subtasks`);
      return plan;
    }

    // Step 3: Execute subtasks (parallel or sequential)
    plan.status = 'executing';
    let results;

    if (strategy === 'sequential') {
      results = await this._executeSequential(assignments, fromAgentId, timeout, sharedNamespaceId, parentConversationId);
    } else {
      results = await this._executeParallel(assignments, fromAgentId, timeout, sharedNamespaceId, parentConversationId);
    }

    // Step 4: Synthesize results
    const synthesis = this._synthesize(taskDescription, results);

    plan.status = 'completed';
    plan.results = results;
    plan.synthesis = synthesis;
    plan.completedAt = new Date().toISOString();
    plan.totalLatency = Date.now() - startTime;

    this._stats.completedPlans++;

    this.logger.info('TaskPlanner', `Plan ${planId.substring(0, 8)} completed: ${results.filter(r => r.status === 'ok').length}/${results.length} subtasks succeeded in ${plan.totalLatency}ms`);

    // Cleanup old plans (keep max 50)
    if (this.activePlans.size > 50) {
      const oldest = Array.from(this.activePlans.keys()).slice(0, this.activePlans.size - 50);
      for (const id of oldest) {
        this.activePlans.delete(id);
      }
    }

    return plan;
  }

  /**
   * Decompose a task description into subtasks based on keyword patterns.
   *
   * Strategy:
   * 1. Try splitting by explicit delimiters (numbered lists, bullets, "and", "then", semicolons)
   * 2. If split produces multiple parts, match each to a skill domain
   * 3. If no split possible, check if task spans multiple distinct skill domains
   * 4. Require at least 2 assignable subtasks — single-domain tasks stay as-is
   *
   * @private
   */
  _decompose(taskDescription) {
    const subtasks = [];
    const seen = new Set();

    // Try splitting by explicit structure: numbered lists, bullets, "and"/"then", semicolons
    const parts = taskDescription
      .split(/\s*(?:;\s*|\d+[.)]\s+|\n[-•*]\s+|\band\s+then\b|\bthen\b)/i)
      .map(p => p.trim())
      .filter(p => p.length > 5);

    // Also try splitting by "and" but only if it produces well-matched parts
    let andParts = [];
    if (parts.length <= 1) {
      andParts = taskDescription
        .split(/\s*\band\b\s*/i)
        .map(p => p.trim())
        .filter(p => p.length > 5);
    }

    const candidateParts = parts.length > 1 ? parts : (andParts.length > 1 ? andParts : []);

    if (candidateParts.length > 1) {
      // Multi-part task: match each part to a skill
      for (const part of candidateParts.slice(0, this.maxSubtasks)) {
        const matchedSkills = this._matchSkills(part);
        if (matchedSkills.length > 0) {
          const primary = matchedSkills[0];
          const key = primary.skill + ':' + part.substring(0, 30);
          if (!seen.has(key)) {
            seen.add(key);
            subtasks.push({
              description: part,
              requiredSkill: primary.skill,
              category: primary.category,
              allMatchedSkills: matchedSkills.map(m => m.skill)
            });
          }
        }
      }
    }

    // If structured split didn't work, check if whole task spans multiple skill domains
    if (subtasks.length <= 1) {
      subtasks.length = 0; // Reset
      seen.clear();

      const allMatches = this._matchSkills(taskDescription);
      // Deduplicate by skill name
      const uniqueSkills = [];
      const skillsSeen = new Set();
      for (const m of allMatches) {
        if (!skillsSeen.has(m.skill)) {
          skillsSeen.add(m.skill);
          uniqueSkills.push(m);
        }
      }

      // Only decompose if task spans 2+ distinct skill domains
      if (uniqueSkills.length >= 2) {
        for (const skillMatch of uniqueSkills.slice(0, this.maxSubtasks)) {
          subtasks.push({
            description: taskDescription,
            requiredSkill: skillMatch.skill,
            category: skillMatch.category,
            allMatchedSkills: [skillMatch.skill]
          });
        }
      }
    }

    return subtasks;
  }

  /**
   * Match a text against skill patterns.
   * @private
   * @returns {Array<{skill: string, category: string}>}
   */
  _matchSkills(text) {
    const matches = [];
    for (const sp of this.SKILL_PATTERNS) {
      if (sp.pattern.test(text)) {
        matches.push({ skill: sp.skill, category: sp.category });
      }
    }
    return matches;
  }

  /**
   * Assign agents to subtasks using SkillCache.
   * Uses 3-tier lookup: findBySkillName → findByCategory → broad search.
   * @private
   */
  _assignAgents(subtasks, fromAgentId) {
    return subtasks.map(subtask => {
      let assignedAgent = null;

      if (this.skillCache) {
        // Tier 1: Direct skill name match
        const matches = this.skillCache.findBySkillName(subtask.requiredSkill);
        const candidates = matches.filter(m => m.agentId !== fromAgentId && m.agentId !== 'master');

        if (candidates.length > 0) {
          assignedAgent = {
            agentId: candidates[0].agentId,
            agentName: candidates[0].agentName,
            rating: candidates[0].rating,
            matchedSkill: subtask.requiredSkill,
            matchTier: 'direct'
          };
        }

        // Tier 2: Category match
        if (!assignedAgent) {
          const catMatches = this.skillCache.findByCategory(subtask.category);
          const catCandidates = catMatches.filter(m => m.agentId !== fromAgentId && m.agentId !== 'master');
          if (catCandidates.length > 0) {
            assignedAgent = {
              agentId: catCandidates[0].agentId,
              agentName: catCandidates[0].agentName,
              rating: catCandidates[0].rating,
              matchedSkill: catCandidates[0].skillName || subtask.requiredSkill,
              matchTier: 'category'
            };
          }
        }

        // Tier 3: Broad search
        if (!assignedAgent) {
          const searchResults = this.skillCache.search(subtask.requiredSkill);
          const skillAgents = (searchResults.skills || []).filter(s => s.agentId !== fromAgentId && s.agentId !== 'master');
          if (skillAgents.length > 0) {
            assignedAgent = {
              agentId: skillAgents[0].agentId,
              agentName: skillAgents[0].agentName,
              rating: skillAgents[0].rating || 1.0,
              matchedSkill: skillAgents[0].skillName || subtask.requiredSkill,
              matchTier: 'search'
            };
          }
        }
      }

      return {
        ...subtask,
        assignedAgent,
        status: assignedAgent ? 'assigned' : 'unassigned'
      };
    });
  }

  /**
   * Execute subtasks in parallel with concurrency limit.
   * Uses Promise.allSettled for graceful handling of individual failures.
   * @private
   */
  async _executeParallel(assignments, fromAgentId, timeout, sharedNamespaceId, parentConversationId) {
    const results = [];
    const pending = [...assignments];

    while (pending.length > 0) {
      // Take up to maxConcurrency subtasks
      const batch = pending.splice(0, this.maxConcurrency);

      this.logger.info('TaskPlanner', `Executing batch of ${batch.length} subtasks in parallel (${pending.length} remaining)`);

      const batchResults = await Promise.allSettled(
        batch.map(subtask => this._executeSingle(subtask, fromAgentId, timeout, sharedNamespaceId, parentConversationId))
      );

      for (let i = 0; i < batchResults.length; i++) {
        const settled = batchResults[i];
        if (settled.status === 'fulfilled') {
          results.push(settled.value);
        } else {
          results.push({
            description: batch[i].description,
            agentId: batch[i].assignedAgent?.agentId,
            agentName: batch[i].assignedAgent?.agentName,
            status: 'error',
            error: settled.reason?.message || 'Unknown error',
            reply: null
          });
          this._stats.failedSubtasks++;
        }
      }
    }

    return results;
  }

  /**
   * Execute subtasks sequentially (order preserved).
   * In sequential mode, each subtask can access shared context from earlier subtasks.
   * @private
   */
  async _executeSequential(assignments, fromAgentId, timeout, sharedNamespaceId, parentConversationId) {
    const results = [];

    for (const subtask of assignments) {
      try {
        const result = await this._executeSingle(subtask, fromAgentId, timeout, sharedNamespaceId, parentConversationId);
        results.push(result);
      } catch (err) {
        results.push({
          description: subtask.description,
          agentId: subtask.assignedAgent?.agentId,
          agentName: subtask.assignedAgent?.agentName,
          status: 'error',
          error: err.message,
          reply: null
        });
        this._stats.failedSubtasks++;
      }
    }

    return results;
  }

  /**
   * Execute a single subtask by sending to assigned agent via MessageRouter.
   * Includes shared context injection and result storage (Roadmap 5.5).
   * @private
   */
  async _executeSingle(subtask, fromAgentId, timeout, sharedNamespaceId, parentConversationId) {
    this._stats.totalSubtasks++;

    if (!subtask.assignedAgent) {
      this._stats.skippedSubtasks++;
      return {
        description: subtask.description,
        status: 'skipped',
        reason: 'No agent available for skill: ' + subtask.requiredSkill,
        reply: null
      };
    }

    if (!this.messageRouter) {
      this._stats.failedSubtasks++;
      return {
        description: subtask.description,
        status: 'error',
        reason: 'MessageRouter not available',
        reply: null
      };
    }

    // Build message with shared context injection (Roadmap 5.5)
    let messageWithContext = subtask.description;
    if (sharedNamespaceId && this.sharedContext) {
      const summary = this.sharedContext.getSummary(sharedNamespaceId);
      if (summary) {
        messageWithContext = `${summary}\n\n---\n\n${subtask.description}`;
      }
    }

    const startTime = Date.now();

    try {
      const result = await this.messageRouter.sendMessage({
        from: fromAgentId,
        to: subtask.assignedAgent.agentId,
        message: messageWithContext,
        timeout: timeout,
        data: { planSubtask: true, skill: subtask.requiredSkill, sharedNamespaceId },
        parentConversationId: parentConversationId  // Link child job to parent for restart resume
      });

      const latency = Date.now() - startTime;
      this._stats.successfulSubtasks++;

      this.logger.info('TaskPlanner', `Subtask completed by ${subtask.assignedAgent.agentName} (${latency}ms): "${sanitizeForLog(subtask.description, 60)}"`);

      // Store result as fact in shared context (Roadmap 5.5)
      const reply = result.reply || '';
      if (sharedNamespaceId && this.sharedContext && reply) {
        const factKey = 'result_' + subtask.requiredSkill + '_' + subtask.assignedAgent.agentId.substring(0, 8);
        // Use extractKeyFact for concise summary instead of raw truncation
        const factValue = typeof this.sharedContext.extractKeyFact === 'function'
          ? this.sharedContext.extractKeyFact(reply, 500)
          : reply.substring(0, 500);
        this.sharedContext.set(
          sharedNamespaceId,
          factKey,
          factValue,
          subtask.assignedAgent.agentId
        );
      }

      return {
        description: subtask.description,
        agentId: subtask.assignedAgent.agentId,
        agentName: subtask.assignedAgent.agentName,
        status: 'ok',
        reply,
        messageId: result.messageId,
        latency
      };
    } catch (err) {
      this._stats.failedSubtasks++;
      this.logger.warn('TaskPlanner', `Subtask failed (${subtask.assignedAgent.agentName}): ${sanitizeForLog(err.message, 100)}`);

      return {
        description: subtask.description,
        agentId: subtask.assignedAgent.agentId,
        agentName: subtask.assignedAgent.agentName,
        status: 'error',
        error: err.message,
        reply: null,
        latency: Date.now() - startTime
      };
    }
  }

  /**
   * Synthesize results from multiple agents into a summary.
   * @private
   */
  _synthesize(taskDescription, results) {
    const successful = results.filter(r => r.status === 'ok');
    const failed = results.filter(r => r.status === 'error');
    const skipped = results.filter(r => r.status === 'skipped');

    let summary = `**Task Plan Results** (${successful.length} completed`;
    if (failed.length > 0) summary += `, ${failed.length} failed`;
    if (skipped.length > 0) summary += `, ${skipped.length} skipped`;
    summary += ')\n\n';

    for (const result of results) {
      if (result.status === 'ok') {
        const latencyStr = result.latency ? ` (${result.latency}ms)` : '';
        summary += `**${result.agentName}**${latencyStr} — ${result.description.substring(0, 80)}\n`;
        summary += result.reply ? result.reply + '\n\n' : '(no reply)\n\n';
      } else if (result.status === 'error') {
        summary += `**${result.agentName || 'Unknown'}** — ${result.description.substring(0, 80)}\nError: ${result.error}\n\n`;
      } else if (result.status === 'skipped') {
        summary += `**Skipped** — ${result.description.substring(0, 80)}\nReason: ${result.reason}\n\n`;
      }
    }

    return {
      totalSubtasks: results.length,
      successful: successful.length,
      failed: failed.length,
      skipped: skipped.length,
      summary: summary.trim()
    };
  }

  /**
   * Get plan by ID.
   */
  getPlan(planId) {
    return this.activePlans.get(planId) || null;
  }

  /**
   * List active plans.
   */
  listPlans() {
    return Array.from(this.activePlans.values()).map(p => ({
      planId: p.planId,
      task: p.task.substring(0, 80),
      status: p.status,
      strategy: p.strategy || 'sequential',
      subtaskCount: p.subtasks.length,
      createdAt: p.createdAt,
      completedAt: p.completedAt || null,
      totalLatency: p.totalLatency || null
    }));
  }

  /**
   * Get planner statistics.
   */
  getStats() {
    return {
      ...this._stats,
      activePlans: Array.from(this.activePlans.values()).filter(p => p.status === 'executing').length,
      totalTrackedPlans: this.activePlans.size,
      maxConcurrency: this.maxConcurrency,
      defaultTimeout: this.defaultTimeout,
      maxSubtasks: this.maxSubtasks
    };
  }

  /**
   * Shutdown — clear state.
   */
  shutdown() {
    this.activePlans.clear();
    this.logger.info('TaskPlanner', 'Shutdown');
  }
}

module.exports = TaskPlanner;
