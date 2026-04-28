import { Agent } from '@mariozechner/pi-agent-core';
import type {
  AgentEvent,
  AgentState,
  BeforeToolCallContext,
  AfterToolCallContext,
} from '@mariozechner/pi-agent-core';
import { streamSimple, completeSimple, createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type { Context, AssistantMessageEvent, AssistantMessage } from '@mariozechner/pi-ai';
import { executionModel, getApiKey } from '@/services/models.js';
import { createUniversalTools } from '@/tools/universal.js';
import { loadMultipleSkills } from '@/services/skills.js';
import type { TaskConfig, ExecutionState, SubagentConfig } from '@/types/index.js';
import type { SkillInfo } from '@/types/index.js';
import { logger } from '@/lib/logger.js';
import { recordEvent } from '@/services/db.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * DeepSeek non-streaming completion function.
 * Uses direct fetch() instead of OpenAI SDK streaming to avoid SSE stalls.
 * Correctly enables thinking mode and handles reasoning_content per DeepSeek spec.
 */
function deepseekCompleteFn(model: any, context: Context, options?: any) {
  const stream = createAssistantMessageEventStream();

  (async () => {
    try {
      const apiKey = options?.apiKey || getApiKey(model.provider) || '';
      if (!apiKey) throw new Error('No API key for provider: ' + model.provider);

      const messages = buildDeepSeekMessages(context);
      const body: Record<string, unknown> = {
        model: model.id,
        messages,
        stream: false,
        max_tokens: options?.maxTokens ?? model.maxTokens ?? 16384,
        thinking: { type: 'enabled' },
        reasoning_effort: 'max',
      };

      if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
      }

      if (context.tools && context.tools.length > 0) {
        body.tools = context.tools.map((t: any) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
      }

      if (options?.toolChoice) {
        body.tool_choice = options.toolChoice;
      }

      const url = (model.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '') + '/chat/completions';
      logger.debug('DeepSeek non-streaming request', { model: model.id, messageCount: messages.length });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`DeepSeek API ${response.status}: ${text}`);
      }

      const data = (await response.json()) as any;
      const choice = data.choices?.[0];
      if (!choice) throw new Error('No choices in DeepSeek response');

      const msg = choice.message;
      const contentBlocks: any[] = [];

      if (msg.content) {
        contentBlocks.push({ type: 'text', text: msg.content });
      }
      if (msg.reasoning_content) {
        contentBlocks.push({
          type: 'thinking',
          thinking: msg.reasoning_content,
          thinkingSignature: 'reasoning_content',
        });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          contentBlocks.push({
            type: 'toolCall',
            id: tc.id,
            name: tc.function?.name || '',
            arguments: JSON.parse(tc.function?.arguments || '{}'),
          });
        }
      }

      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: contentBlocks,
        api: model.api,
        provider: model.provider,
        model: model.id,
        responseId: data.id,
        usage: {
          input: data.usage?.prompt_tokens || 0,
          output: data.usage?.completion_tokens || 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: data.usage?.total_tokens || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: mapFinishReason(choice.finish_reason),
        timestamp: Date.now(),
      };

      logger.debug('DeepSeek non-streaming response', {
        model: model.id,
        stopReason: assistantMsg.stopReason,
        contentBlocks: contentBlocks.map((c) => c.type),
      });

      stream.push({ type: 'start', partial: assistantMsg });
      stream.push({ type: 'done', reason: assistantMsg.stopReason as 'stop' | 'length' | 'toolUse', message: assistantMsg });
      stream.end(assistantMsg);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : JSON.stringify(error);
      logger.error('DeepSeek non-streaming error', { error: errMsg });

      const errorMsg: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: options?.signal?.aborted ? 'aborted' : 'error',
        errorMessage: errMsg,
        timestamp: Date.now(),
      };

      stream.push({ type: 'error', reason: errorMsg.stopReason as 'error' | 'aborted', error: errorMsg });
      stream.end(errorMsg);
    }
  })();

  return stream;
}

