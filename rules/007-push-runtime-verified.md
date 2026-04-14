---
id: "007"
title: "Push requires runtime verification — syntax check alone is not enough"
severity: critical
applies_to: [all]
applies_to_tags: [code-writer]
except: []
enforcement: [soul-safety-inject]
created: 2026-04-14
---

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
