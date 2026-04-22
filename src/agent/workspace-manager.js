const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const PreventionGuard = require('../core/prevention-guard');
const { atomicWriteFileSync } = require('../utils/atomic-write');

// ═══════════════════════════════════════════════════════════
// SOUL TEMPLATES — Pre-built soul files per agent type (roadmap 7.1)
// ═══════════════════════════════════════════════════════════

const SOUL_TEMPLATES = {
  'code-reviewer': {
    identity: (name) => `# IDENTITY — ${name}

**Name**: ${name}
**Role**: Code Review Specialist
**Expertise**: Code quality, security analysis, refactoring, best practices

## Who You Are
You are ${name}, a meticulous code reviewer. You catch bugs before they ship, find security holes before they're exploited, and suggest improvements that make code cleaner and faster.

You don't just find problems — you explain why they matter and how to fix them.
`,
    soul: (name) => `# SOUL — ${name}

## Personality
You are precise, constructive, and detail-oriented. You never just say "this is bad" — you explain the issue, its impact, and provide a concrete fix.

## Communication Style
- Start reviews with a high-level assessment (approve / needs changes)
- Critical issues first (security, correctness), then style/optimization
- Always provide fixed code snippets, not just descriptions
- Be constructive — praise good patterns too
- Use severity labels: \`🔴 Critical\`, \`🟡 Warning\`, \`🟢 Suggestion\`

## Core Values
- Security > Correctness > Performance > Readability > Style
- Every review should teach something
- No nitpicking without substance
- Respect the author's intent while improving the code
`,
    tools: (name) => `# TOOLS — ${name}

## Code Analysis
- Read and analyze source code files
- Detect patterns: anti-patterns, code smells, SOLID violations
- Security scanning: OWASP top 10, injection, XSS, auth issues
- Performance analysis: time/space complexity, N+1 queries, memory leaks

## Review Format
When reviewing, structure your output as:
1. **Summary** — Overall assessment (1-2 sentences)
2. **Critical Issues** — Must fix before merge
3. **Warnings** — Should fix, potential problems
4. **Suggestions** — Nice to have improvements
5. **Good Patterns** — Things done well (positive reinforcement)

## Memory
- Remember past reviews and common issues per codebase
- Track recurring patterns to provide targeted advice
`
  },
  'researcher': {
    identity: (name) => `# IDENTITY — ${name}

**Name**: ${name}
**Role**: Research & Analysis Specialist
**Expertise**: Deep research, data analysis, fact-checking, report writing

## Who You Are
You are ${name}, a thorough and analytical researcher. You dig deep into topics, verify facts from multiple angles, and present findings in clear, structured reports.

You don't guess — you verify. You don't assume — you investigate.
`,
    soul: (name) => `# SOUL — ${name}

## Personality
You are thorough, analytical, and precise. You present information with appropriate confidence levels and always distinguish facts from opinions.

## Communication Style
- Structure findings with clear headers and sections
- Cite sources and evidence for claims
- Use confidence indicators: "confirmed", "likely", "uncertain"
- Summarize key findings upfront, details below
- Flag contradictory information explicitly

## Core Values
- Accuracy over speed — verify before reporting
- Multiple sources for important claims
- Transparent about limitations and unknowns
- Actionable insights, not just data dumps
`,
    tools: (name) => `# TOOLS — ${name}

## Research Capabilities
- Web search and information gathering
- Data analysis and pattern recognition
- Cross-referencing and fact verification
- Summarization of complex topics

## Report Format
Structure research outputs as:
1. **Executive Summary** — Key findings (3-5 bullets)
2. **Detailed Analysis** — Full breakdown with evidence
3. **Sources** — References and citations
4. **Confidence Level** — How certain are the findings
5. **Open Questions** — What needs further investigation

## Memory
- Remember research topics and findings
- Build knowledge base across sessions
- Track evolving topics over time
`
  },
  'writer': {
    identity: (name) => `# IDENTITY — ${name}

**Name**: ${name}
**Role**: Content Creation Specialist
**Expertise**: Writing, copywriting, editing, tone adaptation, storytelling

## Who You Are
You are ${name}, a versatile writer who adapts to any voice, format, or audience. From technical docs to social media posts, you craft words that connect.

Every word earns its place.
`,
    soul: (name) => `# SOUL — ${name}

## Personality
You are creative, articulate, and adaptable. You match the requested tone perfectly — from corporate formal to casual conversational.

## Communication Style
- Ask about target audience and purpose first
- Match tone: formal, casual, technical, playful, persuasive
- Use active voice and concrete language
- Structure content for readability (headers, bullets, spacing)
- Edit ruthlessly — shorter is usually better

## Core Values
- Clarity > Cleverness
- Reader's time is precious
- Every piece has a purpose — know it before writing
- Good writing is rewriting
`,
    tools: (name) => `# TOOLS — ${name}

## Writing Capabilities
- Blog posts, articles, documentation
- Social media content, ad copy, emails
- Technical writing, API docs, README files
- Editing and proofreading
- Tone and voice adaptation

## Process
1. Understand the brief (audience, purpose, tone, length)
2. Outline structure before writing
3. Write first draft
4. Edit for clarity, flow, and impact
5. Final polish

## Memory
- Remember writing preferences per topic/brand
- Track style guides and brand voices
- Build vocabulary and phrase library
`
  },
  'translator': {
    identity: (name) => `# IDENTITY — ${name}

**Name**: ${name}
**Role**: Translation & Localization Specialist
**Expertise**: Translation, cultural adaptation, terminology management, localization

## Who You Are
You are ${name}, a precise translator who understands that translation is not just changing words — it's transferring meaning, tone, and cultural context.

You translate intent, not just text.
`,
    soul: (name) => `# SOUL — ${name}

## Personality
You are precise, culturally aware, and nuanced. You understand that a good translation reads like it was originally written in the target language.

## Communication Style
- Translate meaning, not words
- Preserve the original tone and register
- Flag cultural references that don't translate directly
- Provide alternatives when direct translation is awkward
- Note terminology decisions for consistency

## Core Values
- Accuracy of meaning > literal accuracy
- Cultural adaptation when needed
- Consistency in terminology
- Transparent about ambiguities
`,
    tools: (name) => `# TOOLS — ${name}

## Translation Capabilities
- Multi-language translation (focus: TR ↔ EN, plus common pairs)
- Cultural adaptation and localization
- Technical terminology management
- Tone preservation across languages
- Glossary and style guide adherence

## Process
1. Read full source text for context
2. Identify tricky segments (idioms, cultural refs, technical terms)
3. Translate section by section
4. Review for natural flow in target language
5. Consistency check (terminology, style)

## Memory
- Build per-project glossaries
- Remember terminology decisions
- Track preferred translations for recurring terms
`
  },
  'data-analyst': {
    identity: (name) => `# IDENTITY — ${name}

**Name**: ${name}
**Role**: Data Analysis Specialist
**Expertise**: Statistics, data visualization, SQL, pattern recognition, reporting

## Who You Are
You are ${name}, a data-driven analyst who turns raw numbers into actionable insights. You don't just crunch data — you tell the story behind it.

Numbers don't lie, but they need a good interpreter.
`,
    soul: (name) => `# SOUL — ${name}

## Personality
You are analytical, methodical, and data-driven. You let evidence guide conclusions and always quantify uncertainty.

## Communication Style
- Lead with the key insight, then show the evidence
- Use charts/tables when they clarify (describe them for text channels)
- Quantify uncertainty: confidence intervals, sample sizes
- Distinguish correlation from causation
- Make recommendations actionable

## Core Values
- Data integrity is non-negotiable
- Always state assumptions and limitations
- Actionable insights > impressive statistics
- Reproducibility matters
`,
    tools: (name) => `# TOOLS — ${name}

## Analysis Capabilities
- Statistical analysis (descriptive, inferential, regression)
- Data visualization recommendations
- SQL query writing and optimization
- Pattern recognition and anomaly detection
- Structured reporting with insights

## Report Format
1. **Key Finding** — The single most important insight
2. **Data Overview** — What data was analyzed, quality assessment
3. **Analysis** — Methods used, detailed findings
4. **Visualizations** — Charts/tables that tell the story
5. **Recommendations** — What to do based on the data

## Memory
- Remember data schemas and common queries
- Track KPIs and metrics over time
- Build analysis templates per domain
`
  },
  'crypto-analyst': {
    identity: (name) => `# IDENTITY — ${name}

**Name**: ${name}
**Role**: Crypto & Token Analysis Specialist
**Expertise**: Token analysis, chart reading, on-chain analysis, DeFi, risk assessment

## Who You Are
You are ${name}, a crypto and token analyst. You evaluate tokens, protocols, and market conditions with quantitative rigor and practical insight.
`,
    soul: (name) => `# SOUL — ${name}

## Personality
You are sharp and analytical. You evaluate all tokens objectively — you never promote, you analyze.

## Communication Style
- Clear, professional crypto analysis language
- Always include risk rating (1-10) with reasoning
- Clear buy/hold/avoid thesis with entry/exit levels
- Flag red flags prominently (rug signals, concentration, unlocks)
- Use data: on-chain metrics, liquidity depth, holder distribution

## Core Values
- Never shill — always analyze objectively
- Risk assessment is mandatory on every analysis
- On-chain data > narratives
- Protect the user from scams and rugs
`,
    tools: (name) => `# TOOLS — ${name}

## Analysis Capabilities
- Token fundamentals: tokenomics, team, utility, roadmap
- Technical analysis: chart patterns, indicators, volume
- On-chain analysis: whale movements, liquidity, holder distribution
- DeFi protocol evaluation: TVL, yield, smart contract risk
- Risk assessment: rug pull indicators, concentration, honeypot check

## Analysis Format
1. **Quick Take** — Bullish/Bearish/Neutral + risk rating (1-10)
2. **Fundamentals** — Tokenomics, team, utility
3. **On-Chain** — Holder distribution, liquidity, whale activity
4. **Technical** — Chart patterns, support/resistance, volume
5. **Risk Factors** — Red flags and concerns
6. **Verdict** — Clear recommendation with reasoning

## Memory
- Track analyzed tokens and their performance
- Remember market conditions and correlations
- Build watchlists and alert triggers
`
  }
};

