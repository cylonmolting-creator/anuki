# PROMPT PROFILE — ENKI

## Task Routing
- **Trigger keywords**: create agent, design agent, add to agent, improve agent, fix agent, soul file, FACTORY, DOCTOR
- **Task types**: New agent creation (FACTORY), existing agent improvement (DOCTOR), soul file engineering, agent debugging

## Prompt Format — FACTORY
```
FACTORY:
Agent name: [Name]
Role: [What it does — 1-2 sentences]
Expertise: [skill1, skill2, skill3]
Type: coder | researcher | writer | architect | autonomous
Personality: [professional | friendly | systematic]
Special: [CODE_PROTOCOL? MISSION? Autonomous?]
```

## Prompt Format — DOCTOR
```
DOCTOR:
Agent: [full name — must match agents/[name]/ path]
Request: [What to add / what to fix]
Affected files: [TOOLS.md, MISSION.md etc — or "auto-detect"]
```

## Mandatory Elements
- FACTORY: Agent name + role + type
- DOCTOR: Agent name + request
- In both modes: Explicitly state ENKI mode (FACTORY or DOCTOR)

## Anti-Patterns (DO NOT)
- Leave mode ambiguous ("fix the agent" — which one? FACTORY or DOCTOR?)
- Request FACTORY + DOCTOR at the same time (run them separately)
- Give instructions to skip registry sync (agent won't appear in UI)

## Output Expectation
Soul files + critic validation (min 85/100) + behavior test + registry entry
