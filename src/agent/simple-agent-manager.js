const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const MASTER_DIR = require('../utils/base-dir');
const DATA_DIR = path.join(MASTER_DIR, 'data');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const WORKSPACE_DIR = path.join(MASTER_DIR, 'workspace');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const APPS_DIR = path.join(MASTER_DIR, 'apps'); // Native app directory (macOS .app bundles)

const MASTER_AGENT_ID = 'master';

// ═══════════════════════════════════════════════════════════
// AGENT LIFECYCLE MANAGEMENT — Auto-pause/wake, resource limits (roadmap 7.4)
// ═══════════════════════════════════════════════════════════

const LIFECYCLE_DEFAULTS = {
  idleThresholdMs: 24 * 60 * 60 * 1000,  // 24 hours
  checkIntervalMs: 30 * 60 * 1000,        // 30 minutes
  maxConcurrentPerAgent: 3,                // max concurrent tasks
  priorities: { master: 10, default: 5 }   // priority queue weights
};

/**
 * Touch agent activity timestamp — call this on every message/interaction
 */
function touchAgentActivity(agentId) {
  if (agentId === MASTER_AGENT_ID) return; // Master never pauses
  const data = loadAgents();
  const agent = data.agents.find(a => a.id === agentId);
  if (!agent) return;

  if (!agent.lifecycle) {
    agent.lifecycle = { status: 'active', lastActivity: null, pausedAt: null, wakeCount: 0 };
  }
  agent.lifecycle.lastActivity = new Date().toISOString();

  // Auto-wake if paused
  if (agent.lifecycle.status === 'paused') {
    agent.lifecycle.status = 'active';
    agent.lifecycle.pausedAt = null;
    agent.lifecycle.wakeCount = (agent.lifecycle.wakeCount || 0) + 1;
  }

  saveAgents(data);
}

/**
 * Pause an agent (manual or auto)
 * Returns the agent or null if not found
 */
function pauseAgent(agentId, reason = 'manual') {
  if (agentId === MASTER_AGENT_ID) throw new Error('Master agent cannot be paused');
  const data = loadAgents();
  const agent = data.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('Agent not found');

  if (!agent.lifecycle) {
    agent.lifecycle = { status: 'active', lastActivity: null, pausedAt: null, wakeCount: 0 };
  }

  agent.lifecycle.status = 'paused';
  agent.lifecycle.pausedAt = new Date().toISOString();
  agent.lifecycle.pauseReason = reason;

  saveAgents(data);
  return agent;
}

/**
 * Wake a paused agent (manual or on-demand)
 * Returns the agent or null if not found
 */
function wakeAgent(agentId) {
  if (agentId === MASTER_AGENT_ID) return getMasterAgent();
  const data = loadAgents();
  const agent = data.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('Agent not found');

  if (!agent.lifecycle) {
    agent.lifecycle = { status: 'active', lastActivity: null, pausedAt: null, wakeCount: 0 };
  }

  agent.lifecycle.status = 'active';
  agent.lifecycle.pausedAt = null;
  agent.lifecycle.pauseReason = null;
  agent.lifecycle.lastActivity = new Date().toISOString();
  agent.lifecycle.wakeCount = (agent.lifecycle.wakeCount || 0) + 1;

  saveAgents(data);
  return agent;
}

/**
 * Get lifecycle status for a specific agent
 */
function getAgentLifecycle(agentId) {
  const agent = getAgent(agentId);
  if (!agent) return null;

  const lifecycle = agent.lifecycle || { status: 'active', lastActivity: null, pausedAt: null, wakeCount: 0 };
  const lastActivity = lifecycle.lastActivity ? new Date(lifecycle.lastActivity) : null;
  const idleMs = lastActivity ? Date.now() - lastActivity.getTime() : null;

  return {
    agentId: agent.id,
    agentName: agent.name,
    status: lifecycle.status || 'active',
    lastActivity: lifecycle.lastActivity,
    idleMs,
    idleHuman: idleMs ? _humanDuration(idleMs) : 'unknown',
    pausedAt: lifecycle.pausedAt,
    pauseReason: lifecycle.pauseReason || null,
    wakeCount: lifecycle.wakeCount || 0,
    resourceLimits: lifecycle.resourceLimits || LIFECYCLE_DEFAULTS
  };
}

/**
 * Check all agents for idle timeout and auto-pause them
 * Returns list of agents that were auto-paused
 */
