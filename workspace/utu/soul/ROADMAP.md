# ROADMAP — UTU

> Long-term mission map for the Rule Guardian

## Phase 1: Foundation (COMPLETE ✓)

Core rule system established and working:
- [x] Soul files created (IDENTITY, SOUL, SAFETY, MISSION, TOOLS, PROMPT_PROFILE, first_prompt.txt)
- [x] Rule creation workflow documented
- [x] Rule propagation system integrated with build-rules.js
- [x] 4 foundational rules in place (001-004)
- [x] CODE_PROTOCOL established for rule operations

## Phase 2: Active Maintenance (IN PROGRESS)

Current focus: Managing the rule system as it grows

- [ ] Monitor agents for rule violations or issues
- [ ] Audit existing rules monthly for:
  - [ ] Conflicts or contradictions
  - [ ] Obsolete or superseded rules
  - [ ] Gaps (known problems without rules)
- [ ] Respond to user requests for new rules
- [ ] Verify rule propagation after every change
- [ ] Document rule decisions in CHANGELOG.md

## Phase 3: Expansion

Scale the rule system to cover new agent types and patterns

- [ ] Add rules for security (code review, secret management)
- [ ] Add rules for data handling (privacy, retention)
- [ ] Add rules for documentation (inline comments, docstrings)
- [ ] Add rules for testing (coverage, E2E verification)
- [ ] Create rule templates for common scenarios
- [ ] Build conflict detection automation

## Phase 4: Optimization

Make rule management more efficient

- [ ] Automated rule conflict detection
- [ ] Rule deprecation lifecycle (active → deprecated → removed)
- [ ] Rule versioning (if rules need to evolve over time)
- [ ] Agent-specific rule profiles
- [ ] Rule coverage dashboard
- [ ] Audit automation

## Current Rules (Phase 1 Complete)

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| 001 | No destructive tests with real data | critical | ✓ Active |
| 002 | Clean up after every task | high | ✓ Active |
| 003 | No assumptions — verify before claiming | high | ✓ Active |
| 004 | Honesty — don't say done if it's not done | high | ✓ Active |

## Known Rule Gaps (Proposed)

Rules that should be created in Phase 2/3:

- [ ] **Security**: "Never hardcode secrets (API keys, tokens, credentials)"
- [ ] **Testing**: "Every code change must have passing tests"
- [ ] **Code review**: "Code changes require peer review before merge"
- [ ] **Documentation**: "Major features must be documented"
- [ ] **Performance**: "Performance-critical code must have benchmarks"

## Next Steps

1. Wait for user to request new rules or rule modifications
2. Monitor agents for rule violations
3. Schedule monthly audits to check for gaps or conflicts
4. Plan Phase 3 expansion based on agent growth

## Success Metrics

- ✓ All rules have clear "Why" explanations
- ✓ Rules are enforced consistently across agents
- ✓ No rule contradictions in the system
- ✓ New rules are created only for known problems
- ✓ Rule propagation is 100% verified
- ✓ Agents report rule violations (when they happen)

