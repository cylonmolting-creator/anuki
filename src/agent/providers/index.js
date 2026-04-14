'use strict';

const ClaudeProvider = require('./claude-provider');
const OpenAIProvider = require('./openai-provider');
const OllamaProvider = require('./ollama-provider');

/**
 * Provider registry — maps provider names to classes.
 * Add new providers here.
 */
const PROVIDER_CLASSES = {
  claude: ClaudeProvider,
  openai: OpenAIProvider,
  ollama: OllamaProvider
};

/**
 * Create a provider instance by name
 * @param {string} providerName - 'claude', 'openai', 'ollama'
 * @param {object} config - Provider-specific config from config.json
 * @param {object} logger - Logger instance
 * @returns {BaseProvider}
 */
function createProvider(providerName, config, logger) {
  const ProviderClass = PROVIDER_CLASSES[providerName];
  if (!ProviderClass) {
    const available = Object.keys(PROVIDER_CLASSES).join(', ');
    throw new Error(`Unknown LLM provider: '${providerName}'. Available: ${available}`);
  }
  return new ProviderClass(config || {}, logger);
}

/**
 * Get list of all available provider names
 * @returns {string[]}
 */
function getAvailableProviders() {
  return Object.keys(PROVIDER_CLASSES);
}

/**
 * Validate all configured providers and return status
 * @param {object} providersConfig - config.agent.providers from config.json
 * @param {object} logger
 * @returns {Promise<object[]>} Array of { name, configured, error? }
 */
async function validateAllProviders(providersConfig, logger) {
  const results = [];

  for (const name of Object.keys(PROVIDER_CLASSES)) {
    const providerConfig = (providersConfig && providersConfig[name]) || {};
    const provider = new PROVIDER_CLASSES[name](providerConfig, logger);
    const validation = provider.validate();

    // Handle both sync and async validate()
    const result = validation instanceof Promise ? await validation : validation;
    results.push({
      name,
      configured: result.valid,
      error: result.error || null,
      supportsAgentic: provider.supportsAgentic(),
      supportsResume: provider.supportsResume()
    });
  }

  return results;
}

module.exports = {
  createProvider,
  getAvailableProviders,
  validateAllProviders,
  PROVIDER_CLASSES,
  ClaudeProvider,
  OpenAIProvider,
  OllamaProvider
};
