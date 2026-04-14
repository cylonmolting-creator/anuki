'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const BaseProvider = require('./base-provider');

/**
 * Claude Code CLI Provider
 *
 * Uses the Claude Code CLI (`claude`) for agentic execution.
 * Supports: streaming, session resume, tool use, multi-turn agentic mode.
 * Output format: stream-json (newline-delimited JSON events).
 */
class ClaudeProvider extends BaseProvider {
  constructor(config, logger) {
    super(config, logger);
    this.claudePath = config.path || process.env.CLAUDE_PATH || 'claude';
  }

  get name() {
    return 'claude';
  }

  supportsResume() {
    return true;
  }

  supportsAgentic() {
    return true;
  }

  mapModel(anukiModel) {
    const modelMap = {
      'haiku': 'claude-haiku-4-5-20251001',
      'sonnet': 'claude-sonnet-4-5-20250929',
      'opus': 'claude-opus-4-6'
    };
    return modelMap[anukiModel] || anukiModel;
  }

  getFallbackModel(model) {
    if (model === 'opus' || (model && model.includes('opus'))) return 'sonnet';
    if (model === 'sonnet' || (model && model.includes('sonnet'))) return 'haiku';
    return null;
  }

  buildArgs(options) {
    const { message, systemPrompt, model, sessionId, maxTurns, images } = options;

    const args = [
      '--dangerously-skip-permissions',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages'
    ];

    // Model
    const mappedModel = this.mapModel(model);
    args.push('--model', mappedModel);

    // Fallback model
    const fallback = this.getFallbackModel(model);
    if (fallback) {
      args.push('--fallback-model', this.mapModel(fallback));
    }

    // Turn limits
    if (maxTurns && Number.isFinite(maxTurns) && maxTurns > 0) {
      args.push('--max-turns', String(maxTurns));
    }

    // System prompt
    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    // Session resume
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // Message with images
    let fullMessage = message;
    if (images && images.length > 0) {
      const validImages = images.filter(p => fs.existsSync(p));
      if (validImages.length > 0) {
        const imageList = validImages.map(p => `- ${p}`).join('\n');
        fullMessage = message + '\n\n[User attached these media files — read and analyze with Read tool:]\n' + imageList;
      }
    }

    args.push('-p', fullMessage);

    return { binary: this.claudePath, args };
  }

  spawnProcess(spawnConfig, workspaceDir, env) {
    const cleanEnv = { ...env };
    delete cleanEnv.CLAUDECODE; // Prevent nested session error

    const proc = spawn(spawnConfig.binary, spawnConfig.args, {
      cwd: workspaceDir,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    });

    return { process: proc, type: 'cli' };
  }

  parseOutputLine(line) {
    // Claude CLI outputs stream-json — each line is a JSON object.
    // We return it as-is since executor.js already knows this format.
    // This is the "native" format — other providers normalize TO this format.
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  isRetryableError(exitCode, stderr) {
    if (exitCode === 143 || exitCode === 137) return false; // intentional kill
    if (exitCode === 0) return false;
    if (exitCode === null) return false; // spawn failure

    const stderrLower = (stderr || '').toLowerCase();
    const nonRetryable = ['api key', 'invalid api', 'authentication', 'unauthorized',
      'permission denied', 'not found: claude', 'enoent', 'workspace not found'];
    for (const p of nonRetryable) {
      if (stderrLower.includes(p)) return false;
    }

    // Rate limits, network errors are retryable
    const retryable = ['rate limit', 'overloaded', 'connection', 'timeout', 'econnreset', 'socket hang up'];
    for (const p of retryable) {
      if (stderrLower.includes(p)) return true;
    }

    return exitCode === 1; // Generic error — retry once
  }

  validate() {
    // Check if claude binary exists
    const { execSync } = require('child_process');
    try {
      execSync(`which ${this.claudePath}`, { timeout: 5000, stdio: 'pipe' });
      return { valid: true };
    } catch {
      return {
        valid: false,
        error: `Claude CLI not found at '${this.claudePath}'. Install: npm install -g @anthropic-ai/claude-code`
      };
    }
  }
}

module.exports = ClaudeProvider;
