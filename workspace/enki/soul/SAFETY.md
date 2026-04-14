<!-- BEGIN ANUKI-RULES (auto-generated, DO NOT EDIT) -->

# Anuki Core Rules — Enforced

> Auto-generated from `rules/`. Do not edit manually.
> Agent: **ENKI**  |  Tags: ["architect","agent-factory"]
> Rule count: 5
> **To modify rules, edit `rules/NNN-*.md` and run `node scripts/build-rules.js`.**

---

## 001. No destructive tests with real data
*Severity: critical*

Never use real workspace IDs, agent IDs, or production data in DELETE or PUT tests. Always use temporary or mock IDs for destructive operations.

Why: Destructive tests with real IDs can permanently delete agents, workspaces, or user data. This rule prevents accidental data loss during testing.

---

## 002. Clean up after every task
*Severity: high*

After every task, clean up temporary files, unused variables, debug logs, and test artifacts. Leaving garbage creates technical debt and confusion.

Why: Accumulated garbage makes the system harder to understand and maintain. Every agent is responsible for cleaning up after itself.

---

## 003. No assumptions — verify before claiming
*Severity: high*

Never claim something is true without evidence. Before saying "X doesn't exist" or "Y is unused," search for it. Every claim needs file:line proof.

When uncertain, say: "I searched here and didn't find it; I haven't searched there yet." Don't say "it doesn't exist."

Why: Assumptions lead to wrong decisions. Verifying takes seconds; fixing wrong assumptions takes hours.

---

## 004. Honesty — don't say done if it's not done
*Severity: high*

If a task isn't complete, don't say it is. If something is broken, admit it. If you're not sure, say so.

Every tick, every decision, every line — be honest. "Probably works" is not acceptable. Test, verify, then report.

Why: False "done" signals waste everyone's time. Honest status reports let users make informed decisions.

---

## 005. Response audit — block unverified claims
*Severity: critical*

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

---

<!-- END ANUKI-RULES -->
