import 'dotenv/config';
import * as path from 'node:path';

// --- Server ---
export const PORT = Number(process.env.PORT || 8000);
export const HOST = process.env.HOST || '0.0.0.0';

// --- Data directories ---
export const DATA_DIR = process.env.DATA_DIR || path.resolve(import.meta.dirname, '../../data');
export const DATABASE_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'db', 'tasks.db');
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(DATA_DIR, 'tasks');
export const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(import.meta.dirname, '../../../config');
export const SKILLS_DIR = process.env.SKILLS_DIR || path.resolve(import.meta.dirname, '../../../skills');

// --- API Keys (required, no fallbacks) ---
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[FATAL] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export const API_KEYS = {
  deepseek: requireEnv('DEEPSEEK_API_KEY'),
  gemini: process.env.GEMINI_API_KEY || '',
};

// --- Model Config (all overridable via env) ---
export interface ModelConfigEntry {
  id: string;
  name: string;
  baseUrl: string;
  provider: 'deepseek' | 'gemini';
  api: 'openai-completions';
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  thinkingFormat?: 'deepseek' | 'openai';
}

function envModel(
  prefix: string,
  defaults: Partial<ModelConfigEntry> & Pick<ModelConfigEntry, 'id' | 'name' | 'baseUrl'>,
): ModelConfigEntry {
  return {
    id: process.env[`${prefix}_MODEL_ID`] || defaults.id,
    name: process.env[`${prefix}_MODEL_NAME`] || defaults.name,
    baseUrl: process.env[`${prefix}_BASE_URL`] || defaults.baseUrl,
    provider: (process.env[`${prefix}_PROVIDER`] as ModelConfigEntry['provider']) || defaults.provider || 'deepseek',
    api: (process.env[`${prefix}_API`] as ModelConfigEntry['api']) || defaults.api || 'openai-completions',
    reasoning: process.env[`${prefix}_REASONING`] === 'true' || defaults.reasoning === true,
    input: defaults.input ?? ['text'],
    contextWindow: Number(process.env[`${prefix}_CONTEXT_WINDOW`] || defaults.contextWindow || 128000),
    maxTokens: Number(process.env[`${prefix}_MAX_TOKENS`] || defaults.maxTokens || 8192),
    thinkingFormat: (process.env[`${prefix}_THINKING_FORMAT`] as ModelConfigEntry['thinkingFormat']) || defaults.thinkingFormat,
  };
}

/** Default LLM for agent execution (subagents) */
export const EXECUTION_MODEL_CONFIG = envModel('EXECUTION', {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  baseUrl: 'https://api.deepseek.com',
  provider: 'deepseek',
  reasoning: true,
  input: ['text'],
  contextWindow: 128000,
  maxTokens: 32768,
  thinkingFormat: 'deepseek',
});

/** LLM for skill routing */
export const ROUTER_MODEL_CONFIG = envModel('ROUTER', {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  baseUrl: 'https://api.deepseek.com',
  provider: 'deepseek',
  reasoning: false,
  input: ['text'],
  contextWindow: 128000,
  maxTokens: 512,
});

/** Vision / image-caption model (Gemini by default) */
export const VISION_MODEL_CONFIG = envModel('VISION', {
  id: 'gemini-3-flash-preview',
  name: 'Gemini 3 Flash Preview',
  baseUrl: 'https://nexus.alphacat.pro/v1',
  provider: 'gemini',
  reasoning: false,
  input: ['text', 'image'],
  contextWindow: 128000,
  maxTokens: 8192,
});

// --- Execution Config ---
export const EXECUTION_CONFIG = {
  defaultTimeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS || 1_800_000),
  maxConcurrentTasks: Number(process.env.MAX_CONCURRENT_TASKS || 10),
  cleanupIntervalMs: Number(process.env.CLEANUP_INTERVAL_MS || 60_000),
  taskMaxAgeMs: Number(process.env.TASK_MAX_AGE_MS || 3_600_000),
  writeFileMaxLines: Number(process.env.WRITE_FILE_MAX_LINES || 800),
  writeFileMaxChars: Number(process.env.WRITE_FILE_MAX_CHARS || 32000),
};

// --- Workspace Cleanup ---
export const WORKSPACE_CONFIG = {
  maxAgeDays: Number(process.env.WORKSPACE_MAX_AGE_DAYS || 30),
  maxCount: Number(process.env.WORKSPACE_MAX_COUNT || 1000),
  cleanupIntervalMs: Number(process.env.CLEANUP_INTERVAL_MS || 86_400_000), // daily by default
};

// --- Router ---
export const ROUTER_CONFIG = {
  model: ROUTER_MODEL_CONFIG,
  maxTokens: ROUTER_MODEL_CONFIG.maxTokens,
  temperature: 0.1,
};
