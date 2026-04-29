import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import type { TaskConfig, ExecutionState } from '@/types/index.js';
import { TaskStatus } from '@/types/index.js';
import { executionModel, getApiKey } from '@/services/models.js';
import { createUniversalTools } from '@/tools/universal.js';
import { loadMultipleSkills } from '@/services/skills.js';
import { logger } from '@/lib/logger.js';
import { errMsg } from '@/lib/helpers.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { deepseekCompleteFn } from './deepseek.js';
import {
  estimateTokens,
  shouldCompact,
  findCutPoint,
  generateCompactionSummary,
  truncateMessages,
  COMPACT_KEEP_RECENT_TOKENS,
  COMPACT_THRESHOLD_RATIO,
} from './compaction.js';
import { StageTracker } from './stage-tracker.js';
import { buildSystemPrompt } from './prompt.js';
import { handleAgentEvent, checkOutputsNonEmpty, collectArtifacts, appendLog } from './events.js';

export { StageTracker } from './stage-tracker.js';
export { buildSystemPrompt } from './prompt.js';

export async function runTask(
  config: TaskConfig,
  onEvent: (state: ExecutionState) => void,
): Promise<ExecutionState> {
  const state: ExecutionState = {
    status: TaskStatus.Running,
    query: config.query,
    skillName: config.skillName,
    startTime: Date.now(),
    artifacts: [],
  };

  const skillNames = config.skillSet?.skills ?? [config.skillName];
  const loadedSkills = await loadMultipleSkills(skillNames);
  const primarySkill = loadedSkills.find((s) => s.info.name === config.skillName) ?? loadedSkills[0];

  await fs.mkdir(path.join(config.workspaceDir, 'outputs'), { recursive: true });

  await fs.writeFile(
    path.join(config.workspaceDir, 'request.json'),
    JSON.stringify(
      { query: config.query, skill: config.skillName, productConfig: config.productConfig },
      null,
      2,
    ),
    'utf-8',
  );

  const systemPrompt = buildSystemPrompt(
    loadedSkills,
    primarySkill,
    config.workspaceDir,
    config.subagent,
    config.productConfig,
  );

  const stageTracker = new StageTracker(config.subagent);

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: executionModel,
      thinkingLevel: 'xhigh',
      tools: createUniversalTools(config.workspaceDir),
    },
    getApiKey: (provider) => getApiKey(provider),
    maxRetryDelayMs: 300_000,
    toolExecution: 'parallel',
    streamFn: deepseekCompleteFn,

    transformContext: async (messages, signal) => {
      const contextWindow = executionModel.contextWindow || 1_000_000;
      const totalTokens = estimateTokens(messages);
      let compacted = messages;

      if (shouldCompact(totalTokens, contextWindow)) {
        try {
          const { cutIndex } = findCutPoint(messages, COMPACT_KEEP_RECENT_TOKENS);
          const messagesToSummarize = messages.slice(0, cutIndex);
          const keptMessages = messages.slice(cutIndex);

          if (messagesToSummarize.length > 0) {
            logger.info('Context compaction triggered', {
              taskId: config.taskId,
              totalTokens,
              contextWindow,
              threshold: Math.floor(contextWindow * COMPACT_THRESHOLD_RATIO),
              messagesToSummarize: messagesToSummarize.length,
              keptMessages: keptMessages.length,
            });

            const summary = await generateCompactionSummary(
              messagesToSummarize,
              executionModel,
              getApiKey(executionModel.provider) || '',
              signal,
            );

            compacted = [
              {
                role: 'user' as const,
                content: [
                  {
                    type: 'text' as const,
                    text: `[Context Checkpoint] The conversation history before this point was compacted into a summary:\n\n<summary>\n${summary}\n</summary>\n\nContinue from here.`,
                  },
                ],
                timestamp: Date.now(),
              },
              ...keptMessages,
            ];

            logger.info('Context compaction complete', {
              taskId: config.taskId,
              summaryChars: summary.length,
              newMessageCount: compacted.length,
            });
          }
        } catch (err) {
          logger.error('Context compaction failed, falling back to truncation', {
            taskId: config.taskId,
            error: errMsg(err),
          });
          compacted = truncateMessages(messages, 6);
        }
      } else if (messages.length > 30) {
        compacted = truncateMessages(messages, 10);
      }

      // Selective reasoning_content: keep for tool-call turns, strip otherwise
      const fixed = compacted.map((msg) => {
        if (msg.role !== 'assistant') return msg;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const assistantMsg = msg as any;
        const hasToolCalls = assistantMsg.content.some((b: any) => b.type === 'toolCall');
        const newContent = assistantMsg.content
          .map((block: any) => {
            if (block.type === 'thinking') {
              if (hasToolCalls) {
                return { ...block, thinkingSignature: 'reasoning_content' };
              }
              return null;
            }
            return block;
          })
          .filter(Boolean);
        return { ...assistantMsg, content: newContent };
      });
      logger.debug('transformContext', {
        taskId: config.taskId,
        originalMessages: messages.length,
        compactedMessages: compacted.length,
        totalTokens,
      });
      return fixed;
    },

    beforeToolCall: async (context) => {
      const toolName = context.toolCall.name;
      await appendLog(
        config.workspaceDir,
        `[BEFORE_TOOL] ${toolName} args=${JSON.stringify(context.args)}`,
      );
      stageTracker.recordToolCall(toolName);
      return undefined;
    },

    afterToolCall: async (context) => {
      const toolName = context.toolCall.name;
      const status = context.isError ? 'ERROR' : 'OK';
      await appendLog(
        config.workspaceDir,
        `[AFTER_TOOL] ${toolName} status=${status}`,
      );

      if (toolName === 'write_file' && !context.isError) {
        stageTracker.recordArtifactWritten();
      }

      return undefined;
    },

    onResponse: (response) => {
      logger.debug('LLM response', {
        taskId: config.taskId,
        status: response.status,
        headers: Object.keys(response.headers),
      });
    },
  });

  agent.subscribe(async (event: AgentEvent, signal: AbortSignal) => {
    await handleAgentEvent(event, config.workspaceDir, state, signal, config.taskId);
    onEvent({ ...state });

    if (event.type === 'agent_end') {
      await fs.writeFile(
        path.join(config.workspaceDir, 'messages.json'),
        JSON.stringify(agent.state.messages, null, 2),
        'utf-8',
      );

      if (!stageTracker.isArtifactWritten) {
        logger.warn('Agent ended but outputs/ is empty — injecting followUp', {
          taskId: config.taskId,
        });
        const hint = state.error
          ? `\n\n之前的错误：${state.error}\n\n请根据错误提示调整策略：每次 write_file 最多写 300 行，大文件分多次写入并用 edit_file 追加。`
          : '';
        agent.followUp({
          role: 'user',
          content: '注意：你还没有将任何产物写入 outputs/ 目录。请立即将结果写入文件，分批写入（每次不超过 300 行），用户只能下载文件，看不到对话内容。' + hint,
          timestamp: Date.now(),
        });
        state.error = undefined;
      }
    }
  });

  const TASK_TIMEOUT_MS = 600_000;
  let settled = false;
  const timeoutTimer = setTimeout(() => {
    if (!settled) {
      logger.warn('Task timeout – aborting agent', {
        taskId: config.taskId,
        timeoutMs: TASK_TIMEOUT_MS,
        elapsedMs: Date.now() - state.startTime!,
      });
      agent.abort();
    }
  }, TASK_TIMEOUT_MS);

  try {
    await agent.prompt(config.query);
    await agent.waitForIdle();
    settled = true;
    clearTimeout(timeoutTimer);

    state.artifacts = await collectArtifacts(config.workspaceDir);
    state.status = TaskStatus.Completed;
    state.message = `Task completed. Artifacts: ${state.artifacts.join(', ') || 'none'}`;
  } catch (err) {
    settled = true;
    clearTimeout(timeoutTimer);
    state.status = TaskStatus.Failed;
    state.error = errMsg(err);
    state.message = `Task failed: ${state.error}`;
  } finally {
    state.endTime = Date.now();
    const manifest = {
      taskId: config.taskId,
      status: state.status,
      artifacts: state.artifacts,
      message: state.message,
      error: state.error,
      startTime: state.startTime,
      endTime: state.endTime,
    };
    await fs.writeFile(
      path.join(config.workspaceDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }

  onEvent({ ...state });
  return state;
}
