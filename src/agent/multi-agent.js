/**
 * MULTI-AGENT ROUTING
 *
 * OpenClaw-style isolated agent instances:
 * - Isolated agent for each channel/account/person
 * - Separate workspace + session + memory
 * - Agent profiles (persona, capabilities, restrictions)
 * - Cross-agent communication (optional)
 * - Agent lifecycle management
 *
 * Use cases:
 * - Different persona for different people
 * - Project-based separate workspaces
 * - Group vs DM different behavior
 * - Test/production agent separation
 */

const path = require('path');
const fs = require('fs');

class MultiAgentRouter {
  constructor(config = {}, logger) {
    this.logger = logger;

    // Base paths
    this.basePath = config.basePath || require('../utils/base-dir');

    // Agent instances
    this.agents = new Map();

    // Default agent profile
    this.defaultProfile = config.defaultProfile || {
      persona: 'System',
      model: 'claude-sonnet-4-20250514',
      systemPromptPrefix: '',
      capabilities: ['chat', 'memory', 'tools'],
      restrictions: [],
      maxTokens: 8192,
      temperature: 0.7
    };

    // Routing rules
    this.routingRules = config.routingRules || [];

    // Load persisted agents
    this._loadAgents();

    this.log('Initialized with ' + this.agents.size + ' agents');
  }

  /**
   * Route a message to the appropriate agent
   */
  route(channel, userId, groupId = null) {
    // Build routing key
    const routingKey = this._buildRoutingKey(channel, userId, groupId);

    // Check existing agent
    let agent = this.agents.get(routingKey);

    if (!agent) {
      // Create new agent based on routing rules
      const profile = this._resolveProfile(channel, userId, groupId);
      agent = this._createAgent(routingKey, profile);
    }

    // Update last activity
    agent.lastActivity = new Date().toISOString();

    return agent;
  }

  /**
   * Get agent for a specific routing key
   */
  getAgent(routingKey) {
    return this.agents.get(routingKey);
  }

  /**
   * Get agent by channel and user
   */
  getAgentFor(channel, userId, groupId = null) {
    const routingKey = this._buildRoutingKey(channel, userId, groupId);
    return this.agents.get(routingKey);
  }

  /**
   * Create a custom agent
   */
  createAgent(routingKey, profile) {
    return this._createAgent(routingKey, { ...this.defaultProfile, ...profile });
  }

  /**
   * Update agent profile
   */
  updateAgent(routingKey, updates) {
    const agent = this.agents.get(routingKey);
    if (!agent) return null;

    Object.assign(agent.profile, updates);
    agent.updatedAt = new Date().toISOString();

    this._saveAgents();
    this.log('Updated agent: ' + routingKey);

    return agent;
  }

  /**
   * Delete an agent
   */
  deleteAgent(routingKey) {
    const agent = this.agents.get(routingKey);
    if (!agent) return null;

    // Clean up workspace
    if (agent.workspace && fs.existsSync(agent.workspace)) {
      // Optionally archive instead of delete
      this.log('Agent workspace preserved: ' + agent.workspace);
    }

    this.agents.delete(routingKey);
    this._saveAgents();

    this.log('Deleted agent: ' + routingKey);
    return agent;
  }

  /**
   * Add a routing rule
   */
  addRoutingRule(rule) {
    // Validate rule
    if (!rule.match || !rule.profile) {
      throw new Error('Routing rule must have match and profile');
    }

    this.routingRules.push({
      id: rule.id || this._generateId(),
      priority: rule.priority || 0,
      match: rule.match,
      profile: rule.profile,
      createdAt: new Date().toISOString()
    });

    // Sort by priority
    this.routingRules.sort((a, b) => b.priority - a.priority);

    this._saveRules();
    this.log('Added routing rule: ' + rule.match.description);

    return rule;
  }

  /**
   * Get all agents
   */
  getAllAgents() {
    return Array.from(this.agents.entries()).map(([key, agent]) => ({
      routingKey: key,
      ...agent
    }));
  }

  /**
   * Get agent stats
   */
  getStats() {
    const agents = this.getAllAgents();
    const now = Date.now();

    const activeCount = agents.filter(a => {
      const lastActive = new Date(a.lastActivity).getTime();
      return now - lastActive < 3600000; // Active in last hour
    }).length;

    return {
      totalAgents: agents.length,
      activeAgents: activeCount,
      routingRules: this.routingRules.length,
      agentsByChannel: this._groupByChannel(agents)
    };
  }