function checkIdleAgents(thresholdMs = LIFECYCLE_DEFAULTS.idleThresholdMs) {
  const data = loadAgents();
  const now = Date.now();
  const paused = [];

  for (const agent of data.agents) {
    if (agent.id === MASTER_AGENT_ID) continue; // Skip master
    if (!agent.lifecycle) {
      agent.lifecycle = { status: 'active', lastActivity: null, pausedAt: null, wakeCount: 0 };
    }
    if (agent.lifecycle.status === 'paused') continue; // Already paused

    const lastActivity = agent.lifecycle.lastActivity ? new Date(agent.lifecycle.lastActivity).getTime() : 0;
    const idleMs = now - lastActivity;

    if (lastActivity > 0 && idleMs >= thresholdMs) {
      agent.lifecycle.status = 'paused';
      agent.lifecycle.pausedAt = new Date().toISOString();
      agent.lifecycle.pauseReason = 'idle-timeout';
      paused.push({ id: agent.id, name: agent.name, idleMs });
    }
  }

  if (paused.length > 0) {
    saveAgents(data);
  }

  return paused;
}

/**
 * Get lifecycle overview for all agents
 */
function getLifecycleOverview() {
  const data = loadAgents();
  const now = Date.now();
  const agents = data.agents.filter(a => a.id !== MASTER_AGENT_ID);

  return {
    total: agents.length,
    active: agents.filter(a => !a.lifecycle || a.lifecycle.status === 'active').length,
    paused: agents.filter(a => a.lifecycle?.status === 'paused').length,
    agents: agents.map(a => {
      const lc = a.lifecycle || {};
      const lastActivity = lc.lastActivity ? new Date(lc.lastActivity).getTime() : 0;
      return {
        id: a.id,
        name: a.name,
        status: lc.status || 'active',
        idleMs: lastActivity > 0 ? now - lastActivity : null,
        idleHuman: lastActivity > 0 ? _humanDuration(now - lastActivity) : 'no activity',
        pauseReason: lc.pauseReason || null,
        wakeCount: lc.wakeCount || 0
      };
    })
  };
}

function _humanDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  const d = Math.floor(h / 24);
  return d + 'd ' + (h % 24) + 'h';
}

// ═══════════════════════════════════════════════════════════
// SKILL EXTRACTION — Auto-generate capabilities from agent config/soul (roadmap 5.2)
// ═══════════════════════════════════════════════════════════

/**
 * Extract skills from agent config (interests, firstPrompt, name).
 * Generates capabilities.skillsSimple (string[]) and capabilities.description.
 * Called on createAgent() and enrichAgentSkills().
 */
function extractSkillsFromConfig(agent) {
  const skills = new Set();
  const sources = [];

  // Extract from interests.areas (comma-separated string)
  const areas = agent.interests?.areas || agent.firstPrompt || '';
  if (areas) {
    sources.push(areas);
    // Split by comma, clean up, add as skills
    areas.split(',').forEach(s => {
      const skill = s.trim().toLowerCase().replace(/\s+/g, '-');
      if (skill.length >= 2 && skill.length <= 50) {
        skills.add(skill);
      }
    });
  }

  // Extract from personality traits
  if (Array.isArray(agent.personality?.traits)) {
    agent.personality.traits.forEach(t => {
      if (t && t.length >= 2) skills.add(t.toLowerCase().replace(/\s+/g, '-'));
    });
  }

  // Extract from agent name (common agent types)
  const nameLower = (agent.name || '').toLowerCase();
  const nameSkillMap = {
    'reviewer': 'code-review',
    'coder': 'code-writing',
    'writer': 'writing',
    'translator': 'translation',
    'researcher': 'research',
    'analyst': 'data-analysis',
    'tester': 'testing',
    'designer': 'design',
    'devops': 'devops',
    'security': 'security-analysis',
    'math': 'mathematics',
    'tutor': 'tutoring',
    'assistant': 'general-assistant'
  };
  for (const [keyword, skill] of Object.entries(nameSkillMap)) {
    if (nameLower.includes(keyword)) {
      skills.add(skill);
    }
  }

  // Build description from sources
  const description = sources.length > 0
    ? `${agent.name} — ${sources[0].substring(0, 200)}`
    : `${agent.name} — General purpose agent`;

  return {
    skillsSimple: Array.from(skills),
    skills: [], // Full schema skills are not auto-generated (added manually or via API)
    description,
    language: null, // User sets language via soul files — no default enforced
    responseTime: 'fast'
  };
}

