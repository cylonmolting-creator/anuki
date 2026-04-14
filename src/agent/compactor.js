/**
 * Anuki SESSION COMPACTOR v4.2 — Token-Based
 *
 * Token-based context management:
 *
 * Strategies:
 *   1. SOFT TRIM  — Summarize old messages (preserves information)
 *   2. HARD CLEAR — Critical level: placeholder large tool results,
 *                   keep only last N messages + summary
 *
 * Features:
 *   - Token-based decisions (instead of message count)
 *   - Semantic bookmark: Important messages (reminders, decisions, preferences) preserved
 *   - Tool result placeholder: Large tool outputs trimmed
 *   - ContextGuard integration
 */

class SessionCompactor {
  constructor(config, logger) {
    // Legacy message-count based fallback (backward compat)
    this.maxMessages = config.maxMessages || 40;
    this.compactTo = config.compactTo || 15;
    this.logger = logger;

    // Token-based thresholds
    this.softTrimTokenThreshold = config.softTrimTokenThreshold || 0.70;  // Soft trim at 70%
    this.hardClearTokenThreshold = config.hardClearTokenThreshold || 0.90; // Hard clear at 90%
    this.targetUsageAfterTrim = config.targetUsageAfterTrim || 0.50;      // Target after trim: 50%

    // Semantic bookmark: Messages containing these phrases are preserved with priority
    // Use phrases not single words — prevents false positives
    this.bookmarkKeywords = [
      'remember', 'save', 'important', 'don\'t forget',
      'decision', 'preference', 'we decided',
      'never do', 'always use',
      'critical bug', 'must fix',
      'deadline', 'take note'
    ];

    // Tool result max length (threshold for placeholder replacement)
    this.toolResultMaxChars = config.toolResultMaxChars || 300;

    // ContextGuard reference (injected from index.js)
    this.contextGuard = null;
  }

  /**
   * ContextGuard inject
   */
  setContextGuard(cg) {
    this.contextGuard = cg;
  }

  /**
   * Is token-based compaction needed?
   * Uses ContextGuard for token-based decisions, falls back to message count
   */
  needsCompaction(session, systemPrompt) {
    if (!session.messages || session.messages.length === 0) return false;

    // Token-based check (preferred)
    if (this.contextGuard && systemPrompt) {
      const status = this.contextGuard.checkContext(systemPrompt, session.messages);
      if (status.action === 'compact' || status.action === 'truncate') {
        this.log('Token-based compaction needed: ' + status.usage + '% used (' + status.action + ')');
        return true;
      }
      return false;
    }

    // Fallback: message count based
    return session.messages.length > this.maxMessages;
  }

  /**
   * Determine compaction level: 'soft' or 'hard'
   */
  getCompactionLevel(session, systemPrompt) {
    if (this.contextGuard && systemPrompt) {
      const status = this.contextGuard.checkContext(systemPrompt, session.messages);
      const usage = status.usage / 100;

      if (usage >= this.hardClearTokenThreshold) return 'hard';
      if (usage >= this.softTrimTokenThreshold) return 'soft';
      return 'none';
    }

    // Fallback: message count based
    if (session.messages.length > this.maxMessages * 1.5) return 'hard';
    if (session.messages.length > this.maxMessages) return 'soft';
    return 'none';
  }

  /**
   * Main compaction method — applies soft or hard based on level
   */
  async compact(session, systemPrompt) {
    const level = this.getCompactionLevel(session, systemPrompt);

    if (level === 'none') return session;
    if (level === 'hard') return this._hardClear(session, systemPrompt);
    return this._softTrim(session, systemPrompt);
  }

  // =================================================================
  // SOFT TRIM — Summarize old messages, preserve semantic bookmarks
  // =================================================================

  _softTrim(session, systemPrompt) {
    const oldCount = session.messages.length;

    // Calculate how many messages to keep (token-based)
    let keepCount = this.compactTo;
    if (this.contextGuard && systemPrompt) {
      keepCount = this.contextGuard.getRecommendedMessageCount(
        session.messages,
        this.targetUsageAfterTrim
      );
    }

    // Keep at least 5 messages
    keepCount = Math.max(5, Math.min(keepCount, session.messages.length));

    const toSummarize = session.messages.slice(0, -keepCount);
    const toKeep = session.messages.slice(-keepCount);

    if (toSummarize.length === 0) return session;

    // Find and preserve semantic bookmarks
    const bookmarked = [];
    const nonBookmarked = [];

    for (const msg of toSummarize) {
      if (this._isBookmarked(msg)) {
        bookmarked.push(msg);
      } else {
        nonBookmarked.push(msg);
      }
    }

    // Trim tool results (in preserved messages too)
    const trimmedKeep = toKeep.map(m => this._trimToolResult(m));

    // Build summary — include both user and assistant messages
    const summaryPairs = [];
    for (let i = 0; i < nonBookmarked.length; i++) {
      const m = nonBookmarked[i];
      if (!m.content || m.content.length <= 10) continue;
      const prefix = m.role === 'user' ? 'User' : 'Agent';
      summaryPairs.push(prefix + ': ' + m.content.substring(0, 150));
    }

    // Add bookmarked messages to summary too (but protect separately)
    const bookmarkSummary = bookmarked.map(m => {
      const prefix = m.role === 'user' ? 'User' : 'Agent';
      return '★ ' + prefix + ': ' + (m.content || '').substring(0, 200);
    });

    const summary = {
      role: 'system',
      content: [
        '[Previous conversation summary — ' + toSummarize.length + ' messages, soft trim]',
        '',
        'Conversation flow:',
        summaryPairs.slice(-10).join('\n'),
        '',
        bookmarkSummary.length > 0
          ? 'Important notes:\n' + bookmarkSummary.join('\n')
          : ''
      ].filter(Boolean).join('\n'),
      timestamp: new Date().toISOString(),
      isCompacted: true,
      compactionType: 'soft'
    };

    session.messages = [summary, ...trimmedKeep];
    session.compactedAt = new Date().toISOString();
    session.compactionCount = (session.compactionCount || 0) + 1;

    this.log('Soft trim: ' + oldCount + ' → ' + session.messages.length +
      ' msgs (bookmarked: ' + bookmarked.length + ')');

    return session;
  }

