const fs = require('fs');
const path = require('path');
const os = require('os');

class WebChatChannel {
  constructor(config, handler, logger, wsServer) {
    this.config = config;
    this.handler = handler;
    this.logger = logger;
    this.wsServer = wsServer;
    this.mediaDir = path.join(os.tmpdir(), 'anuki-media');
    if (!fs.existsSync(this.mediaDir)) fs.mkdirSync(this.mediaDir, { recursive: true });
  }

  // Save base64 image data to temp file
  _saveBase64Image(base64Data, filename) {
    try {
      // Strip data URL prefix if present
      const data = base64Data.replace(/^data:[^;]+;base64,/, '');
      const buffer = Buffer.from(data, 'base64');
      const ext = path.extname(filename) || '.png';
      const localPath = path.join(this.mediaDir, `webchat_${Date.now()}${ext}`);
      fs.writeFileSync(localPath, buffer);

      this.logger.info('WebChat', `Saved media: ${localPath} (${buffer.length} bytes)`);
      setTimeout(() => { fs.unlink(localPath, () => {}); }, 600000);
      return localPath;
    } catch (e) {
      this.logger.error('WebChat', `Save image failed: ${e.message}`);
      return null;
    }
  }

  async start() {
    if (!this.wsServer || !this.wsServer.wss) {
      this.logger.error('WebChat', 'WebSocket server required');
      return;
    }

    this.wsServer.wss.on('connection', (ws) => {
      const clientId = 'web_' + Date.now();

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'chat') {
            const text = msg.text || '';
            const images = [];

            // Handle base64 images from web client
            if (msg.images && Array.isArray(msg.images)) {
              for (const img of msg.images) {
                if (img.data) {
                  const filePath = this._saveBase64Image(img.data, img.name || 'image.png');
                  if (filePath) images.push(filePath);
                }
              }
            }

            if (!text && images.length === 0) return;

            const displayText = text || (images.length > 0 ? '[User sent a media file. Please analyze.]' : '');
            const mediaInfo = images.length > 0 ? ` [+${images.length} media]` : '';
            this.logger.info('WebChat', `[${clientId}] ${displayText.substring(0, 50)}${mediaInfo}`);

            let lastMessageId = Date.now();

            await this.handler.handle({
              text: displayText,
              channel: 'webchat',
              userId: clientId,
              userName: msg.userName || 'WebUser',
              images,
              reply: async (r, options = {}) => {
                // Edit mode: send update with same message ID
                if (options.edit) {
                  ws.send(JSON.stringify({
                    type: 'chat_update',
                    messageId: lastMessageId,
                    text: r
                  }));
                } else {
                  // New message
                  lastMessageId = Date.now();
                  ws.send(JSON.stringify({
                    type: 'chat',
                    messageId: lastMessageId,
                    text: r
                  }));
                }
              }
            });
          }
        } catch {}
      });
    });

    this.logger.info('WebChat', 'Ready on WebSocket');
  }

  async stop() {}
}

module.exports = WebChatChannel;
