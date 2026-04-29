import type { SubagentConfig, SkillInfo } from '@/types/index.js';
import { EXECUTION_CONFIG } from '@/config/index.js';

export function buildSystemPrompt(
  loadedSkills: { info: SkillInfo; content: string; dir: string }[],
  primarySkill: { info: SkillInfo; content: string; dir: string },
  workspaceDir: string,
  subagent?: SubagentConfig,
  productConfig?: Record<string, unknown>,
): string {
  const productJson = productConfig ? JSON.stringify(productConfig, null, 2) : '（未提供）';

  const skillBlocks = loadedSkills.map((s) => {
    const isPrimary = s.info.name === primarySkill.info.name;
    const marker = isPrimary ? '【主导 Skill】' : '【辅助 Skill】';
    return [
      `--- ${marker} ${s.info.name} v${s.info.version} ---`,
      s.content,
      `--- 结束 ${s.info.name} ---`,
    ].join('\n');
  });

  const enforcementLines = subagent
    ? subagent.enforcementRules.map((r, i) => `${i + 1}. ${r}`)
    : buildEnforcementRules().map((r, i) => `${i + 1}. ${r}`);

  const workflowLines = subagent
    ? subagent.workflowStages.map(
        (s) =>
          `- ${s.id}: ${s.name}${s.required ? ' （必须）' : ''}${s.condition ? ` — 条件：${s.condition}` : ''}`,
      )
    : [];

  const parts = [
    subagent?.systemPromptModifier ??
      '你是一个自主执行 Skill 的 Agent。你拥有以下通用工具：bash（执行 shell 命令）、read_file（读取文件）、write_file（写入文件）、edit_file（编辑文件）。',
    '',
    '## 绝对强制规则（必须遵守）',
    ...enforcementLines,
    '',
    '## 工作区规则',
    `- 工作区目录：${workspaceDir}`,
    '- 所有文件路径均相对于工作区。产物目录统一使用 outputs/。',
    '- Skill 文件已复制到工作区内的 `skills/` 目录，可直接用 read_file 读取。',
    '- 环境变量 TASK_ID 已自动设置。',
    '- 完成后在工作区根目录写入 manifest.json，列出所有产物。',
    '',
  ];

  if (workflowLines.length > 0) {
    parts.push('## 工作流程阶段', ...workflowLines, '');
  }

  parts.push(
    '## 产品配置',
    productJson,
    '',
    '## Skill 执行指令（按优先级排序）',
    ...skillBlocks,
    '',
    '## 执行策略',
    `当前主导 Skill 是：${primarySkill.info.name}。优先执行该 Skill 的工作流程。`,
    loadedSkills.length > 1
      ? `辅助 Skill（${loadedSkills
          .filter((s) => s.info.name !== primarySkill.info.name)
          .map((s) => s.info.name)
          .join(', ')}）可在需要时调用。`
      : '',
  );

  return parts.join('\n');
}

function buildEnforcementRules(): string[] {
  const maxLines = EXECUTION_CONFIG.writeFileMaxLines;
  const maxChars = EXECUTION_CONFIG.writeFileMaxChars;
  return [
    '**所有最终产物必须写入 outputs/ 目录**。禁止仅在对话中回复内容——用户看不到你的对话，只能下载文件。',
    '如果任务是生成文案、笔记、分析等文字内容，必须写入 `outputs/*.md`。',
    '如果任务是生成图片，必须保存到 `outputs/*.png`。',
    '如果任务是生成 HTML slides / deck，必须保存到 `outputs/*.html`。',
    '任务结束前必须确认 `outputs/` 目录非空。如果为空，立即将结果写入文件。',
    '**文件读取限制**：单次 turn 最多读取 3-5 个关键文件。不要遍历读取整个 assets/ 或 templates/ 目录的所有文件。',
    '**优先引用而非内联**：如果 skill 的 assets 包含大量 CSS/JS，优先通过 CDN 链接或 `<script src="...">` 引用，不要把整个库的内容内联到 HTML 中。',
    '**强制分块写入（关键规则）**：',
    `  ⚠️ 单次 write_file 调用最多写入 ${maxLines} 行或 ${maxChars} 字符。绝对禁止在一次 write_file 中写入超过 ${maxLines} 行的文件。`,
    `  ⚠️ 如果目标文件预计超过 ${maxLines} 行，必须：先 write_file 写入前 ${maxLines} 行（文件骨架+核心结构），再用 edit_file 追加后续内容，每次追加不超过 200 行。`,
    '  ⚠️ 多页 HTML deck（3 页以上）必须拆分为多次写入：第 1 次只写封面+第 1 页（≤200行），后续每次追加 1~2 页。',
    '  ⚠️ 违反此规则会导致 API 响应被截断（JSON 解析失败），任务将直接失败。宁可多写几次，不要一次写太多。',
  ];
}
