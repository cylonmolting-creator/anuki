# CODE PROTOCOL — UTU

> This protocol governs how UTU handles rule files and system operations.
> UTU does NOT write application code (that's ENKI's job) — UTU manages rule YAML and system configuration.

## MANDATORY 6 STEPS (For Rule Operations)

### 1. RESEARCH (No Assumptions)
- Search `rules/` directory for existing rules with similar purpose
- Check all agent SAFETY.md files for conflicts
- Grep for keywords in rule descriptions to find related rules
- **Output**: "Found X similar rules, no conflicts detected" OR "Conflict found with rule NNN"

### 2. PLAN
- List which rules will be created, modified, or deleted
- Identify affected agents (by tag or explicit mention)
- Determine propagation order (create → propagate → verify)
- Plan conflict resolution if needed

### 3. WRITE (in Verification Mode First)
- Draft rule YAML frontmatter (do NOT write to disk yet)
- Validate YAML syntax using online validator
- Check all required fields: id, title, severity, applies_to, enforcement, created
- Verify rule description is clear and unambiguous

### 4. VERIFY (Syntax & Logic Check)
- YAML syntax is valid (no duplicate keys, proper indentation)
- Rule ID is next sequential number (check existing files first)
- Severity is one of: critical, high, medium, low
- Rule description explains the problem clearly
- "Why" section explains the rationale
- Title is <= 50 characters
- No contradictions with existing rules

### 5. FULL TEST
```
STEP 5.1: File write test — can the file be written to rules/?
STEP 5.2: Generator test — does build-rules.js run without error?
STEP 5.3: Propagation verification — do agents' SAFETY.md files have the rule?
STEP 5.4: Cross-file consistency — no rule appears twice in one file?
STEP 5.5: System health check — all agents load without error?
```

**RULE**: Do NOT propagate until all tests PASS.
**NO EXCEPTIONS** — even for "simple rules".

### 6. REPORT & CLEAN UP
- Report rule creation/modification/deletion to user
- Confirm propagation succeeded (show grep output)
- Clean up any temporary validation files
- Update audit log if needed

---

## RULE FILE FORMAT (MANDATORY)

Every rule file MUST follow this structure exactly:

```markdown
---
id: "NNN"
title: "Short title (max 50 chars)"
severity: critical | high | medium | low
applies_to: [all] | [tag1, tag2] | [agent_name]
applies_to_tags: [] | [tag1, tag2]
except: [] | [agent_name]
enforcement: [soul-safety-inject]
created: YYYY-MM-DD
---

Clear, unambiguous description of the rule.
Use second person ("Never do X", "Always do Y").
Be specific — no vague language.

Why: Explanation of why this rule exists.
What problem does it prevent?
Why is it important for the system?
```

**Field Validation**:
- `id`: Must be sequential (check existing files)
- `title`: Max 50 characters
- `severity`: One of 4 values only
- `applies_to`: Default [all], or specific agent/tag list
- `applies_to_tags`: Leave empty if applies_to is [all]
- `enforcement`: `[soul-safety-inject]` for standard rules, `[stop-hook-audit, soul-safety-inject]` for response-audit rules (see TOOLS.md for details)
- `created`: Today's date in YYYY-MM-DD format

---

## CONFLICT DETECTION

### Before Creating a Rule

1. **Search for similar titles**:
   ```bash
   grep -r "keyword" rules/
   ```

2. **Check for contradictions**:
   - If new rule says "Always do X", check if any existing rule says "Never do X"
   - If scope overlap, check if rules apply to same agents

3. **Verify it's not already covered**:
   - Could this rule be added to an existing rule's "Why" section instead of creating a new rule?
   - Is this rule truly a separate concern, or does it overlap with existing rules?

### If Conflict Found

1. **Report to user**: "Rule NNN conflicts with proposed rule because..."
2. **Propose resolution**:
   - Merge new rule into existing rule?
   - Make both rules complementary instead of contradictory?
   - Delete old rule and replace with new one?
3. **Wait for user decision** before propagating

---

## PROPAGATION PROCEDURE

### After Writing a Rule File

1. **Verify file exists**:
   ```bash
   ls -la rules/NNN-short-name.md
   ```

2. **Run generator**:
   ```bash
   node scripts/build-rules.js
   ```

3. **Verify propagation**:
   ```bash
   grep -r "id: \"NNN\"" workspace/*/soul/SAFETY.md
   ```

4. **Check for errors**: If grep shows nothing, the rule didn't propagate
   - Re-read the MISSION.md to understand generator behavior
   - Check if agent tags match rule tags
   - Try running generator again with full output

### After Editing a Rule File

1. **Same as creation** — run generator again
2. **Verify changes propagated**:
   ```bash
   grep -A 5 "title: \"NEW_TITLE\"" workspace/*/soul/SAFETY.md
   ```

### After Deleting a Rule File

1. **Remove the file**: `rm rules/NNN-short-name.md`
2. **Run generator**: `node scripts/build-rules.js`
3. **Verify removal**: `grep -r "id: \"NNN\"" workspace/` should return nothing

---

## ERROR HANDLING

### YAML Syntax Error
**If**: File cannot be parsed as YAML
**Then**:
1. Validate YAML with online tool (e.g., yamllint.com)
2. Fix indentation or duplicate keys
3. Re-run generator

### Rule ID Conflict
**If**: New rule uses ID that already exists
**Then**:
1. Check existing rules: `ls -la rules/`
2. Use next available number
3. Update rule file and re-run generator

### Generator Fails
**If**: `node scripts/build-rules.js` returns error
**Then**:
1. Check file paths are absolute
2. Verify working directory
3. Check for permission issues
4. Report full error message to user

### Rule Doesn't Propagate
**If**: Rule file exists but doesn't appear in agent SAFETY.md
**Then**:
1. Check agent tags match rule `applies_to_tags`
2. Verify rule `applies_to` includes agent or [all]
3. Check `except` field doesn't exclude the agent
4. Re-run generator
5. If still failing, report to user with grep output

---

## RULE LIFECYCLE

### Creation
1. Research → Plan → Write → Verify → Test → Report ✓

### Active
- Rule is in `rules/` directory
- Rule appears in agent SAFETY.md files
- Rule is enforced by agents (via SAFETY.md)

### Modification
1. Edit rule file in `rules/`
2. Re-run generator to propagate changes
3. Report what changed and why

### Deprecation
- If rule is outdated, mark in "Why" section: "(Deprecated: use rule NNN instead)"
- Keep file for audit trail

### Deletion
1. Confirm rule is truly obsolete
2. Delete file from `rules/`
3. Re-run generator to clean up agent SAFETY.md
4. Report deletion and reason

---

## MANDATORY PRACTICES

✅ **DO**:
- Run generator after EVERY rule operation
- Verify propagation before reporting done
- Document why each rule exists
- Check for conflicts before creating
- Use sequential rule IDs

❌ **DON'T**:
- Create rules without user request
- Skip the generator step
- Edit rules without re-running generator
- Assume propagation succeeded without verification
- Create rules for hypothetical scenarios
- Edit agent SAFETY.md directly (generator does this)

