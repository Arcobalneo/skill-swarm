# Skill Swarm — MVP 设计文档

## 1. 产品定位

对外提供一套**稳定、可观测的 Agent 端点服务**。用户只需提交一段自然语言 `query`，后端自动完成：意图路由 → Skill 调度 → Agent 执行 → 产物打包 → 可下载链接返回。

> 对调用方而言，整个流程就是“提交任务 → 轮询状态 → 下载产物”三步。

---

## 2. 用户旅程（调用方视角）

```
1. POST /api/v1/tasks
   Body: { "query": "帮我搜索小红书关于露营的爆款笔记，并生成一张同款风格的图片" }
   → 返回: { "taskId": "a3f7b2...", "status": "pending" }

2. GET /api/v1/tasks/:taskId （轮询）
   → 返回: { "status": "running", "progress": "正在执行 bash: nexus xhs search..." }
   → 返回: { "status": "completed", "artifacts": [...] }

3. GET /api/v1/tasks/:taskId/artifacts
   → 返回: [{ "name": "output.zip", "downloadUrl": "/api/v1/download/:taskId?token=...&expires=..." }]

4. GET /api/v1/download/:taskId?token=...
   → 返回: application/zip 流（30 分钟有效期）
```

---

## 3. 内部执行流程（后端视角）

```
接收 query
  │
  ▼
┌─────────────────┐
│ ① 创建任务      │  ← 生成 taskId，创建工作区目录 tasks/{taskId}/
│    (TaskManager)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ② LLM 路由 Skill│  ← 一次 DeepSeek API 调用，将 query 映射到 skillName + parameters
│    (Router)     │     若用户显式指定 skill，则跳过此步
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ③ 调度 Agent    │  ← 为任务创建独立的 pi-agent-core Agent 实例
│    (Executor)   │     加载对应 SKILL.md 作为 system prompt
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ④ Agent 执行    │  ← Agent 在工作区内调用 universal tools（bash/read/write/edit）
│    (pi-agent)   │     所有文件/命令被限制在 tasks/{taskId}/ 沙箱内
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ⑤ 监控与日志    │  ← 订阅 Agent 事件流，实时写入 task.log 与 status.json
│    (TaskManager)│     支持外部轮询 GET /tasks/:id 获取最新进度
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ⑥ 产物打包      │  ← Agent 完成后，扫描 tasks/{taskId}/outputs/ 目录
│    (Artifacts)  │     打包为 ZIP，生成一次性下载 token（30min 过期）
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ ⑦ 任务完成      │  ← status = "completed"，artifacts 列表返回给轮询方
│    (TaskManager)│
└─────────────────┘
```

---

## 4. API 规范

### 4.1 创建任务

```http
POST /api/v1/tasks
Content-Type: application/json

{
  "query": "string, required",
  "skill": "string, optional — 显式指定要执行的 skill"
}
```

**响应 201**
```json
{
  "taskId": "a3f7b2e9d1c4",
  "status": "pending",
  "skillName": "xhs-note-replicator",
  "createdAt": "2026-04-27T14:30:00Z"
}
```

### 4.2 查询任务状态

```http
GET /api/v1/tasks/:taskId
```

**响应 200（运行中）**
```json
{
  "taskId": "a3f7b2e9d1c4",
  "status": "running",
  "skillName": "xhs-note-replicator",
  "progress": "执行工具: bash (nexus xhs search 露营)",
  "startedAt": "2026-04-27T14:30:01Z",
  "updatedAt": "2026-04-27T14:30:15Z"
}
```

**响应 200（已完成）**
```json
{
  "taskId": "a3f7b2e9d1c4",
  "status": "completed",
  "skillName": "xhs-note-replicator",
  "artifacts": [
    { "name": "note.md", "path": "outputs/note.md", "size": 2048 },
    { "name": "cover.png", "path": "outputs/cover.png", "size": 524288 }
  ],
  "completedAt": "2026-04-27T14:32:00Z"
}
```

### 4.3 获取产物下载链接

```http
GET /api/v1/tasks/:taskId/artifacts
```

**响应 200**
```json
{
  "taskId": "a3f7b2e9d1c4",
  "artifacts": [
    {
      "name": "outputs.zip",
      "downloadUrl": "/api/v1/download/a3f7b2e9d1c4?token=abc123&expires=1714230000"
    }
  ]
}
```

