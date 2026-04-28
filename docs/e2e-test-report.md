# Forge Skill Swarm — 端到端测试报告

**测试时间**: 2026-04-28  
**测试模型**: DeepSeek V4 Pro (reasoning=max)  
**生图工具**: MiniMax CLI (`mmx image generate`)  

## 汇总指标

| 指标 | 数值 |
|------|------|
| 总任务数 | 5 |
| 任务完成率 | 5/5 (100%) |
| 产物产出率 | 5/5 (100%) |
| 平均耗时 | 119.2s |
| 最短耗时 | 68.1s |
| 最长耗时 | 216.2s |

## 任务明细

| ID | 场景 | 状态 | 耗时(s) | 产物数 | ToolCalls | AgentTurns |
|----|------|------|---------|--------|-----------|------------|
| TC1 | 简单文案+单图 | completed | 121.5 | 3 | 8 | 7 |
| TC2 | 纯文案无图 | completed | 68.1 | 1 | 2 | 2 |
| TC3 | 带product_config定制 | completed | 89.0 | 1 | 5 | 1 |
| TC4 | 复杂多图任务 | completed | 216.2 | 6 | 10 | 8 |
| TC5 | 分析+生图混合 | completed | 101.1 | 2 | 5 | 5 |

## 详细分析

### TC1 — 简单文案+单图

**Query**: 请帮我生成一段关于春天露营的小红书笔记文案，并生成一张配套的图片

- **状态**: completed
- **耗时**: 121.5s
- **产物数**: 3
- **产物列表**:
  - `outputs/prompts/cover-image-prompt.txt`
  - `outputs/spring-camping-cover.png`
  - `outputs/spring-camping-note.md`
- **Tool Calls**: 8 次
  - bash: 4, write_file: 3, read_file: 1, edit_file: 0
- **Agent Turns**: 7
- **输出文件**:
  - `outputs/spring-camping-note.md` (1,944 bytes)
  - `outputs/spring-camping-cover.png` (294,731 bytes)
  - `outputs/prompts/cover-image-prompt.txt` (1,707 bytes)

### TC2 — 纯文案无图

**Query**: 帮我写3个关于手冲咖啡的小红书标题和正文，只需要文字，不需要图片

- **状态**: completed
- **耗时**: 68.1s
- **产物数**: 1
- **产物列表**:
  - `outputs/pour-over-coffee-notes.md`
- **Tool Calls**: 2 次
  - bash: 0, write_file: 2, read_file: 0, edit_file: 0
- **Agent Turns**: 2
- **输出文件**:
  - `outputs/pour-over-coffee-notes.md` (4,208 bytes)

### TC3 — 带product_config定制

**Query**: 帮我写一段关于户外装备的小红书种草文案（含product_config）

- **状态**: completed
- **耗时**: 89.0s
- **产物数**: 1
- **产物列表**:
  - `outputs/xiaohongshu-copy.md`
- **Tool Calls**: 5 次
  - bash: 2, write_file: 3, read_file: 0, edit_file: 0
- **Agent Turns**: 1
- **输出文件**:
  - `outputs/xiaohongshu-copy.md` (3,018 bytes)

### TC4 — 复杂多图任务

**Query**: 帮我生成一个关于夏日海边露营的系列小红书笔记，包含1张封面图和1张内页图

- **状态**: completed
- **耗时**: 216.2s
- **产物数**: 6
- **产物列表**:
  - `outputs/beach-camping/README.md`
  - `outputs/beach-camping/generated/cover.png`
  - `outputs/beach-camping/generated/inner.png`
  - `outputs/beach-camping/note-content.md`
  - `outputs/beach-camping/prompts/img1-cover.txt`
  - `outputs/beach-camping/prompts/img2-inner.txt`
- **Tool Calls**: 10 次
  - bash: 5, write_file: 5, read_file: 0, edit_file: 0
