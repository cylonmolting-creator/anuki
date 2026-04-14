# Anuki — Launch Materials

## Product Hunt

**Tagline** (60 char): AI Agent LEGO Platform — Build your own multi-agent team

**Description:**
Anuki is an open-source multi-agent AI platform. You get 3 core agents — ENKI (creates agents), PROTOS (routes requests), UTU (manages rules) — and use them to build unlimited custom agents.

Think of it as LEGO for AI agents. We give you the blocks. You build the team.

10 unique features no competitor has:
- Create agents by talking to ENKI — no UI forms, just describe what you want
- PROTOS bridges natural language to agent-specific prompts
- UTU is the sole rule authority — consistency guaranteed
- SSOT rule propagation — tag-based, per-agent, idempotent
- Soul files (identity + personality + mission) for every agent
- Cognitive memory (3 layers: episodic, semantic, procedural)
- Hook-enforced governance — mechanical rule enforcement, not guidelines
- Response-level enforcement (Stop hooks) — every agent response is audited. Two modes: claim verification (blocks unverified claims without evidence) and behavioral enforcement (blocks forbidden patterns unconditionally — questions, banned phrases, etc). Industry first.
- Self-healing deadlock protection — bad rules can't break the system. 5-layer defense with syntax validation, atomic writes, and auto-recovery.
- LEGO philosophy — you own everything, customize everything, BYOK

git clone, npm install, npm start. That's it.

**Topics:** AI, Developer Tools, Open Source, Productivity, Agents

---

## Hacker News

**Title:** Show HN: Anuki – Multi-agent AI platform with response-level enforcement (agents can't make unverified claims)

**Text:**
I built an open-source platform for creating and managing AI agent teams.

The idea: instead of one monolithic AI assistant, you get building blocks. 3 core agents ship with the platform:

- ENKI: Creates new agents. Tell it "I want a code review agent" and it generates the complete agent package.
- PROTOS: Default greeter. Routes your requests to the right agent, crafts prompts.
- UTU: Rule keeper. Only agent allowed to write rules. Ensures consistency.

10 things no other multi-agent framework does:

1. Agent-creator agent (ENKI) — create agents by talking to an agent, not filling UI forms
2. Prompt bridge agent (PROTOS) — translates natural language into agent-specific instructions
3. Rule-keeper agent (UTU) — sole authority on rules, no other agent can touch them
4. SSOT rule propagation — tag-based, per-agent, generator script, idempotent
5. Soul + Memory + Rules integrated — identity, learning, and governance in one platform
6. Cognitive memory (3 layers) — episodic, semantic, procedural — agents learn and remember
7. Hook-enforced governance — PreToolUse/PostToolUse hooks mechanically block forbidden actions
8. Response-level enforcement (Stop hooks) — every response is audited after generation. Two modes: claim verification (blocks "this is unused" unless file:line evidence is provided) and behavioral enforcement (blocks questions, banned phrases — unconditionally). No other framework does this.
9. Self-healing deadlock protection — bad rules can't break the system. 5-layer defense: shell sanitization, syntax validation (sh -n), atomic writes, and SessionStart auto-recovery. Born from a real production incident.
10. LEGO philosophy — you change everything, build your own agents, write your own rules

Stack: Node.js, Claude CLI, WebSocket, Express. No database needed.

BYOK (bring your own key) — you need an Anthropic API key or Claude CLI installed.

GitHub: https://github.com/cylonmolting-creator/anuki

---

## Dev.to Article

**Title:** Building Anuki: An Open-Source AI Agent LEGO Platform

**Tags:** ai, opensource, agents, nodejs

**Body:**

### The Problem

Most AI tools give you one assistant. You talk to it, it helps, conversation ends. But what if you could build a *team* of specialized AI agents that work together?

### The Solution: Anuki

Anuki is an open-source platform that ships with 3 core agents:

| Agent | What it does |
|---|---|
| **ENKI** | Creates, edits, and destroys agents. Your agent factory. |
| **PROTOS** | Default greeter. Routes requests, crafts prompts. |
| **UTU** | Rule guardian. Only authority on the rule system. |

With these 3, you can create unlimited specialized agents. A code reviewer. A research assistant. A content writer. Whatever you need.

### What Makes It Different

**Soul Files** — Every agent has markdown files defining its identity, personality, and mission. Not just a system prompt — a complete persona.

**Cognitive Memory** — 3 layers:
- Episodic: what happened (conversation logs)
- Semantic: what's known (facts, preferences)
- Procedural: how to do things (learned workflows)

**SSOT Rules** — Write a rule once. A generator script propagates it to all affected agents based on tags. Idempotent. Consistent.

**Hook Enforcement** — Rules aren't just text. PreToolUse hooks mechanically block forbidden actions. An agent *cannot* bypass a hook — it's enforced at the system level.

**Response-Level Enforcement (Stop Hooks)** — This is the big one. Every other framework guards *tool calls*. Anuki also guards *what agents say*. After every response, a Stop hook scans the output. Two modes: **claim verification** (blocks "unused", "not found" unless evidence like file:line or grep results is provided) and **behavioral enforcement** (blocks questions, banned phrases — unconditionally). The agent must rewrite. This is deterministic shell-level enforcement — not a prompt, not a suggestion. Industry first.

**Self-Healing Deadlock Protection** — Hook systems have a dangerous failure mode: a bad hook can block all tool calls, creating an unrecoverable deadlock. Anuki prevents this with 5 layers: shell sanitization, regex escaping, `sh -n` syntax validation before deployment, atomic writes, and auto-recovery on session start. Born from a real production incident — now the system self-heals instead of locking up.

### Quick Start

```bash
git clone https://github.com/cylonmolting-creator/anuki.git
cd anuki
cp .env.example .env
npm install
npm start
```

Open http://localhost:3000. PROTOS greets you. Ask ENKI to create a new agent. Tell UTU to add a rule. Build your team.

### Architecture

Node.js server with Express + WebSocket. No database — everything is files (JSON + Markdown). Each agent gets its own workspace with soul files, memory directories, and session data.

The system runs Claude CLI under the hood. You bring your own Anthropic API key (BYOK).

### What's Next

This is v0.1 — the MVP. Planned:
- More channel integrations (Telegram, Discord, Slack)
- Agent marketplace / templates
- Visual workflow builder
- Multi-user support

GitHub: https://github.com/cylonmolting-creator/anuki

MIT licensed. PRs welcome.
