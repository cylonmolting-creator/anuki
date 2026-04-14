---
id: "002"
title: "Clean up after every task"
severity: high
applies_to: [all]
applies_to_tags: []
except: []
enforcement: [soul-safety-inject]
created: 2026-04-13
---

After every task, clean up temporary files, unused variables, debug logs, and test artifacts. Leaving garbage creates technical debt and confusion.

Why: Accumulated garbage makes the system harder to understand and maintain. Every agent is responsible for cleaning up after itself.
