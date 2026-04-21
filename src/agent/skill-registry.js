/**
 * SkillRegistry — Agent Skill Registration from Soul Files
 *
 * Scans agent soul files (SOUL.md, IDENTITY.md) on startup to extract
 * skill keywords and register them as agent capabilities in agents.json.
 *
 * This enables:
 * - Agents without manually-configured skills to be discoverable
 * - /api/skills/search to find agents by soul-file-derived skills
 * - Auto-router to use registry for intelligent routing
 * - SkillCache to index all skills across all agents
 *
 * Architecture:
 * - Runs on startup: extracts skills from soul files for ALL agents
 * - Runs on agent creation: registers skills for new agent
 * - Syncs to agents.json: so SkillCache and /api/skills/search see them
 * - Non-destructive: preserves manually defined skills (with schemas)
 *
 * Roadmap 5.2: Agent skill registration
 */

const fs = require('fs');
const path = require('path');

const MASTER_DIR = require('../utils/base-dir');
const AGENTS_FILE = path.join(MASTER_DIR, 'data', 'agents.json');

class SkillRegistry {
  constructor(workspaceManager, agentManager, logger) {
    this.workspaceManager = workspaceManager;
    this.agentManager = agentManager;
    this.logger = logger;
    this.baseDir = MASTER_DIR;

    // Extracted skills per agent (agentId -> string[])
    this.extractedSkills = new Map();
  }

  /**
   * Initialize: scan all agent soul files and register skills.
   * Syncs extracted skills to agents.json so SkillCache can index them.
   */
  initialize() {
    const agents = this.agentManager.listAgents();
    let registered = 0;
    let synced = 0;

    for (const agent of agents) {
      const skills = this._extractSkillsForAgent(agent);
      if (skills.length > 0) {
        this.extractedSkills.set(agent.id, skills);
        registered++;

        // Sync to agents.json if agent is missing capabilities.skills
        const needsSync = this._syncToAgentsJson(agent, skills);
        if (needsSync) synced++;
      }
    }

    this.logger.success('SkillRegistry',
      `Initialized: ${registered}/${agents.length} agents have skills, ${synced} synced to agents.json`
    );
  }

  /**
   * Extract skills for a single agent from soul files + agent config.
   * Combines: existing skillsSimple + soul file extraction + config extraction.
   * @param {Object} agent - Agent object from agentManager
   * @returns {string[]} Combined skill keywords
   */
  _extractSkillsForAgent(agent) {
    const allSkills = new Set();

    // 1. Keep existing skillsSimple
    const existing = agent.capabilities?.skillsSimple || [];
    for (const s of existing) allSkills.add(s.toLowerCase());

    // 2. Extract from soul files (deep content analysis)
    const soulSkills = this._parseSoulFiles(agent.id);
    for (const s of soulSkills) allSkills.add(s.toLowerCase());

    // 3. Extract from agent config (interests, personality traits, name)
    const configSkills = this._extractFromConfig(agent);
    for (const s of configSkills) allSkills.add(s.toLowerCase());

    return Array.from(allSkills);
  }

  /**
   * Extract skills from agent config fields (interests, traits, name).
   * @param {Object} agent
   * @returns {string[]}
   * @private
   */
  _extractFromConfig(agent) {
    const skills = [];

    // From interests.areas (comma-separated string)
    const areas = agent.interests?.areas || '';
    if (areas) {
      areas.split(',').forEach(s => {
        const skill = s.trim().toLowerCase().replace(/\s+/g, '-');
        if (skill.length >= 2 && skill.length <= 50) skills.push(skill);
      });
    }

    // From personality traits
    if (Array.isArray(agent.personality?.traits)) {
      for (const t of agent.personality.traits) {
        if (t && t.length >= 2) skills.push(t.toLowerCase().replace(/\s+/g, '-'));
      }
    }

    // From agent name (common agent types)
    const nameLower = (agent.name || '').toLowerCase();
    const nameSkillMap = {
      'reviewer': 'code-review', 'coder': 'code-writing',
      'writer': 'writing', 'translator': 'translation',
      'researcher': 'research', 'analyst': 'data-analysis',
      'tester': 'testing', 'math': 'mathematics',
      'security': 'security-analysis', 'devops': 'devops',
    };
    for (const [keyword, skill] of Object.entries(nameSkillMap)) {
      if (nameLower.includes(keyword)) skills.push(skill);
    }

    return skills;
  }

