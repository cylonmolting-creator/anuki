const path = require('path');
const { CHANNEL_REGISTRY } = require('./registry');
const { setEnvVars, removeEnvVars } = require('../utils/env-manager');

class ChannelManager {
  constructor(channels, channelHandler, logger, wsServer, agentManager) {
    this.channels = channels;
    this.channelHandler = channelHandler;
    this.logger = logger;
    this.wsServer = wsServer;
    this.agentManager = agentManager;
  }

  // Get channel status for a specific agent
  getAgentChannels(agentId) {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) throw new Error('Agent not found');

    const agentChannels = agent.channels || {};

    return Object.values(CHANNEL_REGISTRY).map(reg => ({
      key: reg.key,
      name: reg.name,
      active: !!this.channels[reg.key],
      configured: !!agentChannels[reg.key],
      alwaysActive: !!reg.alwaysActive,
      enableOnly: !!reg.enableOnly,
      note: reg.note || null,
      fields: (reg.fields || []).map(f => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: f.required,
        isSet: !!(agentChannels[reg.key] && agentChannels[reg.key][f.key])
      })),
      requireOneOf: reg.requireOneOf || null
    }));
  }

  // Add channel to agent + activate it
  async addAgentChannel(agentId, channelKey, envVars) {
    const reg = CHANNEL_REGISTRY[channelKey];
    if (!reg) throw new Error(`Unknown channel: ${channelKey}`);
    if (reg.alwaysActive) throw new Error(`${reg.name} is always active`);

    const agent = this.agentManager.getAgent(agentId);
    if (!agent) throw new Error('Agent not found');

    // Validate required fields
    if (reg.enableOnly) {
      envVars[reg.enableVar] = 'true';
    } else if (reg.requireOneOf) {
      const hasOne = reg.requireOneOf.some(k => envVars[k]);
      if (!hasOne) throw new Error(`At least one of ${reg.requireOneOf.join(', ')} is required`);
    } else {
      for (const key of reg.envVars.required) {
        if (!envVars[key]) throw new Error(`${key} is required`);
      }
    }

    // Stop existing channel if running
    if (this.channels[reg.key]) {
      try {
        if (this.channels[reg.key].stop) await this.channels[reg.key].stop();
        if (this.channels[reg.key].destroy) this.channels[reg.key].destroy();
      } catch (e) {
        this.logger.warn('ChannelManager', `Stop ${reg.name}: ${e.message}`);
      }
      delete this.channels[reg.key];
    }

    // Write env vars to .env + process.env
    setEnvVars(envVars);

    // Save channel config to agent data
    const agentChannels = agent.channels || {};
    agentChannels[channelKey] = { ...envVars };
    this.agentManager.updateAgentChannels(agentId, agentChannels);

    // Build config and start channel
    const config = reg.configBuilder(process.env);
    const modulePath = path.resolve(__dirname, '..', reg.module);

    delete require.cache[require.resolve(modulePath)];
    const ChannelClass = require(modulePath);

    const args = reg.key === 'webchat'
      ? [config, this.channelHandler, this.logger, this.wsServer]
      : [config, this.channelHandler, this.logger];

    const channel = new ChannelClass(...args);

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${reg.name} start timeout (15s)`)), 15000)
    );

    try {
      await Promise.race([channel.start(), timeout]);
    } catch (e) {
      this.logger.warn('ChannelManager', `${reg.name} start: ${e.message}`);
    }

    this.channels[reg.key] = channel;
    this.logger.success('ChannelManager', `${reg.name} activated for agent ${agent.name}`);

    return { message: `${reg.name} activated successfully` };
  }

  // Remove channel from agent + deactivate
  async removeAgentChannel(agentId, channelKey) {
    const reg = CHANNEL_REGISTRY[channelKey];
    if (!reg) throw new Error(`Unknown channel: ${channelKey}`);
    if (reg.alwaysActive) throw new Error(`${reg.name} cannot be removed`);

    const agent = this.agentManager.getAgent(agentId);
    if (!agent) throw new Error('Agent not found');

    // Stop channel
    if (this.channels[reg.key]) {
      try {
        if (this.channels[reg.key].stop) await this.channels[reg.key].stop();
        if (this.channels[reg.key].destroy) this.channels[reg.key].destroy();
      } catch (e) {
        this.logger.warn('ChannelManager', `Stop ${reg.name}: ${e.message}`);
      }
      delete this.channels[reg.key];
    }

    // Remove env vars
    const allKeys = [...reg.envVars.required, ...reg.envVars.optional];
    if (reg.enableVar) allKeys.push(reg.enableVar);
    removeEnvVars(allKeys);

    // Remove from agent data
    const agentChannels = agent.channels || {};
    delete agentChannels[channelKey];
    this.agentManager.updateAgentChannels(agentId, agentChannels);

    this.logger.success('ChannelManager', `${reg.name} removed from agent ${agent.name}`);
    return { message: `${reg.name} removed successfully` };
  }
}

module.exports = ChannelManager;
