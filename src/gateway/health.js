const http = require('http');

class HealthServer {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.server = null;
  }

  async start() {
    const port = this.config.port || 3002;
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          healthy: true,
          uptime: process.uptime(),
          memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
          pid: process.pid
        }));
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.logger.warn('Health', `Port ${port} in use, trying ${port + 10}...`);
          this.server.listen(port + 10, () => {
            this.logger.info('Health', `Server on http://localhost:${port + 10} (fallback)`);
            resolve();
          });
        } else {
          this.logger.error('Health', `Server error: ${err.message}`);
          resolve(); // Don't crash gateway for health server
        }
      });

      this.server.listen(port, () => {
        this.logger.info('Health', `Server on http://localhost:${port}`);
        resolve();
      });
    });
  }
}

module.exports = HealthServer;