  // =================================================================
  // HARD CLEAR — Critical level, aggressive cleanup
  // =================================================================

  _hardClear(session, systemPrompt) {
    const oldCount = session.messages.length;

    // Minimum message count: keep only last 5-8 messages
    let keepCount = 8;
    if (this.contextGuard && systemPrompt) {
      keepCount = this.contextGuard.getRecommendedMessageCount(
        session.messages,
        0.35 // Target: 35% usage
      );
      keepCount = Math.max(5, Math.min(keepCount, 10)); // Range: 5-10
    }

    const toRemove = session.messages.slice(0, -keepCount);
    const toKeep = session.messages.slice(-keepCount);

    // Collect all bookmarks (to be added to summary)
    const allBookmarks = [];
    for (const msg of toRemove) {
      if (this._isBookmarked(msg)) {
        const prefix = msg.role === 'user' ? 'User' : 'Agent';
        allBookmarks.push('★ ' + prefix + ': ' + (msg.content || '').substring(0, 120));
      }
    }

    // Aggressively trim tool results in preserved messages
    const trimmedKeep = toKeep.map(m => this._trimToolResult(m, 150));

    // Brief summary
    const topicSet = new Set();
    for (const m of toRemove) {
      if (m.role === 'user' && m.content && m.content.length > 10) {
        const tokens = m.content.toLowerCase().split(/\s+/).slice(0, 3);
        topicSet.add(tokens.join(' '));
      }
    }

    const summary = {
      role: 'system',
      content: [
        '[Conversation history cleared — ' + toRemove.length + ' messages, hard clear]',
        'Previous topics: ' + Array.from(topicSet).slice(-8).join(', '),
        allBookmarks.length > 0
          ? '\nPreserved important notes:\n' + allBookmarks.slice(-5).join('\n')
          : ''
      ].filter(Boolean).join('\n'),
      timestamp: new Date().toISOString(),
      isCompacted: true,
      compactionType: 'hard'
    };

    session.messages = [summary, ...trimmedKeep];
    session.compactedAt = new Date().toISOString();
    session.compactionCount = (session.compactionCount || 0) + 1;

    this.log('Hard clear: ' + oldCount + ' → ' + session.messages.length +
      ' msgs (bookmarks preserved: ' + allBookmarks.length + ')');

    return session;
  }

  // =================================================================
  // HELPERS
  // =================================================================

  /**
   * Is this message a semantic bookmark? (Contains important content)
   */
  _isBookmarked(msg) {
    if (!msg.content) return false;

    // Don't bookmark compaction summary messages (this check MUST come BEFORE keyword check)
    if (msg.isCompacted) return false;

    const lower = msg.content.toLowerCase();

    for (const kw of this.bookmarkKeywords) {
      if (lower.includes(kw)) return true;
    }

    return false;
  }

  /**
   * Trim tool results / long responses with placeholders
   */
  _trimToolResult(msg, maxChars) {
    maxChars = maxChars || this.toolResultMaxChars;
    if (!msg.content || msg.content.length <= maxChars) return msg;

    // Don't trim system summary messages
    if (msg.role === 'system' && msg.isCompacted) return msg;

    // Detect and trim code blocks
    const codeBlockRegex = /```[\s\S]*?```/g;
    let trimmed = msg.content;

    const codeBlocks = trimmed.match(codeBlockRegex);
    if (codeBlocks) {
      for (const block of codeBlocks) {
        if (block.length > 200) {
          const firstLine = block.split('\n')[0];
          const lineCount = block.split('\n').length;
          trimmed = trimmed.replace(block, firstLine + '\n[... ' + lineCount + ' lines of code ...]\n```');
        }
      }
    }

    // If still too long, keep last maxChars characters
    if (trimmed.length > maxChars) {
      const prefix = trimmed.substring(0, 80);
      const suffix = trimmed.substring(trimmed.length - (maxChars - 100));
      trimmed = prefix + '\n[... truncated ...]\n' + suffix;
    }

    return { ...msg, content: trimmed };
  }

  /**
   * Report token usage status (for debugging)
   */
  getTokenStatus(session, systemPrompt) {
    if (!this.contextGuard || !systemPrompt) {
      return {
        mode: 'message-count',
        messageCount: session.messages ? session.messages.length : 0,
        maxMessages: this.maxMessages,
        needsCompaction: this.needsCompaction(session)
      };
    }

    const status = this.contextGuard.checkContext(systemPrompt, session.messages);
    return {
      mode: 'token-based',
      tokenUsage: status.usage + '%',
      totalTokens: status.totalTokens,
      limit: status.available,
      action: status.action,
      compactionLevel: this.getCompactionLevel(session, systemPrompt),
      messageCount: session.messages ? session.messages.length : 0
    };
  }

  log(msg) {
    if (this.logger) {
      this.logger.info('Compactor', msg);
    }
  }
}

module.exports = SessionCompactor;