/** Convert pi-ai Context messages to DeepSeek OpenAI-compatible format. */
function buildDeepSeekMessages(context: Context): any[] {
  const messages: any[] = [];

  if (context.systemPrompt) {
    messages.push({ role: 'system', content: context.systemPrompt });
  }

  for (const msg of context.messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const content = msg.content
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((c: any) => {
            if (c.type === 'text') return { type: 'text', text: c.text };
            if (c.type === 'image')
              return {
                type: 'image_url',
                image_url: { url: `data:${c.mimeType};base64,${c.data}` },
              };
            return null;
          })
          .filter(Boolean);
        if (content.length > 0) messages.push({ role: 'user', content });
      }
    } else if (msg.role === 'assistant') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assistantMsg = msg as any;
      const assistant: any = { role: 'assistant', content: '' };
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const hasToolCalls = assistantMsg.content.some((b: any) => b.type === 'toolCall');

      for (const block of assistantMsg.content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        } else if (block.type === 'thinking' && block.thinking) {
          // DeepSeek spec:
          // - Turns WITH tool calls: MUST include reasoning_content
          // - Turns WITHOUT tool calls: reasoning_content optional (API ignores it)
          // We keep it only for tool-call turns to save context window.
          if (hasToolCalls) {
            thinkingParts.push(block.thinking);
          }
        }
      }

      if (thinkingParts.length > 0) {
        assistant.reasoning_content = thinkingParts.join('\n');
      }
      if (textParts.length > 0) {
        assistant.content = textParts.join('');
      }

      const toolCalls = assistantMsg.content.filter((b: any) => b.type === 'toolCall');
      if (toolCalls.length > 0) {
        assistant.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }

      // DeepSeek requires content to be non-null on assistant messages
      if (!assistant.content) {
        assistant.content = '';
      }

      messages.push(assistant);
    } else if (msg.role === 'toolResult') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolMsg = msg as any;
      const text =
        typeof toolMsg.content === 'string'
          ? toolMsg.content
          : toolMsg.content
              ?.filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n');
      messages.push({
        role: 'tool',
        content: text || '',
        tool_call_id: toolMsg.toolCallId,
      });
    }
  }

  return messages;
}

function mapFinishReason(reason: string | null): AssistantMessage['stopReason'] {
  if (reason === null) return 'stop';
  switch (reason) {
    case 'stop':
    case 'end':
      return 'stop';
    case 'length':
      return 'length';
    case 'function_call':
    case 'tool_calls':
      return 'toolUse';
    case 'content_filter':
      return 'error';
    default:
      return 'stop';
  }
}

const DEEPSEEK_TIMEOUT_MS = 600_000;

// ============================================================================
// Context Compaction (inspired by pi-mono coding-agent)
// DeepSeek v4 Flash claims 1M context window. Trigger compaction at 75% = 750K
// ============================================================================

const COMPACT_THRESHOLD_RATIO = 0.75;
const COMPACT_KEEP_RECENT_TOKENS = 150_000; // keep ~150K tokens of recent history
const COMPACT_RESERVE_TOKENS = 16_384;      // budget for summarization prompt + response
const COMPACT_MAX_SUMMARY_TOKENS = 8_192;   // max tokens for the summary itself

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function estimateTokens(messages: any[]): number {
  let total = 0;
  for (const msg of messages) {
    let chars = 0;
    switch (msg.role) {
      case 'user':
      case 'toolResult': {
        const content = msg.content;
        if (typeof content === 'string') {
          chars = content.length;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) chars += block.text.length;
            if (block.type === 'image') chars += 4_800; // ~1200 tokens per image
          }
        }
        break;
      }
      case 'assistant': {
        const assistant = msg as AssistantMessage;
        for (const block of assistant.content) {
          if (block.type === 'text') chars += block.text.length;
          else if (block.type === 'thinking') chars += (block as any).thinking?.length ?? 0;
          else if (block.type === 'toolCall') chars += block.name.length + JSON.stringify(block.arguments).length;
        }
        break;
      }
    }
    total += Math.ceil(chars / 4);
  }
  return total;
}

function shouldCompact(contextTokens: number, contextWindow: number): boolean {
  const threshold = Math.floor(contextWindow * COMPACT_THRESHOLD_RATIO);
  return contextTokens > threshold;
}

