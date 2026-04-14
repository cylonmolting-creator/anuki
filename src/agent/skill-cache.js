const fs = require('fs');
const path = require('path');

/**
 * SkillCache — In-Memory Skill Discovery & Registry
 *
 * Maintains a live cache of all agent skills across the system.
 * Used by AutoRouter for fast skill matching and discovery.
 *
 * Architecture:
 * - Memory-based: Fast lookup (no DB queries)
 * - TTL: 10 minutes (refreshes automatically)
 * - Indexed: By agent ID, skill ID, category, skill name
 * - Observable: Notifies on skill updates
 * - Rating persistence: Saved to data/skill-ratings.json
 * - Soul-file registration: SkillRegistry extracts skills from SOUL.md (Roadmap 5.2)
 */

class SkillCache {
  constructor(agentManager, logger) {
    this.agentManager = agentManager;
    this.logger = logger;

    // Rating persistence file
    const baseDir = require('../utils/base-dir');
    this.ratingsFile = path.join(baseDir, 'data', 'skill-ratings.json');

    // Cache structure
    this.cache = new Map();

    // Indexes for fast lookup
    this.indexByCategory = new Map();
    this.indexBySkillName = new Map();
    this.indexBySimpleSkill = new Map();

    // SkillRegistry reference (injected from index.js — Roadmap 5.2)
    this.skillRegistry = null;

    // TTL config
    this.TTL = 10 * 60 * 1000;
    this.refreshTimer = null;
    this._refreshDebounceTimer = null;

    this.logger.info('SkillCache', 'Initialized');
  }

  initialize() {
    this._loadPersistedRatings();
    this._refresh();
    this._startAutoRefresh();
    this.logger.success('SkillCache', 'Cache initialized and auto-refresh started');
  }

  _refresh() {
    const agents = this.agentManager.listAgents();

    const preservedStats = new Map();
    for (const [agentId, cached] of this.cache) {
      preservedStats.set(agentId, {
        rating: cached.rating,
        successCount: cached.successCount,
        failureCount: cached.failureCount,
        avgLatency: cached.avgLatency
      });
    }

    this.cache.clear();
    this.indexByCategory.clear();
    this.indexBySkillName.clear();
    this.indexBySimpleSkill.clear();

    for (const agent of agents) {
      const simpleSkills = new Set();

      if (agent.capabilities && agent.capabilities.skillsSimple) {
        for (const s of agent.capabilities.skillsSimple) {
          simpleSkills.add(s.toLowerCase());
        }
      }

      // From SkillRegistry (soul-file-derived skills — Roadmap 5.2)
      if (this.skillRegistry) {
        const registrySkills = this.skillRegistry.getSkills(agent.id);
        for (const s of registrySkills) {
          simpleSkills.add(s.toLowerCase());
        }
      }

      const agentRating = preservedStats.get(agent.id)
        ? preservedStats.get(agent.id).rating
        : 1.0;

      for (const skillName of simpleSkills) {
        if (!this.indexBySimpleSkill.has(skillName)) {
          this.indexBySimpleSkill.set(skillName, []);
        }
        this.indexBySimpleSkill.get(skillName).push({
          agentId: agent.id,
          agentName: agent.name,
          rating: agentRating
        });
      }

      const hasStructuredSkills = agent.capabilities && agent.capabilities.skills && agent.capabilities.skills.length > 0;

      if (!hasStructuredSkills && simpleSkills.size > 0) {
        const prev = preservedStats.get(agent.id) || (this._persistedRatings ? this._persistedRatings.get(agent.id) : null);
        this.cache.set(agent.id, {
          agentId: agent.id,
          agentName: agent.name,
          skills: [],
          skillsSimple: Array.from(simpleSkills),
          skillCount: simpleSkills.size,
          description: (agent.capabilities && agent.capabilities.description) || ('Agent with ' + simpleSkills.size + ' skills'),
          language: (agent.capabilities && agent.capabilities.language) || 'en',
          responseTime: (agent.capabilities && agent.capabilities.responseTime) || 'medium',
          rating: prev ? (prev.rating != null ? prev.rating : 1.0) : 1.0,
          successCount: prev ? (prev.successCount || 0) : 0,
          failureCount: prev ? (prev.failureCount || 0) : 0,
          avgLatency: prev ? (prev.avgLatency || 0) : 0,
          lastUpdated: new Date().toISOString(),
          soulDerived: true
        });
        continue;
      }

      if (!hasStructuredSkills) continue;

      const prev = preservedStats.get(agent.id) || (this._persistedRatings ? this._persistedRatings.get(agent.id) : null);
      const agentCache = {
        agentId: agent.id,
        agentName: agent.name,
        skills: agent.capabilities.skills,
        skillCount: agent.capabilities.skills.length,
        description: agent.capabilities.description || '',
        language: agent.capabilities.language || 'en',
        responseTime: agent.capabilities.responseTime || 'unknown',
        rating: prev ? (prev.rating != null ? prev.rating : (agent.rating != null ? agent.rating : 1.0)) : (agent.rating != null ? agent.rating : 1.0),
        successCount: prev ? (prev.successCount || 0) : (agent.successCount || 0),
        failureCount: prev ? (prev.failureCount || 0) : (agent.failureCount || 0),
        avgLatency: prev ? (prev.avgLatency || 0) : (agent.avgLatency || 0),
        lastUpdated: new Date().toISOString()
      };

      this.cache.set(agent.id, agentCache);

      for (const skill of agent.capabilities.skills) {
        const category = skill.category || 'general';
        if (!this.indexByCategory.has(category)) {
          this.indexByCategory.set(category, []);
        }
        this.indexByCategory.get(category).push({
          agentId: agent.id,
          agentName: agent.name,
          skillId: skill.id,
          skillName: skill.name,
          rating: agentCache.rating
        });

        const sName = skill.name.toLowerCase();
        if (!this.indexBySkillName.has(sName)) {
          this.indexBySkillName.set(sName, []);
        }
        this.indexBySkillName.get(sName).push({
          agentId: agent.id,
          agentName: agent.name,
          skillId: skill.id,
          category: skill.category,
          rating: agentCache.rating
        });
      }
    }

    this.logger.info('SkillCache', 'Cache refreshed: ' + this.cache.size + ' agents, ' + this._getTotalSkillCount() + ' structured + ' + this.indexBySimpleSkill.size + ' simple skills');
  }

