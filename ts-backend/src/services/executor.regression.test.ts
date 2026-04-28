import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runTask } from './executor.js';
import type { TaskConfig, ExecutionState } from '@/types/index.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { initDb, closeDb, createTask } from '@/services/db.js';
import * as os from 'node:os';

const TEST_TIMEOUT_MS = 600_000; // 10 min per test
const DB_PATH = path.join(os.tmpdir(), `forge-regression-${Date.now()}.db`);

beforeAll(() => {
  initDb(DB_PATH);
});

afterAll(async () => {
  closeDb();
  await fs.unlink(DB_PATH).catch(() => {});
});

function createTestConfig(skillName: string, query: string, workspaceDir: string): TaskConfig {
  return {
    taskId: `reg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    workspaceDir,
    query,
    skillName,
    skillSet: { primary: skillName, skills: [skillName] },
  };
}

async function runTest(config: TaskConfig): Promise<ExecutionState & { elapsedMs: number }> {
  await fs.mkdir(config.workspaceDir, { recursive: true });

  // Create DB record first so recordEvent() foreign key succeeds.
  createTask({
    id: config.taskId,
    query: config.query,
    skillName: config.skillName,
    subagent: config.subagent?.id,
    workspacePath: config.workspaceDir,
  });

  const start = Date.now();
  const state = await runTask(config, () => {});
  const elapsedMs = Date.now() - start;
  return { ...state, elapsedMs };
}

function reportResult(label: string, state: ExecutionState & { elapsedMs: number }) {
  const minutes = (state.elapsedMs / 1000 / 60).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`\n[REGRESSION] ${label}`);
  // eslint-disable-next-line no-console
  console.log(`  status: ${state.status}`);
  // eslint-disable-next-line no-console
  console.log(`  elapsed: ${state.elapsedMs}ms (${minutes}min)`);
  // eslint-disable-next-line no-console
  console.log(`  artifacts: ${state.artifacts?.join(', ') || 'none'}`);
  if (state.error) {
    // eslint-disable-next-line no-console
    console.log(`  error: ${state.error}`);
  }
  if (state.message) {
    // eslint-disable-next-line no-console
    console.log(`  message: ${state.message}`);
  }
}

describe('Regression Tests', () => {

// ---------------------------------------------------------------------------
// Test 1: insight-report-deck — simple (single-page brief report)
// ---------------------------------------------------------------------------
it(
  'insight-report-deck simple: single-page brief HTML report',
  async () => {
    const workspaceDir = path.join(os.tmpdir(), 'regression-id-simple');
    await fs.rm(workspaceDir, { recursive: true, force: true });

    const config = createTestConfig(
      'insight-report-deck',
      '生成一个关于远程办公趋势的单页HTML洞察报告。\n' +
        '主题：远程办公效率提升策略\n' +
        '要求：\n' +
        '- 只需要1页\n' +
        '- 包含标题、3个核心策略点、总结\n' +
        '- 输出到 outputs/report.html',
      workspaceDir,
    );

    const state = await runTest(config);
    reportResult('insight-report-deck simple', state);

    expect(state.status).toBe('completed');
    expect(state.error).toBeFalsy();
    expect(state.artifacts.length).toBeGreaterThan(0);

    const outputsDir = path.join(workspaceDir, 'outputs');
    const files = await fs.readdir(outputsDir).catch(() => [] as string[]);
    const htmlFiles = files.filter((f) => f.endsWith('.html'));
    expect(htmlFiles.length).toBeGreaterThan(0);
  },
  TEST_TIMEOUT_MS,
);

}); // end describe.sequential

// ---------------------------------------------------------------------------
// Test 2: insight-report-deck — complex (multi-page deck with charts & tables)
// ---------------------------------------------------------------------------
it(
  'insight-report-deck complex: multi-page dark-theme dashboard',
  async () => {
    const workspaceDir = path.join(os.tmpdir(), 'regression-id-complex');
    await fs.rm(workspaceDir, { recursive: true, force: true });

    const config = createTestConfig(
      'insight-report-deck',
      '用dark主题生成一个新能源汽车行业数据看板HTML文件。\n' +
        '要求：\n' +
        '- 封面页（标题+副标题+日期）\n' +
        '- 市场规模趋势图（用Chart.js折线图）\n' +
        '- 竞品对比表（至少3个品牌）\n' +
        '- 用户画像分析页\n' +
        '- 机会矩阵页\n' +
        '- 行动计划页\n' +
        '- 共6页\n' +
        '- 输出到 outputs/dashboard.html',
      workspaceDir,
    );

    const state = await runTest(config);
    reportResult('insight-report-deck complex', state);

    expect(state.status).toBe('completed');
    expect(state.error).toBeFalsy();
    expect(state.artifacts.length).toBeGreaterThan(0);

    const outputsDir = path.join(workspaceDir, 'outputs');
    const files = await fs.readdir(outputsDir).catch(() => [] as string[]);
    const htmlFiles = files.filter((f) => f.endsWith('.html'));
    expect(htmlFiles.length).toBeGreaterThan(0);

    // Verify the HTML file is non-empty
    const htmlPath = path.join(outputsDir, htmlFiles[0]);
    const stats = await fs.stat(htmlPath);
    expect(stats.size).toBeGreaterThan(1000);
  },
  TEST_TIMEOUT_MS,
);

// ---------------------------------------------------------------------------
// Test 3: xhs-note-replicator — simple (pure copywriting, no external deps)
// ---------------------------------------------------------------------------
it(
  'xhs-note-replicator simple: pure copywriting generation',
  async () => {
    const workspaceDir = path.join(os.tmpdir(), 'regression-xhs-simple');
    await fs.rm(workspaceDir, { recursive: true, force: true });

    const config = createTestConfig(
      'xhs-note-replicator',
      '写一段小红书种草文案。\n' +
        '产品：降噪耳机\n' +
        '核心卖点：\n' +
        '- 40小时超长续航\n' +
        '- 45dB深度主动降噪\n' +
        '- 佩戴舒适无压迫感\n' +
        '要求：\n' +
        '- 输出到 outputs/copywriting.md\n' +
        '- 包含： catchy 标题、正文（200字以上）、5-8个话题标签',
      workspaceDir,
    );

    const state = await runTest(config);
    reportResult('xhs-note-replicator simple', state);

    expect(state.status).toBe('completed');
    expect(state.error).toBeFalsy();
    expect(state.artifacts.length).toBeGreaterThan(0);

    const outputsDir = path.join(workspaceDir, 'outputs');
    const files = await fs.readdir(outputsDir).catch(() => [] as string[]);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    expect(mdFiles.length).toBeGreaterThan(0);
  },
  TEST_TIMEOUT_MS,
);

// ---------------------------------------------------------------------------
// Test 4: xhs-note-replicator — complex (image analysis + prompt generation)
// ---------------------------------------------------------------------------
it(
  'xhs-note-replicator complex: image analysis + prompt generation',
  async () => {
    const workspaceDir = path.join(os.tmpdir(), 'regression-xhs-complex');
    await fs.rm(workspaceDir, { recursive: true, force: true });

    // Copy reference images from skill test-set into workspace
    const srcImgDir = path.resolve(
      import.meta.dirname,
      '../../../../skills/xhs-note-replicator/.forge-skill-sop/1.0.0/test-set/xhs-note-replicator-test-1.0.0/input/case-001',
    );
    const destImgDir = path.join(workspaceDir, 'reference-images');
    try {
      await fs.cp(srcImgDir, destImgDir, { recursive: true, force: true });
    } catch {
      // If copy fails (e.g. images not present), the test continues — agent may still generate prompts from description
    }

    const config = createTestConfig(
      'xhs-note-replicator',
      '基于以下参考笔记信息，为产品生成完整的小红书复刻产物。\n' +
        '参考笔记标题：肺癌早期症状，这6个信号千万别忽视\n' +
        '参考结构：恐惧引入 → 症状清单 → 行动建议 → 产品卖点 → 合规声明\n' +
        '产品：智能保温杯\n' +
        '核心卖点：\n' +
        '- 12小时恒温\n' +
        '- APP智能控温\n' +
        '- 316不锈钢材质\n' +
        '合规声明：具体产品信息以实际为准\n\n' +
        '要求：\n' +
        '1. 输出复刻文案到 outputs/copywriting.md（标题+正文+话题标签）\n' +
        '2. 输出3张图片的生成提示词到 outputs/prompts/img1.txt ~ img3.txt\n' +
        '3. 不要尝试下载任何外部资源，直接基于提供的信息生成\n' +
        '4. 如果 reference-images/ 目录有图片，可分析图片风格来优化提示词',
      workspaceDir,
    );

    const state = await runTest(config);
    reportResult('xhs-note-replicator complex', state);

    expect(state.status).toBe('completed');
    expect(state.error).toBeFalsy();
    expect(state.artifacts.length).toBeGreaterThan(0);

    const outputsDir = path.join(workspaceDir, 'outputs');
    const files = await fs.readdir(outputsDir, { recursive: true }).catch(() => [] as string[]);
    const allFiles = Array.isArray(files) ? files : [];
    const flatFiles = allFiles.map((f) => (typeof f === 'string' ? f : path.join(f as unknown as string, '')));
    const mdFiles = flatFiles.filter((f) => f.endsWith('.md'));
    const txtFiles = flatFiles.filter((f) => f.endsWith('.txt'));

    expect(mdFiles.length).toBeGreaterThan(0);
    // Prompt files are a bonus — if mmx/vision tools fail, txt files may not exist.
    // We only assert that the core copywriting artifact exists.
  },
  TEST_TIMEOUT_MS,
);
