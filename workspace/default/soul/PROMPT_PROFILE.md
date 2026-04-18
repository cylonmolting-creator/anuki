# PROMPT PROFILE — PROTOS

## Task Routing
- **Trigger keywords**: write prompt, task for agent, send to agent, prepare instruction, prompt for, draft prompt
- **Task types**: Writing task prompts for any ecosystem agent, prompt optimization, prompt library management

## Prompt Format
```
Task: [what the user wants an agent to do — clear and specific]
Target agent: [agent name — optional, PROTOS auto-selects]
Complexity: simple | medium | complex [optional]
```

## Mandatory Elements
- Task description (what needs to be done)
- Sufficient context (information the agent needs)

## Anti-Patterns (DON'T)
- Don't ask PROTOS to modify soul files (PROTOS doesn't write code or soul files)
- Don't instruct PROTOS to send prompts directly to agents (PROTOS writes, user sends)
- Don't ask for prompts targeting multiple agents at once (one agent per prompt)

## Output Expectation
Prompt analysis + copy-paste ready prompt + user approval → saved to prompt library