  _startAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => { this._refresh(); }, this.TTL);
  }

  refreshNow() {
    if (this._refreshDebounceTimer) clearTimeout(this._refreshDebounceTimer);
    this._refreshDebounceTimer = setTimeout(() => {
      this._refreshDebounceTimer = null;
      this._refresh();
      this.logger.info('SkillCache', 'Event-driven refresh triggered');
    }, 500);
  }

  findBySkillName(skillName) {
    var key = skillName.toLowerCase();
    var structured = this.indexBySkillName.get(key) || [];
    var simple = (this.indexBySimpleSkill.get(key) || []).map(function(m) {
      return {
        agentId: m.agentId,
        agentName: m.agentName,
        skillId: 'simple-' + key,
        category: 'registered',
        rating: m.rating
      };
    });

    var seen = new Set();
    var merged = [];
    var all = structured.concat(simple);
    for (var i = 0; i < all.length; i++) {
      if (!seen.has(all[i].agentId)) {
        seen.add(all[i].agentId);
        merged.push(all[i]);
      }
    }
    return merged.sort(function(a, b) { return b.rating - a.rating; });
  }

  findByCategory(category) {
    var matches = this.indexByCategory.get(category) || [];
    return matches.sort(function(a, b) { return b.rating - a.rating; });
  }

  getAgent(agentId) {
    return this.cache.get(agentId) || null;
  }

  getAgentSkills(agentId) {
    var agent = this.cache.get(agentId);
    return agent ? agent.skills : [];
  }

  getSkill(agentId, skillId) {
    var agent = this.cache.get(agentId);
    if (!agent) return null;
    return agent.skills.find(function(s) { return s.id === skillId; }) || null;
  }

  updateRating(agentId, success, latency) {
    if (latency === undefined) latency = 0;
    var cached = this.cache.get(agentId);
    if (!cached) {
      this.logger.warn('SkillCache', 'Agent not in cache: ' + agentId);
      return;
    }

    if (success) { cached.successCount++; } else { cached.failureCount++; }

    var totalCalls = cached.successCount + cached.failureCount;
    cached.avgLatency = Math.round((cached.avgLatency * (totalCalls - 1) + latency) / totalCalls);
    cached.rating = cached.successCount / totalCalls;
    cached.lastUpdated = new Date().toISOString();

    this._savePersistedRatings();

    this.logger.info('SkillCache',
      'Updated ' + cached.agentName + ': rating=' + (cached.rating * 100).toFixed(1) + '%, success=' + cached.successCount + ', fail=' + cached.failureCount + ', latency=' + cached.avgLatency + 'ms'
    );
  }

  getAllAgents() {
    return Array.from(this.cache.values()).map(function(agent) {
      return {
        id: agent.agentId,
        name: agent.agentName,
        skillCount: agent.skillCount,
        description: agent.description,
        language: agent.language,
        responseTime: agent.responseTime,
        rating: agent.rating,
        successCount: agent.successCount,
        failureCount: agent.failureCount,
        avgLatency: agent.avgLatency,
        skills: agent.skills
      };
    });
  }

  getCategories() {
    return Array.from(this.indexByCategory.keys());
  }

  search(query) {
    var q = query.toLowerCase();
    var results = { agents: [], skills: [], categories: [] };

    for (var entry of this.cache) {
      var agentId = entry[0];
      var agent = entry[1];
      if (agent.agentName.toLowerCase().includes(q) || agent.description.toLowerCase().includes(q)) {
        results.agents.push({ id: agentId, name: agent.agentName, rating: agent.rating, skillCount: agent.skillCount });
      }
    }

    for (var skEntry of this.indexBySkillName) {
      if (skEntry[0].includes(q)) {
        results.skills.push.apply(results.skills, skEntry[1].slice(0, 3));
      }
    }

    var seenAgentIds = new Set(results.skills.map(function(s) { return s.agentId; }));
    for (var ssEntry of this.indexBySimpleSkill) {
      var ssName = ssEntry[0];
      if (ssName.includes(q)) {
        for (var match of ssEntry[1]) {
          if (!seenAgentIds.has(match.agentId)) {
            results.skills.push({
              agentId: match.agentId,
              agentName: match.agentName,
              skillId: 'simple-' + ssName,
              skillName: ssName,
              category: 'registered',
              rating: match.rating
            });
            seenAgentIds.add(match.agentId);
          }
        }
      }
    }

    for (var cat of this.indexByCategory.keys()) {
      if (cat.includes(q)) {
        results.categories.push({ name: cat, agentCount: this.indexByCategory.get(cat).length });
      }
    }

    return results;
  }

  getStats() {
    return {
      agentCount: this.cache.size,
      totalSkills: this._getTotalSkillCount(),
      simpleSkills: this.indexBySimpleSkill.size,
      categories: this.indexByCategory.size,
      hasRegistry: !!this.skillRegistry,
      lastRefresh: (Array.from(this.cache.values())[0] || {}).lastUpdated || null,
      ttl: this.TTL,
      topAgents: Array.from(this.cache.values())
        .sort(function(a, b) { return b.rating - a.rating; })
        .slice(0, 5)
        .map(function(a) { return { name: a.agentName, rating: a.rating }; })
    };
  }

  _getTotalSkillCount() {
    var count = 0;
    for (var agent of this.cache.values()) {
      count += agent.skillCount || 0;
    }
    return count;
  }

  _loadPersistedRatings() {
    this._persistedRatings = new Map();
    try {
      if (fs.existsSync(this.ratingsFile)) {
        var data = JSON.parse(fs.readFileSync(this.ratingsFile, 'utf8'));
        if (data && typeof data === 'object') {
          for (var key of Object.keys(data)) {
            this._persistedRatings.set(key, data[key]);
          }
          this.logger.info('SkillCache', 'Loaded persisted ratings for ' + this._persistedRatings.size + ' agents');
        }
      }
    } catch (e) {
      this.logger.warn('SkillCache', 'Failed to load persisted ratings: ' + e.message);
    }
  }

  _savePersistedRatings() {
    try {
      var data = {};
      for (var entry of this.cache) {
        var cached = entry[1];
        if (cached.successCount > 0 || cached.failureCount > 0) {
          data[entry[0]] = {
            rating: cached.rating,
            successCount: cached.successCount,
            failureCount: cached.failureCount,
            avgLatency: cached.avgLatency,
            lastUpdated: cached.lastUpdated
          };
        }
      }
      fs.writeFileSync(this.ratingsFile, JSON.stringify(data, null, 2));
    } catch (e) {
      this.logger.warn('SkillCache', 'Failed to save ratings: ' + e.message);
    }
  }

  shutdown() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this._refreshDebounceTimer) clearTimeout(this._refreshDebounceTimer);
    this._savePersistedRatings();
    this.logger.info('SkillCache', 'Shutdown (ratings persisted)');
  }
}

module.exports = SkillCache;