/**
 * Enrich agent capabilities from soul files (SOUL.md).
 * Reads workspace soul directory and extracts additional skills from content.
 * Returns updated capabilities or null if no soul files found.
 */
function enrichFromSoulFiles(agentId) {
  const soulDir = path.join(WORKSPACE_DIR, agentId, 'soul');
  if (!fs.existsSync(soulDir)) return null;

  const skills = new Set();

  // Read SOUL.md for skill extraction
  const soulPath = path.join(soulDir, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    const content = fs.readFileSync(soulPath, 'utf8').toLowerCase();

    // Extract skills from common keywords in soul files
    const skillKeywords = {
      'code review': 'code-review',
      'refactoring': 'refactoring',
      'debugging': 'debugging',
      'testing': 'testing',
      'writing': 'writing',
      'translation': 'translation',
      'research': 'research',
      'analysis': 'analysis',
      'data analysis': 'data-analysis',
      'web scraping': 'web-scraping',
      'mathematics': 'mathematics',
      'machine learning': 'machine-learning',
      'design': 'design',
      'security': 'security',
      'devops': 'devops',
      'crypto': 'crypto-analysis',
      'blockchain': 'blockchain',
      'summarization': 'summarization',
      'planning': 'planning',
      'problem solving': 'problem-solving',
      'communication': 'communication'
    };

    for (const [keyword, skill] of Object.entries(skillKeywords)) {
      if (content.includes(keyword)) {
        skills.add(skill);
      }
    }
  }

  return skills.size > 0 ? Array.from(skills) : null;
}
const MASTER_AGENT = {
  id: MASTER_AGENT_ID,
  name: 'System',
  nickname: 'System',
  registry: {
    tagline: 'Anuki System',
    subtitle: 'Platform orchestrator — invisible background service',
    model: 'system',
    nameStory: 'The invisible orchestrator that manages all agents.',
    trackRecord: 'Multi-agent platform backbone',
    createdDate: '2026-04-13'
  },
  personality: { style: 'neutral', traits: ['reliable', 'invisible'] },
  interests: { areas: 'agent orchestration' },
  appearance: { color: '#6366f1', avatarUrl: null },
  channels: {},
  memory: { enabled: true, maxSize: -1 },
  workStyle: { proactive: false, heartbeat: false, cronEnabled: true },
  port: null,
  createdAt: '2026-04-13T00:00:00.000Z',
  running: true,
  isMaster: true
};

// Ensure data directory
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load agents
function loadAgents() {
  try {
    if (fs.existsSync(AGENTS_FILE)) {
      const content = fs.readFileSync(AGENTS_FILE, 'utf8');
      const data = JSON.parse(content);
      if (data && Array.isArray(data.agents)) return data;
    }
  } catch (e) {
    console.error('Error loading agents:', e.message);
    // Try backup
    const bak = AGENTS_FILE + '.bak';
    try {
      if (fs.existsSync(bak)) {
        const data = JSON.parse(fs.readFileSync(bak, 'utf8'));
        if (data && Array.isArray(data.agents) && data.agents.length > 0) {
          console.error('Recovered agents from backup');
          fs.writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2));
          return data;
        }
      }
    } catch (e2) { /* ignore */ }
  }
  return { agents: [] };
}

// Save agents (atomic write: temp file + rename to prevent corruption)
function saveAgents(data) {
  try {
    const tmpFile = AGENTS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, AGENTS_FILE);
    // Keep backup copy
    if (data.agents.length > 0) {
      fs.copyFileSync(AGENTS_FILE, AGENTS_FILE + '.bak');
    }
  } catch (e) {
    console.error('Error saving agents:', e.message);
  }
}

