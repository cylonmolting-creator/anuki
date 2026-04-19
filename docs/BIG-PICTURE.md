# BIG PICTURE — how to look at a bug, a change, a decision

> Mandatory reading. Injected at session start. Every agent internalizes it.

This document answers one question: **when I see a problem,
what do I do?** The answer is to see the whole system instead
of chasing symptoms. The pattern below is distilled from real
work (both in this repo and in the private ecosystem that
spawned it) — it's a procedure, not a story.

## Big-picture in two sentences

Before making a change:
1. **Understand the entire system the change lives in** —
   the lines above and below, who calls this function, where
   the data flows in from, every writer/reader of any shared
   state involved.
2. **Walk the blast radius of the change through the whole
   tree** — when I change this line, what else could break?
   Which tests hit it, which runtime paths trigger it, is
   there backward compatibility to maintain?

"Symptom chasing" is the opposite: silence the failure, rerun,
see green, call it done. Symptom chasing hides bugs.
Big-picture fixes them.

## 4-step big-picture flow

### 1. State — pin down what is what (Rule 003, Rule 012)

- **Look in 5 places**: `src/`, `public/`, `workspace/`,
  `data/`, `*.md`
- Every claim has **file:line** evidence. No "probably".
- After an edit, **verify on disk with grep** — the Edit tool
  can say "success" while the file on disk is unchanged
  (sandbox sync, permission quirks, open editors).

### 2. Root cause — not symptom (Rule 002)

- **Why** did this happen? Write the cause→effect chain.
- If there are multiple links, **name each one** explicitly.
- Band-aid detection: if the response mentions "fix", it must
  also mention "root cause / grep -r / regression / guard".
  (The `SSOT_STOP_BANDAID` hook enforces this.)
- **Example** (from this repo): a queue-flush UI test kept
  failing. The first guess — "backend is suppressing 'done'"
  — was symptom chasing. Tracing file:line showed the real
  cause in the frontend: `addMessage` did not remove the
  `.welcome` overlay, so the injected message was hidden
  behind it.

### 3. Projection — what else will this change break

- Does the **same pattern exist elsewhere**? — `grep -rn`
- Who **calls** the function I'm changing? — caller scan.
  For each caller, ask: will this change break that caller?
- If shared state is involved (globals, module-scope `let`,
  DOM elements), **list every writer and reader** walking
  over that state.
- **Example** (from this repo): refactoring `resetUIState`
  touched 7 call sites. Each was classified (reconnect vs
  terminal). Reconnect callers got the default guard, terminal
  callers got `force=true`. Not a one-line change — a design.

### 4. Verification — runtime, end-to-end (Rule 025)

- `node -c` is not enough. **Runtime start** + **real
  workflow** must be exercised.
- Before `git push`: fresh-clone acid test. Soul-file checksum
  must stay bit-identical (enforced by
  `scripts/e2e-safe-run.sh`).
- If a test fails, do not water down the test first — **try
  to fix the app first**. Prove the test is actually wrong
  (isolated pass) before softening it.
- The "test vs app" question is answered by **isolated run**:
  fails only in suite → pollution / race / brittle test.
  Fails in isolation too → real app bug; fix the app.

## Symptom chasing vs big-picture — contrast

| Signal | Symptom chasing | Big-picture |
|---|---|---|
| Test failure | Soften the test (.last(), skip) | grep/trace the real cause |
| Response says "done" | We wrote something, unsure it ran | Bash exit 0 + grep verify + curl 200 with file:line |
| Bug report | Band-aid fix + commit | `grep -r` for the same pattern + regression guard |
| Hook blocks you | Bypass the hook | Take what the hook found seriously |
| Claim | "probably works" | "evidence at file.ext:NNN" |

## Enforcement hooks (machine-level companion)

The big-picture discipline has a machine-enforced layer.
Anuki's hooks already block the following:

- **Rule 002 BANDAID** — bug-fix claim without root-cause trace
  → Stop BLOCK
- **Rule 005 claim audit** — claim without evidence → BLOCK
- **Rule 010 destructive** — real IDs in DELETE/PUT/`rm -rf` → BLOCK
- **Rule 012 edit verify** — edit's text not on disk → Stop BLOCK + tracker
- **Rule 013 stack patch** — 5+ edits to the same file → BLOCK
- **Rule 020 read-before-edit** — PreToolUse Edit with no prior Read → BLOCK
- **Rule 021 cleanup** — artifacts created mid-session still
  present at Stop → BLOCK
- **Rule 024/001 claim audit** — past-tense action claim with no
  matching tool_use in transcript → BLOCK

The hooks are **barriers against symptom chasing** so big-picture
becomes the default path.

## Self-check — is big-picture actually running?

Before submitting a response, run through these:

1. Does every claim have `file.ext:NNN` or `grep ... → result`?
2. Can I list the **callers** of the thing I changed?
3. If I said "fix", is there a **one-sentence root cause**?
4. Am I confident the **same pattern is not elsewhere** — and
   did I show how I scanned?
5. Is there **specific runtime evidence** it actually works
   (bash exit / curl / test pass)?
6. If I changed a test, did I **prove it was the test and not
   the app** (isolated run)? Which one?

Four or more "no"s mean I'm symptom chasing. Stop, restart
the big-picture flow.
