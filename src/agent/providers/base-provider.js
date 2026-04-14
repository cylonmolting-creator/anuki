'use strict';

/**
 * BaseProvider — Abstract LLM provider interface.
 *
 * All providers must implement:
 *   - spawn(options) → returns { process, parseStream }
 *   - buildArgs(options) → provider-specific args
 *   - parseOutputLine(line) → normalized event object
 *   - name → string identifier
 *   - supportsResume() → boolean
 *   - supportsAgentic() → boolean
 *   - mapModel(anukiModel) → provider-specific model string
 */

class BaseProvider {
  constructor(config, logger) {
    this.config = config || {};
    this.logger = logger;
  }

  /**
   * Provider name (e.g., 'claude', 'openai', 'ollama')
   */
  get name() {
    throw new Error('Provider must implement name getter');
  }

  /**
   * Whether this provider supports session resume
   */
  supportsResume() {
    return false;
  }

  /**
   * Whether this provider supports agentic mode (tool use, multi-turn)
   */
  supportsAgentic() {
    return false;
  }

  /**
   * Map Anuki's generic model tiers to provider-specific model IDs
   * @param {string} anukiModel - 'haiku', 'sonnet', 'opus', or a full model ID
   * @returns {string} Provider-specific model ID
   */
  mapModel(anukiModel) {
    throw new Error('Provider must implement mapModel()');
  }

  /**
   * Get the fallback model for a given model (for rate limit handling)
   * @param {string} model - Current model
   * @returns {string|null} Fallback model or null
   */
  getFallbackModel(model) {
    return null;
  }

  /**
   * Build spawn arguments for the CLI or HTTP request config
   * @param {object} options
   * @param {string} options.message - User message
   * @param {string} options.systemPrompt - System prompt
   * @param {string} options.model - Selected model
   * @param {string|null} options.sessionId - Session ID for resume
   * @param {number|null} options.maxTurns - Max agentic turns
   * @param {string} options.workspaceDir - Working directory
   * @param {string[]} options.images - Image paths
   * @returns {object} Provider-specific spawn config
   */
  buildArgs(options) {
    throw new Error('Provider must implement buildArgs()');
  }

  /**
   * Spawn the LLM process/connection
   * @param {object} spawnConfig - Result from buildArgs()
   * @param {string} workspaceDir - CWD for the process
   * @param {object} env - Environment variables
   * @returns {object} { process, type: 'cli'|'http' }
   */
  spawnProcess(spawnConfig, workspaceDir, env) {
    throw new Error('Provider must implement spawnProcess()');
  }

  /**
   * Parse a single output line into a normalized event
   *
   * Normalized event types:
   *   { type: 'system', session_id, model }
   *   { type: 'text', content }
   *   { type: 'tool_start', tool, id, input }
   *   { type: 'tool_result', success, tool_use_id, output }
   *   { type: 'progress', turn, maxTurns, percentage }
   *   { type: 'result', subtype: 'success'|'error', result, total_cost_usd, usage }
   *   { type: 'cost', cost, duration }
   *   { type: 'error', content }
   *
   * @param {string} line - Raw output line
   * @returns {object|null} Normalized event or null to skip
   */
  parseOutputLine(line) {
    throw new Error('Provider must implement parseOutputLine()');
  }

  /**
   * Check if a CLI error is retryable
   * @param {number} exitCode
   * @param {string} stderr
   * @returns {boolean}
   */
  isRetryableError(exitCode, stderr) {
    return false;
  }

  /**
   * Validate that the provider is properly configured
   * @returns {{ valid: boolean, error?: string }}
   */
  validate() {
    return { valid: true };
  }

  /**
   * Get provider status info for health checks
   * @returns {{ name, configured, error? }}
   */
  getStatus() {
    const validation = this.validate();
    return {
      name: this.name,
      configured: validation.valid,
      error: validation.error || null
    };
  }
}

module.exports = BaseProvider;