  /**
   * Parse soul files for an agent and extract skill keywords
   * @param {string} agentId
   * @returns {string[]} Extracted skill keywords
   */
  _parseSoulFiles(agentId) {
    const workspaceDir = path.join(this.baseDir, 'workspace', agentId);
    const soulDir = path.join(workspaceDir, 'soul');

    if (!fs.existsSync(soulDir)) {
      return [];
    }

    const skills = new Set();

    // Parse SOUL.md
    const soulPath = path.join(soulDir, 'SOUL.md');
    if (fs.existsSync(soulPath)) {
      const content = fs.readFileSync(soulPath, 'utf8');
      this._extractFromContent(content, skills);
    }

    // Parse IDENTITY.md
    const identityPath = path.join(soulDir, 'IDENTITY.md');
    if (fs.existsSync(identityPath)) {
      const content = fs.readFileSync(identityPath, 'utf8');
      this._extractFromContent(content, skills);
    }

    // Parse TOOLS.md (if it lists capabilities)
    const toolsPath = path.join(soulDir, 'TOOLS.md');
    if (fs.existsSync(toolsPath)) {
      const content = fs.readFileSync(toolsPath, 'utf8');
      this._extractFromContent(content, skills);
    }

    return Array.from(skills);
  }

  /**
   * Extract skill keywords from markdown content
   * Looks for patterns like:
   * - Bullet lists (- skill name)
   * - Section headers (## Expertise)
   * - Comma-separated lists in paragraphs
   * @param {string} content - Markdown text
   * @param {Set} skills - Set to add skills to
   */
  _extractFromContent(content, skills) {
    // Guard: if content is undefined or not a string, skip extraction
    if (!content || typeof content !== 'string') {
      return;
    }

    // Known skill domains to look for
    const skillDomains = [
      // Mathematics
      'mathematics', 'math', 'calculus', 'algebra', 'statistics',
      'probability', 'geometry', 'topology', 'optimization',
      'linear-algebra', 'number-theory', 'combinatorics',
      // Finance
      'financial-math', 'financial-analysis', 'fraud-detection',
      'ponzi-detection', 'mlm-analysis', 'crypto-analysis',
      'token-analysis', 'defi', 'yield-analysis',
      // Coding
      'code-writing', 'code-review', 'debugging', 'refactoring',
      'testing', 'software-engineering', 'api-development',
      // Research & Analysis
      'research', 'web-research', 'data-analysis', 'summarization',
      'translation', 'localization',
      // Quality
      'quality-assurance', 'bug-detection', 'verification',
      'system-health', 'monitoring',
      // AI & Agent
      'agent-coordination', 'system-management',
      'multi-agent', 'planning', 'task-management',
      // General
      'general-assistant', 'writing', 'communication',
      'problem-solving', 'analysis', 'crypto'
    ];

    const lowerContent = content.toLowerCase();

    // Method 1: Match known skill domains
    for (const domain of skillDomains) {
      try {
        const searchTerm = domain.replace(/-/g, '[- ]?');
        const regex = new RegExp(`\\b${searchTerm}\\b`, 'i');
        if (regex.test(lowerContent)) {
          skills.add(domain);
        }
      } catch {
        // Invalid regex from domain name — skip
      }
    }

    // Method 2: Extract from "UZMANLIK" or "Expertise" or "Skills" sections
    const sectionPatterns = [
      /##\s*(?:expertise|skills|capabilities)/i,
      /##\s*(?:mission)/i,
      /\*\*(?:skills?|expertise)\*\*\s*:/i
    ];

    for (const pattern of sectionPatterns) {
      const match = content.match(pattern);
      if (match) {
        // Get content after this section header (until next ## or end)
        const startIdx = match.index + match[0].length;
        const nextSection = content.indexOf('\n## ', startIdx);
        const sectionContent = content.substring(startIdx, nextSection > 0 ? nextSection : undefined);

        // Extract bullet items
        const bulletRegex = /^[-*]\s+(.+)$/gm;
        let bulletMatch;
        while ((bulletMatch = bulletRegex.exec(sectionContent)) !== null) {
          const item = bulletMatch[1].trim()
            .replace(/\*\*/g, '')     // Remove bold
            .replace(/\(.+?\)/g, '')  // Remove parenthetical
            .replace(/:.+$/, '')      // Remove everything after colon
            .trim()
            .toLowerCase();

          if (item.length >= 3 && item.length <= 50) {
            // Convert to skill-id format
            const skillId = item
              .replace(/[^a-z0-9\s-]/g, '')
              .replace(/\s+/g, '-')
              .substring(0, 40);
            if (skillId.length >= 3) {
              skills.add(skillId);
            }
          }
        }
      }
    }

    // Method 3: Extract from interests/areas fields (comma-separated)
    const interestPatterns = [
      /(?:interests?|areas?)\s*[:=]\s*(.+?)(?:\n|$)/gi,
      /\*\*(?:areas?)\*\*\s*[:=]\s*(.+?)(?:\n|$)/gi
    ];

    for (const pattern of interestPatterns) {
      let interestMatch;
      while ((interestMatch = pattern.exec(content)) !== null) {
        const items = interestMatch[1].split(/[,;]/).map(s => s.trim().toLowerCase());
        for (const item of items) {
          if (item.length >= 3 && item.length <= 50) {
            const skillId = item
              .replace(/[^a-z0-9\s-]/g, '')
              .replace(/\s+/g, '-')
              .substring(0, 40);
            if (skillId.length >= 3) {
              skills.add(skillId);
            }
          }
        }
      }
    }
  }

