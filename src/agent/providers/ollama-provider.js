'use strict';

const BaseProvider = require('./base-provider');
const { executeTool } = require('../tools');
const { tryParseJSON } = require('../../utils/helpers');

/**
 * Ollama Provider — Full Agentic Mode (for supported models)
 *
 * Uses the Ollama native REST API (/api/chat) for local model inference.
 * Implements a multi-turn agentic loop with tool calling for capable models.
 *
 * Key differences from OpenAI:
 *   - Uses JSONL streaming (not SSE)
 *   - Tool calls: stream: false (streaming + tools is broken in Ollama)
 *   - Arguments come as parsed JSON objects (not strings)
 *   - Tool results use tool_name (not tool_call_id)
 *   - No tool call IDs — we generate our own
 *
 * Supports: streaming (text), tool use (function calling), multi-turn.
 * Does NOT support: session resume (stateless).
 *
 * Requirements: Ollama running locally (default: http://localhost:11434).
 * Install: https://ollama.ai
 */

const MAX_AGENTIC_TURNS = 15;

// Models known to support tool/function calling reliably
const TOOL_CAPABLE_MODELS = [
  'llama3.1', 'llama3.2', 'llama3.3', 'llama4',
  'qwen2.5', 'qwen3',
  'mistral', 'mistral-nemo', 'mistral-small', 'mistral-large',
  'deepseek-v3',
  'command-r', 'command-r-plus'
];

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
    // Check if the configured model supports tool calling
    return TOOL_CAPABLE_MODELS.some(m => this.defaultModel.toLowerCase().includes(m));
  }

  mapModel(anukiModel) {
    // Ollama uses model names directly
    const modelMap = {
      'haiku': this.defaultModel,
      'sonnet': this.defaultModel,
      'opus': this.defaultModel
    };
    return modelMap[anukiModel] || this.defaultModel;
  }

  buildArgs(options) {
    const { message, systemPrompt, model, tools, maxTurns, workspaceDir } = options;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: message });

    const body = {
      model: this.mapModel(model),
      messages,
      stream: true // Stream text; tool turns use stream: false
    };

    if (tools && tools.length > 0 && this.supportsAgentic()) {
      body.tools = tools;
    }

    return {
      url: `${this.baseUrl}/api/chat`,
      body,
      maxTurns: maxTurns || MAX_AGENTIC_TURNS,
      workspaceDir
    };
  }

  spawnProcess(spawnConfig, workspaceDir, env) {
    const { PassThrough } = require('stream');
    const http = require('http');
    const https = require('https');

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let killed = false;
    let activeReq = null;

    const effectiveWorkspaceDir = spawnConfig.workspaceDir || workspaceDir;
    const maxTurns = spawnConfig.maxTurns || MAX_AGENTIC_TURNS;
    const hasTools = spawnConfig.body.tools && spawnConfig.body.tools.length > 0;

    // Conversation history
    const messages = [...spawnConfig.body.messages];

    // Emit system event
    stdout.write(JSON.stringify({
      type: 'system',
      session_id: `ollama-${Date.now()}`,
      model: spawnConfig.body.model
    }) + '\n');

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turnCount = 0;
    const startTime = Date.now();

    /**
     * Run one turn. If tools are present and model wants to call them,
     * we use stream:false (Ollama streaming + tools is unreliable).
     * For the final text response, we stream.
     */
    const runTurn = () => {
      if (killed) return;
      turnCount++;

      if (turnCount > maxTurns) {
        const elapsed = Date.now() - startTime;
        stdout.write(JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: '[Max turns reached. Stopping agentic loop.]',
          usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
          total_cost_usd: 0,
          duration_ms: elapsed
        }) + '\n');
        stdout.end();
        stderr.end();
        return;
      }

      // Progress event
      if (turnCount > 1) {
        stdout.write(JSON.stringify({
          type: 'progress',
          turn: turnCount,
          maxTurns,
          percentage: Math.round((turnCount / maxTurns) * 100),
          elapsedMs: Date.now() - startTime
        }) + '\n');
      }

      // For tool-calling turns: stream: false (reliable tool parsing)
      // For text-only turns (no tools or last turn): stream: true
      const useStream = !hasTools;

      const requestBody = {
        model: spawnConfig.body.model,
        messages,
        stream: useStream
      };
      if (hasTools) {
        requestBody.tools = spawnConfig.body.tools;
      }

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
        let toolCalls = [];

        res.on('data', (chunk) => {
          if (killed) return;
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const parsed = JSON.parse(line);

              if (useStream) {
                // Streaming mode — text deltas
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
              } else {
                // Non-streaming mode — complete response in one JSON object
                if (parsed.message) {
                  fullContent = parsed.message.content || '';
                  if (parsed.message.tool_calls && parsed.message.tool_calls.length > 0) {
                    toolCalls = parsed.message.tool_calls;
                  }
                }
              }

              // Token counts
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
          if (killed) return;

          // Handle remaining buffer (non-streaming responses may not end with newline)
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              if (parsed.message) {
                fullContent = parsed.message.content || fullContent;
                if (parsed.message.tool_calls && parsed.message.tool_calls.length > 0) {
                  toolCalls = parsed.message.tool_calls;
                }
              }
              if (parsed.done === true) {
                inputTokens = parsed.prompt_eval_count || inputTokens;
                outputTokens = parsed.eval_count || outputTokens;
              }
            } catch {
              // Ignore parse errors in remaining buffer
            }
          }

          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;

          if (toolCalls.length > 0) {
            // --- AGENTIC: Execute tool calls and continue ---

            // Stream any text content that came before tool calls
            if (fullContent) {
              stdout.write(JSON.stringify({
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: fullContent }
                }
              }) + '\n');
            }

            // Build assistant message for conversation history
            const assistantMsg = {
              role: 'assistant',
              content: fullContent || '',
              tool_calls: toolCalls
            };
            messages.push(assistantMsg);

            // Execute each tool call
            for (let i = 0; i < toolCalls.length; i++) {
              const tc = toolCalls[i];
              const toolName = tc.function?.name || 'unknown';
              const toolArgs = tc.function?.arguments || {};

              // Emit tool_start
              stdout.write(JSON.stringify({
                type: 'tool_start',
                tool: toolName,
                id: `ollama_${turnCount}_${i}`,
                input: JSON.stringify(toolArgs).substring(0, 200)
              }) + '\n');

              // Execute — Ollama args are already parsed objects (not strings)
              const parsedArgs = typeof toolArgs === 'string'
                ? tryParseJSON(toolArgs)
                : toolArgs;

              const result = executeTool(toolName, parsedArgs, {
                workspaceDir: effectiveWorkspaceDir,
                logger: this.logger
              });

              const resultContent = result.success
                ? (result.output || 'OK')
                : `Error: ${result.error}`;

              // Emit tool_result
              stdout.write(JSON.stringify({
                type: 'tool_result',
                tool: toolName,
                id: `ollama_${turnCount}_${i}`,
                success: result.success,
                output: resultContent.substring(0, 500)
              }) + '\n');

              // Add tool result to conversation (Ollama native format)
              messages.push({
                role: 'tool',
                content: resultContent.substring(0, 50000)
              });
            }

            // Continue the agentic loop
            runTurn();

          } else {
            // --- DONE: Model gave final answer ---
            const elapsed = Date.now() - startTime;
            stdout.write(JSON.stringify({
              type: 'result',
              subtype: 'success',
              result: fullContent,
              usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
              total_cost_usd: 0,
              duration_ms: elapsed
            }) + '\n');
            stdout.end();
            stderr.end();
          }
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

      req.write(JSON.stringify(requestBody));
      req.end();
      activeReq = req;
    };

    // Start the first turn
    runTurn();

    const fakeProcess = {
      stdout,
      stderr,
      pid: -1,  // Sentinel value — never matches server PID (prevents self-kill in executor orphan cleanup)
      killed: false,
      _req: null,
      kill(signal) {
        killed = true;
        this.killed = true;
        if (activeReq) activeReq.destroy();
        if (!stdout.destroyed) stdout.destroy();
        if (!stderr.destroyed) stderr.destroy();
      },
      on(event, handler) {
        if (event === 'close') {
          stdout.on('end', () => handler(0, null));
        } else if (event === 'error') {
          // Errors handled within loop
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
    const http = require('http');
    return new Promise((resolve) => {
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
              resolve({ valid: true });
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