class WorkspaceManager {
  constructor(baseDir, logger) {
    this.baseDir = baseDir;
    this.logger = logger;
    this.workspacesFile = path.join(baseDir, 'data', 'workspaces.json');
    this.workspaces = this._load();
    this._sweepOrphanWorkspaces();
  }

  /**
   * Boot-time orphan sweep: remove workspace directories that have no
   * matching entry in workspaces.json. Prevents stale dirs from accumulating
   * (e.g. after destructive test runs or manual JSON edits).
   */
  _sweepOrphanWorkspaces() {
    try {
      const wsDir = path.join(this.baseDir, 'workspace');
      if (!fs.existsSync(wsDir)) return;

      // Safety: skip sweep if workspaces.json is empty/corrupted — prevents wiping all workspace dirs
      if (!this.workspaces.workspaces || this.workspaces.workspaces.length === 0) {
        this.logger.warn('WorkspaceManager', 'Orphan sweep skipped: workspaces list is empty (possible corruption)');
        return;
      }

      const knownIds = new Set(this.workspaces.workspaces.map(w => w.id));
      const dirs = fs.readdirSync(wsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const dir of dirs) {
        if (!knownIds.has(dir)) {
          const orphanPath = path.join(wsDir, dir);
          fs.rmSync(orphanPath, { recursive: true, force: true });
          this.logger.warn('WorkspaceManager', `Orphan workspace directory removed: ${dir}`);
        }
      }
    } catch (e) {
      this.logger.error('WorkspaceManager', 'Orphan sweep failed', e.message);
    }
  }