  /**
   * Get all registered skills for an agent
   * @param {string} agentId
   * @returns {string[]}
   */
  getSkills(agentId) {
    return this.extractedSkills.get(agentId) || [];
  }

  /**
   * Get all registered skills across all agents
   * @returns {Map<string, string[]>}
   */
  getAllSkills() {
    return this.extractedSkills;
  }

  /**
   * Search for agents with a specific skill
   * @param {string} query - Skill name or keyword
   * @returns {Array<{agentId: string, agentName: string, matchedSkills: string[]}>}
   */
  search(query) {
    const q = query.toLowerCase();
    const results = [];

    for (const [agentId, skills] of this.extractedSkills) {
      const matched = skills.filter(s => s.includes(q) || q.includes(s));
      if (matched.length > 0) {
        const agent = this.agentManager.getAgent(agentId);
        results.push({
          agentId,
          agentName: agent?.name || agentId,
          matchedSkills: matched,
          matchCount: matched.length
        });
      }
    }

    // Sort by match count (most matches first)
    return results.sort((a, b) => b.matchCount - a.matchCount);
  }

  /**
   * Re-register skills for a specific agent (e.g., after creation or soul file edit).
   * Also syncs to agents.json for SkillCache discovery.
   * @param {string} agentId
   */
  refreshAgent(agentId) {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;

    const skills = this._extractSkillsForAgent(agent);
    if (skills.length > 0) {
      this.extractedSkills.set(agentId, skills);
      this._syncToAgentsJson(agent, skills);
    } else {
      this.extractedSkills.delete(agentId);
    }

    this.logger.info('SkillRegistry', `Refreshed skills for ${agent.name}: ${skills.length} skills`);
  }

