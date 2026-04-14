/**
 * AutoRouter — Intelligent Agent Routing
 *
 * Analyzes user messages and automatically selects the best agent based on:
 * - Keywords in message (explicit mentions like "math", "calculate")
 * - Agent capabilities matching (skills, description)
 * - Context hints (numbers, formulas, financial terms)
 *
 * Usage:
 *   const router = new AutoRouter(agentManager, logger);
 *   const result = router.route(userMessage);
 *   if (result.targetAgent) {
 *     // Route to result.targetAgent
 *   }
 */

class AutoRouter {
  constructor(agentManager, logger) {
    this.agentManager = agentManager;
    this.logger = logger;
    this.skillCache = null; // Injected from index.js

    // Skill patterns: keyword → skill mapping
    // Empty by default — populated dynamically when users create agents with skills.
    // Core agent routing (ENKI/UTU) is handled by coreAgentPatterns below.
    this.skillPatterns = {};

    // Agent creation / rule patterns — route to ENKI or UTU
    this.coreAgentPatterns = {
      'enki': [
        /create\s+(a\s+|an\s+|new\s+)?agent/i,
        /build\s+(a\s+|an\s+|me\s+)?agent/i,
        /make\s+(a\s+|an\s+|me\s+)?agent/i,
        /i\s+(want|need)\s+(a\s+|an\s+)?agent/i,
        /new\s+agent/i,
        /agent\s+that\s+(can|does|handles|manages)/i,
        /edit\s+(the\s+)?agent/i,
        /modify\s+(the\s+)?agent/i,
        /delete\s+(the\s+)?agent/i,
        /remove\s+(the\s+)?agent/i,
      ],
      'utu': [
        /add\s+(a\s+)?rule/i,
        /create\s+(a\s+)?rule/i,
        /new\s+rule/i,
        /write\s+(a\s+)?rule/i,
        /change\s+(the\s+)?rule/i,
        /modify\s+(the\s+)?rule/i,
        /delete\s+(the\s+)?rule/i,
        /remove\s+(the\s+)?rule/i,
        /what\s+rules/i,
        /list\s+rules/i,
      ]
    };

    // Agent name shortcuts — only core agents; user-created agents are matched by name dynamically
    this.agentAliases = {
      'enki': ['enki', 'creator', 'builder', 'factory'],
      'utu': ['utu', 'rules', 'governance'],
      'protos': ['protos', 'prompt', 'bridge']
    };
  }

  /**
   * Route user message to best agent
   *
   * @param {string} userMessage - User's message
   * @param {string} currentAgentId - Current agent ID (optional, for context)
   * @returns {Object} { shouldRoute: boolean, targetAgent: string|null, confidence: number, reason: string }
   */
  route(userMessage, currentAgentId = null) {
    const msg = userMessage.toLowerCase();

    // 1. Check for explicit agent mentions (e.g., "math agent'a sor", "ask crypto")
    const explicitMention = this._checkExplicitMention(msg);
    if (explicitMention) {
      return {
        shouldRoute: true,
        targetAgent: explicitMention.agentId,
        confidence: 0.95,
        reason: `Explicit mention: ${explicitMention.keyword}`,
        method: 'explicit'
      };
    }

    // 2. Core agent routing (ENKI for agent creation, UTU for rules)
    for (const [agentId, patterns] of Object.entries(this.coreAgentPatterns)) {
      const matched = patterns.filter(p => p.test(msg));
      if (matched.length > 0 && agentId !== currentAgentId) {
        const agent = this.agentManager.getAgent(agentId);
        if (agent) {
          return {
            shouldRoute: true,
            targetAgent: agentId,
            confidence: 0.95,
            reason: `Core agent pattern: ${agentId} (${matched.length} matches)`,
            method: 'core-agent'
          };
        }
      }
    }

    // 3. Skill-based routing (pattern matching)
    // Only route when message is CLEARLY about that skill domain
    // Minimum 2 patterns must match (single keyword like "math" is too weak)
    const skillMatch = this._matchSkills(msg);
    if (skillMatch && skillMatch.confidence > 0.7 && skillMatch.matchedPatterns.length >= 2) {
      // Find agent with this skill
      const agent = this._findAgentBySkill(skillMatch.skill);
      if (agent && agent.id !== currentAgentId) {
        return {
          shouldRoute: true,
          targetAgent: agent.id,
          confidence: skillMatch.confidence,
          reason: `Skill match: ${skillMatch.skill} (${skillMatch.matchedPatterns.length} patterns)`,
          method: 'skill-match',
          matchedSkill: skillMatch.skill
        };
      }
    }

    // 3. No routing needed
    return {
      shouldRoute: false,
      targetAgent: null,
      confidence: 0,
      reason: 'No clear routing signal',
      method: 'none'
    };
  }