/**
 * Find the cut point: walk backwards from newest, accumulating tokens until
 * we exceed keepRecentTokens. Cut at the closest valid point (user/assistant
 * message, never toolResult).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findCutPoint(messages: any[], keepRecentTokens: number): { cutIndex: number; isSplitTurn: boolean } {
  let accumulated = 0;
  let cutIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    accumulated += estimateTokens([msg]);

    if (accumulated >= keepRecentTokens) {
      // Find closest valid cut point at or after i
      // Valid: user or assistant. Skip toolResult.
      for (let j = i; j < messages.length; j++) {
        if (messages[j].role === 'user' || messages[j].role === 'assistant') {
          cutIndex = j;
          break;
        }
      }
      break;
    }
  }

  // If cutIndex is an assistant with tool results after it, include the tool results
  // (they must stay paired with the assistant)
  if (messages[cutIndex]?.role === 'assistant') {
    let end = cutIndex + 1;
    while (end < messages.length && messages[end].role === 'toolResult') {
      end++;
    }
    cutIndex = end; // keep everything from cutIndex onwards
  }

  const isSplitTurn = cutIndex > 0 && messages[cutIndex]?.role !== 'user';
  return { cutIndex, isSplitTurn };
}

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI agent, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Truncate tool result text for serialization to keep summarization prompt bounded. */
const TOOL_RESULT_MAX_CHARS = 2_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeMessages(messages: any[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              ?.filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('');
      if (text) parts.push(`[User]: ${text.slice(0, 2_000)}`);
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'thinking') thinkingParts.push((block as any).thinking ?? '');
        else if (block.type === 'toolCall') {
          toolCalls.push(`${block.name}(${JSON.stringify(block.arguments).slice(0, 200)})`);
        }
      }
      if (thinkingParts.length) parts.push(`[Assistant thinking]: ${thinkingParts.join('\n').slice(0, 1_000)}`);
      if (textParts.length) parts.push(`[Assistant]: ${textParts.join('\n').slice(0, 1_000)}`);
      if (toolCalls.length) parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`);
    } else if (msg.role === 'toolResult') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              ?.filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('');
      if (text) parts.push(`[Tool result]: ${text.slice(0, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Generate a compaction summary by calling the LLM (non-streaming).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateCompactionSummary(
  messagesToSummarize: any[],
  model: any,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const conversationText = serializeMessages(messagesToSummarize);
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`;

  const summarizationMessages = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: promptText }],
      timestamp: Date.now(),
    },
  ];

  const response = await completeSimple(
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    {
      apiKey,
      maxTokens: COMPACT_MAX_SUMMARY_TOKENS,
      // reasoning intentionally omitted — summarization doesn't need thinking
      signal,
      timeoutMs: 120_000,
    },
  );

  if (response.stopReason === 'error') {
    throw new Error(`Summarization failed: ${response.errorMessage || 'Unknown error'}`);
  }

  return response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

// agentStreamFn removed — using deepseekCompleteFn (non-streaming) instead.

/**
 * Truncate message history to prevent context-window overflow.
 * Keeps system/user messages and the most recent N complete turns
 * (assistant + its tool results). Older turns are dropped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function truncateMessages(messages: any[], maxTurns: number = 6): any[] {
  const preserved: any[] = [];
  const turns: any[][] = [];
  let currentTurn: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (currentTurn.length > 0) turns.push(currentTurn);
      currentTurn = [msg];
    } else if (currentTurn.length > 0) {
      currentTurn.push(msg);
    } else {
      preserved.push(msg);
    }
  }
  if (currentTurn.length > 0) turns.push(currentTurn);

  const dropped = turns.length - maxTurns;
  if (dropped > 0) {
    logger.debug('Truncating context history', { totalTurns: turns.length, keptTurns: maxTurns, dropped });
  }
  const keptTurns = turns.slice(-maxTurns);
  return [...preserved, ...keptTurns.flat()];
}

export async function runTask(
  config: TaskConfig,
  onEvent: (state: ExecutionState) => void,
): Promise<ExecutionState> {
  const state: ExecutionState = {
    status: 'running',
    query: config.query,
    skillName: config.skillName,
    startTime: Date.now(),
    artifacts: [],
  };

  const skillNames = config.skillSet?.skills ?? [config.skillName];
  const loadedSkills = await loadMultipleSkills(skillNames);
  const primarySkill = loadedSkills.find((s) => s.info.name === config.skillName) ?? loadedSkills[0];

  await fs.mkdir(config.workspaceDir, { recursive: true });
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

  // Track stage execution for workflow enforcement
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

    // Fix DeepSeek reasoning_content signature BEFORE every LLM call.
    // DeepSeek API returns reasoning via a top-level `reasoning_content` field
    // on assistant messages (parallel to `content`). pi-ai stores it as a
    // `thinking` content block with `thinkingSignature` set to the observed
    // field name (e.g. "reasoning" or "reasoning_content").
    //
    // We MUST keep the `thinking` block type so that pi-ai's `convertMessages`
    // can extract it into `assistantMsg.reasoning_content`. We only rewrite the
    // signature to the canonical "reasoning_content" so that the outgoing
    // OpenAI-compatible request contains the correct field name.
    transformContext: async (messages, signal) => {
      // ----------------------------------------------------------------------
      // 1. Context Compaction (pi-mono style)
      //    DeepSeek v4 Flash claims 1M context. Trigger at 75% = 750K tokens.
      //    When triggered, summarize old messages via LLM, keep recent ones raw.
      // ----------------------------------------------------------------------
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

            const summaryMsg = {
              role: 'user' as const,
              content: [
                {
                  type: 'text' as const,
                  text: `[Context Checkpoint] The conversation history before this point was compacted into a summary:\n\n<summary>\n${summary}\n</summary>\n\nContinue from here.`,
                },
              ],
              timestamp: Date.now(),
            };
            compacted = [summaryMsg, ...keptMessages];

            logger.info('Context compaction complete', {
              taskId: config.taskId,
              summaryChars: summary.length,
              newMessageCount: compacted.length,
            });
          }
        } catch (err) {
          logger.error('Context compaction failed, falling back to truncation', {
            taskId: config.taskId,
            error: err instanceof Error ? err.message : String(err),
          });
          compacted = truncateMessages(messages, 6);
        }
      } else if (messages.length > 30) {
        // Light-weight fallback: truncate old turns before we even hit the threshold
        compacted = truncateMessages(messages, 10);
      }

      // ----------------------------------------------------------------------
      // 2. Selective reasoning_content for DeepSeek compatibility.
      //    DeepSeek spec:
      //    - Turns WITH tool calls: MUST include reasoning_content in subsequent
      //      requests. We keep thinking blocks and ensure signature is
      //      'reasoning_content'.
      //    - Turns WITHOUT tool calls: reasoning_content is optional (API ignores
      //      it). We strip thinking blocks to save context window.
      // ----------------------------------------------------------------------
      const fixed = compacted.map((msg) => {
        if (msg.role !== 'assistant') return msg;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const assistantMsg = msg as any;
        const hasToolCalls = assistantMsg.content.some((b: any) => b.type === 'toolCall');
        const newContent = assistantMsg.content
          .map((block: any) => {
            if (block.type === 'thinking') {
              if (hasToolCalls) {
                // Must preserve reasoning_content for tool-call turns
                return { ...block, thinkingSignature: 'reasoning_content' };
              }
              // Strip thinking from non-tool-call turns to save tokens
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

    // Log and validate every tool call before execution
    beforeToolCall: async (context) => {
      const toolName = context.toolCall.name;
      await appendLog(
        config.workspaceDir,
        `[BEFORE_TOOL] ${toolName} args=${JSON.stringify(context.args)}`,
      );
      // Track stage progress based on tool name
      stageTracker.recordToolCall(toolName);
      return undefined; // allow execution
    },

    // Inspect results after tool execution for enforcement
    afterToolCall: async (context) => {
      const toolName = context.toolCall.name;
      const status = context.isError ? 'ERROR' : 'OK';
      await appendLog(
        config.workspaceDir,
        `[AFTER_TOOL] ${toolName} status=${status}`,
      );

      // If a write_file succeeded, mark that artifacts are being produced
      if (toolName === 'write_file' && !context.isError) {
        stageTracker.recordArtifactWritten();
      }

      return undefined; // no override
    },

    // onPayload removed — request body is fully controlled in deepseekCompleteFn.
    // Debug logging is done inside deepseekCompleteFn via logger.debug().

    onResponse: (response) => {
      logger.debug('LLM response', {
        taskId: config.taskId,
        status: response.status,
        headers: Object.keys(response.headers),
      });
    },
  });

  // Subscribe to lifecycle events with proper abort signal handling
  agent.subscribe(async (event: AgentEvent, signal: AbortSignal) => {
    await handleAgentEvent(event, config.workspaceDir, state, signal, config.taskId);
    onEvent({ ...state });

    if (event.type === 'agent_end') {
      // Persist full message transcript
      await fs.writeFile(
        path.join(config.workspaceDir, 'messages.json'),
        JSON.stringify(agent.state.messages, null, 2),
        'utf-8',
      );

      // Workflow enforcement: if outputs/ is empty, inject followUp to force writing
      const hasArtifacts = await checkOutputsNonEmpty(config.workspaceDir);
      if (!hasArtifacts) {
        logger.warn('Agent ended but outputs/ is empty — injecting followUp', {
          taskId: config.taskId,
        });
        agent.followUp({
          role: 'user',
          content: '注意：你还没有将任何产物写入 outputs/ 目录。请立即将结果写入文件，用户只能下载文件，看不到对话内容。',
          timestamp: Date.now(),
        });
      }
    }
  });

  const TASK_TIMEOUT_MS = 600_000; // 10 minutes max per task
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
    state.status = 'completed';
    state.message = `Task completed. Artifacts: ${state.artifacts.join(', ') || 'none'}`;
  } catch (err) {
    settled = true;
    clearTimeout(timeoutTimer);
    state.status = 'failed';
    state.error = err instanceof Error ? err.message : String(err);
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

/**
 * Tracks which workflow stages have been touched based on tool calls.
 */
class StageTracker {
  private toolCallCount = 0;
  private artifactWritten = false;
  private stages: Map<string, boolean> = new Map();

  constructor(private subagent?: SubagentConfig) {
    if (subagent) {
      for (const stage of subagent.workflowStages) {
        this.stages.set(stage.id, false);
      }
    }
  }

  recordToolCall(toolName: string) {
    this.toolCallCount++;
    // Heuristic stage detection
    if (toolName === 'bash') {
      this.stages.set('stage0', true); // env check
    }
    if (toolName === 'read_file') {
      this.stages.set('stage0', true); // reading references
    }
    if (toolName === 'write_file') {
      this.stages.set('stage3', true); // generating output
    }
  }

  recordArtifactWritten() {
    this.artifactWritten = true;
  }

  getSummary() {
    return {
      toolCalls: this.toolCallCount,
      artifactWritten: this.artifactWritten,
      stagesCompleted: Array.from(this.stages.entries())
        .filter(([, done]) => done)
        .map(([id]) => id),
    };
  }
}

async function checkOutputsNonEmpty(workspaceDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(workspaceDir, 'outputs'));
    return entries.length > 0;
  } catch {
    return false;
  }
}

function buildSystemPrompt(
  loadedSkills: { info: SkillInfo; content: string; dir: string }[],
  primarySkill: { info: SkillInfo; content: string; dir: string },
  workspaceDir: string,
  subagent?: SubagentConfig,
  productConfig?: Record<string, unknown>,
): string {
  const productJson = productConfig ? JSON.stringify(productConfig, null, 2) : '（未提供）';

  // Build skill content blocks
  const skillBlocks = loadedSkills.map((s) => {
    const isPrimary = s.info.name === primarySkill.info.name;
    const marker = isPrimary ? '【主导 Skill】' : '【辅助 Skill】';
    return [
      `--- ${marker} ${s.info.name} v${s.info.version} ---`,
      s.content,
      `--- 结束 ${s.info.name} ---`,
    ].join('\n');
  });

  // Build enforcement rules from subagent config
  const enforcementLines = subagent
    ? subagent.enforcementRules.map((r, i) => `${i + 1}. ${r}`)
    : [
        '1. **所有最终产物必须写入 outputs/ 目录**。禁止仅在对话中回复内容——用户看不到你的对话，只能下载文件。',
        '2. 如果任务是生成文案、笔记、分析等文字内容，必须写入 `outputs/*.md`。',
        '3. 如果任务是生成图片，必须保存到 `outputs/*.png`。',
        '4. 如果任务是生成 HTML slides / deck，必须保存到 `outputs/*.html`。',
        '5. 任务结束前必须确认 `outputs/` 目录非空。如果为空，立即将结果写入文件。',
        '6. **文件读取限制**：单次 turn 最多读取 3-5 个关键文件。不要遍历读取整个 assets/ 或 templates/ 目录的所有文件。',
        '7. **优先引用而非内联**：如果 skill 的 assets 包含大量 CSS/JS，优先通过 CDN 链接或 `<script src="...">` 引用，不要把整个库的内容内联到 HTML 中。',
        '8. **快速迭代**：先写一个最小可用版本到 outputs/，再用 edit_file 逐步完善，不要等"完美"后再写文件。',
      ];

  // Build workflow stages from subagent config
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

async function handleAgentEvent(
  event: AgentEvent,
  workspaceDir: string,
  state: ExecutionState,
  signal: AbortSignal,
  taskId: string,
): Promise<void> {
  switch (event.type) {
    case 'agent_start': {
      await appendLog(workspaceDir, '[AGENT START]');
      recordEvent(taskId, 'agent_start');
      break;
    }
    case 'turn_start': {
      await appendLog(workspaceDir, '[TURN START]');
      recordEvent(taskId, 'turn_start');
      break;
    }
    case 'turn_end': {
      const msg = event.message;
      const stopReason = (msg as { stopReason?: string }).stopReason ?? 'normal';
      const hasError = msg.role === 'assistant' && stopReason === 'error';
      await appendLog(
        workspaceDir,
        `[TURN END] role=${msg.role} stopReason=${stopReason}`,
      );
      recordEvent(taskId, 'turn_end', { role: msg.role, stopReason });
      if (hasError) {
        state.error = (msg as { errorMessage?: string }).errorMessage ?? 'Assistant turn failed';
      }
      break;
    }
    case 'message_start': {
      await appendLog(workspaceDir, `[MESSAGE START] role=${event.message.role}`);
      break;
    }
    case 'message_update': {
      // Token-level streaming — lightweight, don't log every token
      break;
    }
    case 'message_end': {
      if (event.message.role === 'assistant') {
        const text = event.message.content
          .filter((b) => b.type === 'text')
          .map((b) => ('text' in b ? b.text : ''))
          .join('');
        if (text) {
          await appendLog(
            workspaceDir,
            `[ASSISTANT] ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}`,
            signal,
          );
          recordEvent(taskId, 'assistant_message', {
            length: text.length,
            preview: text.slice(0, 200),
          });
        }
      }
      break;
    }
    case 'tool_execution_start': {
      await appendLog(
        workspaceDir,
        `[TOOL START] ${event.toolName} args=${JSON.stringify(event.args)}`,
        signal,
      );
      recordEvent(taskId, 'tool_start', { toolName: event.toolName });
      break;
    }
    case 'tool_execution_update': {
      // Partial tool results — don't log to avoid spam
      break;
    }
    case 'tool_execution_end': {
      const status = event.isError ? 'ERROR' : 'OK';
      await appendLog(workspaceDir, `[TOOL END] ${event.toolName} status=${status}`, signal);
      recordEvent(taskId, 'tool_end', { toolName: event.toolName, status, isError: event.isError });
      break;
    }
    case 'agent_end': {
      await appendLog(workspaceDir, `[AGENT END] status=${state.status}`, signal);
      recordEvent(taskId, 'agent_end', { finalStatus: state.status });
      break;
    }
  }
}

async function appendLog(
  workspaceDir: string,
  line: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const logPath = path.join(workspaceDir, 'agent.log');
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  await fs.appendFile(logPath, entry, 'utf-8');
}

async function collectArtifacts(workspaceDir: string): Promise<string[]> {
  const outputsDir = path.join(workspaceDir, 'outputs');
  try {
    const files = await listFilesRecursive(outputsDir);
    return files.map((f) => path.relative(workspaceDir, f));
  } catch {
    return [];
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}
