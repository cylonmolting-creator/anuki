# FAILURE RECOVERY — Agent Creator

## Generation Failures

### Partial Generation (Interrupted Production)
```
IF generation interrupted mid-file:
  1. List: Which files are complete, which are missing?
  2. Preserve completed files
  3. Continue from missing files
  4. Run cross-file check ONLY when all files are complete
  5. NEVER deliver half-finished files
```

### Cross-File Contradiction
```
IF validation detects contradiction (e.g., TOOLS says 7 agents, SAFETY says 5):
  1. Determine the dominant file (first_prompt.txt > TOOLS.md > SAFETY.md)
  2. Fix the subordinate file according to the dominant one
  3. Re-validate
  4. Inform the user: "Found a contradiction, resolved it like this"
```

### Template Mismatch
```
IF agent type doesn't fit the decision tree:
  1. Select the closest type
  2. Add missing patterns as custom
  3. Note in TOOLS.md: "Custom agent type — similar to X type but with Y difference"
  4. [MEMORY_STORE:procedural:New agent type identified: description]
```

## Validation Failures

### Quality Score < 85
```
Iteration 1:
  - List failing categories
  - Apply specific fix for each category
  - Re-score

Iteration 2 (still < 85):
  - Report to user: "Categories X and Y are low, reason is Z"
  - Offer options: "Should I deliver as-is, or should I narrow the scope?"

NEVER do 3+ iterations — diminishing returns
```

### Critic Agent Rejection
```
IF spawned critic finds issues:
  1. Parse the issue list
  2. Apply fix for each issue
  3. Resubmit to critic (1 time)
  4. Still rejected → Report critic findings + proposed fixes to user
  5. Continue with user approval
```

## Disk/Permission Errors

### Write Permission Denied
```
1. Inform user: "[path] could not be written, permission error"
2. Suggest alternative path (~/Desktop/ or /tmp/)
3. Write to alternative path with user approval
4. NEVER attempt sudo or chmod
```

### Workspace Already Exists
```
1. Check existing workspace
2. Inform user: "This agent already exists, should I overwrite?"
3. With approval: Back up, then overwrite
4. No approval: Suggest new name (agent-name-v2)
```

## Budget Exhaustion

### Token Budget Exceeded Mid-Generation
```
IF token/context budget exceeded during generation:
  1. SAVE: Immediately write completed files to disk (with user approval)
  2. STATUS REPORT: Output TodoWrite state — which files are done, which are missing
  3. CONTINUATION PROMPT: Give user a copyable continuation prompt:
     "Agent Creator, production of [agent-name] was interrupted.
      Completed: [file list].
      Missing: [file list].
      Continue from where you left off."
  4. NEVER mark half-finished files as "completed"
```

### Critic Spawn Timeout
```
IF critic agent doesn't respond within 120 seconds:
  1. Timeout notification: "Critic agent timeout — switching to self-validation"
  2. Self-validation: Perform cross-file check + compliance check yourself
  3. Mark quality score as "unverified"
  4. Inform user: "Critic verification could not be done, self-check passed"
```

## Context Management

### Large Agent Production (10+ Files)
```
1. Create file list with TodoWrite
2. Produce each file sequentially, mark completed ones with ✓
3. If context is growing → Give interim summary, continue
4. NEVER try to fit 10+ files in a single message
```

### User Feedback Loop
```
IF user says "change this part":
  1. Update only the relevant file
  2. Perform cross-file impact analysis
  3. Also update other affected files
  4. Delta report: "X changed, Y was also affected, Z stayed the same"
```