  /**
   * Check for explicit agent mentions — only DIRECT COMMANDS to route
   * @private
   */
  _checkExplicitMention(msg) {
    // ONLY match explicit routing commands like:
    // - "ask math: what is 2+2"
    // - "ask math 5*10"
    // - "ask math 2+2"
    // DO NOT match when user is TALKING ABOUT an agent:
    // - "math agent is not responding" — NOT a routing command
    // - "are you communicating with the math agent" — NOT a routing command
    const agents = this.agentManager.listAgents();

    // Routing command patterns (English)
    const routingVerbs = [
      /^ask /,     // ask math ...
      / ask$/,     // ... math ask
      /ask:/,      // ask math:
    ];

    for (const agent of agents) {
      const name = agent.name.toLowerCase();
      const aliases = this.agentAliases[name] || [];
      const allNames = [name, ...aliases];

      for (const alias of allNames) {
        // Check explicit routing verbs AFTER agent name
        for (const verbPattern of routingVerbs) {
          // Build combined check: message must contain alias AND routing verb
          const aliasIdx = msg.indexOf(alias);
          if (aliasIdx === -1) continue;

          // The routing verb should be near the alias (within 20 chars)
          const nearbyText = msg.substring(aliasIdx, aliasIdx + alias.length + 20);
          if (verbPattern.test(nearbyText)) {
            return { agentId: agent.id, keyword: alias };
          }
        }
      }
    }

    return null;
  }

  /**
   * Match skills against message patterns
   * @private
   */
  _matchSkills(msg) {
    let bestMatch = null;
    let maxScore = 0;

    for (const [skill, patterns] of Object.entries(this.skillPatterns)) {
      const matchedPatterns = [];
      for (const pattern of patterns) {
        if (pattern.test(msg)) {
          matchedPatterns.push(pattern.source);
        }
      }

      if (matchedPatterns.length > 0) {
        // Confidence based on absolute match count (not percentage of total patterns):
        // 1 match = 0.5 (too weak to route alone)
        // 2 matches = 0.75 (borderline — route if >= 2 check passes)
        // 3+ matches = 0.9+ (strong signal)
        const confidence = Math.min(0.25 + (matchedPatterns.length * 0.25), 1.0);

        if (confidence > maxScore) {
          maxScore = confidence;
          bestMatch = {
            skill,
            confidence,
            matchedPatterns
          };
        }
      }
    }

    return bestMatch;
  }

  /**
   * Find agent by skill (uses cache if available)
   * @private
   */
  _findAgentBySkill(skill) {
    // Use skill cache if available (faster)
    if (this.skillCache) {
      // Search by skill name first, then by category
      let matches = this.skillCache.findBySkillName(skill);
      if (matches.length === 0 && this.skillCache.findByCategory) {
        matches = this.skillCache.findByCategory(skill);
      }
      if (matches.length > 0) {
        // Return agent with highest rating
        return this.agentManager.getAgent(matches[0].agentId);
      }
      return null;
    }

    // Fallback: search agents directly
    const agents = this.agentManager.listAgents();

    for (const agent of agents) {
      if (!agent.capabilities || !agent.capabilities.skills) continue;

      // Check if agent has this skill (match by name, id, OR category)
      const hasSkill = agent.capabilities.skills.some(s => {
        if (typeof s === 'string') return s === skill;
        if (typeof s === 'object') return s.name === skill || s.id === skill || s.category === skill;
        return false;
      });

      if (hasSkill) {
        return agent;
      }
    }

    return null;
  }

  /**
   * Get routing suggestions (for UI display)
   */
  getSuggestions(userMessage) {
    const result = this.route(userMessage);

    if (!result.shouldRoute) {
      return [];
    }

    const agent = this.agentManager.getAgent(result.targetAgent);
    if (!agent) return [];

    return [{
      agentId: agent.id,
      agentName: agent.name,
      confidence: result.confidence,
      reason: result.reason,
      skills: agent.capabilities?.skills || []
    }];
  }
}

module.exports = AutoRouter;
