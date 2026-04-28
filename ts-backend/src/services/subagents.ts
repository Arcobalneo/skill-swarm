import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CONFIG_DIR } from '@/config/index.js';
import { logger } from '@/lib/logger.js';

export interface WorkflowStage {
  id: string;
  name: string;
  required: boolean;
  condition?: string;
}

export interface SubagentConfig {
  id: string;
  name: string;
  description: string;
  skills: string[];
  systemPromptModifier: string;
  workflowStages: WorkflowStage[];
  enforcementRules: string[];
}

export interface SubagentsRoot {
  subagents: Record<string, SubagentConfig>;
  skillToSubagent: Record<string, string>;
}

const CONFIG_PATH = path.join(CONFIG_DIR, 'subagents.json');

let cachedConfig: SubagentsRoot | null = null;

export async function loadSubagentConfig(): Promise<SubagentsRoot> {
  if (cachedConfig) return cachedConfig;
  const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as SubagentsRoot;
  cachedConfig = parsed;
  logger.info('Loaded subagent config', {
    subagents: Object.keys(parsed.subagents),
    skillMap: parsed.skillToSubagent,
  });
  return parsed;
}

export async function resolveSubagent(skillName: string): Promise<SubagentConfig | null> {
  const config = await loadSubagentConfig();
  const subagentId = config.skillToSubagent[skillName];
  if (!subagentId) return null;
  return config.subagents[subagentId] ?? null;
}
