/**
 * ANUKI REFLECTION ENGINE
 * 
 * Runs periodically (nightly or on-demand) to:
 * 1. Analyze the day's episodes
 * 2. Extract patterns, preferences, facts
 * 3. Store them as semantic/procedural memories
 * 4. Update core memory (MEMORY.md)
 * 5. Apply memory decay
 * 
 * This is what turns raw conversations into wisdom.
 * Without this, the system is just a note-taker.
 * With this, the system learns from experience.
 */

const { execSync } = require('child_process');

class ReflectionEngine {
  constructor(cognitiveMemory, logger) {
    this.memory = cognitiveMemory;
    this.logger = logger;
    this.isRunning = false;
    this.lastRun = null;
  }

  /**
   * Run full reflection cycle
   */
  async runReflection(dateStr) {
    if (this.isRunning) {
      this.log('Already running, skipping');
      return null;
    }

    this.isRunning = true;
    const targetDate = dateStr || new Date().toISOString().split('T')[0];
    
    this.log('Starting reflection for ' + targetDate);

    try {
      // 1. Generate reflection prompt
      const prompt = this.memory.generateReflectionPrompt(targetDate);
      
      if (!prompt) {
        this.log('No episodes to reflect on');
        this.isRunning = false;
        return null;
      }

      // 2. Send to Claude for analysis
      const reflectionResult = await this._callClaude(prompt);
      
      if (!reflectionResult) {
        this.log('Claude returned empty reflection');
        this.isRunning = false;
        return null;
      }

      // 3. Process results
      const processed = this.memory.processReflection(reflectionResult);
      
      // 4. Apply memory decay
      const decay = this.memory.applyDecay();

      // 5. Log the reflection summary
      this._logReflectionSummary(targetDate, processed, decay);

      this.lastRun = new Date().toISOString();
      this.isRunning = false;

      return {
        date: targetDate,
        processed,
        decay,
        timestamp: this.lastRun
      };
    } catch (err) {
      this.log('Reflection failed: ' + err.message);
      this.isRunning = false;
      return null;
    }
  }

  /**
   * Pre-compaction flush: save important context before session gets too long
   * Similar to OpenClaw's memoryFlush but smarter
   */
  async preCompactionFlush(session, channel, userId) {
    if (!session.messages || session.messages.length < 15) return;

    this.log('Pre-compaction flush triggered');

    const recentMessages = session.messages.slice(-15);
    const conversationText = recentMessages
      .map(m => (m.role === 'user' ? 'User' : 'System') + ': ' + m.content)
      .join('\n');

    const flushPrompt = {
      system: `The conversation context window is about to fill up. Extract IMPORTANT information from the following conversation that should not be lost.

Only save what is truly important:
- New information/preferences stated by the user
- Decisions made
- Important actions taken and their results
- Recurring patterns

SKIP unimportant items:
- Greetings
- General chat
- Repetition of already known information

Respond in JSON format:
{
  "important_facts": [
    { "content": "...", "category": "user_pref|decision|action|pattern", "importance": 7 }
  ],
  "nothing_important": false
}

If there is nothing worth saving: { "nothing_important": true }`,
      userMessage: 'Conversation:\n' + conversationText
    };

    try {
      const result = await this._callClaude(flushPrompt);
      
      if (result) {
        const data = typeof result === 'string' ? JSON.parse(result) : result;
        
        if (!data.nothing_important && data.important_facts) {
          for (const fact of data.important_facts) {
            this.memory.storeSemantic({
              content: fact.content,
              category: fact.category || 'general',
              importance: fact.importance || 5,
              source: 'pre_compaction_flush',
              tags: ['flush', channel]
            });
          }
          this.log('Pre-compaction flush saved ' + data.important_facts.length + ' facts');
        } else {
          this.log('Pre-compaction flush: nothing important to save');
        }
      }
    } catch (e) {
      this.log('Pre-compaction flush failed: ' + e.message);
    }
  }

  /**
   * Auto-importance scoring: let Claude decide how important a message is
   */
  scoreImportance(userMessage, response) {
    // Quick heuristic scoring (no API call needed)
    let score = 5;

    // Length indicates complexity
    if (userMessage.length > 200) score += 1;
    if (response.length > 500) score += 1;

    // Explicit memory requests
    if (/remember|save|important/i.test(userMessage)) score += 2;

    // Personal information
    if (/my name|i live|i work/i.test(userMessage)) score += 2;

    // Decisions and actions
    if (/decide|choose|create|setup/i.test(userMessage)) score += 1;

    // Crypto-specific high value
    if (/wallet|api.key|token|contract|0x[a-fA-F0-9]/i.test(userMessage)) score += 1;

    // Errors and problems
    if (/error|bug|broken|fix/i.test(userMessage)) score += 1;

    // Greetings and casual chat are low importance
    if (/^(hey|hi|hello)/i.test(userMessage) && userMessage.length < 30) score = 2;
    if (/^(ok|yes|no|thx)/i.test(userMessage)) score = 2;

    return Math.min(10, Math.max(1, score));
  }

  /**
   * Detect user sentiment/emotion from message
   */
  detectSentiment(message) {
    const lower = message.toLowerCase();
    
    if (/thanks|great|awesome|perfect|wonderful|excellent/i.test(lower)) return 'positive';
    if (/angry|frustrated|terrible|bad|broken|awful/i.test(lower)) return 'negative';
    if (/urgent|asap|quick|immediately|right now/i.test(lower)) return 'urgent';
    if (/\?$/.test(message.trim())) return 'curious';
    
    return 'neutral';
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════

  async _callClaude(prompt) {
    try {
      const fullPrompt = prompt.system + '\n\n' + prompt.userMessage;

      const result = execSync(
        'claude -p 2>/dev/null',
        {
          input: fullPrompt,
          encoding: 'utf8',
          timeout: 60000,
          maxBuffer: 10 * 1024 * 1024,
          env: Object.assign({}, process.env, { HOME: require('os').homedir() })
        }
      ).trim();

      // Try to extract JSON from response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return result;
    } catch (e) {
      this.log('Claude call failed: ' + e.message);
      return null;
    }
  }

  _logReflectionSummary(date, processed, decay) {
    const summary = [
      '═══ REFLECTION COMPLETE ═══',
      'Date: ' + date,
      'New semantic memories: ' + processed.semantic,
      'New procedural memories: ' + processed.procedural,
      'Core memory updates: ' + processed.coreUpdates,
      'Memories decayed: ' + decay.decayed,
      'Memories fading: ' + decay.forgotten,
      '═══════════════════════════'
    ].join('\n');

    this.log(summary);
  }

  log(msg) {
    if (this.logger) {
      this.logger.info('Reflection', msg);
    }
  }
}

module.exports = ReflectionEngine;
