/**
 * CONTEXT WINDOW GUARD
 *
 * OpenClaw-style token management:
 * - Token counting (approximate + tiktoken-style)
 * - Context window monitoring
 * - Automatic summarization trigger
 * - Safe truncation without losing important info
 * - Pre-overflow actions (memory flush)
 *
 * Context window management is critical:
 * - Claude Sonnet: ~200K tokens
 * - Overflow = error or truncation
 * - Early intervention = information loss prevention
 */

class ContextGuard {
  constructor(config = {}, logger) {
    this.logger = logger;

    // Model context limits (tokens)
    // Both full model IDs and short aliases supported
    this.contextLimits = {
      'claude-sonnet-4-20250514': 200000,
      'claude-3-5-haiku-20241022': 200000,
      'claude-opus-4-20250514': 200000,
      'sonnet': 200000,
      'haiku': 200000,
      'opus': 200000,
      'gpt-4-turbo': 128000,
      'gpt-4o': 128000,
      default: 100000
    };

    // Thresholds
    this.warningThreshold = config.warningThreshold || 0.7;  // 70% - start warning
    this.actionThreshold = config.actionThreshold || 0.85;   // 85% - trigger compaction
    this.criticalThreshold = config.criticalThreshold || 0.95; // 95% - force truncate

    // Current model
    this.currentModel = config.model || 'claude-sonnet-4-20250514';

    // Reserved tokens for response
    this.reservedForResponse = config.reservedForResponse || 8192;

    this.log('Initialized for ' + this.currentModel + ' (' + this.getContextLimit() + ' tokens)');
  }

  /**
   * Get context limit for current model
   */
  getContextLimit() {
    return this.contextLimits[this.currentModel] || this.contextLimits.default;
  }

  /**
   * Set current model
   */
  setModel(model) {
    this.currentModel = model;
    this.log('Model changed to ' + model + ' (' + this.getContextLimit() + ' tokens)');
  }

  /**
   * Count tokens in text (approximation)
   * Uses ~4 chars per token heuristic
   * For production, integrate tiktoken or similar
   */
  countTokens(text) {
    if (!text) return 0;

    // Simple approximation: ~4 chars per token for English
    // Turkish/special chars: ~3 chars per token
    const charCount = text.length;

    // Count special tokens
    const specialChars = (text.match(/[^\x00-\x7F]/g) || []).length;
    const normalChars = charCount - specialChars;

    // Weighted calculation
    const tokens = Math.ceil(normalChars / 4) + Math.ceil(specialChars / 3);

    return tokens;
  }

  /**
   * Count tokens in a message array
   */
  countSessionTokens(messages) {
    if (!messages || !Array.isArray(messages)) return 0;

    let total = 0;

    for (const msg of messages) {
      // Role token overhead (~4 tokens per message for role, separators)
      total += 4;

      if (typeof msg.content === 'string') {
        total += this.countTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        // Multi-part content (text + images)
        for (const part of msg.content) {
          if (part.type === 'text') {
            total += this.countTokens(part.text);
          } else if (part.type === 'image') {
            // Images are expensive: ~765 tokens for small, up to 1365 for large
            total += 1000;
          }
        }
      }
    }

    return total;
  }

  /**
   * Count total context tokens (system + messages + tools)
   */
  countTotalContext(systemPrompt, messages, toolDefinitions = null) {
    let total = 0;

    // System prompt
    total += this.countTokens(systemPrompt);

    // Messages
    total += this.countSessionTokens(messages);

    // Tool definitions (if any)
    if (toolDefinitions) {
      const toolsJson = JSON.stringify(toolDefinitions);
      total += this.countTokens(toolsJson);
    }

    return total;
  }

  /**
   * Check context status and return action recommendation
   */
  checkContext(systemPrompt, messages, toolDefinitions = null) {
    const totalTokens = this.countTotalContext(systemPrompt, messages, toolDefinitions);
    const limit = this.getContextLimit();
    const available = limit - this.reservedForResponse;
    const usage = totalTokens / available;

    const status = {
      totalTokens,
      limit,
      available,
      reserved: this.reservedForResponse,
      usage: Math.round(usage * 100),
      action: 'none',
      details: null
    };

    if (usage >= this.criticalThreshold) {
      status.action = 'truncate';
      status.details = 'Critical: ' + status.usage + '% used. Force truncation required.';
    } else if (usage >= this.actionThreshold) {
      status.action = 'compact';
      status.details = 'High usage: ' + status.usage + '%. Compaction recommended.';
    } else if (usage >= this.warningThreshold) {
      status.action = 'warn';
      status.details = 'Warning: ' + status.usage + '% used. Consider summarizing soon.';
    }

    return status;
  }

