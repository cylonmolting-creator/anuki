/**
 * ANUKI COGNITIVE MEMORY SYSTEM
 * 
 * Inspired by CoALA (Cognitive Architectures for Language Agents)
 * and Letta/MemGPT's self-editing memory.
 * 
 * Three memory types:
 *   1. EPISODIC  — What happened (events, conversations, outcomes)
 *   2. SEMANTIC  — What I know (facts, rules, patterns extracted from episodes)
 *   3. PROCEDURAL — How to do things (learned workflows, skills, preferences)
 * 
 * Key innovations:
 *   - Self-editing: Agent decides what to remember/forget via tools
 *   - Reflection: Nightly job distills episodes into semantic knowledge
 *   - Importance scoring: Memories decay unless reinforced
 *   - Cue-based retrieval: Context-aware memory search
 */

const fs = require('fs');
const path = require('path');

class CognitiveMemory {
  constructor(baseDir, logger) {
    this.baseDir = baseDir || require('../utils/base-dir');
    this.logger = logger;
    
    // Memory directories
    this.dirs = {
      episodic:   path.join(this.baseDir, 'memory', 'episodic'),
      semantic:   path.join(this.baseDir, 'memory', 'semantic'),
      procedural: path.join(this.baseDir, 'memory', 'procedural'),
      sessions:   path.join(this.baseDir, 'sessions', 'active'),
      core:       path.join(this.baseDir, 'memory')
    };

    // Ensure all directories exist
    Object.values(this.dirs).forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    // Core memory file (always in context, like MemGPT)
    this.coreMemoryFile = path.join(this.baseDir, 'MEMORY.md');
    
    // In-memory index for fast search
    this.index = {
      episodic: [],
      semantic: [],
      procedural: []
    };

    // TF-IDF: Document frequency table (word occurrence count across documents)
    this.documentFrequency = {};
    this.totalDocuments = 0;

    // N-gram index (for bigram-based fuzzy matching)
    this.ngramIndex = new Map(); // ngram -> Set<entryId>

    // Multilingual synonym/alias map (semantic proximity without embeddings)
    this.synonyms = this._buildSynonymMap();

    // Cross-channel identity matching (OpenClaw identityLinks)
    this.identityLinks = this._loadIdentityLinks();

    // Search instrumentation (3.2)
    this._searchStats = {
      totalQueries: 0,
      totalTimeMs: 0,
      slowQueries: 0,       // queries > 100ms
      cacheHits: 0,
      cacheMisses: 0,
      lastQueryMs: 0,
      maxQueryMs: 0,
      recentSlow: []         // last 10 slow queries [{query, timeMs, resultCount, timestamp}]
    };

    // LRU cache for search results (max 100 entries, 60s TTL)
    this._searchCache = new Map();
    this._searchCacheMaxSize = 100;
    this._searchCacheTTL = 60 * 1000; // 60 seconds

    // Load existing memories into index
    this._buildIndex();

    // Run integrity check on startup
    this._integrityReport = this.checkIntegrity();

    this.log('CognitiveMemory initialized',
      `E:${this.index.episodic.length} S:${this.index.semantic.length} P:${this.index.procedural.length} healthy=${this._integrityReport.healthy}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // CORE MEMORY — Always in context window (like MemGPT core memory)
  // ═══════════════════════════════════════════════════════════════

  getCoreMemory() {
    // Return cached version if available (invalidated on update)
    if (this._coreMemoryCache !== undefined) return this._coreMemoryCache;
    try {
      if (fs.existsSync(this.coreMemoryFile)) {
        this._coreMemoryCache = fs.readFileSync(this.coreMemoryFile, 'utf8');
        return this._coreMemoryCache;
      }
    } catch (e) { /* File missing or unreadable — return empty */ }
    this._coreMemoryCache = '';
    return '';
  }

  updateCoreMemory(newContent) {
    try {
      // Atomic write: write to temp file then rename (prevents corruption on crash)
      const tmpFile = this.coreMemoryFile + '.tmp';
      fs.writeFileSync(tmpFile, newContent, 'utf8');
      fs.renameSync(tmpFile, this.coreMemoryFile);
      this._coreMemoryCache = newContent; // Update cache
      this.log('Core memory updated');
      return true;
    } catch (e) {
      this.log('Core memory update failed: ' + e.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // EPISODIC MEMORY — Specific events and interactions
  // ═══════════════════════════════════════════════════════════════

  /**
   * Store an episode (a conversation turn with context)
   *
   * @param {object} episode - { type, channel, user, input, output, context, outcome, emotions, importance, tags, goal, steps, stepContext }
   * @param {object} episode.stepContext - (9.2) Multi-step task memory with constraints and solutions
   *   - goal: Overall objective of the task
   *   - constraints: Array of limitations/requirements (e.g., "API rate limit 100/min", "must complete in 5 min")
   *   - attemptedSolutions: Array of things tried and why they failed/succeeded
   *   - outcome: Final result of the task (success/partial/failure)
   */
  storeEpisode(episode) {
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      type: episode.type || 'conversation',    // conversation, action, observation, error
      channel: episode.channel || 'unknown',
      user: episode.user || 'unknown',
      input: episode.input || '',
      output: episode.output || '',
      context: episode.context || {},           // situational context
      outcome: episode.outcome || null,         // success/failure/partial
      emotions: episode.emotions || null,       // user sentiment detected
      importance: episode.importance || 5,      // 1-10 scale
      tags: episode.tags || [],
      goal: episode.goal || null,               // multi-step: overall goal/task
      steps: episode.steps || [],               // multi-step: [{index, action, result, timestamp}]
      stepCount: (episode.steps || []).length,  // for quick access
      stepContext: episode.stepContext || null, // (9.2) Multi-step task memory: {goal, constraints, attemptedSolutions, outcome}
      accessCount: 0,
      lastAccessed: null,
      decayFactor: 1.0                          // starts at 1.0, decays over time
    };

    // Write to daily file
    const dateStr = new Date().toISOString().split('T')[0];
    const filePath = path.join(this.dirs.episodic, dateStr + '.jsonl');

    try {
      // Non-blocking write — index immediately, disk write in background
      const line = JSON.stringify(entry) + '\n';
      fs.promises.appendFile(filePath, line, 'utf8').catch(err => {
        this.log('Episode write failed (async): ' + err.message);
      });
      const indexed = this._indexEntry(entry, 'episodic');
      this.index.episodic.push(indexed);
      this._updateDocumentFrequency(indexed);
      this.invalidateSearchCache();
      this.log('Episode stored', entry.id + (entry.stepContext ? ' (with step context)' : ''));
      return entry.id;
    } catch (e) {
      this.log('Episode store failed: ' + e.message);
      return null;
    }
  }

  /**
   * Add a step to an ongoing multi-step task
   * Called during task execution to log intermediate progress
   *
   * @param {string} episodeId - The episode ID this step belongs to
   * @param {object} step - { index, action, result, constraints, attemptedSolutions, timestamp }
   */
  addStep(episodeId, step) {
    try {
      // Find the episode in memory
      const episode = this.index.episodic.find(e => e.id === episodeId);
      if (!episode) {
        this.log('addStep: Episode not found', episodeId);
        return false;
      }

      // Ensure steps array exists
      if (!episode.steps) episode.steps = [];

      // Normalize step
      const stepEntry = {
        index: step.index || episode.steps.length,
        action: step.action || 'unknown',
        result: step.result || null,
        constraints: step.constraints || {},  // e.g., { maxTokens: 100, deadline: '2026-02-15T06:00:00Z' }
        attemptedSolutions: step.attemptedSolutions || [],  // [{ try, error, alternativeConsidered }]
        timestamp: step.timestamp || new Date().toISOString(),
        duration_ms: step.duration_ms || 0,
        success: step.success || (step.result !== null && step.result !== 'error')
      };

      episode.steps.push(stepEntry);
      episode.stepCount = episode.steps.length;

      // Also need to persist back to disk (update the daily JSONL file)
      this._updateEpisodeOnDisk(episode);

      this.log('Step added', `${episodeId}:step${stepEntry.index}`);
      return true;
    } catch (e) {
      this.log('addStep failed: ' + e.message);
      return false;
    }
  }

  /**
   * Get all steps for an episode (for retrieval during task execution)
   */
  getEpisodeSteps(episodeId) {
    const episode = this.index.episodic.find(e => e.id === episodeId);
    if (!episode) return [];
    return episode.steps || [];
  }

  /**
   * Cleanup old steps from completed tasks
   * Called periodically to keep episodic memory lean
   *
   * @param {object} options - { maxStepsPerEpisode: 10, minAgeMs: 7200000 }
   */
  // cleanupOldSteps — see authoritative implementation below (~line 1800+)

  /**
   * (9.2) Clean up old low-importance episodes and episodes without stepContext
   *
   * Removes episodes that:
   * - Have importance < 2 (very low value)
   * - Are older than 7 days AND have not been accessed in 24 hours
   * - Are orphaned (no stepContext AND outcome not success)
   */
  cleanupOldEpisodes(options = {}) {
    const minImportance = options.minImportance || 2;
    const maxAgeDays = options.maxAgeDays || 7;
    const minLastAccessAgeHours = options.minLastAccessAgeHours || 24;

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const minAccessAgeMs = minLastAccessAgeHours * 60 * 60 * 1000;

    let removed = 0;

    // Iterate through all episodic files
    const episodicDir = this.dirs.episodic;
    try {
      if (!fs.existsSync(episodicDir)) return { removed: 0 };

      const files = fs.readdirSync(episodicDir).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(episodicDir, file);
        let lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
        const filtered = [];

        for (const line of lines) {
          try {
            const episode = JSON.parse(line);
            const episodeAge = now - new Date(episode.timestamp).getTime();
            const lastAccessAge = episode.lastAccessed
              ? now - new Date(episode.lastAccessed).getTime()
              : episodeAge; // If never accessed, treat as never accessed

            // Keep episodes with high importance
            if (episode.importance >= minImportance) {
              filtered.push(line);
              continue;
            }

            // Remove very old AND unaccessed episodes
            if (episodeAge > maxAgeMs && lastAccessAge > minAccessAgeMs) {
              removed++;
              continue;
            }

            // Keep stepContext episodes (they're valuable for learning)
            if (episode.stepContext) {
              filtered.push(line);
              continue;
            }

            // Keep episodes with successful outcomes
            if (episode.outcome === 'success') {
              filtered.push(line);
              continue;
            }

            // Everything else is kept (err on side of retention)
            filtered.push(line);
          } catch (e) {
            // Keep unparseable lines
            filtered.push(line);
          }
        }

        // Write back cleaned file
        if (filtered.length < lines.length) {
          fs.writeFileSync(filePath, filtered.join('\n') + (filtered.length > 0 ? '\n' : ''), 'utf8');
        }
      }

      if (removed > 0) {
        this.log('Cleanup old episodes', `${removed} low-importance old episodes removed`);
      }
      return { removed };
    } catch (e) {
      this.log('cleanupOldEpisodes failed: ' + e.message);
      return { removed: 0 };
    }
  }

  /**
   * Internal: Update an episode's entry on disk (append-only JSONL)
   * Since JSONL is append-only, we remove the old entry and append the updated one
   */
  _updateEpisodeOnDisk(episode) {
    try {
      const dateStr = episode.timestamp.split('T')[0];
      const filePath = path.join(this.dirs.episodic, dateStr + '.jsonl');

      if (!fs.existsSync(filePath)) return false;

      // Read all lines, filter out the old episode, write back with updated one
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
      const filtered = lines.filter(line => {
        try {
          const entry = JSON.parse(line);
          return entry.id !== episode.id;
        } catch {
          return true; // Keep unparseable lines
        }
      });

      // Atomic write: temp file + rename to prevent data loss on concurrent access
      const updatedContent = filtered.join('\n') + (filtered.length > 0 ? '\n' : '') + JSON.stringify(episode) + '\n';
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, updatedContent, 'utf8');
      fs.renameSync(tmpFile, filePath);

      return true;
    } catch (e) {
      this.log('_updateEpisodeOnDisk failed: ' + e.message);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SEMANTIC MEMORY — Facts, rules, patterns (distilled from episodes)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Store a semantic fact or learned pattern
   */
  storeSemantic(fact) {
    const entry = {
      id: 'sem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      category: fact.category || 'general',     // user_pref, world_fact, pattern, rule
      content: fact.content,                     // the actual knowledge
      confidence: fact.confidence || 0.8,        // 0-1, how sure we are
      source: fact.source || 'observation',      // observation, reflection, told_by_user
      sourceEpisodes: fact.sourceEpisodes || [], // which episodes led to this
      importance: fact.importance || 5,
      tags: fact.tags || [],
      accessCount: 0,
      lastAccessed: null,
      supersedes: fact.supersedes || null,       // ID of fact this replaces
      valid: true                                // can be invalidated later
    };

    const filePath = path.join(this.dirs.semantic, 'knowledge.jsonl');
    
    try {
      // If superseding, invalidate old fact
      if (entry.supersedes) {
        this._invalidateSemantic(entry.supersedes);
      }
      
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
      const indexed = this._indexEntry(entry, 'semantic');
      this.index.semantic.push(indexed);
      this._updateDocumentFrequency(indexed);
      this.invalidateSearchCache();
      this.log('Semantic stored', entry.id + ': ' + entry.content.substring(0, 60));
      return entry.id;
    } catch (e) {
      this.log('Semantic store failed: ' + e.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PROCEDURAL MEMORY — Learned skills and workflows
  // ═══════════════════════════════════════════════════════════════

  /**
   * Store a learned procedure/skill
   */
  storeProcedural(procedure) {
    const entry = {
      id: 'proc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      name: procedure.name,                      // e.g., "token_research", "check_rug"
      description: procedure.description || '',
      steps: procedure.steps || [],              // ordered steps
      triggerPatterns: procedure.triggers || [],  // when to activate this procedure
      successRate: procedure.successRate || null, // tracked over time
      timesUsed: 0,
      lastUsed: null,
      importance: procedure.importance || 5,
      tags: procedure.tags || [],
      version: 1
    };

    const filePath = path.join(this.dirs.procedural, 'skills.jsonl');
    
    try {
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
      const indexed = this._indexEntry(entry, 'procedural');
      this.index.procedural.push(indexed);
      this._updateDocumentFrequency(indexed);
      this.invalidateSearchCache();
      this.log('Procedural stored', entry.id + ': ' + entry.name);
      return entry.id;
    } catch (e) {
      this.log('Procedural store failed: ' + e.message);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SEARCH — Find relevant memories across all types
  // ═══════════════════════════════════════════════════════════════

  /**
   * Advanced hybrid search: TF-IDF + n-gram fuzzy + synonym expansion
   * Close to OpenClaw's embedding(70%)+BM25(30%) model, without embeddings
   */
  search(query, options = {}) {
    const startTime = Date.now();
    try {
      const maxResults = options.maxResults || 10;
      const types = options.types || ['episodic', 'semantic', 'procedural'];
      const minImportance = options.minImportance || 0;

      const queryTokens = this._tokenize(query);
      if (queryTokens.length === 0) return [];

      // Check LRU cache
      const cacheKey = query + '|' + maxResults + '|' + types.join(',') + '|' + minImportance;
      const cached = this._searchCacheGet(cacheKey);
      if (cached) {
        this._searchStats.cacheHits++;
        this._recordSearchTiming(startTime, query, cached.length, true);
        return cached;
      }
      this._searchStats.cacheMisses++;

      // Synonym expansion: sorguyu genislet
      const expandedTokens = this._expandWithSynonyms(queryTokens);

      let results = [];

      for (const type of types) {
        const entries = this.index[type] || [];

        for (const entry of entries) {
          if (entry.importance < minImportance) continue;
          if (entry.valid === false) continue;

          // Hybrid score: TF-IDF(50%) + N-gram fuzzy(30%) + exact(20%)
          const tfidfScore = this._calculateTFIDF(expandedTokens, entry);
          const ngramScore = this._calculateNgramSimilarity(query, entry);
          const exactScore = this._calculateExactMatch(queryTokens, entry);

          const score = (tfidfScore * 0.50) + (ngramScore * 0.30) + (exactScore * 0.20);

          if (score > 0.01) {
            // Type boost: semantic > procedural > episodic
            const typeBoost = type === 'semantic' ? 1.2 : type === 'procedural' ? 1.1 : 1.0;

            results.push({
              id: entry.id,
              type,
              score: score * typeBoost,
              content: entry.searchText.substring(0, 300),
              importance: entry.importance,
              timestamp: entry.timestamp,
              tags: entry.tags || []
            });
          }
        }
      }

      // Sort by combined score (relevance * importance * recency)
      results.sort((a, b) => {
        const scoreA = a.score * a.importance * this._recencyBoost(a.timestamp);
        const scoreB = b.score * b.importance * this._recencyBoost(b.timestamp);
        return scoreB - scoreA;
      });

      // Mark accessed
      const topResults = results.slice(0, maxResults);
      topResults.forEach(r => this._markAccessed(r.id, r.type));

      // Store in LRU cache
      this._searchCacheSet(cacheKey, topResults);

      // Record timing
      this._recordSearchTiming(startTime, query, topResults.length, false);

      return topResults;
    } catch (e) {
      this._recordSearchTiming(startTime, query, 0, false);
      this.log('Search failed', e.message);
      return [];
    }
  }

  /**
   * Get context-relevant memories for a conversation turn
   * This is called before each Claude API call
   */
  getContextualMemories(userMessage, sessionHistory = []) {
    const memories = {
      core: '',
      relevant: [],
      recentEpisodes: [],
      applicableProcedures: []
    };

    try {
      memories.core = this.getCoreMemory();
      memories.relevant = this.search(userMessage, { maxResults: 5 });
      memories.recentEpisodes = this._getRecentEpisodes(24);
      memories.applicableProcedures = this._matchProcedures(userMessage);
    } catch (e) {
      this.log('getContextualMemories failed', e.message);
    }

    return memories;
  }

  // =================================================================
  // CROSS-CHANNEL IDENTITY — OpenClaw identityLinks modeli
  // =================================================================

  /**
   * Match the same user across different channels
   * Example: webchat-123 = webchat-456 (same user, different sessions)
   */
  linkIdentity(channel1, userId1, channel2, userId2) {
    const key1 = channel1 + '-' + userId1;
    const key2 = channel2 + '-' + userId2;

    // Find existing group or create new one
    let groupId = this.identityLinks[key1] || this.identityLinks[key2] || ('ig_' + Date.now().toString(36));

    this.identityLinks[key1] = groupId;
    this.identityLinks[key2] = groupId;

    this._saveIdentityLinks();
    this.log('Identity linked', key1 + ' <-> ' + key2 + ' (group: ' + groupId + ')');
    return groupId;
  }

  /**
   * Get all channel identities for a user
   */
  getLinkedIdentities(channel, userId) {
    const key = channel + '-' + userId;
    const groupId = this.identityLinks[key];
    if (!groupId) return [key];

    return Object.entries(this.identityLinks)
      .filter(([_, gid]) => gid === groupId)
      .map(([k, _]) => k);
  }

  /**
   * Load cross-channel session — also fetch this user's sessions from other channels
   */
  loadCrossChannelContext(channel, userId) {
    const linkedIds = this.getLinkedIdentities(channel, userId);
    const contexts = [];

    for (const linkedKey of linkedIds) {
      const [ch, uid] = linkedKey.split('-');
      if (ch === channel && uid === userId) continue; // Skip self

      const session = this.loadPersistedSession(ch, uid);
      if (session.messages && session.messages.length > 0) {
        const lastMsg = session.messages[session.messages.length - 1];
        contexts.push({
          channel: ch,
          lastActivity: lastMsg.timestamp,
          messageCount: session.messages.length,
          recentTopics: session.messages.slice(-3).map(m => (m.content || '').substring(0, 80))
        });
      }
    }

    return contexts;
  }

  _loadIdentityLinks() {
    const filePath = path.join(this.baseDir, 'memory', 'identity-links.json');
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch (e) {
      this.log('Identity links load failed', e.message);
    }
    return {};
  }

  _saveIdentityLinks() {
    const filePath = path.join(this.baseDir, 'memory', 'identity-links.json');
    try {
      fs.writeFileSync(filePath, JSON.stringify(this.identityLinks, null, 2), 'utf8');
    } catch (e) {
      this.log('Identity links save failed', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // REFLECTION — Distill episodes into semantic knowledge
  // ═══════════════════════════════════════════════════════════════

  /**
   * Generate a reflection prompt for Claude to process
   * This runs as a nightly job or when session ends
   */
  generateReflectionPrompt(dateStr) {
    const targetDate = dateStr || new Date().toISOString().split('T')[0];
    const episodes = this._loadEpisodesForDate(targetDate);
    
    if (episodes.length === 0) return null;

    const existingSemantic = this._loadAllSemantic().filter(s => s.valid !== false);
    
    const prompt = {
      system: `You are the memory manager. Analyze today's conversations and extract persistent knowledge.

EXISTING KNOWLEDGE (semantic memory):
${existingSemantic.map(s => '- [' + s.category + '] ' + s.content).join('\n')}

TODAY'S CONVERSATIONS (${episodes.length} episodes):
${episodes.map(e => '[' + e.timestamp + '] ' + e.user + ': ' + e.input + '\nAgent: ' + (e.output || '').substring(0, 200)).join('\n---\n')}

TASK:
1. Extract persistent knowledge (user preferences, learned facts, recurring patterns)
2. Identify new information that contradicts existing knowledge (supersedes)
3. Identify new workflows/skills learned
4. Rate each with importance (1-10) and confidence (0-1)

Respond in JSON:
{
  "semantic": [
    { "category": "user_pref|world_fact|pattern|rule", "content": "...", "importance": 7, "confidence": 0.9, "supersedes": null, "tags": [] }
  ],
  "procedural": [
    { "name": "...", "description": "...", "steps": ["..."], "triggers": ["..."], "importance": 6, "tags": [] }
  ],
  "coreMemoryUpdates": [
    { "section": "About User|Key Decisions|Preferences|...", "action": "add|update|remove", "content": "..." }
  ],
  "insights": "Brief summary of the day and notable patterns"
}`,
      userMessage: 'Analyze today\'s conversations and extract persistent knowledge.'
    };

    return prompt;
  }

  /**
   * Process reflection results from Claude
   */
  processReflection(reflectionResult) {
    let processed = { semantic: 0, procedural: 0, coreUpdates: 0 };
    
    try {
      const data = typeof reflectionResult === 'string' 
        ? JSON.parse(reflectionResult) 
        : reflectionResult;

      // Store new semantic memories
      if (data.semantic && Array.isArray(data.semantic)) {
        for (const fact of data.semantic) {
          this.storeSemantic({
            ...fact,
            source: 'reflection'
          });
          processed.semantic++;
        }
      }

      // Store new procedural memories
      if (data.procedural && Array.isArray(data.procedural)) {
        for (const proc of data.procedural) {
          this.storeProcedural(proc);
          processed.procedural++;
        }
      }

      // Update core memory
      if (data.coreMemoryUpdates && Array.isArray(data.coreMemoryUpdates)) {
        for (const update of data.coreMemoryUpdates) {
          this._applyCoreMemoryUpdate(update);
          processed.coreUpdates++;
        }
      }

      this.log('Reflection processed', JSON.stringify(processed));
      return processed;
    } catch (e) {
      this.log('Reflection processing failed: ' + e.message);
      return processed;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // DECAY — Natural forgetting of unimportant memories
  // ═══════════════════════════════════════════════════════════════

  /**
   * Apply decay to all memories
   * Run periodically (e.g., daily)
   */
  applyDecay() {
    try {
      const decayRate = 0.95;  // lose 5% importance per day
      const minImportance = 1;
      let decayed = 0;
      let forgotten = 0;

      // Decay episodic memories
      for (const entry of this.index.episodic) {
        const daysSince = (Date.now() - new Date(entry.timestamp).getTime()) / (1000 * 60 * 60 * 24);

        // Recent accesses slow down decay (access boost makes effective days smaller)
        // accessCount=5 → divisor=1.5 → decay is 1.5x slower
        const accessResistance = 1 + Math.min(entry.accessCount * 0.1, 1.0);
        const effectiveDays = daysSince / accessResistance;
        const effectiveDecay = Math.pow(decayRate, effectiveDays);

        const newImportance = Math.max(minImportance, entry.originalImportance * effectiveDecay);

        if (newImportance < 2 && entry.importance >= 2) {
          forgotten++;
        }

        entry.importance = Math.round(newImportance * 10) / 10;
        decayed++;
      }

      this.log('Decay applied', `${decayed} entries processed, ${forgotten} fading`);
      return { decayed, forgotten };
    } catch (e) {
      this.log('Decay failed', e.message);
      return { decayed: 0, forgotten: 0, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MEMORY TOOLS — For Claude to self-edit memory
  // ═══════════════════════════════════════════════════════════════

  /**
   * Returns tool definitions for Claude API
   */
  getMemoryTools() {
    return [
      {
        name: 'memory_store',
        description: 'Store important information in persistent memory. Use to save user preferences, learned facts, or recurring patterns.',
        input_schema: {
          type: 'object',
          properties: {
            memoryType: {
              type: 'string',
              enum: ['semantic', 'procedural'],
              description: 'semantic: knowledge/fact/preference, procedural: learned skill/workflow'
            },
            content: {
              type: 'string',
              description: 'Information to store'
            },
            category: {
              type: 'string',
              enum: ['user_pref', 'world_fact', 'pattern', 'rule', 'skill'],
              description: 'Information category'
            },
            importance: {
              type: 'number',
              description: 'Importance level (1-10)'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags (for search)'
            }
          },
          required: ['memoryType', 'content', 'importance']
        }
      },
      {
        name: 'memory_search',
        description: 'Search memory. Search across past conversations, learned information, and skills.',
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Topic/keyword to search for'
            },
            types: {
              type: 'array',
              items: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
              description: 'Memory types to search'
            },
            maxResults: {
              type: 'number',
              description: 'Maximum number of results (default: 5)'
            }
          },
          required: ['query']
        }
      },
      {
        name: 'memory_update_core',
        description: 'Update core memory file (MEMORY.md). Store important persistent knowledge about the user.',
        input_schema: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              description: 'Section to update (About User, Preferences, Projects, etc.)'
            },
            action: {
              type: 'string',
              enum: ['add', 'update', 'remove'],
              description: 'Action to perform'
            },
            content: {
              type: 'string',
              description: 'Content to add/update'
            }
          },
          required: ['section', 'action', 'content']
        }
      },
      {
        name: 'memory_forget',
        description: 'Mark a memory record as invalid. Use to forget incorrect or outdated information.',
        input_schema: {
          type: 'object',
          properties: {
            memoryId: {
              type: 'string',
              description: 'ID of the memory record to forget'
            },
            reason: {
              type: 'string',
              description: 'Reason for forgetting'
            }
          },
          required: ['memoryId', 'reason']
        }
      }
    ];
  }

  /**
   * Execute a memory tool call from Claude
   */
  executeMemoryTool(toolName, input) {
    switch (toolName) {
      case 'memory_store':
        if (input.memoryType === 'semantic') {
          return this.storeSemantic({
            content: input.content,
            category: input.category || 'general',
            importance: input.importance || 5,
            tags: input.tags || [],
            source: 'agent_decision'
          });
        } else if (input.memoryType === 'procedural') {
          return this.storeProcedural({
            name: input.category || 'skill',
            description: input.content,
            importance: input.importance || 5,
            tags: input.tags || []
          });
        }
        break;

      case 'memory_search':
        return this.search(input.query, {
          types: input.types || ['episodic', 'semantic', 'procedural'],
          maxResults: input.maxResults || 5
        });

      case 'memory_update_core':
        return this._applyCoreMemoryUpdate(input);

      case 'memory_forget':
        return this._invalidateMemory(input.memoryId, input.reason);

      default:
        return { error: 'Unknown memory tool: ' + toolName };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SESSION PERSISTENCE — Survive restarts
  // ═══════════════════════════════════════════════════════════════

  /**
   * Save session to disk
   */
  persistSession(channel, userId, session) {
    // Sanitize to prevent path traversal (strip anything except alphanumeric, dash, underscore, dot)
    const safeChannel = String(channel).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const key = safeChannel + '-' + safeUserId;
    const filePath = path.join(this.dirs.sessions, key + '.json');
    // Double-check: resolved path must be inside sessions dir
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.dirs.sessions) + path.sep)) {
      this.log('Session persist blocked: path traversal attempt');
      return false;
    }
    
    try {
      const data = {
        channel,
        userId,
        lastUpdated: new Date().toISOString(),
        messageCount: session.messages ? session.messages.length : 0,
        messages: session.messages || []
      };
      
      // Atomic write: temp file + rename
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpFile, filePath);
      return true;
    } catch (e) {
      this.log('Session persist failed: ' + e.message);
      return false;
    }
  }

  /**
   * Load session from disk
   */
  loadPersistedSession(channel, userId) {
    const safeChannel = String(channel).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const key = safeChannel + '-' + safeUserId;
    const filePath = path.join(this.dirs.sessions, key + '.json');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.dirs.sessions) + path.sep)) {
      this.log('Session load blocked: path traversal attempt');
      return { messages: [], created: new Date().toISOString() };
    }
    
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.log('Session loaded from disk', key + ' (' + (data.messageCount || 0) + ' msgs)');
        return data;
      }
    } catch (e) {
      this.log('Session load failed: ' + e.message);
    }
    
    return { messages: [], created: new Date().toISOString() };
  }

  // ═══════════════════════════════════════════════════════════════
  // STATS — Memory system overview
  // ═══════════════════════════════════════════════════════════════

  getStats() {
    try {
      // Token estimation (GPT-4 style: ~1.3 tokens per word)
      const episodicTokens = this.index.episodic.reduce((sum, e) => {
        const words = (e.searchText || '').split(/\s+/).length;
        return sum + Math.ceil(words * 1.3);
      }, 0);

      const semanticTokens = this.index.semantic
        .filter(s => s.valid !== false)
        .reduce((sum, s) => {
          const words = (s.searchText || '').split(/\s+/).length;
          return sum + Math.ceil(words * 1.3);
        }, 0);

      const proceduralTokens = this.index.procedural.reduce((sum, p) => {
        const words = (p.searchText || '').split(/\s+/).length;
        return sum + Math.ceil(words * 1.3);
      }, 0);

      const coreMemoryContent = this.getCoreMemory();
      const coreMemoryTokens = Math.ceil(coreMemoryContent.length / 4); // 1 token ≈ 4 chars

      const totalTokens = episodicTokens + semanticTokens + proceduralTokens + coreMemoryTokens;

      // Decay projections — estimate when memories will fade below importance threshold
      const now = Date.now();
      const decayRate = 0.95; // 5% per day (from applyDecay)
      const decayingMemories = this.index.episodic.filter(e => {
        const daysSince = (now - new Date(e.timestamp).getTime()) / (1000 * 60 * 60 * 24);
        const projectedImportance = (e.originalImportance || e.importance) * Math.pow(decayRate, daysSince);
        return projectedImportance < 3 && projectedImportance >= 2; // fading soon
      });

      // Calculate days until 50% of current memories fade below threshold
      const avgImportance = this.index.episodic.reduce((sum, e) => sum + e.importance, 0) / Math.max(1, this.index.episodic.length);
      const daysUntil50Fade = avgImportance > 2 ? Math.log(2 / avgImportance) / Math.log(decayRate) : 0;

      // Warning if >80% capacity (arbitrary threshold: 10k tokens per type)
      const capacityThresholds = {
        episodic: 10000,
        semantic: 5000,
        procedural: 2000,
        core: 8000
      };

      const warnings = [];
      if (episodicTokens > capacityThresholds.episodic * 0.8) {
        warnings.push(`Episodic memory at ${Math.round(episodicTokens / capacityThresholds.episodic * 100)}% capacity`);
      }
      if (semanticTokens > capacityThresholds.semantic * 0.8) {
        warnings.push(`Semantic memory at ${Math.round(semanticTokens / capacityThresholds.semantic * 100)}% capacity`);
      }
      if (proceduralTokens > capacityThresholds.procedural * 0.8) {
        warnings.push(`Procedural memory at ${Math.round(proceduralTokens / capacityThresholds.procedural * 100)}% capacity`);
      }
      if (coreMemoryTokens > capacityThresholds.core * 0.8) {
        warnings.push(`Core memory at ${Math.round(coreMemoryTokens / capacityThresholds.core * 100)}% capacity`);
      }

      return {
        // Memory counts
        episodic: this.index.episodic.length,
        semantic: this.index.semantic.filter(s => s.valid !== false).length,
        procedural: this.index.procedural.length,
        totalMemories: this.index.episodic.length + this.index.semantic.length + this.index.procedural.length,

        // Timestamps
        oldestEpisode: this.index.episodic.length > 0 ? this.index.episodic[0].timestamp : null,
        newestEpisode: this.index.episodic.length > 0 ? this.index.episodic[this.index.episodic.length - 1].timestamp : null,

        // Token usage (Roadmap 10.4)
        tokens: {
          episodic: episodicTokens,
          semantic: semanticTokens,
          procedural: proceduralTokens,
          core: coreMemoryTokens,
          total: totalTokens
        },

        // Decay projections (Roadmap 10.4)
        decay: {
          fadingSoon: decayingMemories.length,
          avgImportance: Math.round(avgImportance * 10) / 10,
          daysUntil50Fade: Math.max(0, Math.round(daysUntil50Fade))
        },

        // Capacity warnings (Roadmap 10.4)
        warnings,
        capacityOk: warnings.length === 0,

        // Legacy fields
        coreMemorySize: coreMemoryContent.length,
        integrity: this._integrityReport ? { healthy: this._integrityReport.healthy, warnings: this._integrityReport.warnings.length } : null,
        search: this.getSearchStats()
      };
    } catch (e) {
      this.log('getStats failed', e.message);
      return { episodic: 0, semantic: 0, procedural: 0, totalMemories: 0, coreMemorySize: 0, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SEARCH INSTRUMENTATION — Timing, caching, slow query tracking
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get search performance stats
   */
  getSearchStats() {
    const s = this._searchStats;
    return {
      totalQueries: s.totalQueries,
      avgQueryMs: s.totalQueries > 0 ? Math.round(s.totalTimeMs / s.totalQueries * 100) / 100 : 0,
      maxQueryMs: s.maxQueryMs,
      lastQueryMs: s.lastQueryMs,
      slowQueries: s.slowQueries,
      cacheHits: s.cacheHits,
      cacheMisses: s.cacheMisses,
      cacheHitRate: (s.cacheHits + s.cacheMisses) > 0
        ? Math.round(s.cacheHits / (s.cacheHits + s.cacheMisses) * 100) : 0,
      cacheSize: this._searchCache.size,
      cacheMaxSize: this._searchCacheMaxSize,
      recentSlowQueries: s.recentSlow.slice(-10)
    };
  }

  /**
   * Record search timing and log slow queries
   */
  _recordSearchTiming(startTime, query, resultCount, fromCache) {
    const elapsed = Date.now() - startTime;
    const s = this._searchStats;

    s.totalQueries++;
    s.totalTimeMs += elapsed;
    s.lastQueryMs = elapsed;
    if (elapsed > s.maxQueryMs) s.maxQueryMs = elapsed;

    // Log slow queries (>100ms)
    if (elapsed > 100) {
      s.slowQueries++;
      s.recentSlow.push({
        query: (query || '').substring(0, 100),
        timeMs: elapsed,
        resultCount,
        fromCache,
        timestamp: new Date().toISOString()
      });
      // Keep only last 10
      if (s.recentSlow.length > 10) s.recentSlow.shift();
      this.log('Slow query', `${elapsed}ms "${(query || '').substring(0, 50)}" → ${resultCount} results${fromCache ? ' (cache)' : ''}`);
    }
  }

  /**
   * LRU cache get — returns null if expired or missing
   */
  _searchCacheGet(key) {
    const entry = this._searchCache.get(key);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.time > this._searchCacheTTL) {
      this._searchCache.delete(key);
      return null;
    }

    // LRU: move to end (most recently used)
    this._searchCache.delete(key);
    this._searchCache.set(key, entry);
    return entry.data;
  }

  /**
   * LRU cache set — evicts oldest entry if over max size
   */
  _searchCacheSet(key, data) {
    // Evict oldest if at capacity
    if (this._searchCache.size >= this._searchCacheMaxSize) {
      const oldestKey = this._searchCache.keys().next().value;
      this._searchCache.delete(oldestKey);
    }
    this._searchCache.set(key, { data, time: Date.now() });
  }

  /**
   * Invalidate search cache — call when memories change (store/delete)
   */
  invalidateSearchCache() {
    this._searchCache.clear();
  }

  // ═══════════════════════════════════════════════════════════════
  // INTEGRITY CHECK — Validate memory files on startup
  // ═══════════════════════════════════════════════════════════════

  /**
   * Validates memory file integrity on startup.
   * Checks: directories exist, JSONL files parseable, core memory readable.
   * Returns report object. Does NOT throw — logs warnings only.
   */
  checkIntegrity() {
    const report = {
      healthy: true,
      directories: { ok: 0, missing: 0, created: 0 },
      files: { ok: 0, corrupt: 0, repaired: 0 },
      corruptLines: 0,
      warnings: []
    };

    // 1. Check directories exist (create if missing)
    for (const [name, dir] of Object.entries(this.dirs)) {
      try {
        if (fs.existsSync(dir)) {
          report.directories.ok++;
        } else {
          fs.mkdirSync(dir, { recursive: true });
          report.directories.created++;
          report.warnings.push(`Created missing directory: ${name} (${dir})`);
        }
      } catch (e) {
        report.directories.missing++;
        report.healthy = false;
        report.warnings.push(`Cannot create directory ${name}: ${e.message}`);
      }
    }

    // 2. Check core memory file
    try {
      if (fs.existsSync(this.coreMemoryFile)) {
        const content = fs.readFileSync(this.coreMemoryFile, 'utf8');
        if (content.length === 0) {
          report.warnings.push('Core memory file (MEMORY.md) is empty');
        }
        report.files.ok++;
      } else {
        report.warnings.push('Core memory file (MEMORY.md) does not exist');
      }
    } catch (e) {
      report.files.corrupt++;
      report.healthy = false;
      report.warnings.push(`Core memory read failed: ${e.message}`);
    }

    // 3. Check JSONL files for parseable content
    const jsonlFiles = [
      { name: 'semantic', path: path.join(this.dirs.semantic, 'knowledge.jsonl') },
      { name: 'procedural', path: path.join(this.dirs.procedural, 'skills.jsonl') }
    ];

    // Add episodic daily files
    try {
      if (fs.existsSync(this.dirs.episodic)) {
        const eFiles = fs.readdirSync(this.dirs.episodic).filter(f => f.endsWith('.jsonl'));
        for (const f of eFiles) {
          jsonlFiles.push({ name: `episodic/${f}`, path: path.join(this.dirs.episodic, f) });
        }
      }
    } catch (e) {
      report.warnings.push(`Cannot list episodic directory: ${e.message}`);
    }

    for (const { name, path: filePath } of jsonlFiles) {
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        let fileCorrupt = 0;
        for (const line of lines) {
          try {
            JSON.parse(line);
          } catch (e) {
            fileCorrupt++;
            report.corruptLines++;
          }
        }
        if (fileCorrupt > 0) {
          report.warnings.push(`${name}: ${fileCorrupt}/${lines.length} corrupt lines`);
          report.files.corrupt++;
        } else {
          report.files.ok++;
        }
      } catch (e) {
        report.files.corrupt++;
        report.healthy = false;
        report.warnings.push(`Cannot read ${name}: ${e.message}`);
      }
    }

    // 4. Check identity links file
    const identityFile = path.join(this.baseDir, 'memory', 'identity-links.json');
    if (fs.existsSync(identityFile)) {
      try {
        JSON.parse(fs.readFileSync(identityFile, 'utf8'));
        report.files.ok++;
      } catch (e) {
        report.files.corrupt++;
        report.warnings.push(`identity-links.json corrupt: ${e.message}`);
      }
    }

    if (report.corruptLines > 0) {
      report.healthy = false;
    }

    this.log('Integrity check', `healthy=${report.healthy} dirs=${report.directories.ok}ok/${report.directories.missing}missing files=${report.files.ok}ok/${report.files.corrupt}corrupt corruptLines=${report.corruptLines}`);

    if (report.warnings.length > 0) {
      for (const w of report.warnings) {
        this.log('Integrity warning', w);
      }
    }

    return report;
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════

  _buildIndex() {
    let corruptLines = 0;

    // Index episodic memories
    try {
      const episodicDir = this.dirs.episodic;
      if (fs.existsSync(episodicDir)) {
        const files = fs.readdirSync(episodicDir).filter(f => f.endsWith('.jsonl')).sort();
        for (const file of files) {
          const lines = fs.readFileSync(path.join(episodicDir, file), 'utf8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const indexed = this._indexEntry(entry, 'episodic');
              this.index.episodic.push(indexed);
              this._updateDocumentFrequency(indexed);
            } catch (e) { corruptLines++; }
          }
        }
      }
    } catch (e) {
      this.log('Episodic index build failed', e.message);
    }

    // Index semantic memories
    try {
      const semFile = path.join(this.dirs.semantic, 'knowledge.jsonl');
      if (fs.existsSync(semFile)) {
        const lines = fs.readFileSync(semFile, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const indexed = this._indexEntry(entry, 'semantic');
            this.index.semantic.push(indexed);
            this._updateDocumentFrequency(indexed);
          } catch (e) { corruptLines++; }
        }
      }
    } catch (e) {
      this.log('Semantic index build failed', e.message);
    }

    // Index procedural memories
    try {
      const procFile = path.join(this.dirs.procedural, 'skills.jsonl');
      if (fs.existsSync(procFile)) {
        const lines = fs.readFileSync(procFile, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const indexed = this._indexEntry(entry, 'procedural');
            this.index.procedural.push(indexed);
            this._updateDocumentFrequency(indexed);
          } catch (e) { corruptLines++; }
        }
      }
    } catch (e) {
      this.log('Procedural index build failed', e.message);
    }

    if (corruptLines > 0) {
      this.log('Index build warnings', `${corruptLines} corrupt JSONL lines skipped`);
    }
  }

  _indexEntry(entry, type) {
    let searchText = '';

    switch (type) {
      case 'episodic':
        // (9.2) Include stepContext in search text for better multi-step task memory retrieval
        const stepContextText = entry.stepContext
          ? [entry.stepContext.goal, (entry.stepContext.constraints || []).join(' '), (entry.stepContext.attemptedSolutions || []).map(s => s.solution).join(' ')].join(' ')
          : '';
        searchText = [entry.input, entry.output, (entry.tags || []).join(' '), stepContextText].join(' ');
        break;
      case 'semantic':
        searchText = [entry.content, entry.category, (entry.tags || []).join(' ')].join(' ');
        break;
      case 'procedural':
        searchText = [entry.name, entry.description, (entry.steps || []).join(' '), (entry.tags || []).join(' ')].join(' ');
        break;
    }

    const lowerText = searchText.toLowerCase();
    const tokens = this._tokenize(searchText);

    // Precompute token frequency map for O(1) lookups in TF-IDF/exactMatch
    const tokenFreq = {};
    for (const t of tokens) {
      tokenFreq[t] = (tokenFreq[t] || 0) + 1;
    }

    // Precompute n-gram set for O(1) lookups in ngramSimilarity
    const ngramSet = new Set(this._generateNgrams(lowerText, 2));

    return {
      id: entry.id,
      timestamp: entry.timestamp,
      importance: entry.importance || 5,
      originalImportance: entry.importance || 5,
      accessCount: entry.accessCount || 0,
      tags: entry.tags || [],
      valid: entry.valid !== false,
      searchText: lowerText,
      searchTokens: tokens,
      tokenFreq,
      ngramSet,
      ngramCount: ngramSet.size,
      stepContext: entry.stepContext || null  // (9.2) Preserve stepContext in index
    };
  }

  _tokenize(text) {
    if (!text) return [];
    return text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  // =================================================================
  // GELISMIS ARAMA ALGORITMALARI
  // =================================================================

  /**
   * Calculate TF-IDF score
   * Term Frequency * Inverse Document Frequency
   */
  _calculateTFIDF(queryTokens, entry) {
    if (!entry.searchTokens || entry.searchTokens.length === 0) return 0;

    let score = 0;
    const docLen = entry.searchTokens.length;
    const avgDocLen = 50; // Average document length estimate
    const freq = entry.tokenFreq || {};

    for (const qt of queryTokens) {
      // TF: O(1) lookup from precomputed frequency map
      const termCount = freq[qt] || 0;
      if (termCount === 0) continue;

      // BM25 TF normalizasyonu: k1=1.5, b=0.75
      const k1 = 1.5;
      const b = 0.75;
      const tf = (termCount * (k1 + 1)) / (termCount + k1 * (1 - b + b * (docLen / avgDocLen)));

      // IDF: log(N / df)
      const df = this.documentFrequency[qt] || 1;
      const idf = Math.log((this.totalDocuments + 1) / (df + 0.5));

      score += tf * Math.max(0, idf);
    }

    // Normalize to 0-1 range
    return Math.min(1, score / (queryTokens.length * 2));
  }

  /**
   * N-gram (character bigram) similarity score
   * Provides fuzzy/semantic proximity without embeddings
   * "user preference" -> "preferences" matches (partial overlap)
   */
  _calculateNgramSimilarity(query, entry) {
    if (!query || !entry.ngramSet || entry.ngramCount === 0) return 0;

    const queryNgrams = this._generateNgrams(query.toLowerCase(), 2);
    if (queryNgrams.length === 0) return 0;

    // Use precomputed entry ngramSet for O(1) lookups
    const entrySet = entry.ngramSet;
    let intersection = 0;
    const queryUnique = new Set(queryNgrams);
    for (const ng of queryUnique) {
      if (entrySet.has(ng)) intersection++;
    }

    // Jaccard: intersection / union
    // union = |queryUnique| + |entrySet| - intersection
    const union = queryUnique.size + entry.ngramCount - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Exact match score — full word matching
   */
  _calculateExactMatch(queryTokens, entry) {
    const freq = entry.tokenFreq;
    if (!freq) return 0;

    let exactMatches = 0;
    for (const qt of queryTokens) {
      if (freq[qt]) exactMatches++;
    }

    return queryTokens.length > 0 ? exactMatches / queryTokens.length : 0;
  }

  /**
   * Generate character n-grams
   */
  _generateNgrams(text, n) {
    if (!text || text.length < n) return [];
    const clean = text.toLowerCase().replace(/[^\w\s]/g, '');
    const ngrams = [];
    for (let i = 0; i <= clean.length - n; i++) {
      ngrams.push(clean.substring(i, i + n));
    }
    return ngrams;
  }

  /**
   * Synonym expansion: expand query words with their synonyms
   */
  _expandWithSynonyms(tokens) {
    const expanded = [...tokens];
    for (const token of tokens) {
      const syns = this.synonyms[token];
      if (syns) {
        for (const syn of syns) {
          if (!expanded.includes(syn)) {
            expanded.push(syn);
          }
        }
      }
    }
    return expanded;
  }

  /**
   * Multilingual synonym map (Turkish + English)
   * For semantic proximity without embeddings
   */
  _buildSynonymMap() {
    const groups = [
      ['price', 'cost', 'value', 'expense'],
      ['crypto', 'token', 'coin', 'bitcoin', 'btc', 'eth', 'sol'],
      ['remember', 'save', 'note'],
      ['forget', 'delete', 'remove'],
      ['error', 'bug', 'problem', 'issue'],
      ['search', 'find', 'look', 'query'],
      ['like', 'love', 'favorite', 'preference'],
      ['want', 'need', 'require'],
      ['help', 'support', 'assist'],
      ['news', 'info', 'update'],
      ['sport', 'game', 'football', 'score'],
      ['user', 'person'],
      ['project', 'work', 'task'],
      ['file', 'document', 'doc'],
      ['message', 'text', 'content'],
      ['time', 'duration', 'date'],
      ['large', 'big', 'high'],
      ['small', 'little', 'low'],
    ];

    const map = {};
    for (const group of groups) {
      for (const word of group) {
        map[word] = group.filter(w => w !== word);
      }
    }
    return map;
  }

  /**
   * Update document frequency table (for TF-IDF)
   */
  _updateDocumentFrequency(entry) {
    if (!entry.searchTokens) return;
    const uniqueTokens = new Set(entry.searchTokens);
    for (const token of uniqueTokens) {
      this.documentFrequency[token] = (this.documentFrequency[token] || 0) + 1;
    }
    this.totalDocuments++;
  }

  _recencyBoost(timestamp) {
    const hoursAgo = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
    if (hoursAgo < 1) return 2.0;       // last hour — strong boost
    if (hoursAgo < 24) return 1.5;      // last day
    if (hoursAgo < 168) return 1.2;     // last week
    if (hoursAgo < 720) return 1.0;     // last month
    return 0.8;                          // older
  }

  _markAccessed(id, type) {
    const entries = this.index[type] || [];
    const entry = entries.find(e => e.id === id);
    if (entry) {
      entry.accessCount = (entry.accessCount || 0) + 1;
      entry.lastAccessed = new Date().toISOString();
      // Accessing a memory reinforces it (anti-decay)
      entry.importance = Math.min(10, entry.importance + 0.1);
    }
  }

  _getRecentEpisodes(hours = 24) {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    return this.index.episodic
      .filter(e => new Date(e.timestamp).getTime() > cutoff)
      .slice(-10)
      .map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        content: e.searchText.substring(0, 200)
      }));
  }

  _matchProcedures(message) {
    const tokens = this._tokenize(message);
    const matches = [];
    
    for (const proc of this.index.procedural) {
      if (proc.valid === false) continue;
      
      let score = 0;
      for (const token of tokens) {
        if (proc.searchText.includes(token)) score++;
      }
      
      if (score > 0) {
        matches.push({
          id: proc.id,
          score,
          content: proc.searchText.substring(0, 200)
        });
      }
    }
    
    return matches.sort((a, b) => b.score - a.score).slice(0, 3);
  }

  _loadEpisodesForDate(dateStr) {
    const filePath = path.join(this.dirs.episodic, dateStr + '.jsonl');
    const episodes = [];

    try {
      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            episodes.push(JSON.parse(line));
          } catch (e) { /* Corrupt JSONL line — skip */ }
        }
      }
    } catch (e) {
      this.log('Failed to load episodes for ' + dateStr + ': ' + e.message);
    }

    return episodes;
  }

  _loadAllSemantic() {
    const filePath = path.join(this.dirs.semantic, 'knowledge.jsonl');
    const facts = [];

    try {
      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            facts.push(JSON.parse(line));
          } catch (e) { /* Corrupt JSONL line — skip */ }
        }
      }
    } catch (e) {
      this.log('Failed to load semantic data: ' + e.message);
    }

    return facts;
  }

  _invalidateSemantic(id) {
    const entry = this.index.semantic.find(e => e.id === id);
    if (entry) {
      entry.valid = false;
      this.log('Semantic invalidated', id);
    }
  }

  _invalidateMemory(id, reason) {
    for (const type of ['episodic', 'semantic', 'procedural']) {
      const entry = this.index[type].find(e => e.id === id);
      if (entry) {
        entry.valid = false;
        this.invalidateSearchCache();
        this.log('Memory forgotten', type + ':' + id + ' reason: ' + reason);
        return { success: true, type, id };
      }
    }
    return { success: false, error: 'Memory not found: ' + id };
  }

  _applyCoreMemoryUpdate(update) {
    try {
      let content = this.getCoreMemory();
      
      if (update.action === 'add') {
        // Find the section and append
        const sectionHeader = '## ' + update.section;
        const idx = content.indexOf(sectionHeader);
        
        if (idx !== -1) {
          const nextSection = content.indexOf('\n## ', idx + sectionHeader.length);
          const insertAt = nextSection !== -1 ? nextSection : content.length;
          content = content.slice(0, insertAt) + '\n- ' + update.content + '\n' + content.slice(insertAt);
        } else {
          content += '\n\n## ' + update.section + '\n\n- ' + update.content + '\n';
        }
      } else if (update.action === 'update') {
        // Replace section content
        const sectionHeader = '## ' + update.section;
        const idx = content.indexOf(sectionHeader);
        
        if (idx !== -1) {
          const nextSection = content.indexOf('\n## ', idx + sectionHeader.length);
          const end = nextSection !== -1 ? nextSection : content.length;
          content = content.slice(0, idx) + sectionHeader + '\n\n' + update.content + '\n' + content.slice(end);
        }
      }
      
      this.updateCoreMemory(content);
      this.log('Core memory section updated', update.section);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP AUTO-CLEANUP — Remove old intermediate steps (9.2)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Clean up old episodes with steps (default max-age: 7 days)
   * Removes step data from episodes older than maxAgeDays
   * Keeps full episode for reference, but clears old steps array
   */
  cleanupOldSteps(maxAgeDays = 7) {
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let cleanedCount = 0;

    try {
      // Iterate through episodic memory files
      const episodicDir = this.dirs.episodic;
      if (!fs.existsSync(episodicDir)) return { cleanedCount: 0, error: null };

      const files = fs.readdirSync(episodicDir).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(episodicDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        const cleanedLines = lines.map(line => {
          try {
            const entry = JSON.parse(line);
            const entryAge = now - new Date(entry.timestamp).getTime();

            // If episode has steps and is older than maxAge, clear steps
            if (entry.steps && entry.steps.length > 0 && entryAge > maxAgeMs) {
              entry.steps = [];
              entry.stepCount = 0;
              cleanedCount++;
            }
            return JSON.stringify(entry);
          } catch (e) {
            // If parse fails, keep original line
            return line;
          }
        });

        // Write cleaned content back
        fs.writeFileSync(filePath, cleanedLines.join('\n') + '\n', 'utf8');
      }

      this.log('Step cleanup completed', `Cleaned ${cleanedCount} episodes (max-age: ${maxAgeDays}d)`);
      return { cleanedCount, error: null };
    } catch (e) {
      const errMsg = `Step cleanup failed: ${e.message}`;
      this.log('Step cleanup error', errMsg);
      return { cleanedCount: 0, error: errMsg };
    }
  }

  /**
   * Get step history for a specific task/goal
   * Filters episodes by goal and returns all steps in chronological order
   */
  getStepHistory(goal) {
    const allSteps = [];

    try {
      const episodicDir = this.dirs.episodic;
      if (!fs.existsSync(episodicDir)) return allSteps;

      const files = fs.readdirSync(episodicDir).filter(f => f.endsWith('.jsonl')).sort();

      for (const file of files) {
        const filePath = path.join(episodicDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.goal === goal && entry.steps && entry.steps.length > 0) {
              allSteps.push({
                episodeId: entry.id,
                timestamp: entry.timestamp,
                steps: entry.steps
              });
            }
          } catch (e) {
            // Skip parse errors
          }
        }
      }
    } catch (e) {
      this.log('Step history error', e.message);
    }

    return allSteps;
  }

  log(label, detail) {
    if (this.logger) {
      this.logger.info('Memory', label + (detail ? ' | ' + detail : ''));
    }
  }
}

module.exports = CognitiveMemory;
