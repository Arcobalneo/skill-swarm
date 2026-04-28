# Skill Swarm

> A production-ready agent backend service. Submit a natural-language query, and the backend handles the rest: intent routing → skill scheduling → agent execution → artifact packaging → downloadable ZIP.

[![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=flat&logo=docker&logoColor=white)](docker-compose.yml)
[![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=flat&logo=typescript&logoColor=white)](ts-backend)
[![Node.js](https://img.shields.io/badge/node.js-24.x-339933?style=flat&logo=nodedotjs&logoColor=white)](ts-backend/package.json)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What is this?

Skill Swarm is a backend service that turns natural-language requests into structured, downloadable artifacts through autonomous AI agents.

For the caller, the entire flow is three steps:

```
POST /api/v1/query            →  { taskId, status: "queued" }
GET  /api/v1/tasks/:taskId    →  { status, artifacts, ... }
GET  /api/v1/download/:taskId →  application/zip
```

Internally:

```
Receive query
    │
    ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ ① LLM Router    │ ──→ │ ② Agent Execute │ ──→ │ ③ Package & ZIP │
│   (Skill Match) │     │  (pi-agent-core)│     │  (30min expiry) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Features

- **Intent Routing** — LLM-based router automatically matches queries to the right skill
- **Autonomous Agents** — Powered by `@mariozechner/pi-agent-core` with reasoning, parallel tool execution, and event streaming
- **Non-streaming DeepSeek API** — Bypasses SSE stalls for stable production execution
- **Context Compaction** — Pi-mono inspired summarization to handle long conversations
- **Task Isolation** — Each task gets its own workspace directory
- **Artifact Packaging** — Auto-generated ZIP with 30-minute download links
- **Skill System** — Pluggable skill architecture; drop your own skills into `skills/`

## Tech Stack

| Layer | Technology |
|-------|------------|
| Web Framework | Hono + `@hono/node-server` |
| Agent Engine | `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai` |
| Primary LLM | DeepSeek V4 Flash (official API, `reasoning_effort=max`) |
| Vision Model | Gemini 3 Flash Preview (optional) |
| Image Gen | MiniMax CLI (`mmx-cli`) — optional, for vision-heavy skills |
| Database | SQLite (WAL mode) + filesystem workspaces |
| Testing | Vitest (end-to-end regression tests) |
| Deployment | Docker + Docker Compose |

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & [Docker Compose](https://docs.docker.com/compose/)
- API Keys:
  - **DeepSeek API Key** ([get one](https://platform.deepseek.com/))
  - **Gemini API Key** (optional, for vision tasks)

### 1. Clone & Configure

```bash
git clone https://github.com/YOUR_USERNAME/skill-swarm.git
cd skill-swarm

# Copy environment template
cp .env.example .env
# Edit .env and fill in your DEEPSEEK_API_KEY

# Copy subagent config template
cp config/subagents.json.example config/subagents.json
# Edit subagents.json to register your skills
```

### 2. Add Your Skills

Place your skill directories under `skills/`:

```
skills/
└── your-skill-name/
    ├── SKILL.md          # Skill workflow definition (YAML frontmatter + Markdown)
    ├── assets/           # CSS, JS, templates (optional)
    ├── references/       # Reference docs for the agent (optional)
    └── config/           # Skill-level config templates (optional)
```

Then update `config/subagents.json` to map skills to subagents.

**See [SKILL_SPEC.md](docs/SKILL_SPEC.md) for the full skill authoring guide.**

### 3. Start the Service

```bash
docker compose up -d --build
```

Wait for the health check:

```bash
curl http://localhost:8000/health
# → { "status": "ok", ... }
```

### 4. Submit a Task

```bash
curl -X POST http://localhost:8000/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"query": "Write a blog post about remote work productivity"}'
```

Response:
```json
{
  "task_id": "abc123_xyz",
  "status": "queued",
  "skill": "your-skill-name",
  "routing_confidence": "high"
}
```

Poll for completion:
```bash
curl http://localhost:8000/api/v1/tasks/abc123_xyz
```

Download artifacts:
```bash
curl -O "http://localhost:8000/api/v1/tasks/abc123_xyz/artifacts"
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check + basic stats |
| `POST` | `/api/v1/query` | Submit a natural-language task |
| `GET` | `/api/v1/tasks` | List tasks (paginated, filterable) |
| `GET` | `/api/v1/tasks/:task_id` | Get task status & artifacts |
| `GET` | `/api/v1/tasks/:task_id/events` | Execution event trace |
| `GET` | `/api/v1/tasks/:task_id/artifacts` | Get ZIP download link |
| `GET` | `/api/v1/download/:task_id?expires=<ts>` | Download artifact ZIP |

## Configuration

### Environment Variables

All configuration lives in a single `.env` file at the project root.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | **Yes** | — | DeepSeek API key |
| `GEMINI_API_KEY` | No | — | Gemini API key (vision tasks) |
| `PORT` | No | `8000` | Server port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `EXECUTION_MODEL_ID` | No | `deepseek-v4-flash` | Agent execution model |
| `EXECUTION_BASE_URL` | No | `https://api.deepseek.com` | DeepSeek API endpoint |
| `ROUTER_MODEL_ID` | No | `deepseek-v4-flash` | Skill routing model |
| `VISION_MODEL_ID` | No | `gemini-3-flash-preview` | Vision/caption model |
| `MAX_CONCURRENT_TASKS` | No | `10` | Max parallel tasks |
| `DEFAULT_TIMEOUT_MS` | No | `1800000` | Per-task timeout (30min) |

### Subagent Configuration

`config/subagents.json` maps skills to subagents and defines workflow stages:

```json
{
  "subagents": {
    "my-subagent": {
      "id": "my-subagent",
      "name": "My Subagent",
      "skills": ["my-skill"],
      "systemPromptModifier": "Optional prompt prefix...",
      "workflowStages": [
        { "id": "stage0", "name": "Setup", "required": true },
        { "id": "stage1", "name": "Generate", "required": true }
      ],
      "enforcementRules": [
        "All artifacts must be written to outputs/"
      ]
    }
  },
  "skillToSubagent": {
    "my-skill": "my-subagent"
  }
}
```

## Project Structure

```
skill-swarm/
├── .env                      # Runtime env vars (NOT in git)
├── .env.example              # Env template
├── docker-compose.yml        # Docker Compose config
├── README.md
├── config/
│   ├── subagents.json        # Runtime subagent config (NOT in git)
│   └── subagents.json.example # Config template
├── skills/                   # Your skills (NOT in git)
│   └── .gitkeep
└── ts-backend/               # Backend source code
    ├── Dockerfile
    ├── docker-compose.yml
    ├── src/
    │   ├── api/              # Hono routes & middleware
    │   ├── config/           # App config & model definitions
    │   ├── services/         # Executor, router, task manager, DB
    │   ├── tools/            # Universal tool definitions
    │   └── types/            # TypeScript type definitions
    └── package.json
```

## Development

```bash
cd ts-backend
npm install

# Development server with auto-reload
npm run dev

# Production build
npm run build
npm start

# Run regression tests (calls real APIs)
npm test
```

## Architecture Highlights

### Non-streaming DeepSeek API

To avoid SSE stream stalls, the executor uses direct `fetch()` with `stream: false` instead of OpenAI SDK streaming. This eliminates the connection-hang issues observed with DeepSeek V4 Flash's SSE endpoint.

### Selective `reasoning_content`

Per DeepSeek's API spec:
- **Tool-call turns**: MUST preserve `reasoning_content` in context
- **Non-tool-call turns**: `reasoning_content` is optional (stripped to save tokens)

### Context Compaction

Inspired by pi-mono's coding-agent:
- Token estimation via `chars/4` heuristic
- Trigger compaction at 750K tokens (75% of 1M context window)
- Summarize old messages via non-streaming LLM call
- Keep recent ~150K tokens raw

## License

MIT
