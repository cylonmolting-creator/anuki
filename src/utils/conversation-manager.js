const fs = require('fs');
const path = require('path');

/**
 * ConversationManager - Manages conversation persistence
 * Manages conversation persistence and history
 */
class ConversationManager {
  constructor(baseDir, logger) {
    this.baseDir = baseDir;
    this.logger = logger;
    this.dataDir = path.join(baseDir, 'data');
    this.conversationsFile = path.join(this.dataDir, 'conversations.json');

    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // Load conversations with error recovery (exactly as old system)
  loadConversations() {
    try {
      if (fs.existsSync(this.conversationsFile)) {
        const content = fs.readFileSync(this.conversationsFile, 'utf8');
        return JSON.parse(content);
      }
    } catch (e) {
      this.logger.error('ConversationManager', 'Error loading conversations, creating backup:', e.message);
      // Create backup of corrupted file — keep only 1 backup, delete old ones first
      if (fs.existsSync(this.conversationsFile)) {
        try {
          const dir = path.dirname(this.conversationsFile);
          const base = path.basename(this.conversationsFile);
          fs.readdirSync(dir)
            .filter(f => f.startsWith(base + '.backup'))
            .forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch(_) {} });
        } catch(_) {}
        fs.renameSync(
          this.conversationsFile,
          this.conversationsFile + '.backup'
        );
      }
    }
    return { conversations: [], currentId: null };
  }

  // Save conversations with atomic write (exactly as old system)
  saveConversations(data) {
    try {
      // Write to temp file first, then rename (atomic operation)
      const tempFile = this.conversationsFile + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
      fs.renameSync(tempFile, this.conversationsFile);
    } catch (e) {
      this.logger.error('ConversationManager', 'Error saving conversations:', e.message);
    }
  }

  // Create new conversation
  createConversation(title, workspaceId) {
    const data = this.loadConversations();
    const id = Date.now().toString();
    const conversation = {
      id,
      workspaceId,
      title: title || 'New Conversation',
      messages: [],
      sessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.conversations.unshift(conversation);
    data.currentId = id;
    this.saveConversations(data);
    return conversation;
  }

  // Create conversation with a specific ID (used by inter-agent messaging to ensure ia- prefix)
  createConversationWithId(id, title, workspaceId) {
    const data = this.loadConversations();
    const conversation = {
      id,
      workspaceId,
      title: title || 'New Conversation',
      messages: [],
      sessionId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    data.conversations.unshift(conversation);
    this.saveConversations(data);
    return conversation;
  }

  // Get conversation by ID
  getConversation(conversationId) {
    const data = this.loadConversations();
    return data.conversations.find(c => c.id === conversationId);
  }

  // Update conversation
  updateConversation(conversationId, updates) {
    const data = this.loadConversations();
    const conv = data.conversations.find(c => c.id === conversationId);
    if (conv) {
      Object.assign(conv, updates);
      conv.updatedAt = new Date().toISOString();
      this.saveConversations(data);
    }
    return conv;
  }

  // Add message to conversation
  addMessage(conversationId, role, content) {
    const data = this.loadConversations();
    const conv = data.conversations.find(c => c.id === conversationId);
    if (conv) {
      conv.messages.push({
        role,
        content,
        timestamp: new Date().toISOString()
      });
      conv.updatedAt = new Date().toISOString();
      this.saveConversations(data);
    }
    return conv;
  }

  // Append text to the last assistant message (avoids consecutive same-role messages)
  appendToLastAssistant(conversationId, text) {
    const data = this.loadConversations();
    const conv = data.conversations.find(c => c.id === conversationId);
    if (conv && conv.messages && conv.messages.length > 0) {
      const lastMsg = conv.messages[conv.messages.length - 1];
      if (lastMsg.role === 'assistant') {
        lastMsg.content = lastMsg.content + '\n\n---\n\n' + text;
        conv.updatedAt = new Date().toISOString();
        this.saveConversations(data);
        return conv;
      }
    }
    // Fallback: add as new message
    return this.addMessage(conversationId, 'assistant', text);
  }

  // Set session ID for conversation
  setSessionId(conversationId, sessionId) {
    const data = this.loadConversations();
    const conv = data.conversations.find(c => c.id === conversationId);
    if (conv) {
      conv.sessionId = sessionId;
      conv.updatedAt = new Date().toISOString();
      this.saveConversations(data);
    }
    return conv;
  }

  // Auto-title from first message (exactly as old system)
  autoTitle(conversationId) {
    const data = this.loadConversations();
    const conv = data.conversations.find(c => c.id === conversationId);
    if (conv && (conv.title === 'New Conversation' || conv.title.includes('...')) && conv.messages.length >= 2) {
      const firstMsg = conv.messages[0].content;
      conv.title = firstMsg.substring(0, 40) + (firstMsg.length > 40 ? '...' : '');
      conv.updatedAt = new Date().toISOString();
      this.saveConversations(data);
    }
    return conv;
  }

  // Delete conversation (LAYER 1: User delete)
  deleteConversation(conversationId) {
    const data = this.loadConversations();
    const conv = data.conversations.find(c => c.id === conversationId);

    // LAYER 1: Extract and delete images from this conversation
    if (conv && conv.messages) {
      const uploadsDir = path.resolve(path.join(this.baseDir, 'data', 'uploads'));
      conv.messages.forEach(msg => {
        if (msg.content) {
          // Find all image paths in message content [Image: /path/to/file.png]
          const imageMatches = msg.content.match(/\[Image: ([^\]]+)\]/g);
          if (imageMatches) {
            imageMatches.forEach(match => {
              const imagePath = match.replace('[Image: ', '').replace(']', '');
              // Security: only delete files within uploadsDir (prevent arbitrary file deletion)
              const resolved = path.resolve(imagePath);
              if (!resolved.startsWith(uploadsDir + path.sep) && resolved !== uploadsDir) return;
              try {
                if (fs.existsSync(resolved)) {
                  fs.unlinkSync(resolved);
                }
              } catch (e) {
                // Ignore if file already deleted
              }
            });
          }
        }
      });
    }

    data.conversations = data.conversations.filter(c => c.id !== conversationId);
    if (data.currentId === conversationId) {
      data.currentId = data.conversations[0]?.id || null;
    }
    this.saveConversations(data);
    return true;
  }

  // Update title
  updateTitle(conversationId, title) {
    const data = this.loadConversations();
    const conv = data.conversations.find(c => c.id === conversationId);
    if (conv) {
      conv.title = title;
      conv.updatedAt = new Date().toISOString();
      this.saveConversations(data);
    }
    return conv;
  }

  // Get all conversations
  getAllConversations() {
    return this.loadConversations();
  }

  // Get conversations for workspace
  getWorkspaceConversations(workspaceId) {
    const data = this.loadConversations();
    return data.conversations.filter(c => c.workspaceId === workspaceId);
  }

  /**
   * Prune stale conversations:
   * 1. Delete empty conversations (0 messages) older than 1 hour
   * 2. Delete "Agent:" inter-agent conversations older than 24 hours
   * 3. Cap conversations per workspace at 50 (keep newest)
   * Returns { emptied, agentPruned, capped }
   */
  pruneStaleConversations() {
    const data = this.loadConversations();
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const MAX_PER_WORKSPACE = 50;

    let emptied = 0;
    let agentPruned = 0;
    let capped = 0;
    const initialCount = data.conversations.length;

    // Pass 1: Remove empty conversations older than 1 hour
    data.conversations = data.conversations.filter(c => {
      const age = now - new Date(c.createdAt).getTime();
      if ((!c.messages || c.messages.length === 0) && age > ONE_HOUR) {
        emptied++;
        return false;
      }
      return true;
    });

    // Pass 2: Remove "Agent:" conversations older than 24 hours
    data.conversations = data.conversations.filter(c => {
      const age = now - new Date(c.updatedAt || c.createdAt).getTime();
      if (c.title && c.title.startsWith('Agent:') && age > ONE_DAY) {
        agentPruned++;
        return false;
      }
      return true;
    });

    // Pass 3: Cap per workspace (keep newest by updatedAt)
    const byWorkspace = {};
    for (const c of data.conversations) {
      const ws = c.workspaceId || 'default';
      if (!byWorkspace[ws]) byWorkspace[ws] = [];
      byWorkspace[ws].push(c);
    }
    const keepIds = new Set();
    for (const ws of Object.keys(byWorkspace)) {
      const sorted = byWorkspace[ws].sort((a, b) =>
        new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
      );
      sorted.slice(0, MAX_PER_WORKSPACE).forEach(c => keepIds.add(c.id));
      capped += Math.max(0, sorted.length - MAX_PER_WORKSPACE);
    }
    if (capped > 0) {
      data.conversations = data.conversations.filter(c => keepIds.has(c.id));
    }

    // Fix currentId if it was removed
    if (data.currentId && !data.conversations.find(c => c.id === data.currentId)) {
      data.currentId = data.conversations[0]?.id || null;
    }

    const totalRemoved = initialCount - data.conversations.length;
    if (totalRemoved > 0) {
      this.saveConversations(data);
    }

    return { emptied, agentPruned, capped, totalRemoved };
  }
}

module.exports = ConversationManager;
