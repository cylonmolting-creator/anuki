/**
 * ANUKI MODEL RESOLVER
 *
 * OpenClaw-style multi-provider LLM routing:
 * - Multiple providers (Anthropic, OpenAI, local)
 * - Automatic failover on errors
 * - Rate limit detection + cooldown
 * - Load balancing strategies
 * - Cost tracking
 *
 * This module eliminates dependency on a single provider.
 */

const { execSync, execFileSync } = require('child_process');

class ModelResolver {
  constructor(config = {}, logger) {
    this.logger = logger;

    // Provider configurations
    this.providers = config.providers || [
      {
        name: 'anthropic-sonnet',
        type: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        priority: 1,
        maxTokens: 8192,
        costPer1kInput: 0.003,
        costPer1kOutput: 0.015
      },
      {
        name: 'anthropic-haiku',
        type: 'anthropic',
        model: 'claude-3-5-haiku-20241022',
        priority: 2,
        maxTokens: 8192,
        costPer1kInput: 0.00025,
        costPer1kOutput: 0.00125
      },
      {
        name: 'anthropic-opus',
        type: 'anthropic',
        model: 'claude-opus-4-20250514',
        priority: 3, // expensive, use as last resort
        maxTokens: 8192,
        costPer1kInput: 0.015,
        costPer1kOutput: 0.075
      }
    ];

    // Provider states
    this.providerStates = new Map();
    this.providers.forEach(p => {
      this.providerStates.set(p.name, {
        healthy: true,
        failures: 0,
        lastFailure: null,
        cooldownUntil: null,
        rateLimitedUntil: null,
        totalCalls: 0,
        totalTokens: { input: 0, output: 0 },
        totalCost: 0
      });
    });

    // Configuration
    this.maxFailures = config.maxFailures || 3;
    this.cooldownMs = config.cooldownMs || 60000; // 1 minute
    this.rateLimitCooldownMs = config.rateLimitCooldownMs || 300000; // 5 minutes

    // Strategy: 'priority' | 'round-robin' | 'least-cost' | 'least-load'
    this.strategy = config.strategy || 'priority';
    this.roundRobinIndex = 0;

    this.log('Initialized with ' + this.providers.length + ' providers, strategy: ' + this.strategy);
  }

  /**
   * Get the best available provider based on strategy
   */
  resolve() {
    const available = this.getAvailableProviders();

    if (available.length === 0) {
      // All providers down, try resetting cooldowns
      this.resetCooldowns();
      const retry = this.getAvailableProviders();
      if (retry.length === 0) {
        throw new Error('All LLM providers are unavailable');
      }
      return retry[0];
    }

    switch (this.strategy) {
      case 'round-robin':
        return this._roundRobinSelect(available);
      case 'least-cost':
        return this._leastCostSelect(available);
      case 'least-load':
        return this._leastLoadSelect(available);
      case 'priority':
      default:
        return available[0]; // Already sorted by priority
    }
  }

