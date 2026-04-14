/**
 * GroupChat — Multi-Agent Group Conversations
 *
 * Allows 3-5 agents to participate in a conversation together.
 * Messages are broadcast to all participants, and each agent can respond.
 *
 * Use cases:
 * - Math + Crypto agents analyzing a DeFi protocol together
 * - Multiple specialist agents collaborating on a complex task
 * - Round-table discussions with different perspectives
 *
 * Architecture:
 * - Hub-and-spoke: All messages route through this manager
 * - Turn-based: Agents respond in sequence (not parallel, to avoid chaos)
 * - Persistence: Full conversation history logged to JSONL
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class GroupChat {
  constructor(messageRouter, agentManager, logger) {
    this.messageRouter = messageRouter;
    this.agentManager = agentManager;
    this.logger = logger;

    // Active groups: groupId -> { participants, history, createdAt, topic }
    this.activeGroups = new Map();

    // Persistence
    const baseDir = require('../utils/base-dir');
    this.logFile = path.join(baseDir, 'data', 'group-chats.jsonl');
    this.logDir = path.dirname(this.logFile);

    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.logger.info('GroupChat', 'Initialized group chat manager');
  }

  /**
   * Create a new group chat
   *
   * @param {Object} options
   * @param {string[]} options.participants - Array of agent IDs (3-5 agents)
   * @param {string} [options.topic] - Optional topic/title for the group
   * @param {string} [options.initiator] - Agent ID that initiated the group
   * @returns {Object} Group metadata
   */
  createGroup(options) {
    const { participants, topic = null, initiator = null } = options;

    // Validation
    if (!participants || !Array.isArray(participants)) {
      throw new Error('participants must be an array of agent IDs');
    }

    if (participants.length < 2 || participants.length > 5) {
      throw new Error('Group must have 2-5 participants');
    }

    // Verify all agents exist
    for (const agentId of participants) {
      const agent = this.agentManager.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }
    }

    const groupId = uuidv4();
    const group = {
      id: groupId,
      participants,
      topic: topic || `Group: ${participants.map(id => this.agentManager.getAgent(id)?.name || id).join(', ')}`,
      initiator,
      createdAt: new Date().toISOString(),
      history: [],
      messageCount: 0,
      active: true
    };

    this.activeGroups.set(groupId, group);

    // Log group creation
    this._logEvent({
      type: 'group_created',
      groupId,
      participants,
      topic: group.topic,
      timestamp: group.createdAt
    });

    this.logger.info('GroupChat', `Group created: ${groupId} (${participants.length} agents)`);

    return group;
  }

  /**
   * Send message to group (broadcast to all participants)
   *
   * @param {string} groupId
   * @param {string} fromAgentId - Sender agent ID (or 'user')
   * @param {string} message
   * @param {Object} [options]
   * @param {boolean} [options.waitForReplies=true] - Wait for all agents to respond
   * @param {number} [options.timeout=60] - Timeout per agent response
   * @returns {Promise<Object>} { replies: [ { agentId, reply, timestamp } ], ... }
   */
  async sendMessage(groupId, fromAgentId, message, options = {}) {
    const { waitForReplies = true, timeout = 60 } = options;

    const group = this.activeGroups.get(groupId);
    if (!group) {
      throw new Error(`Group not found: ${groupId}`);
    }

    if (!group.active) {
      throw new Error(`Group is closed: ${groupId}`);
    }

    const messageId = uuidv4();
    const timestamp = new Date().toISOString();

    // Add to history
    const historyEntry = {
      id: messageId,
      from: fromAgentId,
      message,
      timestamp,
      replies: []
    };
    group.history.push(historyEntry);
    group.messageCount++;

    // Log message
    this._logEvent({
      type: 'group_message',
      groupId,
      messageId,
      from: fromAgentId,
      message,
      timestamp
    });

    this.logger.info('GroupChat', `[${groupId}] ${fromAgentId}: ${message.substring(0, 60)}`);

    // Broadcast to all participants (except sender)
    const recipients = group.participants.filter(id => id !== fromAgentId);

    if (!waitForReplies) {
      // Fire-and-forget mode
      for (const recipientId of recipients) {
        this._sendToAgent(groupId, messageId, fromAgentId, recipientId, message, 0);
      }
      return { messageId, recipients, mode: 'fire-and-forget' };
    }

    // Wait for replies mode (sequential, not parallel — prevents chaos)
    const replies = [];

    for (const recipientId of recipients) {
      try {
        const reply = await this._sendToAgent(groupId, messageId, fromAgentId, recipientId, message, timeout);
        replies.push({
          agentId: recipientId,
          agentName: this.agentManager.getAgent(recipientId)?.name || recipientId,
          reply: reply.reply,
          timestamp: new Date().toISOString(),
          status: 'ok'
        });

        // Add reply to history
        historyEntry.replies.push({
          agentId: recipientId,
          reply: reply.reply,
          timestamp: new Date().toISOString()
        });

        // Log reply
        this._logEvent({
          type: 'group_reply',
          groupId,
          messageId,
          from: recipientId,
          reply: reply.reply,
          timestamp: new Date().toISOString()
        });

      } catch (e) {
        this.logger.error('GroupChat', `[${groupId}] ${recipientId} failed: ${e.message}`);
        replies.push({
          agentId: recipientId,
          agentName: this.agentManager.getAgent(recipientId)?.name || recipientId,
          error: e.message,
          timestamp: new Date().toISOString(),
          status: 'error'
        });
      }
    }

    return {
      messageId,
      groupId,
      from: fromAgentId,
      recipients,
      replies,
      timestamp
    };
  }

  /**
   * Send message to single agent in group
   * @private
   */
  async _sendToAgent(groupId, messageId, fromAgentId, toAgentId, message, timeout) {
    const group = this.activeGroups.get(groupId);
    if (!group) throw new Error(`Group not found: ${groupId}`);

    // Build context: include recent group history
    const recentHistory = group.history.slice(-5).map(h =>
      `${h.from}: ${h.message}${h.replies.length > 0 ? '\n' + h.replies.map(r => `  ${r.agentId}: ${r.reply}`).join('\n') : ''}`
    ).join('\n\n');

    const contextualMessage = `[Group chat: ${group.topic}]\n[Participants: ${group.participants.map(id => this.agentManager.getAgent(id)?.name || id).join(', ')}]\n\n**Recent history:**\n${recentHistory}\n\n**New message from ${this.agentManager.getAgent(fromAgentId)?.name || fromAgentId}:**\n${message}`;

    return await this.messageRouter.sendMessage({
      from: fromAgentId,
      to: toAgentId,
      message: contextualMessage,
      timeout,
      data: {
        groupId,
        messageId,
        isGroupChat: true
      }
    });
  }

  /**
   * Get group info
   */
  getGroup(groupId) {
    return this.activeGroups.get(groupId) || null;
  }

  /**
   * Get group history
   */
  getHistory(groupId, limit = 20) {
    const group = this.activeGroups.get(groupId);
    if (!group) return [];

    return group.history.slice(-limit);
  }

  /**
   * Close group
   */
  closeGroup(groupId) {
    const group = this.activeGroups.get(groupId);
    if (!group) throw new Error(`Group not found: ${groupId}`);

    group.active = false;
    group.closedAt = new Date().toISOString();

    this._logEvent({
      type: 'group_closed',
      groupId,
      timestamp: group.closedAt,
      messageCount: group.messageCount
    });

    this.logger.info('GroupChat', `Group closed: ${groupId} (${group.messageCount} messages)`);

    return group;
  }

  /**
   * List all active groups
   */
  listGroups() {
    return Array.from(this.activeGroups.values()).filter(g => g.active);
  }

  /**
   * Log event to JSONL file
   * @private
   */
  _logEvent(event) {
    try {
      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(this.logFile, line, 'utf8');
    } catch (e) {
      this.logger.error('GroupChat', `Failed to log event: ${e.message}`);
    }
  }
}

module.exports = GroupChat;
