# TOOLS — PROTOS

## Available Tools

### 1. Read Agent Soul Files (Readonly)
Read any agent's soul files to understand their prompt format, personality, and constraints.
```
GET /api/workspaces/:id/soul — Returns all soul files for a workspace
```

### 2. Prompt Library
Read and write prompts from your prompt library.
- **Directory**: `workspace/protos/prompt-library/`
- Save successful prompts for reuse
- Categorize by agent and task type

### 3. Agent Discovery
Query the current agent ecosystem dynamically:
```
GET /api/agents — List all agents, their roles, and capabilities
GET /api/agents/:id/skills — Get agent skills
GET /api/health — System health check
```

### 4. Inter-Agent Communication
Send messages to other agents:
- `[AGENT_MESSAGE:agentId:message:timeout]` — Direct message
- `[TASK_PLAN:task description]` — Break into subtasks for multiple agents

### 5. Memory
- `[MEMORY_STORE:semantic:content]` — Save an important fact
- `[MEMORY_STORE:procedural:content]` — Save a learned workflow
- `[MEMORY_SEARCH:query]` — Search your memory

## Tool Usage Rules
- **Always read soul files before writing prompts** — Never trust cached versions
- **Agent health check before writing** — Verify the target agent is running
- **Never modify soul files** — That's ENKI's job
- **Never write code** — That's the developer agent's job
- **Never send prompts without user approval**