  /**
   * Get recommended number of messages to keep
   */
  getRecommendedMessageCount(messages, targetUsage = 0.5) {
    const limit = this.getContextLimit() - this.reservedForResponse;
    const targetTokens = limit * targetUsage;

    // Start from most recent and work backwards
    let total = 0;
    let count = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgTokens = this.countTokens(msg.content || '') + 4;

      if (total + msgTokens > targetTokens) {
        break;
      }

      total += msgTokens;
      count++;
    }

    return Math.max(5, count); // Keep at least 5 messages
  }

  /**
   * Truncate messages to fit within limit
   */
  truncateMessages(messages, targetUsage = 0.5) {
    const keepCount = this.getRecommendedMessageCount(messages, targetUsage);
    const removed = messages.length - keepCount;

    if (removed <= 0) {
      return {
        messages,
        removed: 0,
        summary: null
      };
    }

    // Get messages to remove for summary
    const toRemove = messages.slice(0, removed);
    const toKeep = messages.slice(removed);

    // Generate summary text
    const summaryText = this._generateSummary(toRemove);

    // Insert summary as first message
    const summaryMessage = {
      role: 'system',
      content: '[Previous conversation summary]\n' + summaryText
    };

    return {
      messages: [summaryMessage, ...toKeep],
      removed,
      summary: summaryText
    };
  }

  /**
   * Check if we should trigger pre-compaction memory flush
   */
  shouldFlushMemory(systemPrompt, messages) {
    const status = this.checkContext(systemPrompt, messages);
    return status.action === 'compact' || status.action === 'truncate';
  }

  /**
   * Get current guard configuration status (for /context command)
   */
  getStatus() {
    return {
      model: this.currentModel,
      contextLimit: this.getContextLimit(),
      reservedForResponse: this.reservedForResponse,
      warningThreshold: Math.round(this.warningThreshold * 100) + '%',
      actionThreshold: Math.round(this.actionThreshold * 100) + '%',
      criticalThreshold: Math.round(this.criticalThreshold * 100) + '%'
    };
  }

  /**
   * Format context status for display
   */
  formatStatus(systemPrompt, messages, toolDefinitions = null) {
    const status = this.checkContext(systemPrompt, messages, toolDefinitions);

    const bar = this._createProgressBar(status.usage / 100);

    return [
      'Context Window Status:',
      bar + ' ' + status.usage + '%',
      'Tokens: ' + status.totalTokens.toLocaleString() + ' / ' + status.available.toLocaleString(),
      'Messages: ' + messages.length,
      status.details ? '⚠️ ' + status.details : '✅ Context healthy'
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  _generateSummary(messages) {
    // Simple extractive summary
    const keyPhrases = [];

    for (const msg of messages) {
      const content = msg.content || '';

      // Extract key information
      if (msg.role === 'user') {
        // User questions/requests
        if (content.length > 50) {
          keyPhrases.push('User: ' + content.substring(0, 100) + '...');
        }
      } else if (msg.role === 'assistant') {
        // Key actions/responses
        if (content.includes('✅') || content.includes('error')) {
          keyPhrases.push('Response: ' + content.substring(0, 80) + '...');
        }
      }
    }

    if (keyPhrases.length === 0) {
      return messages.length + ' messages summarized (general conversation)';
    }

    return keyPhrases.slice(0, 5).join('\n');
  }

  _createProgressBar(ratio, width = 20) {
    const filled = Math.round(ratio * width);
    const empty = width - filled;

    let color = '🟩'; // Green
    if (ratio >= this.criticalThreshold) {
      color = '🟥'; // Red
    } else if (ratio >= this.actionThreshold) {
      color = '🟧'; // Orange
    } else if (ratio >= this.warningThreshold) {
      color = '🟨'; // Yellow
    }

    return '[' + color.repeat(filled) + '⬜'.repeat(empty) + ']';
  }

  log(msg) {
    if (this.logger) {
      this.logger.info('ContextGuard', msg);
    }
  }
}

module.exports = ContextGuard;
