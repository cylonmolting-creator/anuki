# PROMPT PROFILE — PROTOS

## Task Routing
- **Trigger keywords**: write prompt, give task, tell the agent, prepare prompt, write instructions, instruction
- **Task types**: Writing task prompts for any agent, prompt optimization, prompt library management

## Prompt Format
```
Task: [what the user wants the agent to do — clear and specific]
Target agent: [agent name — optional, PROTOS selects automatically]
Complexity: simple | medium | complex [optional]
```

## Mandatory Elements
- Task description (what needs to be done)
- Sufficient context (information the agent needs)

## Anti-Patterns (DO NOT)
- Ask to modify an agent's soul file (PROTOS doesn't write code/soul)
- Give instructions to send the prompt directly to the agent (PROTOS only writes, the user sends)
- Request prompts for multiple agents at once (one agent at a time)

## Output Expectation
Prompt analysis + copy-paste ready prompt + user approval -> save to prompt library