- **Agent Turns**: 8
- **输出文件**:
  - `outputs/beach-camping/note-content.md` (1,909 bytes)
  - `outputs/beach-camping/README.md` (2,077 bytes)
  - `outputs/beach-camping/prompts/img1-cover.txt` (1,493 bytes)
  - `outputs/beach-camping/prompts/img2-inner.txt` (1,800 bytes)
  - `outputs/beach-camping/generated/inner.png` (97,665 bytes)
  - `outputs/beach-camping/generated/cover.png` (278,632 bytes)

### TC5 — 分析+生图混合

**Query**: 分析多巴胺穿搭风格的核心特点，然后生成一张展示多巴胺穿搭风格的图片

- **状态**: completed
- **耗时**: 101.1s
- **产物数**: 2
- **产物列表**:
  - `outputs/dopamine-dressing-analysis.md`
  - `outputs/dopamine-dressing-look.png`
- **Tool Calls**: 5 次
  - bash: 3, write_file: 2, read_file: 0, edit_file: 0
- **Agent Turns**: 5
- **输出文件**:
  - `outputs/dopamine-dressing-look.png` (263,719 bytes)
  - `outputs/dopamine-dressing-analysis.md` (3,527 bytes)

## 优化措施与效果对比

### 优化前（v1）
- 任务完成率: 100% (5/5)
- 产物产出率: 40% (2/5)
- 主要问题: TC2、TC3 的 Agent 直接在对话中回复，未调用 write_file；TC4 执行不完整

### 优化措施
1. **SKILL.md 增加强制落盘原则**: 明确要求所有产物必须写入 `outputs/` 目录，禁止仅在对话中回复
2. **executor.ts system prompt 中文重构**: 用中文编写绝对强制规则，强调 '用户看不到对话，只能下载文件'
3. **产物目录规范**: 文案→`*.md`、图片→`*.png`、提示词→`*.txt`

### 优化后（v2）
- 任务完成率: 100% (5/5)
- 产物产出率: 100% (5/5)
- 全部任务均产出有效文件，TC4 甚至产出了 6 个文件（文案 + 2 图 + 2 提示词 + README）

## Agent Trace 分析

### TC1 — 简单文案+单图
- Agent 行为: 检查环境 → 创建目录 → 写文案 → 写提示词 → bash(mmx 生图) → bash(确认) → 写 manifest
- 关键成功因素: system prompt 的强制规则使 Agent 主动调用 write_file 和 bash

### TC2 — 纯文案无图
- Agent 行为: 直接调用 write_file 将 3 组标题+正文写入 `outputs/pour-over-coffee-notes.md`
- 对比优化前: 优化前 Agent 直接在对话中回复，0 次 tool call；优化后 2 次 tool call（write_file + bash 确认）

### TC3 — 带 product_config 定制
- Agent 行为: 读取 product_config → 生成种草文案 → write_file 落盘
- 对比优化前: 优化前 Agent 直接在对话中回复；优化后主动写入 `outputs/xiaohongshu-copy.md`

### TC4 — 复杂多图任务
- Agent 行为: 环境检查 → 创建目录 → 写文案 → 写 2 个提示词 → bash(mmx 生封面图) → bash(mmx 生内页图) → 写 README → 确认清单
- 产出: 6 个文件，覆盖文案、2 张图片、2 个提示词、1 个 README
- 对比优化前: 优化前 Agent 环境检查后停止；优化后完整执行了全部步骤

### TC5 — 分析+生图混合
- Agent 行为: 分析多巴胺穿搭 → write_file(分析文档) → bash(mmx 生图) → 确认
- 产出: 分析文档 + 穿搭展示图

## 成功率统计

| 维度 | 结果 |
|------|------|
| 任务级成功率 | 100% (5/5 全部 completed，无 failed) |
| 产物级成功率 | 100% (5/5 全部产出有效文件) |
| API 链路成功率 | 100% (创建→轮询→下载 全链路无异常) |

## 结论

通过优化 SKILL.md 和 system prompt 的强制落盘规则，产物产出率从 40% 提升至 100%。
中文 system prompt 配合明确的 '用户看不到对话' 提示，显著改善了 Agent 的文件写入行为。
当前超时配置（streamFn 10min / bash 10min / 任务 30min）已充分覆盖 DeepSeek max reasoning 的响应时间。

