/**
 * ERROR ROOT CAUSE ANALYZER (Roadmap 9.4)
 *
 * When an agent fails a task:
 * 1. Analyze failure category (context limit, tool limitation, model knowledge, timeout, etc.)
 * 2. Use LLM to diagnose root cause
 * 3. Log findings with actionable suggestions
 * 4. Track patterns across failures
 *
 * Storage: data/error-analysis.jsonl (one JSON per line)
 * {
 *   timestamp: ISO string,
 *   conversationId: string,
 *   agentId: string,
 *   taskDescription: string,
 *   failureReason: string (raw error message),
 *   failureCategory: string (context_limit, tool_failure, knowledge_gap, timeout, transient),
 *   toolsAttempted: [ {name, success, error} ],
 *   confidence: number (0-1),
 *   analysis: {
 *     category: string,
 *     rootCause: string (LLM diagnosis),
 *     evidence: [ string ],
 *     suggestions: [ string ]
 *   },
 *   duration: number (ms)
 * }
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class ErrorAnalyzer {
  constructor(baseDir, logger, agentExecutor = null) {
    this.baseDir = baseDir || require('../utils/base-dir');
    this.logger = logger;
    this.analysisFile = path.join(this.baseDir, 'data', 'error-analysis.jsonl');
    this.agentExecutor = agentExecutor; // Optional: AgentExecutor for LLM analysis (roadmap 9.4)

    // Concurrency & circuit breaker (prevents cascade / rate limit exhaustion)
    this._activeAnalyses = 0;
    this._maxConcurrentAnalyses = 3;       // Max 3 parallel LLM analyses
    this._consecutiveFailures = 0;
    this._circuitBreakerThreshold = 5;     // After 5 consecutive LLM failures, stop trying
    this._circuitBreakerResetMs = 5 * 60 * 1000; // Reset circuit breaker after 5 minutes
    this._circuitBreakerTrippedAt = null;
    this._lastAnalysisTime = 0;
    this._minAnalysisIntervalMs = 2000;    // Minimum 2s between analyses

    // Ensure data dir exists
    const dataDir = path.join(this.baseDir, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  /**
   * Categorize failure by examining error message and context
   */
  _categorizeFailure(failureReason, toolSuccessCount, toolCount, duration) {
    const lower = (failureReason || '').toLowerCase();

    // Context limit exceeded
    if (lower.includes('context') || lower.includes('token') || lower.includes('max_turns') || lower.includes('budget')) {
      return 'context_limit';
    }

    // Tool failure (e.g., tool returned error)
    if (toolCount > 0 && toolSuccessCount === 0) {
      return 'tool_failure';
    }

    // Knowledge gap (e.g., "I don't know", "unable to find")
    if (lower.includes('don\'t know') || lower.includes('unable to find') ||
        lower.includes('not available') || lower.includes('uncertain')) {
      return 'knowledge_gap';
    }

    // Timeout (tool or CLI timeout)
    if (lower.includes('timeout') || lower.includes('timed out') || duration > 60000) {
      return 'timeout';
    }

    // Transient network error
    if (lower.includes('econnreset') || lower.includes('econnrefused') ||
        lower.includes('etimedout') || lower.includes('network') ||
        lower.includes('temporarily') || lower.includes('overloaded')) {
      return 'transient';
    }

    // Default: unknown
    return 'unknown';
  }

  /**
   * Generate LLM-based root cause analysis
   * Uses Claude to diagnose the failure pattern
   */
  async analyzeWithLLM(failure, agentWorkspaceId) {
    // Build diagnostic prompt
    const prompt = `You are an AI debugging expert. Analyze this agent failure and provide root cause diagnosis.

TASK: ${failure.taskDescription || '(not described)'}
ERROR: ${failure.failureReason || '(no error message)'}
TOOLS ATTEMPTED: ${failure.toolsAttempted ? JSON.stringify(failure.toolsAttempted) : 'none'}
CONFIDENCE: ${(failure.confidence || 0).toFixed(2)}
DURATION: ${failure.duration || '?'}ms

CATEGORIZED AS: ${failure.failureCategory}

Provide your analysis as JSON (no markdown):
{
  "rootCause": "one sentence explanation of why this failed",
  "evidence": ["item 1", "item 2"],
  "suggestions": ["actionable suggestion 1", "actionable suggestion 2"]
}

Be concise. Root cause should be specific: context limit, specific tool limitation, model knowledge gap, or infrastructure issue.`;

    try {
      // Use Claude CLI for analysis
      // Note: This is a lightweight call, use haiku
      const analysis = await this._runClaudeAnalysis(prompt);
      return analysis;
    } catch (e) {
      this.logger.warn('ErrorAnalyzer', `LLM analysis failed: ${e.message}`);

      // Fallback: rule-based suggestions
      return this._getFallbackAnalysis(failure);
    }
  }

  /**
   * Run Claude analysis for error diagnosis (lightweight haiku call via AgentExecutor)
   */
  async _runClaudeAnalysis(prompt) {
    // If AgentExecutor available, use it (preferred)
    if (this.agentExecutor) {
      return new Promise((resolve, reject) => {
        let response = '';
        let isError = false;

        this.agentExecutor.execute({
          workspaceId: 'system',
          conversationId: 'error-analysis-' + Date.now(),
          userMessage: prompt,
          channel: 'cron',
          userId: 'system',
          maxTurns: 5, // Short limit for analysis
          onEvent: (event) => {
            if (event.type === 'text') {
              response += event.content;
            }
          },
          onComplete: (result) => {
            try {
              // Try parsing as JSON
              const jsonStart = response.indexOf('{');
              const jsonEnd = response.lastIndexOf('}');
              if (jsonStart >= 0 && jsonEnd > jsonStart) {
                const jsonStr = response.substring(jsonStart, jsonEnd + 1);
                const parsed = JSON.parse(jsonStr);
                if (parsed.rootCause && parsed.suggestions) {
                  return resolve({
                    rootCause: parsed.rootCause,
                    evidence: parsed.evidence || [],
                    suggestions: parsed.suggestions
                  });
                }
              }
              reject(new Error('Invalid JSON response from analysis'));
            } catch (e) {
              reject(new Error(`Failed to parse analysis: ${e.message}`));
            }
          },
          onError: (err) => {
            isError = true;
            reject(err);
          }
        }).catch(reject);
      });
    }

    // Fallback: spawn claude CLI directly
    return new Promise((resolve, reject) => {
      const claude = spawn('claude', [
        '--output', 'json',
        '--model', 'haiku',
        '--max-tokens', '500'
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      claude.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      claude.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      claude.on('close', (code) => {
        if (code === 0) {
          try {
            // Parse JSON from stdout
            const result = JSON.parse(stdout);
            if (result.rootCause && result.suggestions) {
              return resolve({
                rootCause: result.rootCause,
                evidence: result.evidence || [],
                suggestions: result.suggestions
              });
            }
          } catch (e) {
            // Fall through to fallback
          }
        }
        reject(new Error(`Claude analysis failed: ${stderr || code}`));
      });

      claude.stdin.write(prompt);
      claude.stdin.end();
    });
  }

  /**
   * Fallback analysis when LLM is unavailable
   */
  _getFallbackAnalysis(failure) {
    const analysis = {
      rootCause: '',
      evidence: [],
      suggestions: []
    };

    const cat = failure.failureCategory || 'unknown';
    const lower = (failure.failureReason || '').toLowerCase();

    switch (cat) {
      case 'context_limit':
        analysis.rootCause = 'Agent exceeded token or turn limits during task execution.';
        analysis.evidence = ['Context/token overflow detected', 'Max turns or budget hit'];
        analysis.suggestions = [
          'Simplify task prompts for agents',
          'Reduce context window size (trim older messages)',
          'Break large tasks into smaller subtasks'
        ];
        break;

      case 'tool_failure':
        analysis.rootCause = 'All tool calls returned errors; agent cannot proceed.';
        analysis.evidence = ['Zero successful tool calls', 'Tools may be misconfigured or unavailable'];
        analysis.suggestions = [
          'Verify tool availability and permissions',
          'Check tool documentation for correct usage',
          'Provide better error messages from tools'
        ];
        break;

      case 'knowledge_gap':
        analysis.rootCause = 'Agent lacks knowledge to answer the question.';
        analysis.evidence = ['Agent explicitly said "I don\'t know"', 'Unable to find relevant information'];
        analysis.suggestions = [
          'Provide agent with additional context or documents',
          'Use web search tool to fill knowledge gaps',
          'Ensure knowledge base is up-to-date'
        ];
        break;

      case 'timeout':
        analysis.rootCause = 'Task took too long; timed out before completion.';
        analysis.evidence = ['Duration exceeded timeout threshold', 'Tool or CLI timeout'];
        analysis.suggestions = [
          'Increase timeout thresholds for long-running tasks',
          'Optimize tool implementations for speed',
          'Run tasks asynchronously to avoid blocking'
        ];
        break;

      case 'transient':
        analysis.rootCause = 'Temporary network or service issue; likely recoverable.';
        analysis.evidence = ['Network or service error detected', 'Error is typically transient'];
        analysis.suggestions = [
          'Retry the task automatically',
          'Implement exponential backoff for retries',
          'Check service health before next attempt'
        ];
        break;

      default:
        analysis.rootCause = 'Failure reason unclear. Check logs for details.';
        analysis.evidence = [`Raw error: ${failure.failureReason}`];
        analysis.suggestions = [
          'Check full error logs for more context',
          'Review agent conversation history',
          'Enable debug logging for next attempt'
        ];
    }

    return analysis;
  }

  /**
   * Log failure with full context and analysis
   */
  async logFailure(failure) {
    try {
      // Circuit breaker check — if too many consecutive LLM failures, use fallback only
      if (this._circuitBreakerTrippedAt) {
        const elapsed = Date.now() - this._circuitBreakerTrippedAt;
        if (elapsed < this._circuitBreakerResetMs) {
          this.logger.warn('ErrorAnalyzer', `Circuit breaker active (${this._consecutiveFailures} failures), using fallback analysis`);
          const analysis = this._getFallbackAnalysis(failure);
          return this._persistFailure(failure, analysis);
        }
        // Reset circuit breaker
        this._circuitBreakerTrippedAt = null;
        this._consecutiveFailures = 0;
      }

      // Concurrency guard — don't spawn more than N parallel analyses
      if (this._activeAnalyses >= this._maxConcurrentAnalyses) {
        this.logger.warn('ErrorAnalyzer', `Concurrency limit (${this._maxConcurrentAnalyses}) reached, using fallback analysis`);
        const analysis = this._getFallbackAnalysis(failure);
        return this._persistFailure(failure, analysis);
      }

      // Rate limit — minimum interval between analyses
      const now = Date.now();
      if (now - this._lastAnalysisTime < this._minAnalysisIntervalMs) {
        const analysis = this._getFallbackAnalysis(failure);
        return this._persistFailure(failure, analysis);
      }
      this._lastAnalysisTime = now;

      // Analyze failure with LLM
      this._activeAnalyses++;
      let analysis;
      try {
        analysis = await this.analyzeWithLLM(failure);
        this._consecutiveFailures = 0; // Reset on success
      } catch (llmErr) {
        this._consecutiveFailures++;
        if (this._consecutiveFailures >= this._circuitBreakerThreshold) {
          this._circuitBreakerTrippedAt = Date.now();
          this.logger.warn('ErrorAnalyzer', `Circuit breaker tripped after ${this._consecutiveFailures} consecutive LLM failures`);
        }
        analysis = this._getFallbackAnalysis(failure);
      } finally {
        this._activeAnalyses--;
      }

      return this._persistFailure(failure, analysis);
    } catch (e) {
      this.logger.error('ErrorAnalyzer', `Failed to log failure: ${e.message}`);
      throw e;
    }
  }

  /**
   * Persist failure record to JSONL file
   */
  _persistFailure(failure, analysis) {
    const record = {
      timestamp: new Date().toISOString(),
      conversationId: failure.conversationId,
      agentId: failure.agentId,
      taskDescription: failure.taskDescription,
      failureReason: failure.failureReason,
      failureCategory: failure.failureCategory,
      toolsAttempted: failure.toolsAttempted || [],
      confidence: failure.confidence || 0,
      analysis: analysis,
      duration: failure.duration || 0
    };

    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(this.analysisFile, line);

    this.logger.info('ErrorAnalyzer', `Logged failure: ${failure.failureCategory} (${failure.conversationId})`);
    return record;
  }

  /**
   * Get analysis for a specific conversation
   */
  getAnalysisByConversation(conversationId) {
    if (!fs.existsSync(this.analysisFile)) {
      return [];
    }

    const analyses = [];
    const lines = fs.readFileSync(this.analysisFile, 'utf8').split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.conversationId === conversationId) {
          analyses.push(record);
        }
      } catch (e) {
        // Skip malformed lines
      }
    }

    return analyses;
  }

  /**
   * Get recent failures (last N)
   */
  getRecentFailures(limit = 50) {
    if (!fs.existsSync(this.analysisFile)) {
      return [];
    }

    const lines = fs.readFileSync(this.analysisFile, 'utf8').split('\n').filter(l => l.trim());
    const analyses = [];

    for (const line of lines) {
      try {
        analyses.push(JSON.parse(line));
      } catch (e) {
        // Skip malformed lines
      }
    }

    // Return most recent first
    return analyses.reverse().slice(0, limit);
  }

  /**
   * Get failure patterns (aggregate statistics)
   */
  getFailurePatterns() {
    const failures = this.getRecentFailures(1000); // Analyze last 1000 failures

    const patterns = {
      totalFailures: failures.length,
      byCategory: {},
      byAgent: {},
      recentSuggestions: [],
      topRootCauses: []
    };

    // Count by category
    for (const failure of failures) {
      const cat = failure.failureCategory || 'unknown';
      patterns.byCategory[cat] = (patterns.byCategory[cat] || 0) + 1;
    }

    // Count by agent
    for (const failure of failures) {
      const agent = failure.agentId || 'unknown';
      patterns.byAgent[agent] = (patterns.byAgent[agent] || 0) + 1;
    }

    // Top suggestions
    const suggestionMap = new Map();
    for (const failure of failures) {
      if (failure.analysis && failure.analysis.suggestions) {
        for (const suggestion of failure.analysis.suggestions) {
          suggestionMap.set(suggestion, (suggestionMap.get(suggestion) || 0) + 1);
        }
      }
    }
    patterns.recentSuggestions = Array.from(suggestionMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sugg, count]) => ({ suggestion: sugg, frequency: count }));

    // Top root causes
    const causeMap = new Map();
    for (const failure of failures) {
      if (failure.analysis && failure.analysis.rootCause) {
        causeMap.set(failure.analysis.rootCause, (causeMap.get(failure.analysis.rootCause) || 0) + 1);
      }
    }
    patterns.topRootCauses = Array.from(causeMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([cause, count]) => ({ cause, frequency: count }));

    return patterns;
  }
}

module.exports = ErrorAnalyzer;
