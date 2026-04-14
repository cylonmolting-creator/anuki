const fs = require('fs');
const path = require('path');

class Storage {
  constructor(config) {
    this.dataDir = config.dataDir || path.join(require('../utils/base-dir'), 'data');
    this.workspace = config.workspace || path.join(require('../utils/base-dir'), 'workspace');

    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.workspace)) fs.mkdirSync(this.workspace, { recursive: true });

    this.sessions = {};
    this.reminders = [];
    this.persistentFile = path.join(this.dataDir, 'memory.txt');
    this.remindersFile = path.join(this.dataDir, 'reminders.json');

    // Load reminders from disk on startup
    this._loadReminders();
  }

  loadSession(channel, userId) {
    const key = channel + ':' + userId;
    if (!this.sessions[key]) {
      this.sessions[key] = { messages: [], created: new Date().toISOString() };
    }
    return this.sessions[key];
  }

  saveSession(channel, userId, session) {
    const key = channel + ':' + userId;
    this.sessions[key] = session;
  }

  clearSession(channel, userId) {
    const key = channel + ':' + userId;
    this.sessions[key] = { messages: [], created: new Date().toISOString() };
  }

  loadPersistent() {
    try {
      if (fs.existsSync(this.persistentFile)) {
        return fs.readFileSync(this.persistentFile, 'utf8');
      }
    } catch (e) {}
    return '';
  }

  savePersistent(data) {
    try {
      fs.writeFileSync(this.persistentFile, data, 'utf8');
    } catch (e) {}
  }

  appendPersistent(data) {
    try {
      fs.appendFileSync(this.persistentFile, data, 'utf8');
    } catch (e) {}
  }

  _loadReminders() {
    try {
      if (fs.existsSync(this.remindersFile)) {
        const data = fs.readFileSync(this.remindersFile, 'utf8');
        this.reminders = JSON.parse(data);
        // Clean up expired reminders on load
        const now = Date.now();
        this.reminders = this.reminders.filter(r => new Date(r.time).getTime() > now);
        this._saveReminders();
      }
    } catch (e) {
      this.reminders = [];
    }
  }

  _saveReminders() {
    try {
      fs.writeFileSync(this.remindersFile, JSON.stringify(this.reminders, null, 2), 'utf8');
    } catch (e) {
      console.error('[Storage] Failed to save reminders:', e.message);
    }
  }

  addReminder(userId, text, time, channel) {
    const reminder = {
      userId,
      text,
      time,
      channel,
      id: Date.now(),
      triggerTime: new Date(time).getTime(),
      createdAt: new Date().toISOString()
    };
    this.reminders.push(reminder);
    this._saveReminders();
    return reminder;
  }

  getReminders(userId) {
    if (userId) {
      return this.reminders.filter(r => r.userId === userId);
    }
    return this.reminders;
  }

  removeReminder(id) {
    this.reminders = this.reminders.filter(function(r) { return r.id !== id; });
    this._saveReminders();
  }

  getDueReminders() {
    const now = Date.now();
    const due = [];
    const remaining = [];

    // Separate due and remaining reminders atomically
    for (const r of this.reminders) {
      if (r.triggerTime <= now) {
        due.push(r);
      } else {
        remaining.push(r);
      }
    }

    // Update reminders list immediately (remove due ones)
    this.reminders = remaining;

    // Save to disk if we found any due reminders
    if (due.length > 0) {
      this._saveReminders();
    }

    return due;
  }

  loadTasks() {
    try {
      const tasksFile = path.join(this.dataDir, 'tasks.txt');
      if (fs.existsSync(tasksFile)) {
        return fs.readFileSync(tasksFile, 'utf8');
      }
    } catch (e) {}
    return '';
  }

  saveTasks(data) {
    try {
      const tasksFile = path.join(this.dataDir, 'tasks.txt');
      fs.writeFileSync(tasksFile, data, 'utf8');
    } catch (e) {}
  }
}

module.exports = Storage;