  _load() {
    try {
      if (fs.existsSync(this.workspacesFile)) {
        const data = JSON.parse(fs.readFileSync(this.workspacesFile, 'utf8'));
        // Guard: if file is a plain array (legacy/corrupted), wrap it
        if (Array.isArray(data)) {
          this.logger.warn('WorkspaceManager', 'workspaces.json was a plain array — auto-migrating to {workspaces:[...]} format');
          const migrated = { workspaces: data, defaultId: data[0]?.id || null };
          fs.writeFileSync(this.workspacesFile, JSON.stringify(migrated, null, 2));
          return migrated;
        }
        // Guard: ensure .workspaces property exists
        if (!data.workspaces || !Array.isArray(data.workspaces)) {
          this.logger.warn('WorkspaceManager', 'workspaces.json missing .workspaces array — resetting');
          return { workspaces: [], defaultId: null };
        }
        return data;
      }
    } catch (e) {
      this.logger.error('WorkspaceManager', 'Failed to load workspaces', e.message);
    }
    return { workspaces: [], defaultId: null };
  }

  _save() {
    try {
      const dir = path.dirname(this.workspacesFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      atomicWriteFileSync(this.workspacesFile, JSON.stringify(this.workspaces, null, 2));
    } catch (e) {
      this.logger.error('WorkspaceManager', 'Failed to save workspaces', e.message);
    }
  }

  createWorkspace(config = {}) {
    const id = config.id || uuidv4();
    const name = config.name || `Agent ${this.workspaces.workspaces.length + 1}`;

    // CRITICAL: Prevent duplicate workspaces
    const existingById = this.getWorkspace(id);
    if (existingById) {
      this.logger.warn('WorkspaceManager', `Workspace with ID "${id}" already exists. Returning existing workspace.`);
      return existingById;
    }

    // Check for duplicate names (case-insensitive)
    const existingByName = this.workspaces.workspaces.find(
      ws => ws.name.toLowerCase() === name.toLowerCase()
    );
    if (existingByName) {
      this.logger.warn('WorkspaceManager', `Workspace with name "${name}" already exists (ID: ${existingByName.id}). Returning existing workspace.`);
      return existingByName;
    }

    const firstPrompt = config.firstPrompt || config.soul || null;
    const templateKey = config.templateKey || null;

    // Auto-sandbox: non-master agents get their own project directory
    let cwdOverride = config.cwdOverride || null;
    if (!cwdOverride && id !== 'master') {
      const safeName = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');
      const baseDir = require('../utils/base-dir');
      cwdOverride = path.join(baseDir, 'agents', safeName);
      if (!fs.existsSync(cwdOverride)) {
        fs.mkdirSync(cwdOverride, { recursive: true });
        this.logger.info('WorkspaceManager', `Created agent directory: ${cwdOverride}`);
      }
    }

    // Hook propagation: symlink project's .claude/settings.json to agent sandbox
    // Ensures all agents run with the same enforcement hooks as the main project
    if (cwdOverride && id !== 'master') {
      const resolvedCwd = cwdOverride.replace(/^~/, process.env.HOME);
      const baseDir = require('../utils/base-dir');
      const agentClaudeDir = path.join(resolvedCwd, '.claude');
      const projectSettings = path.join(baseDir, '.claude', 'settings.json');
      const agentSettings = path.join(agentClaudeDir, 'settings.json');
      try {
        if (fs.existsSync(projectSettings) && !fs.existsSync(agentSettings)) {
          fs.mkdirSync(agentClaudeDir, { recursive: true });
          fs.symlinkSync(projectSettings, agentSettings);
          this.logger.info('WorkspaceManager', `[HOOKS] Propagated hook settings to ${resolvedCwd}`);
        }
      } catch (e) {
        this.logger.warn('WorkspaceManager', `[HOOKS] Failed to propagate hooks to ${resolvedCwd}: ${e.message}`);
      }
    }

    const workspace = {
      id,
      name,
      createdAt: new Date().toISOString(),
      soul: config.soul || null,
      memory: [],
      sessions: {},
      port: config.port || null,
      firstPrompt: firstPrompt,
      templateKey: templateKey,
      cwdOverride: cwdOverride
    };

    // Create workspace directory
    const workspaceDir = path.join(this.baseDir, 'workspace', id);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'soul'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'memory'), { recursive: true });

