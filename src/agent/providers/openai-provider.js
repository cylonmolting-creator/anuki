'use strict';

const BaseProvider = require('./base-provider');

/**
 * OpenAI API Provider
 *
 * Uses the OpenAI Chat Completions API directly via HTTP (node-fetch).
 * Supports: streaming (SSE), tool use (function calling).
 * Does NOT support: session resume, agentic file editing.
 *
 * Requirements: OPENAI_API_KEY environment variable.
 */
class OpenAIProvider extends BaseProvider {
  constructor(config, logger) {
    super(config, logger);
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = config.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.defaultModel = config.model || process.env.OPENAI_MODEL || 'gpt-4o';
  }

  get name() {
    return 'openai';
  }

  supportsResume() {
    return false;
  }

  supportsAgentic() {
    return false; // OpenAI API alone doesn't do agentic file editing
  }

  mapModel(anukiModel) {
    const modelMap = {
      'haiku': 'gpt-4o-mini',
      'sonnet': 'gpt-4o',
      'opus': 'gpt-4o'
    };
    return modelMap[anukiModel] || this.defaultModel;
  }

  getFallbackModel(model) {
    if (model === 'gpt-4o') return 'gpt-4o-mini';
    return null;
  }

  buildArgs(options) {
    const { message, systemPrompt, model } = options;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: message });

    return {
      url: `${this.baseUrl}/chat/completions`,
      body: {
        model: this.mapModel(model),
        messages,
        stream: true
      },
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      }
    };
  }

  spawnProcess(spawnConfig, workspaceDir, env) {
    // OpenAI uses HTTP streaming, not a subprocess.
    // We create a fake "process" that wraps the HTTP stream.
    const { Readable, PassThrough } = require('stream');
    const https = require('https');
    const http = require('http');

    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const url = new URL(spawnConfig.url);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(url, {
      method: 'POST',
      headers: spawnConfig.headers
    }, (res) => {
      if (res.statusCode !== 200) {
        let errorBody = '';
        res.on('data', chunk => { errorBody += chunk.toString(); });
        res.on('end', () => {
          stderr.write(`OpenAI API error (${res.statusCode}): ${errorBody}\n`);
          stdout.write(JSON.stringify({
            type: 'result',
            subtype: 'error',
            error: `OpenAI API error (${res.statusCode}): ${errorBody.substring(0, 500)}`
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
        session_id: `openai-${Date.now()}`,
        model: spawnConfig.body.model
      }) + '\n');

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;

            if (delta?.content) {
              fullContent += delta.content;
              stdout.write(JSON.stringify({
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: delta.content }
                }
              }) + '\n');
            }

            // Usage info (in final chunk)
            if (parsed.usage) {
              inputTokens = parsed.usage.prompt_tokens || 0;
              outputTokens = parsed.usage.completion_tokens || 0;
            }
          } catch {
            // Skip unparseable SSE lines
          }
        }
      });

      res.on('end', () => {
        // Emit result event
        stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: fullContent,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          total_cost_usd: null, // OpenAI doesn't report cost in API
          duration_ms: null
        }) + '\n');
        stdout.end();
        stderr.end();
      });

      res.on('error', (err) => {
        stderr.write(`OpenAI stream error: ${err.message}\n`);
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
      stderr.write(`OpenAI connection error: ${err.message}\n`);
      stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'error',
        error: `Connection error: ${err.message}`
      }) + '\n');
      stdout.end();
      stderr.end();
    });

    req.write(JSON.stringify(spawnConfig.body));
    req.end();

    // Create fake process object that matches child_process interface
    const fakeProcess = {
      stdout,
      stderr,
      pid: process.pid, // Use parent PID as placeholder
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
    // Output is already in normalized format (we write it that way in spawnProcess)
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  isRetryableError(exitCode, stderr) {
    const s = (stderr || '').toLowerCase();
    return s.includes('rate limit') || s.includes('429') || s.includes('timeout') || s.includes('econnreset');
  }

  validate() {
    if (!this.apiKey) {
      return {
        valid: false,
        error: 'OPENAI_API_KEY not set. Get one at https://platform.openai.com/api-keys'
      };
    }
    return { valid: true };
  }
}

module.exports = OpenAIProvider;
