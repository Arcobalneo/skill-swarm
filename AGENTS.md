# forge-skill-swarm

A pure TypeScript AI agent execution platform. It runs autonomous "skills" — structured agent workflows defined in Markdown — with a primary focus on replicating and generating Xiaohongshu (小红书) social-media notes.

Documentation and skill definitions are written primarily in **Chinese**.

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| TypeScript executor | Node.js, Hono, TypeScript 5.8 |
| Agent framework | `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai` |
| AI models | DeepSeek V4 Pro, Gemini 3 Flash Preview |
| External CLIs | `nexus` (image generation / multimodal understanding), `curl` |
| Package manager (Node) | npm |
| Testing | Vitest |
| Linting | ESLint + Prettier |

---

## Project Structure

```
forge-skill-swarm/
├── AGENTS.md                   # This file
├── docs/
│   └── mvp-design.md           # MVP product design (Chinese)
├── ts-backend/                 # TypeScript Hono backend
│   ├── package.json
│   ├── tsconfig.json           # strict, ES2022, NodeNext, path aliases (@/)
│   ├── vitest.config.ts
│   ├── eslint.config.js
│   ├── .prettierrc
│   └── src/
│       ├── index.ts            # Server bootstrap (port 8000)
│       ├── types/
│       │   └── index.ts        # Shared types (SkillInfo, ExecutionState, TaskConfig)
│       ├── config/
│       │   └── index.ts        # Environment, API keys, model & execution config
│       ├── lib/
│       │   └── logger.ts       # Structured console logger
│       ├── services/
│       │   ├── models.ts       # DeepSeek & Gemini model definitions
│       │   ├── router.ts       # LLM-based skill routing (DeepSeek)
│       │   ├── skills.ts       # Skill discovery & loading from ../skills
│       │   ├── executor.ts     # Agent execution loop with pi-agent-core
│       │   └── task-manager.ts # Task queue, status persistence, ZIP packaging
│       ├── api/
│       │   ├── index.ts        # Hono routes: /health, /query, /tasks, /download
│       │   └── middleware/
│       │       ├── error.ts    # Global error handler
│       │       └── validate.ts # Request body validation
│       ├── tools/
│       │   └── universal.ts    # bash, read_file, write_file, edit_file
│       └── **/*.test.ts        # Vitest unit tests
├── skills/                     # Skill definitions
│   └── xhs-note-replicator/
│       ├── SKILL.md            # Full skill spec with YAML frontmatter
│       ├── config/
│       │   └── product.example.json
│       └── .forge-skill-sop/   # Versioned SOP docs, test sets, debug notes
└── tasks/                      # Runtime task workspaces (gitignored)
```

---

## Build & Run Commands

```bash
cd ts-backend

# Development (hot reload via tsx)
npm run dev

# Build (tsc + tsc-alias for path resolution)
npm run build

# Production
npm run start

# Lint & Format
npm run lint
npm run format

# Testing
npm run test
npm run test:watch
```

The backend listens on `PORT` (default **8000**).

---

## How Skills Work

Skills are self-contained Markdown files located at `skills/<name>/SKILL.md`. Each file must begin with YAML frontmatter:

```yaml
---
name: xhs-note-replicator
description: "..."
version: 1.0.0
---
```

The backend parses the frontmatter directly, loads the skill content into the agent system prompt, and executes the task using `pi-agent-core` with universal tools (bash, read_file, write_file, edit_file).

Each task produces:
- `request.json` — original user query & config
- `manifest.json` — final status, artifacts list, message
- `outputs/` — deliverables (images, markdown, prompts, etc.)
- `agent.log` — execution trace

---

## Code Style Guidelines

- **TypeScript**: Strict mode enabled; uses ES2022 / NodeNext module resolution; async/await throughout.
- **Path aliases**: Use `@/` for all internal imports (e.g., `@/services/router.js`, `@/lib/logger.js`).
- **File paths**: Prefer `node:path` and `node:fs/promises`.
- **Error handling**: Fall back gracefully (e.g. regex extraction when JSON parsing fails). Catch exceptions and map to HTTP 4xx/5xx responses.
- **Formatting**: Prettier (2-space tabs, single quotes, trailing commas).

---

## Testing Instructions

### Automated Tests

Run the Vitest suite:

```bash
cd ts-backend
npm run test
```

Tests are located alongside source files (`src/**/*.test.ts`). The existing suite covers:
- `GET /health` endpoint
- `POST /api/v1/query` validation and task creation
- `GET /api/v1/tasks/:id` 404 handling

### End-to-End Testing with Real APIs

When testing agent features, **use real APIs directly** — the project has unlimited LLM budget for testing.

```bash
cd ts-backend
npm run dev

# Create a task
curl -X POST http://localhost:8000/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"query": "帮我搜索小红书关于露营的爆款笔记"}'

# Poll status
curl http://localhost:8000/api/v1/tasks/{task_id}

# Get artifacts (download link)
curl http://localhost:8000/api/v1/tasks/{task_id}/artifacts

# Download results
curl "http://localhost:8000/api/v1/download/{task_id}?expires={ts}" -o result.zip
```

---

## Security Considerations

- **API keys are hardcoded in source files**. `ts-backend/src/config/index.ts` contains plaintext API keys (`DEEPSEEK_API_KEY`, `GEMINI_API_KEY`). Rotate these immediately if the repository is shared.
- The `bash` universal tool in `ts-backend/src/tools/universal.ts` executes arbitrary shell commands in the task workspace. It respects `timeout` but does not implement a sandbox or allowlist.
- Path traversal is mitigated in `createUniversalTools` via `resolveWorkspacePath`, which blocks paths escaping the workspace directory.
- The agent can run external network requests via `curl` and `nexus` CLI commands.
- Do not expose the backend to the public internet without authentication and input validation hardening.

---

## Key Runtime Dependencies

- `nexus` CLI must be on `PATH` (image generation & multimodal understanding).
- `curl` must support `-s`, `-o`, `-L`, `-H`.
- Network access to `www.xiaohongshu.com` and `sns-webpic-qc.xhscdn.com` is expected for the replicator skill.

---

## Notes for Agents

- When modifying the **TS backend**, rebuild with `npm run build` and restart the server.
- The `skills/` directory is read at runtime. Changes to a `SKILL.md` take effect immediately (no build step required for skill content).
- Task workspaces under `tasks/` contain ephemeral data; do not commit them.
- Use `npm run lint` and `npm run format` before committing code changes.
