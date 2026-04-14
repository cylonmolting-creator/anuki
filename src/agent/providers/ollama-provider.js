'use strict';

const BaseProvider = require('./base-provider');

/**
 * Ollama Provider
 *
 * Uses the Ollama REST API for local model inference.
 * Supports: streaming, basic chat completion.
 * Does NOT support: session resume, agentic tool use (model-dependent).
 *
 * Requirements: Ollama running locally (default: http://localhost:11434).
 * Install: https://ollama.ai
 */
class OllamaProvider extends BaseProvider {
  constructor(config, logger) {
    super(config, logger);
    this.baseUrl = config.url || process.env.OLLAMA_URL || 'http://localhost:11434';
    this.defaultModel = config.model || process.env.OLLAMA_MODEL || 'llama3.1';
  }

  get name() {
    return 'ollama';
  }

  supportsResume() {
    return false;
  }

  supportsAgentic() {
    return false; // Ollama models generally don't support reliable tool use
  }

  mapModel(anukiModel) {
    // Ollama uses model names directly — user configures which model to use
    const modelMap = {
      'haiku': this.defaultModel,
      'sonnet': this.defaultModel,
      'opus': this.defaultModel
    };
    return modelMap[anukiModel] || this.defaultModel;
  }

  buildArgs(options) {
    const { message, systemPrompt, model } = options;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: message });

    return {
      url: `${this.baseUrl}/api/chat`,
      body: {
        model: this.mapModel(model),
        messages,
        stream: true
      }
    };
  }

  spawnProcess(spawnConfig, workspaceDir, env) {
    const { PassThrough } = require('stream');
    const http = require('http');
    const https = require('https');

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const url = new URL(spawnConfig.url);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      if (res.statusCode !== 200) {
        let errorBody = '';
        res.on('data', chunk => { errorBody += chunk.toString(); });
        res.on('end', () => {
          stderr.write(`Ollama API error (${res.statusCode}): ${errorBody}\n`);
          stdout.write(JSON.stringify({
            type: 'result',
            subtype: 'error',
            error: `Ollama API error (${res.statusCode}): ${errorBody.substring(0, 500)}`
          }) + '\n');
          stdout.end();
          stderr.end();
        });
        return;
      }

      let buffer = '';
      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;

      // Emit system event
      stdout.write(JSON.stringify({
        type: 'system',
        session_id: `ollama-${Date.now()}`,
        model: spawnConfig.body.model
      }) + '\n');

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line);

            // Ollama streams: {"message":{"role":"assistant","content":"text"},"done":false}
            if (parsed.message && parsed.message.content) {
              fullContent += parsed.message.content;
              stdout.write(JSON.stringify({
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: parsed.message.content }
                }
              }) + '\n');
            }

            // Final message with done:true includes token counts
            if (parsed.done === true) {
              inputTokens = parsed.prompt_eval_count || 0;
              outputTokens = parsed.eval_count || 0;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      });

      res.on('end', () => {
        stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: fullContent,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          total_cost_usd: 0, // Local models are free
          duration_ms: null
        }) + '\n');
        stdout.end();
        stderr.end();
      });

      res.on('error', (err) => {
        stderr.write(`Ollama stream error: ${err.message}\n`);
        stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'error',
          error: `Stream error: ${err.message}`
        }) + '\n');
        stdout.end();
        stderr.end();
      });
    });

    req.on('error', (err) => {
      const isConnectionRefused = err.code === 'ECONNREFUSED';
      const errorMsg = isConnectionRefused
        ? `Ollama server not running at ${this.baseUrl}. Start with: ollama serve`
        : `Ollama connection error: ${err.message}`;

      stderr.write(errorMsg + '\n');
      stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'error',
        error: errorMsg
      }) + '\n');
      stdout.end();
      stderr.end();
    });

    req.write(JSON.stringify(spawnConfig.body));
    req.end();

    const fakeProcess = {
      stdout,
      stderr,
      pid: process.pid,
      killed: false,
      _req: req,
      kill(signal) {
        this.killed = true;
        req.destroy();
        if (!stdout.destroyed) stdout.destroy();
        if (!stderr.destroyed) stderr.destroy();
      },
      on(event, handler) {
        if (event === 'close') {
          stdout.on('end', () => handler(0, null));
        } else if (event === 'error') {
          req.on('error', handler);
        }
      }
    };

    return { process: fakeProcess, type: 'http' };
  }

  parseOutputLine(line) {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  isRetryableError(exitCode, stderr) {
    const s = (stderr || '').toLowerCase();
    return s.includes('connection') || s.includes('timeout') || s.includes('econnreset');
  }

  validate() {
    // Check if Ollama is reachable
    const http = require('http');
    return new Promise((resolve) => {
      const url = new URL(this.baseUrl);
      const req = http.get(`${this.baseUrl}/api/tags`, { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              const models = (parsed.models || []).map(m => m.name);
              if (models.length === 0) {
                resolve({ valid: false, error: `Ollama running but no models installed. Run: ollama pull ${this.defaultModel}` });
              } else {
                resolve({ valid: true, models });
              }
            } catch {
              resolve({ valid: true }); // Ollama is running, models unknown
            }
          } else {
            resolve({ valid: false, error: `Ollama responded with status ${res.statusCode}` });
          }
        });
      });
      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          resolve({ valid: false, error: `Ollama not running at ${this.baseUrl}. Install: https://ollama.ai — then run: ollama serve` });
        } else {
          resolve({ valid: false, error: `Cannot reach Ollama: ${err.message}` });
        }
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ valid: false, error: `Ollama timeout at ${this.baseUrl}` });
      });
    });
  }
}

module.exports = OllamaProvider;
