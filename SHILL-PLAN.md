# Anuki — Shill Plan & Materials

> Ready-to-use materials. Copy-paste and submit.
> GitHub: https://github.com/cylonmolting-creator/anuki

---

## PLATFORM MAP (Priority Order)

| # | Platform | Effort | Expected Impact | Type |
|---|----------|--------|-----------------|------|
| 1 | awesome-ai-agents-2026 | PR (5 min) | High — 300+ resources, monthly updated | GitHub PR |
| 2 | e2b-dev/awesome-ai-agents | PR (5 min) | High — very popular list | GitHub PR |
| 3 | kyrolabs/awesome-agents | PR (5 min) | Medium — active list | GitHub PR |
| 4 | SoulSpec / ClawSouls registry | Publish (15 min) | Medium — niche but perfect audience | Registry |
| 5 | Hacker News | Post (2 min) | High — tech audience, viral potential | Show HN |
| 6 | r/AI_Agents | Post (5 min) | Medium-High — 200K+ members | Reddit |
| 7 | r/LocalLLaMA | Post (5 min) | Medium — open source lovers | Reddit |
| 8 | r/SideProject | Post (5 min) | Medium — indie devs | Reddit |
| 9 | Dev.to | Article (10 min) | Medium — SEO, long-term | Blog |
| 10 | Product Hunt | Launch (15 min) | High — but needs demo video | Launch |
| 11 | GitHub Topics | Tags (2 min) | Low-Medium — discoverability | Tags |

---

## 1. AWESOME LISTS (GitHub PR)

### 1a. awesome-ai-agents-2026 (caramaschiHG)

**Repo**: https://github.com/caramaschiHG/awesome-ai-agents-2026

**Category**: Agent Frameworks > Multi-Agent Orchestration

**Entry to add** (table format matching their style):

```
| **[Anuki](https://github.com/cylonmolting-creator/anuki)** | Open-source multi-agent AI platform. Create agents by talking to an agent (ENKI), enforce rules mechanically (SSOT hooks), cognitive memory (3 layers). Node.js. | Free / OSS |
```

**PR title**: `Add Anuki — multi-agent AI platform with response-level enforcement`

**PR body**:
```
Adding Anuki to the Multi-Agent Orchestration section.

Anuki is an open-source multi-agent AI platform (Node.js) with:
- Agent-creator agent (create agents via natural language)
- Response-level claim verification (Stop hooks)
- SSOT mechanical rule enforcement
- 3-layer cognitive memory (episodic/semantic/procedural)
- Soul files for persistent agent identity

GitHub: https://github.com/cylonmolting-creator/anuki
License: MIT
```

**Steps**:
1. Fork https://github.com/caramaschiHG/awesome-ai-agents-2026
2. Find the "Multi-Agent Orchestration" or "Agent Frameworks" section
3. Add the table row
4. Submit PR with title and body above

---

### 1b. e2b-dev/awesome-ai-agents

**Repo**: https://github.com/e2b-dev/awesome-ai-agents

**Category**: Open-source > General purpose, Build your own, Multi-agent

**Entry to add** (matching their format):

```markdown
### [Anuki](https://github.com/cylonmolting-creator/anuki)
Open-source multi-agent AI platform — create agents by talking to an agent, enforce rules mechanically, build a team that learns and remembers.

<details>

- **Category**: General purpose, Build your own, Multi-agent
- Create agents via natural language (ENKI agent)
- Response-level claim verification — Stop hooks audit what agents *say*, not just what they *do*
- SSOT mechanical rule enforcement with tag-based propagation
- 3-layer cognitive memory (episodic, semantic, procedural)
- Soul files (9 types) for persistent agent identity
- Node.js, MIT licensed

[![GitHub](https://img.shields.io/badge/GitHub-cylonmolting--creator%2Fanuki-blue)](https://github.com/cylonmolting-creator/anuki)

</details>
```

**PR title**: `Add Anuki — multi-agent platform with soul files and response-level verification`

**Steps**: Same fork → edit → PR flow.

---

### 1c. kyrolabs/awesome-agents

**Repo**: https://github.com/kyrolabs/awesome-agents

**Category**: Frameworks

**Entry to add** (matching their format):

```markdown
- [Anuki](https://github.com/cylonmolting-creator/anuki): Multi-agent AI platform with soul-driven identity, cognitive memory, and response-level claim verification. Create agents via natural language.
```

**PR title**: `Add Anuki to Frameworks section`

**Steps**: Same fork → edit → PR flow.

---

## 2. SOULSPEC / CLAWSOULS REGISTRY

**What**: SoulSpec is the open standard for AI agent personas. Anuki uses SOUL.md, IDENTITY.md, MISSION.md — exactly what SoulSpec defines.

**Registry**: https://clawsouls.ai (community-published agent personas)

**What to publish**: Anuki's 3 core agent personas (ENKI, PROTOS, UTU) as SoulSpec packages.

**Steps**:
1. Go to https://soulspec.org/ — read the spec
2. Check if Anuki's soul file structure is compatible (it mostly is — SOUL.md, IDENTITY.md already exist)
3. If needed, add `soul.json` manifest to each agent workspace
4. Publish to ClawSouls registry
5. Add a "SoulSpec compatible" badge to README

