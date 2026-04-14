class AgentRouter {
  constructor(config, logger) {
    this.logger = logger;
    this.agents = config.agents || {
      default: { name: 'System', personality: 'Helpful and friendly' },
      code: { name: 'CodeAgent', personality: 'Technical and detailed' },
      creative: { name: 'CreativeAgent', personality: 'Creative and fun' }
    };
    this.rules = config.rules || [
      { pattern: /code|script|program|bug|error/i, agent: 'code' },
      { pattern: /write|story|poem|creative|imagine/i, agent: 'creative' }
    ];
  }

  route(message) {
    for (const rule of this.rules) {
      if (rule.pattern.test(message)) {
        this.logger.info('Router', `Routed to: ${rule.agent}`);
        return this.agents[rule.agent];
      }
    }
    return this.agents.default;
  }

  getAgent(name) {
    return this.agents[name] || this.agents.default;
  }

  addAgent(name, config) {
    this.agents[name] = config;
  }

  addRule(pattern, agentName) {
    this.rules.push({ pattern, agent: agentName });
  }
}

module.exports = AgentRouter;
