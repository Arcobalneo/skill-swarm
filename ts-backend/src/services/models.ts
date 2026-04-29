import type { Model } from '@mariozechner/pi-ai';
import {
  API_KEYS,
  EXECUTION_MODEL_CONFIG,
  ROUTER_MODEL_CONFIG,
  VISION_MODEL_CONFIG,
  type ModelConfigEntry,
} from '@/config/index.js';

export function createModel(config: ModelConfigEntry): Model<'openai-completions'> {
  const compat: Record<string, unknown> = {
    supportsStore: false,
    supportsDeveloperRole: false,
  };

  if (config.thinkingFormat === 'deepseek') {
    compat.thinkingFormat = 'deepseek';
  }

  return {
    id: config.id,
    name: config.name,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning,
    input: config.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat,
  };
}

/** Model used by subagent execution (Agent.runTask) */
export const executionModel = createModel(EXECUTION_MODEL_CONFIG);

/** Model used by the skill router */
export const routerModel = createModel(ROUTER_MODEL_CONFIG);

/** Vision / image-caption model */
export const visionModel = createModel(VISION_MODEL_CONFIG);

export function getApiKey(provider: string): string | undefined {
  return (API_KEYS as Record<string, string>)[provider] || undefined;
}
