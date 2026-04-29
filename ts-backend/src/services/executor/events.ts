import type { AgentEvent } from '@mariozechner/pi-agent-core';
import type { ExecutionState } from '@/types/index.js';
import { recordEvent } from '@/services/db.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function checkOutputsNonEmpty(workspaceDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(workspaceDir, 'outputs'));
    return entries.length > 0;
  } catch {
    return false;
  }
}

export async function handleAgentEvent(
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
      // Clear previous turn's error — each new turn gets a fresh start
      state.error = undefined;
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

export async function appendLog(
  workspaceDir: string,
  line: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const logPath = path.join(workspaceDir, 'agent.log');
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  await fs.appendFile(logPath, entry, 'utf-8');
}

export async function collectArtifacts(workspaceDir: string): Promise<string[]> {
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