### 4.4 下载产物

```http
GET /api/v1/download/:taskId?token=<jwt>&expires=<unix_ts>
```

- `token`：JWT 风格的一次性下载凭证，仅对该 taskId 有效
- `expires`：Unix 时间戳，默认创建后 30 分钟过期
- 过期或 token 无效返回 `410 Gone`

---

## 5. 工作区与产物约定

每个任务拥有独立工作区：

```
tasks/{taskId}/
├── request.json          # 原始 query 与创建时间
├── status.json           # 当前状态（实时更新）
├── task.log              # Agent 执行日志流
├── outputs/              # 产物目录（Agent 约定写入此处）
│   ├── note.md
│   ├── cover.png
│   └── ...
└── manifest.json         # 任务完成后生成的元数据清单
```

**产物打包规则**
- 任务完成后，自动将 `outputs/` 目录打包为 `outputs.zip`
- 若 `outputs/` 为空，返回 `artifacts: []` 与提示信息
- 打包失败视为任务 `failed`

---

## 6. 任务状态机

```
        ┌─────────┐
        │  created│  ← createTask() 初始化
        └────┬────┘
             │ routeSkill() 完成
             ▼
        ┌─────────┐
        │ pending │  ← 等待 Agent 调度
        └────┬────┘
             │ runAgentForTask() 开始执行
             ▼
        ┌─────────┐
        │ running │  ← Agent 执行中，可被轮询
        └────┬────┘
             │
     ┌───────┴───────┐
     ▼               ▼
┌─────────┐    ┌─────────┐
│completed│    │  failed │  ← Agent 异常或打包失败
└─────────┘    └─────────┘
```

---

## 7. Skill 路由机制

1. **显式指定**：用户传 `skill` 字段，直接命中，parameters = `{ query }`
2. **LLM 自动路由**：调用 DeepSeek V4 Pro，prompt 模板包含：
   - 当前所有可用 skill 列表（从 `skills/*/SKILL.md` 的 YAML frontmatter 读取）
   - 用户 query
   - 要求返回 JSON：`{ "skillName": "...", "parameters": { ... } }`

路由失败（LLM 返回非法 JSON 或匹配不到 skill）时，任务状态置为 `failed`。

---

## 8. Agent 执行模型

- **一任务一 Agent**：pi-agent-core 的 `Agent` 不支持并发 `prompt()`，每个任务独立实例
- **工具集**：4 个 universal tools（`bash`, `read_file`, `write_file`, `edit_file`）
- **沙箱**：所有文件/命令被限制在 `tasks/{taskId}/` 目录内，禁止路径穿越
- **技能加载**：将对应 `SKILL.md` 的内容注入为 system prompt，并替换模板变量：
  - `$TASK_ID` → taskId
  - `$WORKSPACE` → 绝对工作区路径
  - `$QUERY` → 用户原始 query

---

## 9. 监控与可观测性

- **日志流**：通过订阅 Agent 的 `tool_start`, `tool_end`, `agent_end` 等事件，实时追加到 `task.log`
- **进度暴露**：`status.json` 的 `progress` 字段记录当前正在执行的工具/步骤
- **错误追踪**：Agent 异常或 tool 失败时，将错误栈写入 `status.json` 的 `error` 字段

---

## 10. 技术栈

| 层级 | 技术 |
|------|------|
| HTTP 服务 | Hono + `@hono/node-server` |
| 验证 | Zod |
| Agent 框架 | `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai` |
| 路由 LLM | DeepSeek V4 Pro (openai-completions) |
| 视觉 LLM | Gemini 3 Flash Preview (openai-completions) |
| 外部 CLI | `nexus` (图片生成 / 小红书搜索) |
| 产物打包 | `archiver` (ZIP) |
| 语言 | TypeScript (ESM) |

---

## 11. 非功能性要求（MVP 阶段）

- **并发**：Node.js 单进程，任务间无共享状态，可水平扩展（多个进程实例 + 负载均衡）
- **持久化**：纯文件系统，无数据库依赖
- **安全**：命令/文件操作严格沙箱化；下载 token 带过期时间
- **测试**：使用真实 API 进行端到端测试（DeepSeek / Gemini / nexus），不 Mock
