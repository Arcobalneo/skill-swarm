import { completeSimple } from '@mariozechner/pi-ai';
import type { Context, AssistantMessage } from '@mariozechner/pi-ai';
import { logger } from '@/lib/logger.js';
import { errMsg } from '@/lib/helpers.js';

// DeepSeek v4 Flash 1M context window — compact at 75% (750K tokens)
export const COMPACT_THRESHOLD_RATIO = 0.75;
export const COMPACT_KEEP_RECENT_TOKENS = 150_000;
export const COMPACT_RESERVE_TOKENS = 16_384;
export const COMPACT_MAX_SUMMARY_TOKENS = 8_192;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function estimateTokens(messages: any[]): number {
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
            if (block.type === 'image') chars += 4_800;
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

export function shouldCompact(contextTokens: number, contextWindow: number): boolean {
  const threshold = Math.floor(contextWindow * COMPACT_THRESHOLD_RATIO);
  return contextTokens > threshold;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findCutPoint(messages: any[], keepRecentTokens: number): { cutIndex: number; isSplitTurn: boolean } {
  let accumulated = 0;
  let cutIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    accumulated += estimateTokens([msg]);

    if (accumulated >= keepRecentTokens) {
      for (let j = i; j < messages.length; j++) {
        if (messages[j].role === 'user' || messages[j].role === 'assistant') {
          cutIndex = j;
          break;
        }
      }
      break;
    }
  }

  // Keep tool results paired with their assistant message
  if (messages[cutIndex]?.role === 'assistant') {
    let end = cutIndex + 1;
    while (end < messages.length && messages[end].role === 'toolResult') {
      end++;
    }
    cutIndex = end;
  }

  const isSplitTurn = cutIndex > 0 && messages[cutIndex]?.role !== 'user';
  return { cutIndex, isSplitTurn };
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI agent, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

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

const TOOL_RESULT_MAX_CHARS = 2_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeMessages(messages: any[]): string {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generateCompactionSummary(
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function truncateMessages(messages: any[], maxTurns: number = 6): any[] {
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
