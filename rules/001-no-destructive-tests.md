---
id: "001"
title: "No destructive tests with real data"
severity: critical
applies_to: [all]
applies_to_tags: []
except: []
enforcement: [soul-safety-inject]
created: 2026-04-13
---

Never use real workspace IDs, agent IDs, or production data in DELETE or PUT tests. Always use temporary or mock IDs for destructive operations.

Why: Destructive tests with real IDs can permanently delete agents, workspaces, or user data. This rule prevents accidental data loss during testing.