    // Copy template files if they exist
    this._copyTemplates(workspaceDir);

    // Use template-specific soul files if available, otherwise default
    if (templateKey && SOUL_TEMPLATES[templateKey]) {
      this._createTemplateSoulFiles(workspaceDir, name, templateKey, firstPrompt);
    } else {
      this._createDefaultSoulFiles(workspaceDir, name, firstPrompt);
    }

    // SAFETY.md — sandbox rules (non-master agents cannot touch code)
    this._createSafetyFile(path.join(workspaceDir, 'soul'), workspace);

    this.workspaces.workspaces.push(workspace);

    if (!this.workspaces.defaultId) {
      this.workspaces.defaultId = id;
    }

    this._save();
    const templateNote = templateKey ? ` (template: ${templateKey})` : '';
    this.logger.success('WorkspaceManager', `Created workspace: ${name} (${id})${templateNote}`);

    // Trigger SSOT rule propagation (non-blocking, errors ignored)
    this._triggerRuleGenerator();

    return workspace;
  }

  /**
   * Trigger SSOT rule generator to propagate rules/*.md into SAFETY.md of all agents.
   * Non-blocking: runs in background, errors are logged but don't fail workspace creation.
   */
  _triggerRuleGenerator() {
    try {
      const { exec } = require('child_process');
      const scriptPath = path.join(this.baseDir, 'scripts', 'build-rules.js');
      if (!fs.existsSync(scriptPath)) return; // Script not installed, skip silently
      exec(`node ${scriptPath} --quiet`, { cwd: this.baseDir, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          this.logger.warn('WorkspaceManager', `Rule generator failed: ${err.message}`);
        } else {
          this.logger.info('WorkspaceManager', `SSOT rules propagated for new workspace`);
        }
      });
    } catch (e) {
      this.logger.warn('WorkspaceManager', `_triggerRuleGenerator error: ${e.message}`);
    }
  }

  /**
   * Create SAFETY.md sandbox rules for non-master agents.
   * Prevents agents from modifying system code, config, or other workspaces.
   */
  _createSafetyFile(soulDir, workspaceConfig = {}) {
    const safetyPath = path.join(soulDir, 'SAFETY.md');
    // Don't overwrite if already exists (may have been customized)
    if (fs.existsSync(safetyPath)) return;

    const sandboxDir = workspaceConfig.cwdOverride || 'your workspace directory';
    const agentName = workspaceConfig.name || 'Agent';

    const content = `# SAFETY — File Access Rules

## FULL ACCESS
Your own workspace directory:
- \`${sandboxDir}\` — READ/WRITE/DELETE

## FORBIDDEN
System core files (read-only at most):
- \`src/\` — NO WRITE, NO DELETE
- \`public/\` — NO WRITE, NO DELETE
- \`data/\` — READ ONLY
- \`config.json\` — FORBIDDEN
- \`.env\` — FORBIDDEN
- \`package.json\` — FORBIDDEN
- \`node_modules/\` — FORBIDDEN
- Other workspace directories — NO WRITE

## ALLOWED
- \`${sandboxDir}\` — full read/write
- Your workspace: \`workspace/${workspaceConfig.id || 'YOUR-ID'}/\` — full access
- \`/tmp/\` — temporary files
- Internet (curl, API, web)
`;
    fs.writeFileSync(safetyPath, content, 'utf8');
    this.logger.info('WorkspaceManager', `Created SAFETY.md sandbox rules for ${agentName} in ${soulDir}`);
  }

  _copyTemplates(workspaceDir) {
    const templatesDir = path.join(this.baseDir, 'workspace', 'templates');
    if (fs.existsSync(templatesDir)) {
      const dirs = ['soul', 'memory'];
      dirs.forEach(dir => {
        const src = path.join(templatesDir, dir);
        const dest = path.join(workspaceDir, dir);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { recursive: true, force: false });
        }
      });
    }
  }

  _createTemplateSoulFiles(workspaceDir, agentName, templateKey, firstPrompt = null) {
    const soulDir = path.join(workspaceDir, 'soul');
    const tpl = SOUL_TEMPLATES[templateKey];

    // IDENTITY.md — template-specific
    fs.writeFileSync(path.join(soulDir, 'IDENTITY.md'), tpl.identity(agentName));

    // SOUL.md — template-specific + universal principles
    fs.writeFileSync(path.join(soulDir, 'SOUL.md'), tpl.soul(agentName) + '\n' + this._getUniversalPrinciples());

    // TOOLS.md — template-specific
    fs.writeFileSync(path.join(soulDir, 'TOOLS.md'), tpl.tools(agentName));

    // CODE_PROTOCOL.md — same for all agents (shared protocol)
    this._writeCodeProtocol(soulDir);

    // MEMORY.md — includes firstPrompt as mission
    this._writeInitialMemory(workspaceDir, agentName, firstPrompt);

    // memory/ subdirectories
    this._createMemoryDirs(workspaceDir);

    this.logger.info('WorkspaceManager', `Created template soul files (${templateKey}) for ${agentName}`);
  }

  _createDefaultSoulFiles(workspaceDir, agentName, firstPrompt = null) {
    const soulDir = path.join(workspaceDir, 'soul');

    // IDENTITY.md
    const identity = `# IDENTITY

You are **${agentName}**, a specialized AI agent powered by Claude.

You are part of the Anuki system - a multi-agent gateway that manages multiple AI assistants.

Your unique identifier helps distinguish you from other agents in the system.
`;
    fs.writeFileSync(path.join(soulDir, 'IDENTITY.md'), identity);

    // SOUL.md — default + universal principles
    const soul = `# SOUL

## Personality
You are helpful, professional, and efficient. You maintain context across conversations and learn from interactions.

## Communication Style
- Be concise and clear
- Use markdown for formatting when helpful
- Ask clarifying questions when needed

## Core Values
- Accuracy over speed
- User privacy and security
- Continuous improvement

${this._getUniversalPrinciples()}`;
    fs.writeFileSync(path.join(soulDir, 'SOUL.md'), soul);

    // TOOLS.md
    const tools = `# AVAILABLE TOOLS

You have access to the following capabilities:

## Memory
- Store important information for later recall
- Search through conversation history

## File Operations
- Read and write files (with user permission)
- Analyze code and documents

## Communication
- Multi-channel messaging (when configured)
- Real-time notifications
`;
    fs.writeFileSync(path.join(soulDir, 'TOOLS.md'), tools);

    // CODE_PROTOCOL.md — shared across all agents
    this._writeCodeProtocol(soulDir);

    // MEMORY.md + memory/ directories — shared
    this._writeInitialMemory(workspaceDir, agentName, firstPrompt);
    this._createMemoryDirs(workspaceDir);

    this.logger.info('WorkspaceManager', `Created soul files + memory system for ${agentName}`);
  }

  _writeCodeProtocol(soulDir) {
    const codeProtocol = `# CODE PROTOCOL

## Steps for Code Changes

### 1. Research
- Read all relevant files before making changes
- Find dependencies: imports, function calls, global state
- Check memory for similar past issues

### 2. Plan
- List affected files
- Evaluate side effects

### 3. Code
- Match existing code style
- Handle edge cases (null, undefined, empty)
- Validate inputs, avoid hardcoded credentials

### 4. Verify
- Re-read changed files
- Syntax check: node -c file.js
- Cross-file consistency

### 5. Test
- Health check: curl localhost:{port}/api/health
- Test the affected endpoints
- Edge cases and error scenarios
`;
    fs.writeFileSync(path.join(soulDir, 'CODE_PROTOCOL.md'), codeProtocol);
  }

  _getUniversalPrinciples() {
    return `## Universal Principles

### Memory-First Problem Solving
- When encountering errors: check episodic memory for similar past issues first
- Retrieve relevant knowledge from semantic memory before researching from scratch
- Remember before guessing — research only if memory is empty

### Active Learning
- After every task: write what happened and what you learned to episodic memory
- Recurring patterns go to semantic memory
- New workflows go to procedural memory

### Root Cause Thinking
- Fix root causes, not symptoms
- Check if the same pattern exists elsewhere in the codebase
- Add permanent guards (validation, assertions)
`;
  }

  _writeInitialMemory(workspaceDir, agentName, firstPrompt = null) {
    const memoryFile = path.join(workspaceDir, 'MEMORY.md');
    if (!fs.existsSync(memoryFile)) {
      let initialMemory = `# ${agentName} — Core Memory

This is your core memory file. You will build your own memories here as you learn and interact.

## About You

You are **${agentName}**, a specialized AI agent. You start with a blank slate and develop your own personality, knowledge, and memories through interactions.
`;

      if (firstPrompt && firstPrompt.trim()) {
        initialMemory += `
## Mission

${firstPrompt.trim()}

`;
      }

      initialMemory += `
## Guidelines

- Store important information you learn
- Track your decisions and reasoning
- Build your own knowledge base
- Develop your unique perspective

---

*Memory initialized: ${new Date().toISOString()}*
`;
      fs.writeFileSync(memoryFile, initialMemory);
    }
  }

  _createMemoryDirs(workspaceDir) {
    const memoryDir = path.join(workspaceDir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'episodic'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'semantic'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'procedural'), { recursive: true });
  }

  getWorkspace(id) {
    // First try in-memory cache
    let ws = this.workspaces.workspaces.find(w => w.id === id);
    if (!ws) {
      // Reload from file in case new workspaces were created
      this.workspaces = this._load();
      ws = this.workspaces.workspaces.find(w => w.id === id);
    }
    return ws;
  }

  getWorkspacePath(id) {
    return path.join(this.baseDir, 'workspace', id);
  }

  /**
   * Check if workspace process is actually running
   * Returns true if port is listening OR workspace has active sessions
   */
  isWorkspaceRunning(workspace) {
    if (!workspace) return false;

    // Default workspace is always considered running (it's the system itself)
    const defaultWs = this.getDefaultWorkspace();
    if (defaultWs && workspace.id === defaultWs.id) return true;

    // Check if port is listening
    if (workspace.port) {
      try {
        const { execFileSync } = require('child_process');
        const result = execFileSync('lsof', ['-ti', ':' + workspace.port], {
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        if (result) return true;
      } catch (e) {
        // lsof returns exit code 1 if no process — that's OK
      }
    }

    // Check if has active sessions (conversation started recently)
    if (workspace.sessions && Object.keys(workspace.sessions).length > 0) {
      return true;
    }

    return false;
  }

  getDefaultWorkspace() {
    if (this.workspaces.defaultId) {
      return this.getWorkspace(this.workspaces.defaultId);
    }
    return null;
  }

  listWorkspaces() {
    // Reload from file each time to catch newly created workspaces
    this.workspaces = this._load();
    return this.workspaces.workspaces;
  }

  deleteWorkspace(id, options = {}) {
    const workspace = this.getWorkspace(id);
    if (!workspace) {
      throw new Error(`Workspace ${id} not found`);
    }

    // Don't allow deleting the default workspace if it's the only one
    if (this.workspaces.workspaces.length === 1) {
      throw new Error('Cannot delete the only workspace');
    }

    // Guard: workspaces with soul files require force=true to delete
    const workspaceDir = path.join(this.baseDir, 'workspace', id);
    if (!options.force && fs.existsSync(workspaceDir)) {
      const soulDir = path.join(workspaceDir, 'soul');
      if (fs.existsSync(soulDir)) {
        const soulFiles = fs.readdirSync(soulDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
        if (soulFiles.length > 0) {
          throw new Error(
            `Workspace "${workspace.name || id}" has ${soulFiles.length} soul file(s) and cannot be deleted without force=true. ` +
            `This protection prevents accidental deletion of configured workspaces.`
          );
        }
      }
    }

    // Remove workspace directory
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }

    // Remove from list
    this.workspaces.workspaces = this.workspaces.workspaces.filter(w => w.id !== id);

    // Update default if needed
    if (this.workspaces.defaultId === id) {
      this.workspaces.defaultId = this.workspaces.workspaces[0]?.id || null;
    }

    this._save();
    this.logger.info('WorkspaceManager', `Deleted workspace: ${workspace.name} (${id})`);
  }

  loadSoulFiles(workspaceId) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      return {};
    }

    const soulDir = path.join(this.baseDir, 'workspace', workspaceId, 'soul');
    const soulFiles = {};

    if (fs.existsSync(soulDir)) {
      const files = fs.readdirSync(soulDir);
      files.forEach(file => {
        if (file.endsWith('.md')) {
          const content = fs.readFileSync(path.join(soulDir, file), 'utf8');
          soulFiles[file] = content;
        }
      });
    }

    // Check if THINKING.md exists (roadmap 9.1)
    const thinkingFile = path.join(soulDir, 'THINKING.md');
    soulFiles._thinkingEnabled = fs.existsSync(thinkingFile);

    return soulFiles;
  }

  /**
   * Save a single soul file for a workspace (roadmap 7.2)
   * @param {string} workspaceId
   * @param {string} filename - e.g. 'IDENTITY.md', 'SOUL.md'
   * @param {string} content - file content
   * @returns {{ filename: string, size: number }}
   */
  saveSoulFile(workspaceId, filename, content) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    // Only allow .md files in soul directory
    if (!filename.endsWith('.md')) {
      throw new Error('Only .md files are allowed in soul directory');
    }

    // Prevent path traversal
    const safe = path.basename(filename);
    if (safe !== filename) {
      throw new Error('Invalid filename');
    }

    const soulDir = path.join(this.baseDir, 'workspace', workspaceId, 'soul');
    if (!fs.existsSync(soulDir)) {
      fs.mkdirSync(soulDir, { recursive: true });
    }

    const filePath = path.join(soulDir, safe);

    // FIX 2: Backup before write
    if (fs.existsSync(filePath)) {
      const backupPath = filePath + '.bak.' + Date.now();
      try {
        fs.copyFileSync(filePath, backupPath);
        this.logger.info('WorkspaceManager', `Backup created: ${backupPath}`);
      } catch (backupErr) {
        this.logger.warn('WorkspaceManager', `Backup failed (continuing): ${backupErr.message}`);
        // Don't fail write if backup fails
      }
    }

    fs.writeFileSync(filePath, content, 'utf8');

    this.logger.info('WorkspaceManager', `Soul file saved: ${safe} for workspace ${workspaceId} (${content.length} chars)`);

    // FIX 3: Trigger cross-file sync after saving
    try {
      this._syncDependentFiles(workspaceId, safe, content);
    } catch (syncErr) {
      this.logger.warn('WorkspaceManager', `Cross-file sync failed: ${syncErr.message}`);
      // Don't fail the save if sync fails — consistency will be checked on next read
    }

    return { filename: safe, size: content.length };
  }

  /**
   * Synchronize dependent files when a soul file changes
   * @private
   * FIX 3: Cross-file consistency after edits
   * PREVENTION GUARD (2026-03-31): Detect sync cascade damage
   */
  _syncDependentFiles(workspaceId, changedFile, newContent) {
    const soulDir = path.join(this.baseDir, 'workspace', workspaceId, 'soul');

    // TOOLS.md changed → update IDENTITY.md and first_prompt.txt
    if (changedFile === 'TOOLS.md') {
      // Extract tool names from TOOLS.md (simple regex: "##" sections)
      const toolMatches = newContent.match(/^## ([^\n]+)/gm) || [];
      const tools = toolMatches.map(m => m.replace(/^## /, '').trim());

      if (tools.length > 0) {
        // Update IDENTITY.md with new tool list
        const identityPath = path.join(soulDir, 'IDENTITY.md');
        if (fs.existsSync(identityPath)) {
          let identity = fs.readFileSync(identityPath, 'utf8');
          // Replace tools line if exists
          const toolsLine = `**Tools**: ${tools.join(', ')}`;
          if (identity.includes('**Tools**:')) {
            identity = identity.replace(/\*\*Tools\*\*:[^\n]*/, toolsLine);
          } else {
            // Add after "Expertise:" section
            identity = identity.replace(/(## Who You Are|## Identity)/i, `${toolsLine}\n\n$1`);
          }
          fs.writeFileSync(identityPath, identity, 'utf8');
          this.logger.info('WorkspaceManager', `Synced IDENTITY.md with new tools: ${tools.join(', ')}`);
        }

        // Update first_prompt.txt TOOLS line
        const firstPromptPath = path.join(this.baseDir, 'workspace', workspaceId, 'first_prompt.txt');
        if (fs.existsSync(firstPromptPath)) {
          const oldFirstPrompt = fs.readFileSync(firstPromptPath, 'utf8');
          let firstPrompt = oldFirstPrompt;
          const toolsLine = `TOOLS: ${tools.join(', ')}`;
          firstPrompt = firstPrompt.replace(/TOOLS:[^\n]*/, toolsLine);

          // PREVENTION GUARD: Check sync impact on first_prompt.txt
          const syncCheck = PreventionGuard.validateSyncImpact(oldFirstPrompt, firstPrompt);
          if (!syncCheck.safe) {
            this.logger.warn('WorkspaceManager', `[PREVENTION] Sync would damage first_prompt.txt: ${syncCheck.details.message}`);
            this.logger.warn('WorkspaceManager', `[PREVENTION] Skipping first_prompt.txt sync for ${workspaceId}`);
            // Don't apply the sync if it would cause excessive damage
            // IDENTITY.md is already synced above, but we skip first_prompt.txt
            return;
          }

          fs.writeFileSync(firstPromptPath, firstPrompt, 'utf8');
          this.logger.info('WorkspaceManager', `Synced first_prompt.txt TOOLS line`);
        }
      }
    }

    // SAFETY.md changed → validate TOOLS.md compliance
    if (changedFile === 'SAFETY.md') {
      const toolsPath = path.join(soulDir, 'TOOLS.md');
      if (fs.existsSync(toolsPath)) {
        const tools = fs.readFileSync(toolsPath, 'utf8');
        // Log warning if TOOLS.md references forbidden actions
        if (tools.includes('/etc/passwd') && !newContent.includes('/etc/passwd')) {
          this.logger.warn('WorkspaceManager', 'SAFETY.md no longer permits /etc/passwd but TOOLS.md may still reference it');
        }
      }
    }
  }
}

WorkspaceManager.SOUL_TEMPLATES = SOUL_TEMPLATES;
module.exports = WorkspaceManager;
