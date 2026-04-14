# Anuki — 10 Unique Features (No Competitor Has These)

> Marketing and pitch reference.

| # | Feature | Description | Competitors |
|---|---|---|---|
| 1 | **Agent-creator agent (ENKI)** | No UI — create agents with an agent. User describes in natural language, ENKI creates from scratch: soul, memory, safety, rules — all automatic | OpenClaw, Paperclip, CrewAI: none do this |
| 2 | **Prompt bridge agent (PROTOS)** | Natural language → agent-specific format. Reads each agent's soul files, writes tailored prompts. 9-step protocol, output scaffolding, anti-pattern aware | Nobody does this |
| 3 | **Rule-keeper agent (UTU)** | ONLY this agent writes rules. No other agent can touch the rules/ directory. Sumerian god of justice — sole owner of governance | Nobody does this |
| 4 | **SSOT rule propagation** | Single source (rules/) → tag-based per-agent filter → automatic generator → idempotent distribution. Add a rule, it propagates to all affected agents | Nobody does this |
| 5 | **Soul + Memory + Rules integrated** | Soul files (identity) + 3-layer memory (learning) + SSOT rules (governance) unified in one platform. Competitors have these partially or not at all | OpenClaw partial, others none |
| 6 | **Cognitive memory (3 layers)** | Episodic (what happened) + Semantic (what I know) + Procedural (how to do it). MemGPT/Letta-style. Agents learn, remember, improve | OpenClaw basic, Paperclip none, CrewAI none |
| 7 | **Hook-enforced governance** | SessionStart + PreToolUse + PostToolUse + UserPromptSubmit — mechanical protection hooks. Deterministic defense against attention drift. Agent cannot "forget" a rule | Nobody does this |
| 8 | **Response-level enforcement (Stop hooks)** | Every agent response is audited *after generation, before delivery*. Two modes: **claim verification** (blocks claims without evidence) and **behavioral enforcement** (blocks forbidden patterns unconditionally). No other framework does response-level enforcement | **Nobody does this** — industry first |
| 9 | **Self-healing deadlock protection** | 5-layer defense: shell sanitization, regex escaping, `sh -n` syntax validation, atomic writes, SessionStart auto-recovery. Bad rules can't break the system — they're detected and skipped. Born from a real production incident | Nobody addresses this |
| 10 | **LEGO philosophy** | User changes everything — create agents, write rules, modify soul files, build their own team. We provide the box, user fills it | Unique approach |

## The Niche: Response-Level Mechanical Enforcement

> **This is the feature that makes Anuki fundamentally different from every other multi-agent framework.**

Every multi-agent framework today (CrewAI, LangGraph, AutoGen, Microsoft Agent Governance Toolkit) enforces rules at the **tool call boundary** — before a tool executes. This covers file edits, API calls, and command execution.

But none of them audit what the agent **says**. An agent can:
- Claim "this file is unused" without searching for it
- Report "task complete" without running tests
- Say "not found" without actually looking

These are **unverified claims in text output** — they bypass every existing guardrail because no tool call is involved.

**Anuki's Stop hook system closes this gap:**

```
Agent generates response
    ↓
Stop hook fires (shell command, <1ms)
    ↓
Scans for claim patterns ("unused", "not found", "dead code", etc.)
    ↓
Checks for evidence patterns (file:line, grep results, PASS, verified)
    ↓
Mode: claim (default)
  Claim found + no evidence? → BLOCK response, force rewrite with proof
  Claim found + evidence? → ALLOW
  No claim? → ALLOW

Mode: behavioral
  Pattern found? → BLOCK (no evidence check needed)
  No pattern? → ALLOW
```

This is **deterministic** (shell regex, not AI judgment), **automatic** (generated from SSOT rules), and **mechanical** (agent cannot bypass it — the hook fires after every response, period).

### Why This Matters

| Enforcement Level | What It Catches | Who Does It |
|---|---|---|
| **Tool-level** (PreToolUse) | Dangerous file edits, destructive commands | CrewAI, LangGraph, AutoGen, MS Toolkit, **Anuki** |
| **Tracking** (PostToolUse) | Files read/written, state changes | Some frameworks, **Anuki** |
| **Prompt-level** (UserPromptSubmit) | Rule reminders at conversation start | **Anuki** |
| **Response-level** (Stop hook) | Unverified claims, false completions | **Anuki only** |

The bottom row — response-level enforcement — is the gap that every other framework leaves open. Anuki is the first to close it.

### How Rules Become Hooks (The SSOT Pipeline)

```
rules/005-stop-audit.md          ← Write a rule (markdown + YAML frontmatter)
        ↓
node scripts/build-rules.js      ← Generator reads all rules
        ↓
.claude/settings.json            ← Stop hook auto-generated
workspace/*/soul/SAFETY.md       ← Per-agent safety rules auto-injected
```

One source. Automatic propagation. Idempotent. Tag-based filtering. The same pipeline that generates PreToolUse hooks now generates Stop hooks — same SSOT, new enforcement layer.

## One-liner pitch

> **Anuki: Build your AI agent team with LEGO-like blocks — create agents with agents, enforce rules mechanically at every level including response audit, grow smarter with cognitive memory.**

## Competitor comparison (short)

- **OpenClaw** = 1 agent, 1 personality. Anuki: N agents, N personalities, they talk to each other.
- **Paperclip** = organizes agents but doesn't create them. Anuki: ENKI creates, PROTOS bridges, UTU governs.
- **CrewAI** = Python framework, define agents in code. Anuki: describe in natural language, agent creates agent.
- **MS Agent Governance Toolkit** = tool-level policy engine. Anuki: tool-level + response-level + SSOT propagation.
- **LangGraph** = graph-based agent orchestration. Anuki: soul-based identity + cognitive memory + mechanical governance at every layer.
