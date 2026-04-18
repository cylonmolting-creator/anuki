# CODE CHANGE PROTOCOL — ENKI

> This protocol is MANDATORY for every code change. No exceptions.
> This protocol applies both when creating agents and when modifying system files.

## MANDATORY 6 STEPS

### 1. RESEARCH (assumptions FORBIDDEN)
- Read ALL related files with the Read tool
- Find dependencies: import, require, function call
- Scan usage locations with Grep
- Verify executor compatibility (soul file formats, workspace structure)

### 2. PLAN
- List affected files
- Evaluate side effects
- Choose the simplest solution
- Perform cross-file consistency check

### 3. CODE — WRITE IN WORKSPACE (NOT IN PRODUCTION!)
- Make code changes in the agent's workspace directory first
- NEVER modify production files directly
- Each agent gets its own isolated workspace (`workspace/{agent-name}/`)
- Write in a style consistent with existing code
- Check every variable/import — is it defined?

### 4. VERIFY
- Re-read the file you modified
- `node -c file.js` — syntax check
- Logic check: undefined variable, typo, missing import
- Soul file format: does it match the structure the executor expects?

### 5. FULL TEST — MANDATORY
```
STEP 5.1: Syntax check — ALL changed files
STEP 5.2: Agent spawn test — can the created agent start?
STEP 5.3: Soul file validation — are all mandatory files present, are formats correct?
STEP 5.4: Cross-file consistency — are cross-file references consistent?
STEP 5.5: Check the ENTIRE SYSTEM (not just the changed part)
  [ ] Health check: curl localhost:3000/api/health
  [ ] Workspace access: all agents
  [ ] New agent endpoint test
```

**RULE**: Do NOT deploy until 100% PASS.
**NO EXCEPTIONS** — even small changes are tested first.

### 6. DEPLOY (AFTER TEST PASS)
- Deploy changes ONLY AFTER tests are 100% PASS
- Verify with diff: are changes correct?
- This step is ONLY performed AFTER Step 5 gives 100% PASS

## AGENT CREATION SPECIAL RULES — CRITICAL

> Every agent you create will be subject to these rules. No exceptions.

### Mandatory file: CODE_PROTOCOL.md
- CODE_PROTOCOL.md MUST be added to every agent's soul/ directory
- This file MUST contain the following rules:
  1. Workspace isolation: write in the agent's own workspace directory
  2. Syntax check requirement (`node -c` or equivalent for the relevant language)
  3. No deploying without 100% PASS
  4. Deploy only after test PASS
- Delivering an agent without CODE_PROTOCOL.md is FORBIDDEN

### Mandatory config: cwdOverride
- Every new agent's workspaces.json entry MUST have `cwdOverride`
- Format: `agents/{agent-name}/`
- This ensures the agent's Claude CLI runs in an isolated directory

### Mandatory config: tags (for SSOT rule propagation)
- Every new agent's workspaces.json entry MUST have a `tags: [...]` array
- Tag catalog: `rules/TAGS.md` — select from there, don't make up tags
- Select tags appropriate for the agent's nature (e.g.: code-writer, researcher, blockchain-dev)
- If a new tag is needed -> add it to `rules/TAGS.md` first, then use it
- Without tags, the agent won't be included in SSOT rule propagation — mandatory

### Mandatory: SSOT rule propagation
- IMMEDIATELY AFTER agent creation, workspace-manager.js automatically runs `scripts/build-rules.js`
- This call is made via `_triggerRuleGenerator()` at the end of the `createWorkspace()` function
- The generator reads `rules/*.md`, injects rule blocks into the new agent's SAFETY.md based on tags
- If manual triggering is needed: `node scripts/build-rules.js`
- ENKI relies on this call — do not interrupt the agent creation flow

### Mandatory test: Validation
- ALL soul files of the created agent must pass syntax + format check
- Agent spawn test must be done before declaring completion
- Declaring done without 100% PASS is FORBIDDEN

### TEMPLATE: New agent CODE_PROTOCOL.md
Every agent you create must have a CODE_PROTOCOL.md containing AT LEAST:
```
1. RESEARCH — read files, find dependencies
2. PLAN — list affected files
3. CODE — write in workspace directory (isolated)
4. VERIFY — syntax check, logic check
5. TEST — full test, 100% PASS mandatory
6. DEPLOY — only after test PASS
RULE: Do NOT deploy until 100% PASS.
```

## NEVER DO
- Make changes without reading the file
- Edit production files DIRECTLY — test FIRST, THEN deploy
- Deploy without testing
- Say "it probably works" — be 100% sure
- Create an agent without CODE_PROTOCOL.md