// Helper: Create icon from avatar image
function createIconFromAvatar(avatarPath, icnsPath, safeName) {
  const ext = path.extname(avatarPath).toLowerCase();
  const tempIconSet = path.join('/tmp', `${safeName}-${Date.now()}.iconset`);
  fs.mkdirSync(tempIconSet, { recursive: true });

  // Icon sizes for macOS .icns
  const sizes = [16, 32, 64, 128, 256, 512, 1024];

  try {
    if (ext === '.svg') {
      // Convert SVG to PNG at different sizes using rsvg-convert or sips
      for (const size of sizes) {
        const outFile = path.join(tempIconSet, `icon_${size}x${size}.png`);
        const out2xFile = path.join(tempIconSet, `icon_${size}x${size}@2x.png`);

        try {
          // Try rsvg-convert first (if installed via homebrew)
          execSync(`rsvg-convert -w ${size} -h ${size} "${avatarPath}" -o "${outFile}"`, { stdio: 'ignore' });
          if (size <= 512) {
            execSync(`rsvg-convert -w ${size * 2} -h ${size * 2} "${avatarPath}" -o "${out2xFile}"`, { stdio: 'ignore' });
          }
        } catch (e) {
          // Fallback: use sips (macOS built-in, doesn't support SVG well but worth a try)
          // Skip if rsvg-convert not available
          console.warn(`rsvg-convert not found, skipping SVG conversion for ${size}px`);
          break;
        }
      }
    } else {
      // PNG/JPG/WebP: resize with sips (macOS built-in)
      for (const size of sizes) {
        const outFile = path.join(tempIconSet, `icon_${size}x${size}.png`);
        const out2xFile = path.join(tempIconSet, `icon_${size}x${size}@2x.png`);

        execSync(`sips -z ${size} ${size} "${avatarPath}" --out "${outFile}"`, { stdio: 'ignore' });
        if (size <= 512) {
          execSync(`sips -z ${size * 2} ${size * 2} "${avatarPath}" --out "${out2xFile}"`, { stdio: 'ignore' });
        }
      }
    }

    // Convert iconset to icns
    execSync(`iconutil -c icns "${tempIconSet}" -o "${icnsPath}"`, { stdio: 'ignore' });
    fs.rmSync(tempIconSet, { recursive: true });
  } catch (e) {
    // Cleanup on error
    if (fs.existsSync(tempIconSet)) {
      fs.rmSync(tempIconSet, { recursive: true });
    }
    throw e;
  }
}

// Optional default iconset — if a project ships one at assets/default.iconset,
// agents get a branded .app icon. If not (MVP default), agents are created
// without a custom icon and macOS renders the generic one. Non-fatal either way.
const ICON_PATH = path.join(MASTER_DIR, 'assets', 'default.iconset');

// Helper: Copy default icon (no-op if no iconset is shipped)
function copyDefaultIcon(icnsPath, safeName) {
  if (!fs.existsSync(ICON_PATH)) {
    // No default iconset — leave the bundle without an icon, proceed silently.
    return;
  }
  const tempIconSet = path.join('/tmp', `${safeName}-default.iconset`);
  try {
    fs.cpSync(ICON_PATH, tempIconSet, { recursive: true });
    execSync(`iconutil -c icns "${tempIconSet}" -o "${icnsPath}"`, { stdio: 'ignore' });
    fs.rmSync(tempIconSet, { recursive: true });
  } catch (e) {
    console.error('Default icon creation warning:', e.message);
    if (fs.existsSync(tempIconSet)) {
      fs.rmSync(tempIconSet, { recursive: true });
    }
  }
}

