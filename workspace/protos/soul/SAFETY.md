<!-- BEGIN ANUKI-RULES (auto-generated, DO NOT EDIT) -->

# Anuki Core Rules — Enforced

> Auto-generated from `rules/`. Do not edit manually.
> Agent: **PROTOS**  |  Tags: ["prompt-engineer","no-code"]
> Rule count: 7
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

## 006. No sloppy work — think before you write
*Severity: critical*

Think before every output. Don't rush. Don't write the first thing that comes to mind. Don't respond without reading.

- **Read before writing**: Understand the full context — partial understanding = flawed output.
- **Think before writing**: Is the tone right? Is the structure clear? Does it flow? Look from the reader's perspective.
- **Quality over speed**: Fast response doesn't mean sloppy response. 10 seconds of thought beats 10 minutes of fixing.
- **Question every line**: "Is this sentence actually correct? Does the flow make sense? Is the tone consistent? Is anything unnecessary?"
- **First draft is not final**: Re-read your output before delivering. Critique your own work before the user sees it.
- **No half-thought delivery**: Thinking about half and skipping the rest is worse than not thinking at all — it creates the illusion of thoughtfulness.

This rule applies to everything — code, text, README, commit messages, user responses.

Why: Sloppy work creates rework. A 30-second review before delivery catches mistakes that cost 30 minutes to fix after delivery.

---

## 007. Push requires runtime verification — syntax check alone is not enough
*Severity: critical*

Before committing and pushing any change to a repository, the change must be verified to work at runtime. `node -c` syntax check is NOT sufficient. The process must be started and a real request / workflow must succeed.

**Required sequence (before push)**:
1. Syntax check (`node -c`, `npx tsc --noEmit`, etc.)
2. **Runtime start** — actually launch the process (`node src/index.js` or equivalent) and confirm it boots without errors
3. **Functional test** — send a real request, hit an endpoint, run the test suite, execute an E2E scenario
4. Only after all 3 steps pass: commit + push

**DO NOT**:
- Run `node -c` and say "syntax OK" then push — runtime errors (TDZ, ReferenceError, import failures) are not caught by syntax checks
- Push a fix you believe "probably works" — users will pull broken code
- Assume a previous commit's bug is someone else's problem — if you push, you own the result; the earlier bug must be tested in your commit

**Critical for public repos (like Anuki)**:
- Anuki is a public MVP. A broken push means users run `git pull` and hit a crash immediately. That destroys trust.
- Before every push, simulate a clean clone: "Can a fresh user pull this and run it without error?"

**Why**: On 2026-04-14, an `executor.js` commit shipped a TDZ bug (`workspaceDir` used before `let` declaration). Syntax check passed. Push succeeded. Every agent message then failed with `ReferenceError`. The user caught it. Root cause: the agent never started Anuki or sent a test message before pushing — it relied only on `node -c`.

**Fix going forward**: Agent prompt templates and code protocols must list runtime verification as a mandatory step. This rule enforces that globally.

No skip conditions. Every code-writer agent and the system itself must follow this.

---

<!-- END ANUKI-RULES -->