  /**
   * Get agent workspace path
   */
  getWorkspace(routingKey) {
    const agent = this.agents.get(routingKey);
    return agent?.workspace || null;
  }

  /**
   * Get agent memory path
   */
  getMemoryPath(routingKey) {
    const agent = this.agents.get(routingKey);
    return agent?.memoryPath || null;
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  _buildRoutingKey(channel, userId, groupId) {
    if (groupId) {
      return channel + ':group:' + groupId;
    }
    return channel + ':user:' + userId;
  }

  _resolveProfile(channel, userId, groupId) {
    // Check routing rules
    for (const rule of this.routingRules) {
      if (this._matchRule(rule.match, channel, userId, groupId)) {
        return { ...this.defaultProfile, ...rule.profile };
      }
    }

    // Channel-specific defaults
    const channelProfiles = {
      webchat: {
        persona: 'Agent (WebChat)',
        capabilities: ['chat', 'memory', 'tools']
      }
    };

    return { ...this.defaultProfile, ...channelProfiles[channel] };
  }

  _matchRule(match, channel, userId, groupId) {
    // Channel match
    if (match.channel && match.channel !== channel) {
      return false;
    }

    // User match
    if (match.userId && match.userId !== userId) {
      return false;
    }

    // Group match
    if (match.groupId && match.groupId !== groupId) {
      return false;
    }

    // Pattern match on userId
    if (match.userPattern) {
      try {
        const regex = new RegExp(match.userPattern);
        if (!regex.test(userId)) {
          return false;
        }
      } catch {
        return false; // Invalid regex pattern — treat as no match
      }
    }

    // Is group check
    if (match.isGroup !== undefined && match.isGroup !== !!groupId) {
      return false;
    }

    return true;
  }

  _createAgent(routingKey, profile) {
    // Create workspace directory
    const sanitizedKey = routingKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const workspace = path.join(this.basePath, 'workspaces', sanitizedKey);
    const memoryPath = path.join(this.basePath, 'memory', 'agents', sanitizedKey);

    // Ensure directories exist
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(memoryPath, { recursive: true });

    const agent = {
      routingKey,
      profile,
      workspace,
      memoryPath,
      sessionPath: path.join(memoryPath, 'session.json'),
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      messageCount: 0
    };

    this.agents.set(routingKey, agent);
    this._saveAgents();

    this.log('Created agent: ' + routingKey + ' with persona: ' + profile.persona);

    return agent;
  }

  _groupByChannel(agents) {
    const grouped = {};

    for (const agent of agents) {
      const channel = agent.routingKey.split(':')[0];
      grouped[channel] = (grouped[channel] || 0) + 1;
    }

    return grouped;
  }

  _generateId() {
    return 'rule_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  }

  _loadAgents() {
    const agentsFile = path.join(this.basePath, 'agents.json');

    try {
      if (fs.existsSync(agentsFile)) {
        const data = fs.readFileSync(agentsFile, 'utf8');
        const agents = JSON.parse(data);

        for (const agent of agents) {
          this.agents.set(agent.routingKey, agent);
        }
      }
    } catch (e) {
      this.log('Failed to load agents: ' + e.message);
    }

    // Load routing rules
    const rulesFile = path.join(this.basePath, 'routing-rules.json');

    try {
      if (fs.existsSync(rulesFile)) {
        const data = fs.readFileSync(rulesFile, 'utf8');
        this.routingRules = JSON.parse(data);
      }
    } catch (e) {
      this.log('Failed to load routing rules: ' + e.message);
    }
  }

  _saveAgents() {
    const agentsFile = path.join(this.basePath, 'agents.json');

    try {
      const data = JSON.stringify(Array.from(this.agents.values()), null, 2);
      fs.writeFileSync(agentsFile, data);
    } catch (e) {
      this.log('Failed to save agents: ' + e.message);
    }
  }

  _saveRules() {
    const rulesFile = path.join(this.basePath, 'routing-rules.json');

    try {
      fs.writeFileSync(rulesFile, JSON.stringify(this.routingRules, null, 2));
    } catch (e) {
      this.log('Failed to save routing rules: ' + e.message);
    }
  }

  log(msg) {
    if (this.logger) {
      this.logger.info('MultiAgent', msg);
    }
  }
}

module.exports = MultiAgentRouter;