// Create .app bundle for agent
function createAppBundle(agent) {
  const safeName = agent.name.replace(/[^a-zA-Z0-9-]/g, '-');

  // Ensure agents-apps directory exists
  if (!fs.existsSync(APPS_DIR)) {
    fs.mkdirSync(APPS_DIR, { recursive: true });
  }

  const appPath = path.join(APPS_DIR, `${safeName}.app`);

  // Create .app structure
  const contentsDir = path.join(appPath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');

  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Create icon from avatar or use default
  const icnsPath = path.join(resourcesDir, 'icon.icns');
  const avatarUrl = agent.appearance?.avatarUrl;

  if (avatarUrl) {
    // Extract filename from avatar URL (/api/avatars/filename.ext)
    const avatarFilename = avatarUrl.split('/').pop();
    const avatarPath = path.join(AVATARS_DIR, avatarFilename);

    if (fs.existsSync(avatarPath)) {
      try {
        createIconFromAvatar(avatarPath, icnsPath, safeName);
      } catch (e) {
        console.error('Avatar icon creation failed, using default:', e.message);
        copyDefaultIcon(icnsPath, safeName);
      }
    } else {
      copyDefaultIcon(icnsPath, safeName);
    }
  } else {
    copyDefaultIcon(icnsPath, safeName);
  }

  // Create Info.plist for macOS app bundle
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${safeName}</string>
    <key>CFBundleIconFile</key>
    <string>icon</string>
    <key>CFBundleIdentifier</key>
    <string>com.anuki.agent.${safeName}</string>
    <key>CFBundleName</key>
    <string>${agent.name}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>`;

  fs.writeFileSync(path.join(contentsDir, 'Info.plist'), plistContent);

  // Create executable script
  const executablePath = path.join(macosDir, safeName);
  const executableContent = `#!/bin/bash
open "http://localhost:${require("../core/config").configManager.get().port || 3000}?agent=${agent.id}"
`;

  fs.writeFileSync(executablePath, executableContent);
  fs.chmodSync(executablePath, '755');

  // Touch app to refresh icon
  fs.utimesSync(appPath, new Date(), new Date());

  return appPath;
}

// Generate SOUL.md content for new agent
function generateSOUL(agent) {
  const personalityDesc = {
    professional: 'formal, precise, and detail-oriented',
    friendly: 'warm, approachable, and conversational',
    humorous: 'witty, playful, and entertaining',
    concise: 'direct, efficient, and to-the-point',
    detailed: 'thorough, comprehensive, and explanatory'
  };

  return `# SOUL.md - ${agent.name}

## Core Identity

**Name:** ${agent.name}
${agent.nickname ? `**Nickname:** ${agent.nickname}` : ''}

## Personality

${agent.personality.style ? `**Style:** ${personalityDesc[agent.personality.style] || 'Balanced and adaptable'}` : 'Balanced and adaptable communication style.'}

**Traits:**
${agent.personality.traits && agent.personality.traits.length > 0 ? agent.personality.traits.map(t => `- ${t.replace('_', ' ')}`).join('\n') : '- Helpful and responsive\n- Clear communicator'}

## Mission / First Prompt

${agent.firstPrompt || agent.interests?.areas || 'General knowledge and problem-solving across various domains.'}

## Core Truths

- Be genuinely helpful, not performatively helpful
- Be resourceful before asking - try to figure it out first
- Respect user time and attention
- Learn and adapt from interactions
- Maintain ${agent.memory.enabled ? 'long-term memory of conversations' : 'session-based context'}

## Communication Guidelines

${agent.personality.traits?.includes('uses_emojis') ? '- Feel free to use emojis to add personality' : '- Keep communication professional without emojis unless context suits it'}
${agent.personality.traits?.includes('asks_questions') ? '- Ask clarifying questions when needed' : '- Make reasonable assumptions when details are unclear'}
${agent.personality.traits?.includes('proactive') ? '- Offer suggestions and improvements proactively' : '- Wait for explicit requests before suggesting alternatives'}
${agent.personality.traits?.includes('cautious') ? '- Double-check before taking irreversible actions' : '- Act confidently when the path is clear'}

## Working Style

${agent.workStyle.proactive ? '- Proactive: Anticipate needs and suggest next steps' : '- Reactive: Respond to specific requests'}
${agent.workStyle.heartbeat ? '- Send periodic check-ins and status updates' : '- Silent until requested'}
- Maximum memory and context retention
- Unlimited persistence and recall

---

*You are not a chatbot. You are ${agent.name}.*
`;
}

// Setup workspace for agent
function setupAgentWorkspace(agent) {
  const wsDir = path.join(WORKSPACE_DIR, agent.id);
  const soulDir = path.join(wsDir, 'soul');
  const memoryDir = path.join(wsDir, 'memory');

  fs.mkdirSync(soulDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });

  // Generate SOUL.md
  const soulContent = generateSOUL(agent);
  fs.writeFileSync(path.join(soulDir, 'SOUL.md'), soulContent);

  // Generate IDENTITY.md
  const identityContent = `# ${agent.name}
Created: ${agent.createdAt}
`;
  fs.writeFileSync(path.join(soulDir, 'IDENTITY.md'), identityContent);

  return wsDir;
}

// Create new agent
// options.workspaceManager — if provided, also registers workspace in workspaces.json
function createAgent(config, options = {}) {
  const data = loadAgents();

  // Support both simple workspace object and full config
  const agentConfig = typeof config === 'string' ? { name: config } : config;

  // All agents share one server process — no per-agent ports needed
  const agent = {
    id: agentConfig.id || Date.now().toString(),
    name: agentConfig.name,
    nickname: agentConfig.nickname || null,
    personality: agentConfig.personality || {},
    interests: agentConfig.interests || {},
    firstPrompt: agentConfig.firstPrompt || agentConfig.interests?.areas || null,
    appearance: agentConfig.appearance || { color: '#f97316', avatarUrl: null, emoji: null },
    channels: agentConfig.channels || {},
    memory: agentConfig.memory || { enabled: true, maxSize: -1 },
    workStyle: agentConfig.workStyle || { proactive: true, heartbeat: true },
    port: null,
    createdAt: new Date().toISOString(),
    appPath: null,
    running: true
  };

  // Auto-generate capabilities from config (roadmap 5.2)
  // Preserve manually-set capabilities if provided, otherwise extract from config
  if (agentConfig.capabilities) {
    agent.capabilities = agentConfig.capabilities;
  } else {
    agent.capabilities = extractSkillsFromConfig(agent);
  }

  // Check for duplicate name
  if (data.agents.find(a => a.id === agent.id)) {
    throw new Error('Agent with this ID already exists');
  }

  // Register workspace in workspaces.json (if workspaceManager provided and not already registered)
  const wm = options.workspaceManager;
  const templateKey = agentConfig.templateKey || null;
  const wmCreated = wm && !wm.getWorkspace(agent.id);
  if (wmCreated) {
    // createWorkspace() builds full workspace: soul files + MEMORY.md + memory subdirs
    // If templateKey is provided, workspace-manager uses template-specific soul files (roadmap 7.1)
    wm.createWorkspace({
      name: agent.name,
      id: agent.id,
      port: null,
      firstPrompt: agent.firstPrompt,
      templateKey: templateKey
    });
    // If no template was used, overwrite generic SOUL.md with agent-config-aware version
    // Template soul files are already rich and don't need this override
    if (!templateKey) {
      const soulDir = path.join(WORKSPACE_DIR, agent.id, 'soul');
      fs.writeFileSync(path.join(soulDir, 'SOUL.md'), generateSOUL(agent));
    }
  } else {
    // No workspaceManager — legacy path, create minimal workspace files
    setupAgentWorkspace(agent);
  }

  // Create .app bundle (opt-in — off by default).
  // Set ANUKI_CREATE_APP_BUNDLES=1 to enable. Disabled by default because:
  // (a) macOS Finder indexes every new .app → spam creation freezes the UI
  // (b) most users interact via the web UI and never need a native app bundle
  // (c) the same functionality is reachable through `npm start` + browser
  if (process.env.ANUKI_CREATE_APP_BUNDLES === '1') {
    try {
      agent.appPath = createAppBundle(agent);
    } catch (e) {
      // Non-fatal — the agent is still created, it just doesn't get a macOS app icon.
      console.error('App bundle creation failed (non-fatal):', e.message);
      agent.appPath = null;
    }
  } else {
    agent.appPath = null;
  }

  // Save to agents list
  data.agents.push(agent);

  saveAgents(data);

  // Refresh Finder/Dock — only if we actually wrote an app bundle.
  // Otherwise this is a massive UX hit (killing Finder for every agent
  // creation froze the desktop during bulk creation).
  if (agent.appPath) {
    try {
      spawn('killall', ['Finder', 'Dock']);
    } catch (e) {
      // Ignore
    }
  }

  return agent;
}

// Delete agent
function deleteAgent(agentId, options = {}) {
  if (agentId === MASTER_AGENT_ID) throw new Error('MASTER agent cannot be deleted');
  const data = loadAgents();
  const agentIndex = data.agents.findIndex(a => a.id === agentId);

  if (agentIndex === -1) {
    throw new Error('Agent not found');
  }

  const agent = data.agents[agentIndex];
  const preserveWorkspace = options.preserveWorkspace || false;

  // Delete .app bundle
  if (agent.appPath && fs.existsSync(agent.appPath)) {
    fs.rmSync(agent.appPath, { recursive: true });
  }

  // Delete workspace directory (optional)
  if (!preserveWorkspace) {
    const wsDir = path.join(WORKSPACE_DIR, agentId);
    if (fs.existsSync(wsDir)) {
      fs.rmSync(wsDir, { recursive: true });
    }
  }

  // Remove from list
  data.agents.splice(agentIndex, 1);
  saveAgents(data);

  // Refresh Finder/Dock
  try {
    spawn('killall', ['Finder', 'Dock']);
  } catch (e) {
    // Ignore
  }

  return { success: true, preservedWorkspace: preserveWorkspace };
}

// Get MASTER agent (from file or default)
function getMasterAgent() {
  const data = loadAgents();
  const saved = data.agents.find(a => a.id === MASTER_AGENT_ID);
  if (saved) return { ...MASTER_AGENT, ...saved, id: MASTER_AGENT_ID, isMaster: true };
  return { ...MASTER_AGENT };
}

// List all agents (orchestrator is invisible — not listed)
function listAgents() {
  const data = loadAgents();
  return data.agents
    .filter(a => a.id !== MASTER_AGENT_ID)
    .map(agent => ({
      ...agent,
      running: true
    }));
}

// Start agent (no-op in Anuki since all agents share one server)
function startAgent(agentId) {
  const data = loadAgents();
  const agent = data.agents.find(a => a.id === agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }
  return agent;
}

// Stop agent (no-op in Anuki)
function stopAgent(agentId) {
  const data = loadAgents();
  const agent = data.agents.find(a => a.id === agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }
  return true;
}

function updateAgentChannels(agentId, channels) {
  const data = loadAgents();
  let agent = data.agents.find(a => a.id === agentId);
  if (!agent) {
    if (agentId === MASTER_AGENT_ID) {
      agent = { ...MASTER_AGENT };
      data.agents.push(agent);
    } else {
      throw new Error('Agent not found');
    }
  }
  agent.channels = channels;
  saveAgents(data);
  return agent;
}

function getAgent(agentId) {
  // Accept "master" for master agent
  if (agentId === MASTER_AGENT_ID) return getMasterAgent();
  // Also accept "system" as alias for master
  if (agentId && agentId.toLowerCase() === 'system') return getMasterAgent();
  const data = loadAgents();
  // Primary lookup: by agent ID
  let agent = data.agents.find(a => a.id === agentId);
  // Fallback: by agent name (case-insensitive) — enables [AGENT_MESSAGE:math:...] syntax
  if (!agent && agentId) {
    const lower = agentId.toLowerCase();
    agent = data.agents.find(a => a.name && a.name.toLowerCase() === lower);
  }
  if (!agent) return null;
  // Anuki architecture: all agents share same process → always "running" (lazy execution)
  return { ...agent, running: true, port: null };
}

function updateAgent(agentId, updates) {
  if (agentId === MASTER_AGENT_ID) throw new Error('Cannot edit master agent');
  const data = loadAgents();
  const agent = data.agents.find(a => a.id === agentId);
  if (!agent) throw new Error('Agent not found');

  const oldName = agent.name;
  const oldAvatarUrl = agent.appearance?.avatarUrl;

  // Updatable fields
  if (updates.name !== undefined) agent.name = updates.name;
  if (updates.nickname !== undefined) agent.nickname = updates.nickname;
  if (updates.appearance !== undefined) {
    agent.appearance = { ...agent.appearance, ...updates.appearance };
  }
  if (updates.personality !== undefined) {
    agent.personality = { ...agent.personality, ...updates.personality };
  }
  if (updates.capabilities !== undefined) {
    agent.capabilities = { ...agent.capabilities, ...updates.capabilities };
  }

  saveAgents(data);

  // Recreate .app bundle if name changed or avatar changed
  const nameChanged = updates.name && updates.name !== oldName;
  const avatarChanged = updates.appearance?.avatarUrl && updates.appearance.avatarUrl !== oldAvatarUrl;

  if (nameChanged || avatarChanged) {
    try {
      // Delete old .app if name changed
      if (nameChanged && agent.appPath && fs.existsSync(agent.appPath)) {
        fs.rmSync(agent.appPath, { recursive: true });
      }

      // Recreate .app with new icon
      agent.appPath = createAppBundle(agent);
      saveAgents(data);
    } catch (e) {
      console.error('Failed to update .app bundle:', e.message);
    }
  }

  return agent;
}

module.exports = {
  createAgent,
  deleteAgent,
  listAgents,
  startAgent,
  stopAgent,
  updateAgentChannels,
  updateAgent,
  getAgent,
  extractSkillsFromConfig,
  enrichFromSoulFiles,
  // Lifecycle management (roadmap 7.4)
  touchAgentActivity,
  pauseAgent,
  wakeAgent,
  getAgentLifecycle,
  checkIdleAgents,
  getLifecycleOverview,
  LIFECYCLE_DEFAULTS
};
