import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { exec } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

function resolveWorkspacePath(workspaceDir: string, relPath: string): string {
  const resolved = path.resolve(workspaceDir, relPath);
  const normalizedWorkspace = path.resolve(workspaceDir);
  if (!resolved.startsWith(normalizedWorkspace + path.sep) && resolved !== normalizedWorkspace) {
    throw new Error(`Path traversal blocked: ${relPath}`);
  }
  return resolved;
}

const bashParams = Type.Object({
  command: Type.String({ description: 'The bash command to execute' }),
  timeout: Type.Optional(
    Type.Number({ default: 600, description: 'Timeout in seconds (default: 600)' }),
  ),
});

const readParams = Type.Object({
  path: Type.String({ description: 'Relative file path within the workspace' }),
});

const writeParams = Type.Object({
  path: Type.String({ description: 'Relative file path within the workspace' }),
  content: Type.String({ description: 'File content to write' }),
});

const editParams = Type.Object({
  path: Type.String({ description: 'Relative file path within the workspace' }),
  old_string: Type.String({ description: 'Exact text to search for (must appear exactly once)' }),
  new_string: Type.String({ description: 'Replacement text' }),
});

export function createUniversalTools(workspaceDir: string): AgentTool[] {
  return [
    {
      name: 'bash',
      label: 'Bash',
      description:
        'Execute a bash shell command in the task workspace. Use this to run nexus CLI, curl, python scripts, or any other shell tools. The command runs with the task workspace as the working directory.',
      parameters: bashParams,
      execute: async (_toolCallId, params: { command: string; timeout?: number }, signal) => {
        const { stdout, stderr } = await execAsync(params.command, {
          cwd: workspaceDir,
          timeout: (params.timeout ?? 600) * 1000,
          signal,
          env: { ...process.env, TASK_ID: path.basename(workspaceDir) },
        });
        const out = stdout.trim();
        const err = stderr.trim();
        const text = out + (err ? `\n[stderr]:\n${err}` : '');
        return {
          content: [{ type: 'text', text: text || '(no output)' }],
          details: { command: params.command, exitCode: 0 },
        };
      },
    } as AgentTool<typeof bashParams>,
    {
      name: 'read_file',
      label: 'Read File',
      description: 'Read the contents of a file in the task workspace.',
      parameters: readParams,
      execute: async (_toolCallId, params: { path: string }) => {
        const target = resolveWorkspacePath(workspaceDir, params.path);
        const content = await fs.readFile(target, 'utf-8');
        return {
          content: [{ type: 'text', text: content }],
          details: { path: params.path, size: content.length },
        };
      },
    } as AgentTool<typeof readParams>,
    {
      name: 'write_file',
      label: 'Write File',
      description:
        'Write content to a file in the task workspace. Creates parent directories automatically.',
      parameters: writeParams,
      execute: async (_toolCallId, params: { path: string; content: string }) => {
        const target = resolveWorkspacePath(workspaceDir, params.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, params.content, 'utf-8');
        return {
          content: [{ type: 'text', text: `Wrote ${params.path}` }],
          details: { path: params.path, size: params.content.length },
        };
      },
    } as AgentTool<typeof writeParams>,
    {
      name: 'edit_file',
      label: 'Edit File',
      description:
        'Edit a file by replacing a specific string with another string. old_string must appear exactly once in the file. This is the preferred way to modify existing files.',
      parameters: editParams,
      execute: async (
        _toolCallId,
        params: { path: string; old_string: string; new_string: string },
      ) => {
        const target = resolveWorkspacePath(workspaceDir, params.path);
        const content = await fs.readFile(target, 'utf-8');
        const occurrences = content.split(params.old_string).length - 1;
        if (occurrences === 0) {
          throw new Error(`old_string not found in ${params.path}`);
        }
        if (occurrences > 1) {
          throw new Error(
            `old_string appears ${occurrences} times in ${params.path}; must appear exactly once`,
          );
        }
        const newContent = content.replace(params.old_string, params.new_string);
        await fs.writeFile(target, newContent, 'utf-8');
        return {
          content: [{ type: 'text', text: `Edited ${params.path}` }],
          details: { path: params.path },
        };
      },
    } as AgentTool<typeof editParams>,
  ];
}
