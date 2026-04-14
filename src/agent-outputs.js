/**
 * Agent Outputs — Stores summaries of each agent's last completed work.
 *
 * Keeps last 10 output entries per agent.
 * Entry: { timestamp, summary, type, channel, duration, model }
 *
 * Persists to data/agent-outputs.json
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = require('./utils/base-dir');
const OUTPUTS_FILE = path.join(BASE_DIR, 'data', 'agent-outputs.json');
const MAX_ENTRIES_PER_AGENT = 10;
const SAVE_DEBOUNCE_MS = 5000;

// Agent-specific keywords for auto-detecting output type
const AGENT_TYPE_PATTERNS = {
  'ENKI': [
    { pattern: /agent.*(creat|spawn|build)/i, type: 'agent-create', label: 'Agent Create' },
    { pattern: /doctor|diagnos|health.*check/i, type: 'doctor', label: 'Doctor Mode' },
    { pattern: /factory|generat/i, type: 'factory', label: 'Factory Mode' },
  ],
  'PROTOS': [
    { pattern: /prompt.*(creat|edit|updat|writ)/i, type: 'prompt-create', label: 'Prompt Writing' },
    { pattern: /soul.*(creat|edit|updat)/i, type: 'soul-edit', label: 'Soul Edit' },
    { pattern: /analy[zs]|review/i, type: 'analysis', label: 'Analysis' },
  ],
  'UTU': [
    { pattern: /rule.*(creat|add|writ)/i, type: 'rule-create', label: 'Rule Create' },
    { pattern: /rule.*(edit|updat|modif)/i, type: 'rule-edit', label: 'Rule Edit' },
    { pattern: /rule.*(delet|remov)/i, type: 'rule-delete', label: 'Rule Delete' },
  ]
};

class AgentOutputs {
  constructor(logger) {
    this.logger = logger;
    // workspaceId -> Array<OutputEntry>
    this.outputs = new Map();
    // agentName cache: workspaceId -> agentName
    this.nameCache = new Map();
    this._saveTimer = null;
    // Callback for real-time notifications (WebSocket broadcast)
    this.onRecord = null;
    this._loadFromDisk();
  }

  /**
   * Record a completed output for an agent
   * @param {string} workspaceId
   * @param {string} agentName - e.g. "ENKI", "UTU"
   * @param {object} data - { userMessage, response, channel, duration, model, cost }
   */
  record(workspaceId, agentName, data) {
    if (!workspaceId) return;

    const name = (agentName || '').toUpperCase();
    this.nameCache.set(workspaceId, name);

    // Auto-detect output type from userMessage + response
    const type = this._detectType(name, data.userMessage || '', data.response || '');

    // Extract summary from response (first meaningful line, max 200 chars)
    const summary = this._extractSummary(data.response || '', name);

    const entry = {
      timestamp: new Date().toISOString(),
      type: type.type,
      typeLabel: type.label,
      summary,
      channel: data.channel || 'unknown',
      duration: data.duration || 0,
      model: data.model || 'unknown',
      cost: data.cost || 0,
      userMessage: (data.userMessage || '').substring(0, 300),
      fullResponse: (data.response || '').substring(0, 20000),
      fullUserMessage: (data.userMessage || '').substring(0, 2000)
    };

    if (!this.outputs.has(workspaceId)) {
      this.outputs.set(workspaceId, []);
    }

    const arr = this.outputs.get(workspaceId);
    arr.push(entry);

    // Keep only last N entries
    if (arr.length > MAX_ENTRIES_PER_AGENT) {
      arr.splice(0, arr.length - MAX_ENTRIES_PER_AGENT);
    }

    this._scheduleSave();

    // Notify listeners (WebSocket broadcast for real-time badge update)
    if (this.onRecord) {
      try {
        this.onRecord(workspaceId, name, entry);
      } catch (e) {
        this.logger.warn('AgentOutputs', `onRecord callback error: ${e.message}`);
      }
    }
  }

  /**
   * Get outputs for a single agent
   */
  getOutputs(workspaceId) {
    const entries = this.outputs.get(workspaceId) || [];
    return {
      workspaceId,
      agentName: this.nameCache.get(workspaceId) || 'Unknown',
      entries: [...entries].reverse(), // newest first
      lastOutput: entries.length > 0 ? entries[entries.length - 1] : null
    };
  }

  /**
   * Get last output for all agents (for the OUTPUT popup overview)
   */
  getAllLastOutputs() {
    const result = {};
    for (const [wsId, entries] of this.outputs) {
      if (entries.length > 0) {
        result[wsId] = {
          agentName: this.nameCache.get(wsId) || 'Unknown',
          lastOutput: entries[entries.length - 1],
          totalOutputs: entries.length
        };
      }
    }
    return result;
  }

  /**
   * Get all outputs for all agents (full detail)
   */
  getAllOutputs() {
    const result = {};
    for (const [wsId] of this.outputs) {
      result[wsId] = this.getOutputs(wsId);
    }
    return result;
  }

  /**
   * Detect output type based on agent name + message content
   */
  _detectType(agentName, userMessage, response) {
    const patterns = AGENT_TYPE_PATTERNS[agentName];
    if (patterns) {
      const combined = userMessage + ' ' + response.substring(0, 500);
      for (const p of patterns) {
        if (p.pattern.test(combined)) {
          return { type: p.type, label: p.label };
        }
      }
    }
    return { type: 'general', label: 'General' };
  }

  /**
   * Extract a meaningful summary from agent response
   * Skips system prefixes, memory tags, etc.
   */
  _extractSummary(response, agentName) {
    if (!response) return 'No response';

    // Clean up common noise
    let text = response
      .replace(/\[MEMORY_\w+:[^\]]*\]/g, '')        // Memory tags
      .replace(/\[CORE_UPDATE:[^\]]*\]/g, '')        // Core updates
      .replace(/\[REMINDER:[^\]]*\]/g, '')           // Reminders
      .replace(/\[AGENT_MESSAGE:[^\]]*\]/g, '')      // Agent messages
      .replace(/\[SHARED_CONTEXT[^\]]*\]/g, '')      // Shared context
      .replace(/```[\s\S]*?```/g, '[code]')          // Code blocks → [code]
      .replace(/\n{2,}/g, '\n')                      // Multiple newlines
      .trim();

    const allLines = text.split('\n');

    // Try to find conclusion bullets at the END (✓, ✅, - lines in last section)
    const conclusionLines = [];
    for (let i = allLines.length - 1; i >= 0; i--) {
      const t = allLines[i].trim();
      if (/^[✓✅•\-\*]/.test(t) && t.length > 5) {
        conclusionLines.unshift(t);
      } else if (conclusionLines.length > 0) {
        break; // Stop when we hit a non-bullet line after finding some
      }
    }
    if (conclusionLines.length >= 2) {
      return conclusionLines.slice(0, 6).join(' | ').substring(0, 500);
    }

    // Fallback: find first meaningful lines
    const lines = allLines.filter(l => {
      const t = l.trim();
      return t.length > 10 && !t.startsWith('#') && !t.startsWith('---') && !t.startsWith('```');
    });

    if (lines.length === 0) {
      return text.substring(0, 300) || 'No response';
    }

    // Take first 3 meaningful lines
    return lines.slice(0, 3).map(l => l.trim()).join(' ').substring(0, 500);
  }

  /**
   * Debounced save
   */
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Load from disk
   */
  _loadFromDisk() {
    try {
      if (fs.existsSync(OUTPUTS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(OUTPUTS_FILE, 'utf-8'));
        if (raw.outputs) {
          for (const [wsId, data] of Object.entries(raw.outputs)) {
            if (Array.isArray(data.entries)) {
              this.outputs.set(wsId, data.entries);
            }
            if (data.agentName) {
              this.nameCache.set(wsId, data.agentName);
            }
          }
        }
        if (this.logger) {
          this.logger.info('AgentOutputs', `Loaded outputs for ${this.outputs.size} agents`);
        }
      }
    } catch (e) {
      if (this.logger) {
        this.logger.warn('AgentOutputs', `Failed to load outputs: ${e.message}`);
      }
    }
  }

  /**
   * Save to disk
   */
  _saveToDisk() {
    try {
      const obj = { outputs: {} };
      for (const [wsId, entries] of this.outputs) {
        obj.outputs[wsId] = {
          agentName: this.nameCache.get(wsId) || 'Unknown',
          entries
        };
      }
      const dir = path.dirname(OUTPUTS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(OUTPUTS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (e) {
      if (this.logger) {
        this.logger.warn('AgentOutputs', `Failed to save outputs: ${e.message}`);
      }
    }
  }

  /**
   * Force save + cleanup on shutdown
   */
  destroy() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveToDisk();
  }
}

module.exports = AgentOutputs;