  /**
   * Sync extracted skills to agents.json capabilities.
   * Non-destructive: preserves manually defined skills (with inputSchema/outputSchema).
   *
   * @param {Object} agent - Agent object
   * @param {string[]} extractedSkills - Extracted skill keywords
   * @returns {boolean} true if agents.json was updated
   * @private
   */
  _syncToAgentsJson(agent, extractedSkills) {
    try {
      if (!fs.existsSync(AGENTS_FILE)) return false;

      const data = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
      const agentData = data.agents.find(a => a.id === agent.id);
      if (!agentData) return false;

      // Initialize capabilities if missing
      if (!agentData.capabilities) {
        agentData.capabilities = {};
      }

      // Check existing skills: if agent already has skills with schemas, don't overwrite
      const existingSkills = agentData.capabilities.skills || [];
      const hasManualSkills = existingSkills.some(s =>
        typeof s === 'object' && (s.inputSchema || s.outputSchema)
      );

      // Build skillsSimple array (flat string list for search/discovery)
      agentData.capabilities.skillsSimple = extractedSkills;

      // If no manual skills exist, also create structured skills entries
      if (!hasManualSkills || existingSkills.length === 0) {
        // Get existing skill IDs to avoid duplicates
        const existingIds = new Set(
          existingSkills
            .filter(s => typeof s === 'object')
            .map(s => s.id)
        );

        // Convert extracted skills to structured format
        const newSkills = extractedSkills
          .filter(skillName => !existingIds.has(`skill-${skillName}`))
          .map(skillName => ({
            id: `skill-${skillName}`,
            name: skillName,
            category: this._categorizeSkill(skillName),
            description: `${skillName} capability (auto-registered from soul files)`
          }));

        agentData.capabilities.skills = [...existingSkills, ...newSkills];
      }

      // Add description if missing
      if (!agentData.capabilities.description) {
        agentData.capabilities.description = this._buildDescription(agent);
      }

      // Atomic write
      const tmpFile = AGENTS_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
      fs.renameSync(tmpFile, AGENTS_FILE);

      return true;
    } catch (e) {
      this.logger.error('SkillRegistry', `Failed to sync agent ${agent.id}: ${e.message}`);
      return false;
    }
  }

  /**
   * Categorize a skill name into a category.
   * @param {string} skillName
   * @returns {string} category
   * @private
   */
  _categorizeSkill(skillName) {
    const s = skillName.toLowerCase();
    if (/math|algebra|calculus|statistics|probability|geometry|topology|optimization|number-theory|combinatorics|linear-algebra/i.test(s)) return 'mathematics';
    if (/financial|finance|ponzi|mlm|yield|fraud/i.test(s)) return 'finance';
    if (/code|debug|refactor|testing|software|api/i.test(s)) return 'code';
    if (/crypto|token|blockchain|defi|memecoin/i.test(s)) return 'crypto';
    if (/research|data-analysis|summarization|analysis/i.test(s)) return 'analysis';
    if (/translation|localization|writing|communication/i.test(s)) return 'language';
    if (/qa|quality|verification|bug|monitoring/i.test(s)) return 'qa';
    if (/agent|multi-agent|system|planning|coordination/i.test(s)) return 'system';
    return 'general';
  }

  /**
   * Build a description string for an agent from its personality/interests.
   * @param {Object} agent
   * @returns {string}
   * @private
   */
  _buildDescription(agent) {
    const parts = [];
    if (agent.personality?.style) parts.push(agent.personality.style);
    if (agent.interests?.areas) parts.push(agent.interests.areas);
    if (agent.firstPrompt) {
      // Take first line of first prompt as description
      const firstLine = agent.firstPrompt.split('\n')[0].substring(0, 100);
      parts.push(firstLine);
    }
    return parts.join(' — ') || `${agent.name} AI agent`;
  }
}

module.exports = SkillRegistry;