**Bonus**: Write a Dev.to post: "How Anuki implements SoulSpec with 9 soul file types"

---

## 3. HACKER NEWS

**Already prepared in LAUNCH.md**. Copy from there.

**Title**: `Show HN: Anuki – Multi-agent AI platform with response-level enforcement (agents can't make unverified claims)`

**URL to submit**: https://github.com/cylonmolting-creator/anuki

**When**: Tuesday or Thursday, PST 00:01 (best launch window)

**Steps**:
1. Go to https://news.ycombinator.com/submit
2. Title: above
3. URL: the GitHub link
4. Post the HN text from LAUNCH.md as a comment immediately after

---

## 4. REDDIT

### 4a. r/AI_Agents

**Title**: `I built an open-source multi-agent platform where agents create other agents (and a Stop hook verifies their claims)`

**Body**:
```
I've been building Anuki — an open-source multi-agent AI platform (Node.js, MIT license).

The core idea: instead of defining agents in code, you describe what you need in natural language. An agent called ENKI creates new agents — complete with identity files, safety rules, and memory.

The thing I'm most proud of: **response-level enforcement**. Every other framework guards tool calls (file edits, API calls). Anuki also guards what agents *say*. When an agent claims "this function is unused", a Stop hook runs grep to check. If the claim is false, the response gets blocked and the agent must rewrite with evidence.

Other features:
- 3-layer cognitive memory (episodic, semantic, procedural)
- SSOT rule system — write once, propagates to all agents via tags
- Soul files (9 types) for persistent agent identity
- Circuit breaker, health watchdog, crash recovery
- Self-healing deadlock protection for the hook system itself

git clone, npm install, npm start. That's it.

GitHub: https://github.com/cylonmolting-creator/anuki

Happy to answer questions.
```

### 4b. r/LocalLLaMA

**Title**: `Open-source multi-agent AI platform with mechanical rule enforcement and cognitive memory — Anuki`

**Body**: Same as above, add this line at the end:
```
Currently uses Claude CLI but multi-provider support (including local LLMs via Ollama) is on the roadmap.
```

### 4c. r/SideProject

**Title**: `I built Anuki — an open-source AI agent LEGO platform`

**Body**: Shorter version:
```
Built this over the past few months. It's a multi-agent AI platform where:

- You create agents by talking to an agent (no UI forms)
- Each agent has persistent identity ("soul files"), memory, and rules
- A mechanical hook system verifies what agents claim — not just what they do
- Agents survive restarts, self-heal, and learn from conversations

Node.js, MIT licensed, git clone and go.

GitHub: https://github.com/cylonmolting-creator/anuki

Would love feedback from other devs building with AI agents.
```

---

## 5. DEV.TO ARTICLE

**Already prepared in LAUNCH.md**. Copy the full Dev.to article from there.

**Steps**:
1. Go to https://dev.to/ → New Post
2. Copy title + body + tags from LAUNCH.md
3. Publish

---

## 6. PRODUCT HUNT

**Already prepared in LAUNCH.md**. But needs a demo video first.

**Demo video plan** (simple, 60-90 seconds):
1. Show terminal: `git clone`, `npm install`, `npm start`
2. Open browser → WebChat UI
3. Chat with PROTOS (default greeter)
4. Ask ENKI to create a new agent
5. Show the agent appearing in sidebar
6. Show UTU adding a rule
7. End with: "3 agents. Unlimited possibilities."

**Tools for recording**: OBS Studio (free), or QuickTime (macOS built-in)

---

## 7. GITHUB TOPICS / TAGS

**Steps**:
1. Go to https://github.com/cylonmolting-creator/anuki → Settings (or "About" gear icon)
2. Add topics: `ai-agents`, `multi-agent`, `llm`, `nodejs`, `soul-files`, `cognitive-memory`, `agent-framework`, `open-source`, `ai`, `anthropic`, `claude`
3. Add description: "Open-source AI Agent LEGO Platform — Build, manage, and orchestrate your own multi-agent team"

---

## TIMING STRATEGY

**Day 1 (Today/Tomorrow)**:
- [ ] Fix GitHub topics/tags (2 min)
- [ ] Submit PRs to 3 awesome lists (15 min total)

**Day 2-3**:
- [ ] Post to r/AI_Agents + r/SideProject (10 min)
- [ ] Publish Dev.to article (10 min)

**Day 4-5**:
- [ ] Post to Hacker News (Tuesday or Thursday, PST morning)
- [ ] Post to r/LocalLLaMA (5 min)

**Week 2**:
- [ ] Record demo video (30 min)
- [ ] Launch on Product Hunt (15 min)
- [ ] Explore SoulSpec registry (30 min)

---

## IMPORTANT NOTES

1. **Don't spam** — post to different platforms on different days. Reddit especially punishes same-day multi-sub posts.
2. **Engage** — respond to every comment. People who comment on launch day are your future contributors.
3. **Be honest** — "built this as a solo dev, feedback welcome" performs better than hype.
4. **Cross-link** — in Reddit posts mention "also on HN" after it's there. GitHub README should link to the HN discussion.
