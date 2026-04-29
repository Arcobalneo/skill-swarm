import { createAssistantMessageEventStream, completeSimple } from '@mariozechner/pi-ai';
import type { Context, AssistantMessage } from '@mariozechner/pi-ai';
import { getApiKey } from '@/services/models.js';
import { EXECUTION_CONFIG } from '@/config/index.js';
import { logger } from '@/lib/logger.js';
import { errMsg } from '@/lib/helpers.js';

export const DEEPSEEK_TIMEOUT_MS = 600_000;

export function deepseekCompleteFn(model: any, context: Context, options?: any) {
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
        max_tokens: options?.maxTokens ?? model.maxTokens ?? 32768,
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

      const rawText = await response.text();
      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        const isTruncated = rawText.length > 10000;
        throw new Error(
          `DeepSeek API response is not valid JSON (${rawText.length} chars). ` +
            (isTruncated
              ? `The response was likely truncated — the model tried to output too much content in a single call. Retry with smaller chunks (write_file ≤ ${EXECUTION_CONFIG.writeFileMaxLines} lines / ${EXECUTION_CONFIG.writeFileMaxChars} chars, use edit_file to append).`
              : `First 200 chars: ${rawText.slice(0, 200)}`),
        );
      }
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
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function?.arguments || '{}');
          } catch {
            throw new Error(
              `Tool call arguments for "${tc.function?.name}" are not valid JSON (likely truncated). ` +
                `The model tried to pass too much data in a single tool call. Retry with smaller content per call (≤ ${EXECUTION_CONFIG.writeFileMaxLines} lines / ${EXECUTION_CONFIG.writeFileMaxChars} chars).`,
            );
          }
          contentBlocks.push({
            type: 'toolCall',
            id: tc.id,
            name: tc.function?.name || '',
            arguments: args,
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
    } catch (err) {
      const message = errMsg(err);
      logger.error('DeepSeek non-streaming error', { error: message });

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
        errorMessage: message,
        timestamp: Date.now(),
      };

      stream.push({ type: 'error', reason: errorMsg.stopReason as 'error' | 'aborted', error: errorMsg });
      stream.end(errorMsg);
    }
  })();

  return stream;
}

export function buildDeepSeekMessages(context: Context): any[] {
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
          // DeepSeek spec: keep reasoning_content only for tool-call turns to save context
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