  /**
   * Get list of healthy, available providers
   */
  getAvailableProviders() {
    const now = Date.now();

    return this.providers
      .filter(p => {
        const state = this.providerStates.get(p.name);

        // Check cooldown
        if (state.cooldownUntil && now < state.cooldownUntil) {
          return false;
        }

        // Check rate limit
        if (state.rateLimitedUntil && now < state.rateLimitedUntil) {
          return false;
        }

        return state.healthy;
      })
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Report successful call
   */
  reportSuccess(providerName, usage = {}) {
    const state = this.providerStates.get(providerName);
    if (!state) return;

    const provider = this.providers.find(p => p.name === providerName);

    state.healthy = true;
    state.failures = 0;
    state.cooldownUntil = null;
    state.totalCalls++;

    if (usage.inputTokens) {
      state.totalTokens.input += usage.inputTokens;
    }
    if (usage.outputTokens) {
      state.totalTokens.output += usage.outputTokens;
    }

    // Calculate cost
    if (provider && usage.inputTokens && usage.outputTokens) {
      const cost =
        (usage.inputTokens / 1000) * provider.costPer1kInput +
        (usage.outputTokens / 1000) * provider.costPer1kOutput;
      state.totalCost += cost;
    }

    this.log(providerName + ' success | Tokens: ' + (usage.inputTokens || 0) + '/' + (usage.outputTokens || 0));
  }

  /**
   * Report failed call
   */
  reportFailure(providerName, error) {
    const state = this.providerStates.get(providerName);
    if (!state) return;

    state.failures++;
    state.lastFailure = Date.now();

    // Check if rate limited
    if (this._isRateLimitError(error)) {
      state.rateLimitedUntil = Date.now() + this.rateLimitCooldownMs;
      this.log(providerName + ' rate limited, cooldown until ' + new Date(state.rateLimitedUntil).toISOString());
      return;
    }

    // Too many failures
    if (state.failures >= this.maxFailures) {
      state.healthy = false;
      state.cooldownUntil = Date.now() + this.cooldownMs;
      this.log(providerName + ' marked unhealthy after ' + state.failures + ' failures');
    } else {
      this.log(providerName + ' failure ' + state.failures + '/' + this.maxFailures + ': ' + error);
    }
  }

  /**
   * Execute a call using the best available provider
   */
  async call(prompt, options = {}) {
    const provider = this.resolve();

    this.log('Using provider: ' + provider.name + ' (' + provider.model + ')');

    try {
      const result = await this._executeCall(provider, prompt, options);

      this.reportSuccess(provider.name, result.usage);

      return {
        provider: provider.name,
        model: provider.model,
        content: result.content,
        usage: result.usage
      };
    } catch (error) {
      this.reportFailure(provider.name, error.message);

      // Try next provider
      const nextProvider = this.resolve();
      if (nextProvider && nextProvider.name !== provider.name) {
        this.log('Failing over to: ' + nextProvider.name);
        return this.call(prompt, options);
      }

      throw error;
    }
  }

  /**
   * Get provider statistics
   */
  getStats() {
    const stats = {};

    for (const [name, state] of this.providerStates) {
      const provider = this.providers.find(p => p.name === name);
      stats[name] = {
        model: provider?.model,
        healthy: state.healthy,
        failures: state.failures,
        cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null,
        rateLimitedUntil: state.rateLimitedUntil ? new Date(state.rateLimitedUntil).toISOString() : null,
        totalCalls: state.totalCalls,
        totalTokens: state.totalTokens,
        totalCost: state.totalCost.toFixed(4)
      };
    }

    return stats;
  }

  /**
   * Reset all provider cooldowns
   */
  resetCooldowns() {
    for (const [name, state] of this.providerStates) {
      state.cooldownUntil = null;
      state.rateLimitedUntil = null;
      state.healthy = true;
      state.failures = 0;
    }
    this.log('All provider cooldowns reset');
  }

  /**
   * Add a new provider at runtime
   */
  addProvider(providerConfig) {
    this.providers.push(providerConfig);
    this.providerStates.set(providerConfig.name, {
      healthy: true,
      failures: 0,
      lastFailure: null,
      cooldownUntil: null,
      rateLimitedUntil: null,
      totalCalls: 0,
      totalTokens: { input: 0, output: 0 },
      totalCost: 0
    });
    this.log('Added provider: ' + providerConfig.name);
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  _roundRobinSelect(available) {
    const provider = available[this.roundRobinIndex % available.length];
    this.roundRobinIndex++;
    return provider;
  }

  _leastCostSelect(available) {
    return available.sort((a, b) => {
      const avgCostA = (a.costPer1kInput + a.costPer1kOutput) / 2;
      const avgCostB = (b.costPer1kInput + b.costPer1kOutput) / 2;
      return avgCostA - avgCostB;
    })[0];
  }

  _leastLoadSelect(available) {
    return available.sort((a, b) => {
      const stateA = this.providerStates.get(a.name);
      const stateB = this.providerStates.get(b.name);
      return stateA.totalCalls - stateB.totalCalls;
    })[0];
  }

  _isRateLimitError(error) {
    const rateLimitPatterns = [
      'rate_limit',
      'rate limit',
      '429',
      'too many requests',
      'quota exceeded',
      'overloaded'
    ];

    const errorLower = error.toLowerCase();
    return rateLimitPatterns.some(p => errorLower.includes(p));
  }

  async _executeCall(provider, prompt, options) {
    // For now, use claude CLI. In future, support multiple backends.
    const systemPrompt = prompt.system || '';
    const userMessage = prompt.userMessage || prompt;
    const tools = options.tools || 'Bash,Read,Write,Edit,WebFetch';

    const fullPrompt = systemPrompt + '\n\n' + userMessage;

    // Use execFileSync with argument array to prevent shell injection
    const args = ['-p', '--model', provider.model, '--allowedTools', tools];
    const result = execFileSync('claude', args, {
      input: fullPrompt,
      encoding: 'utf8',
      timeout: options.timeout || 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, HOME: require('os').homedir() },
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    // Estimate token usage (rough approximation)
    const inputTokens = Math.ceil(fullPrompt.length / 4);
    const outputTokens = Math.ceil(result.length / 4);

    return {
      content: result,
      usage: {
        inputTokens,
        outputTokens
      }
    };
  }

  log(msg) {
    if (this.logger) {
      this.logger.info('ModelResolver', msg);
    }
  }
}

module.exports = ModelResolver;
