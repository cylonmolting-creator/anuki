const CHANNEL_REGISTRY = {
  webchat: {
    name: 'WebChat',
    key: 'webchat',
    module: './channels/webchat',
    envVars: { required: [], optional: [] },
    fields: [],
    alwaysActive: true,
    configBuilder: () => ({})
  }
};

module.exports = { CHANNEL_REGISTRY };
