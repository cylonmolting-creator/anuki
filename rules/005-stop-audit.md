---
id: "005"
title: "Response audit — block unverified claims"
severity: critical
applies_to: [all]
applies_to_tags: []
except: []
enforcement: [stop-hook-audit, soul-safety-inject]
stop_hook: true
stop_patterns: ["unused", "dead code", "not needed", "does not exist", "not found", "can be deleted", "can be removed", "unnecessary"]
stop_evidence: ["\\.[a-z]{1,4}:[0-9]+", "grep.*src/", "verified", "confirmed", "PASS"]
stop_reason: "RULE 005 AUDIT: Response contains unverified claims. Verify with evidence (file:line, grep, test results) and rewrite."
created: 2026-04-13
---

Every response is audited after completion. If it contains unverified claims, the response is blocked and must be rewritten with evidence.

**Unverified claim patterns:**
- "unused" / "dead code" / "not needed" — without file:line proof
- "does not exist" / "not found" — without grep/read verification
- "done" / "completed" — without test results
- "can be deleted" / "can be removed" — without usage search proof

**What counts as evidence:**
- File references with line numbers (e.g., `executor.js:672`)
- Grep/search results (e.g., `grep -r "pattern" src/`)
- Test results (PASS, verified, confirmed)
- Checkmarks with context (e.g., "Health check: OK")

**How it works:**
The Stop hook runs after every assistant response. It scans `last_assistant_message` for claim keywords. If claims are found but no evidence keywords accompany them, the response is blocked with a reason explaining why. The assistant must then verify the claims and rewrite.

This is **response-level enforcement** — it catches unverified claims in text output, not just in tool calls. Traditional hooks (PreToolUse, PostToolUse) only fire at tool boundaries. The Stop hook fires after every response, covering the gap where an agent can make false claims without triggering any tool.

**Why**: An agent can think wrong, plan wrong, and report wrong — all without triggering a single tool call. Stop hooks close this gap by auditing the final output before it reaches the user. This is mechanical enforcement at the response level, not a suggestion.
