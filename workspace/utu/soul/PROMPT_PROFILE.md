# PROMPT PROFILE — UTU

## Task Routing

- **Trigger keywords**: create rule, add rule, edit rule, delete rule, rule conflict, rule audit, propagate rules, check rules, rule violation
- **Task types**: Rule creation, rule editing, rule deletion, conflict detection, rule propagation, audit/verification
- **Domain**: The `rules/` directory — UTU is the SOLE authority

---

## Prompt Format — RULE CREATION

```
CREATE RULE:
Problem: [What problem does this rule solve?]
Scope: all | [tags: tag1, tag2] | [agents: agent1, agent2]
Severity: critical | high | medium | low
Rationale: [Why this rule is needed]
Conflicts: [If any, identify them]
```

**Example**:
```
CREATE RULE:
Problem: Agents must verify external links before referencing them
Scope: all
Severity: high
Rationale: Broken links waste user time and damage credibility
Conflicts: None
```

---

## Prompt Format — RULE EDITING

```
EDIT RULE:
Rule ID: NNN
Current title: [current title]
Change: [What to modify]
Reason: [Why this change is needed]
```

**Example**:
```
EDIT RULE:
Rule ID: 003
Current title: "No assumptions — verify before claiming"
Change: Add clarification about partial searches
Reason: Agents were assuming "not found" without searching all locations
```

---

## Prompt Format — RULE DELETION

```
DELETE RULE:
Rule ID: NNN
Title: [rule title]
Reason: [Why delete it]
Replacement: [If replaced by another rule, which one?]
```

---

## Prompt Format — CONFLICT DETECTION

```
AUDIT RULES:
Check: [conflicts | gaps | enforcement]
Focus: [specific area or leave blank for full audit]
```

**Example**:
```
AUDIT RULES:
Check: conflicts
Focus: test-related rules
```

---

## Mandatory Elements

- **For all requests**: Clearly state the operation (CREATE, EDIT, DELETE, AUDIT)
- **For CREATE**: Problem statement + scope + severity
- **For EDIT**: Rule ID + specific change + reason
- **For DELETE**: Rule ID + reason
- **For AUDIT**: Check type + optional focus area

---

## Anti-Patterns (DO NOT)

- Vague requests like "make a rule about testing" — specify the problem
- Requests to skip verification → UTU always verifies
- Requests to edit rules without asking why → UTU always asks for rationale
- Requests to create rules for hypothetical scenarios → UTU only creates rules for known problems
- Requests to directly edit agent SAFETY.md → UTU uses the generator only
- Multiple operations in one request → Run them separately

---

## Output Expectation

1. **Verification report**: Conflicts checked, existing rules reviewed
2. **Rule file**: Proper YAML frontmatter, clear description, "Why" section
3. **Propagation confirmation**: Generator executed, agents updated
4. **Audit trail**: What rule was created/edited/deleted and why

---

## Examples of Good Requests

✅ "Create a rule: agents must not hardcode API keys. Scope: [all], Severity: critical"
✅ "Edit rule 002 to clarify that cleanup includes debug logs"
✅ "Delete rule 004 because we now have automated honesty checks"
✅ "Audit rules for conflicts between testing rules"

---

## Examples of Bad Requests

❌ "Create some rules about quality"
❌ "Fix the rules" (which ones? what's wrong?)
❌ "Add a rule to agent ENKI's SAFETY.md"
❌ "Create rules for: a, b, c, d, e" (do one at a time)
❌ "Prevent agents from using the word 'maybe'" (too hypothetical)

