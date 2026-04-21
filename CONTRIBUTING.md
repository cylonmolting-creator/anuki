# Contributing to Anuki

Thank you for your interest in contributing to Anuki! This document provides guidelines for contributing to the project.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR_USERNAME/anuki.git`
3. **Install** dependencies: `npm install`
4. **Start** the server: `npm start`

## Prerequisites

- Node.js >= 18.0.0
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated (or OpenAI/Ollama configured in `.env`)

## Project Structure

```
anuki/
├── src/
│   ├── index.js              — Entry point, boot sequence
│   ├── agent/
│   │   ├── executor.js       — Claude CLI orchestration
│   │   ├── workspace-manager.js — Agent workspace management
│   │   └── compactor.js      — Token-based context compaction
│   ├── memory/
│   │   └── cognitive.js      — 3-tier memory (episodic/semantic/procedural)
│   ├── gateway/              — HTTP, WebSocket, cron
│   ├── channels/             — WebChat (extensible to Telegram, Discord, etc.)
│   └── core/                 — Security, backup, sandbox
├── public/                   — Frontend SPA
├── scripts/
│   └── build-rules.js        — SSOT rule → hook compiler
├── workspace/                — Agent workspaces (soul files, memory)
└── rules/                    — SSOT rule definitions (markdown)
```

## Development Workflow

1. **Create a branch** for your feature or fix
2. **Make changes** following the code style of existing files
3. **Test** your changes:
   - `node -c <file>` for syntax validation
   - Start the server and verify endpoints
   - Check `logs/` for errors
4. **Submit a Pull Request** with a clear description

## Code Style

- Vanilla JavaScript (no TypeScript, no transpilation)
- No framework dependencies for frontend (zero-dependency SPA)
- CommonJS modules (`require`/`module.exports`)
- Consistent with existing code patterns

## Rule System (SSOT)

If you're adding or modifying rules:

1. Create/edit a rule file in `rules/` with proper frontmatter
2. Run `node scripts/build-rules.js` to compile rules into hooks
3. Verify the generated `.claude/settings.json` is valid

See [README.md](README.md#ssot-rule-system--mechanical-governance) for rule format details.

## Soul Files

Each agent has soul files in `workspace/<id>/soul/`. When modifying soul files:

- Core types: IDENTITY, SOUL, MISSION, TOOLS, CODE_PROTOCOL, PROMPT_PROFILE, SAFETY, AGENTS (optional: FAILURE_RECOVERY, first_prompt.txt)
- Keep files focused and concise
- Test with a real agent conversation

## Reporting Issues

- Use GitHub Issues
- Include steps to reproduce
- Include relevant log output
- Specify your Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
