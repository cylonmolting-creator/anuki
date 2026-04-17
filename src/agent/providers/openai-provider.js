'use strict';

const BaseProvider = require('./base-provider');
const { executeTool } = require('../tools');

/**
 * OpenAI API Provider — Full Agentic Mode
 *
 * Uses the OpenAI Chat Completions API with function calling (tool use).
 * Implements a multi-turn agentic loop: model calls tools → we execute →
 * send results back → model continues until done.
 *
 * Compatible with: OpenAI, DeepSeek, Groq, Together AI, Azure OpenAI,
 * Fireworks, Perplexity — any OpenAI-compatible endpoint.
 *
 * Supports: streaming (SSE), tool use (function calling), multi-turn.
 * Does NOT support: session resume (stateless).
 *
 * Requirements: OPENAI_API_KEY environment variable (or compatible key).
 */

const MAX_AGENTIC_TURNS = 15;

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
    return true;
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
    const { message, systemPrompt, model, tools, maxTurns, workspaceDir } = options;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: message });

    const body = {
      model: this.mapModel(model),
      messages,
      stream: true
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    return {
      url: `${this.baseUrl}/chat/completions`,
      body,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      maxTurns: maxTurns || MAX_AGENTIC_TURNS,
      workspaceDir
    };
  }

  spawnProcess(spawnConfig, workspaceDir, env) {
    const { PassThrough } = require('stream');
    const https = require('https');
    const http = require('http');

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let killed = false;
    let activeReq = null;

    const effectiveWorkspaceDir = spawnConfig.workspaceDir || workspaceDir;
    const maxTurns = spawnConfig.maxTurns || MAX_AGENTIC_TURNS;
    const hasTools = spawnConfig.body.tools && spawnConfig.body.tools.length > 0;

    // Conversation history — grows with each tool turn
    const messages = [...spawnConfig.body.messages];

    // Emit system event
    stdout.write(JSON.stringify({
      type: 'system',
      session_id: `openai-${Date.now()}`,
      model: spawnConfig.body.model
    }) + '\n');

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let turnCount = 0;
    const startTime = Date.now();

    /**
     * Run one turn of the agentic loop.
     * Sends current messages to the API, parses streaming response,
     * executes tool calls if any, and either loops or finishes.
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
          total_cost_usd: null,
          duration_ms: elapsed
        }) + '\n');
        stdout.end();
        stderr.end();
        return;
      }

      // Emit progress event
      if (turnCount > 1) {
        stdout.write(JSON.stringify({
          type: 'progress',
          turn: turnCount,
          maxTurns,
          percentage: Math.round((turnCount / maxTurns) * 100),
          elapsedMs: Date.now() - startTime
        }) + '\n');
      }

      // Build request body for this turn
      const requestBody = {
        model: spawnConfig.body.model,
        messages,
        stream: true
      };
      if (hasTools) {
        requestBody.tools = spawnConfig.body.tools;
        requestBody.tool_choice = 'auto';
      }

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

        // Tool call accumulation (SSE streams tool_calls in deltas)
        const toolCallsMap = new Map(); // index → { id, name, arguments }

        res.on('data', (chunk) => {
          if (killed) return;
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep incomplete line

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta;

              if (!delta) continue;

              // Text content
              if (delta.content) {
                fullContent += delta.content;
                stdout.write(JSON.stringify({
                  type: 'stream_event',
                  event: {
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text: delta.content }
                  }
                }) + '\n');
              }

              // Tool calls (accumulated from deltas)
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index;
                  if (!toolCallsMap.has(idx)) {
                    toolCallsMap.set(idx, {
                      id: tc.id || '',
                      name: tc.function?.name || '',
                      arguments: ''
                    });
                  }
                  const entry = toolCallsMap.get(idx);
                  if (tc.id) entry.id = tc.id;
                  if (tc.function?.name) entry.name = tc.function.name;
                  if (tc.function?.arguments) entry.arguments += tc.function.arguments;
                }
              }

              // Usage info (in final chunk with stream_options)
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
          if (killed) return;

          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;

          const toolCalls = Array.from(toolCallsMap.values()).filter(tc => tc.name);

          if (toolCalls.length > 0) {
            // --- AGENTIC: Execute tool calls and continue ---

            // Build the assistant message with tool_calls for conversation history
            const assistantMsg = {
              role: 'assistant',
              content: fullContent || null,
              tool_calls: toolCalls.map((tc, i) => ({
                id: tc.id || `call_${turnCount}_${i}`,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: tc.arguments
                }
              }))
            };
            messages.push(assistantMsg);

            // Execute each tool call
            for (const tc of assistantMsg.tool_calls) {
              // Emit tool_start event for UI
              stdout.write(JSON.stringify({
                type: 'tool_start',
                tool: tc.function.name,
                id: tc.id,
                input: tc.function.arguments.substring(0, 200)
              }) + '\n');

              // Parse arguments and execute
              let args;
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                args = {};
              }

              const result = executeTool(tc.function.name, args, {
                workspaceDir: effectiveWorkspaceDir,
                logger: this.logger
              });

              // Build tool result content
              const resultContent = result.success
                ? (result.output || 'OK')
                : `Error: ${result.error}`;

              // Emit tool_result event for UI
              stdout.write(JSON.stringify({
                type: 'tool_result',
                tool: tc.function.name,
                id: tc.id,
                success: result.success,
                output: resultContent.substring(0, 500)
              }) + '\n');

              // Add tool result to conversation history (OpenAI format)
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: resultContent.substring(0, 50000) // Cap at 50KB per tool result
              });
            }

            // Continue the agentic loop — next turn
            runTurn();

          } else {
            // --- DONE: Model gave final answer ---
            const elapsed = Date.now() - startTime;
            stdout.write(JSON.stringify({
              type: 'result',
              subtype: 'success',
              result: fullContent,
              usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
              total_cost_usd: null,
              duration_ms: elapsed
            }) + '\n');
            stdout.end();
            stderr.end();
          }
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

      req.write(JSON.stringify(requestBody));
      req.end();
      activeReq = req;
    };

    // Start the first turn
    runTurn();

    // Create fake process object that matches child_process interface
    const fakeProcess = {
      stdout,
      stderr,
      pid: process.pid,
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
          // Errors are handled within the loop
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
