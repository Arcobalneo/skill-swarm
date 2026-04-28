import { runTask } from '@/services/executor.js';
import type { ExecutionState, SkillSet, SubagentConfig } from '@/types/index.js';
import { logger } from '@/lib/logger.js';
import { WORKSPACE_ROOT, EXECUTION_CONFIG, SKILLS_DIR } from '@/config/index.js';
import { loadSubagentConfig, resolveSubagent } from '@/services/subagents.js';
import {
  createTask,
  updateTaskStatus,
  getTask as getDbTask,
  deleteTask,
  getOldestTasks,
} from '@/services/db.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createWriteStream } from 'node:fs';

const tasks = new Map<string, ExecutionState>();
const runningTasks = new Set<string>();

export function getWorkspaceDir(taskId: string): string {
  return path.join(WORKSPACE_ROOT, taskId);
}

export function createTaskId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function enqueueTask(
  query: string,
  skillName: string,
  productConfig?: Record<string, unknown>,
): Promise<string> {
  if (runningTasks.size >= EXECUTION_CONFIG.maxConcurrentTasks) {
    throw new Error(
      `Too many concurrent tasks (max ${EXECUTION_CONFIG.maxConcurrentTasks}). Please try again later.`,
    );
  }

  const taskId = createTaskId();
  const workspaceDir = getWorkspaceDir(taskId);
  await fs.mkdir(workspaceDir, { recursive: true });

  const subagent = await resolveSubagent(skillName);
  const skillSet: SkillSet = subagent
    ? { primary: skillName, skills: subagent.skills }
    : { primary: skillName, skills: [skillName] };

  // Copy associated skill files into the workspace so read_file can access them
  for (const skill of skillSet.skills) {
    const srcDir = path.join(SKILLS_DIR, skill);
    const destDir = path.join(workspaceDir, 'skills', skill);
    try {
      await fs.cp(srcDir, destDir, { recursive: true, force: true });
      logger.debug('Copied skill into workspace', { taskId, skill, dest: destDir });
    } catch (err) {
      logger.warn('Failed to copy skill into workspace', {
        taskId,
        skill,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const initial: ExecutionState = {
    status: 'queued',
    query,
    skillName,
    startTime: Date.now(),
    artifacts: [],
  };
  tasks.set(taskId, initial);
  await persistStatus(taskId, initial);

  // Write to SQLite
  createTask({
    id: taskId,
    query,
    skillName,
    subagent: subagent?.id,
    workspacePath: workspaceDir,
  });

  runningTasks.add(taskId);
  setImmediate(async () => {
    try {
      await runTask(
        { taskId, workspaceDir, query, skillName, skillSet, subagent: subagent ?? undefined, productConfig },
        (state) => {
          tasks.set(taskId, state);
          persistStatus(taskId, state).catch(() => {});
          syncTaskToDb(taskId, state);
        },
      );
    } catch (err) {
      const failed: ExecutionState = {
        ...initial,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        message: `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
        endTime: Date.now(),
      };
      tasks.set(taskId, failed);
      await persistStatus(taskId, failed);
      syncTaskToDb(taskId, failed);
      logger.error('Task failed', { taskId, error: failed.error });
    } finally {
      runningTasks.delete(taskId);
    }
  });

  return taskId;
}

export async function getStatus(taskId: string): Promise<ExecutionState | null> {
  // 1. In-memory cache
  const mem = tasks.get(taskId);
  if (mem) return mem;

  // 2. SQLite database
  const dbTask = getDbTask(taskId);
  if (dbTask) {
    const state: ExecutionState = {
      status: dbTask.status as ExecutionState['status'],
      query: dbTask.query,
      skillName: dbTask.skill_name,
      startTime: dbTask.created_at,
      endTime: dbTask.completed_at ?? undefined,
      artifacts: [],
      message: dbTask.error_message ?? undefined,
      error: dbTask.error_message ?? undefined,
    };
    tasks.set(taskId, state);
    return state;
  }

  // 3. Fallback to filesystem status.json
  try {
    const raw = await fs.readFile(path.join(getWorkspaceDir(taskId), 'status.json'), 'utf-8');
    const parsed = JSON.parse(raw) as ExecutionState;
    tasks.set(taskId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function persistStatus(taskId: string, state: ExecutionState): Promise<void> {
  const p = path.join(getWorkspaceDir(taskId), 'status.json');
  await fs.writeFile(p, JSON.stringify(state, null, 2), 'utf-8');
}

function syncTaskToDb(taskId: string, state: ExecutionState): void {
  try {
    const fields: Record<string, string | number | null> = {};
    if (state.status === 'running') {
      fields.started_at = state.startTime;
    }
    if (state.status === 'completed' || state.status === 'failed') {
      fields.completed_at = state.endTime ?? Date.now();
      fields.error_message = state.error ?? null;
      fields.artifact_count = state.artifacts.length;
    }
    updateTaskStatus(taskId, state.status, fields);
  } catch (err) {
    logger.warn('Failed to sync task status to DB', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function createZip(taskId: string): Promise<string | null> {
  const workspaceDir = getWorkspaceDir(taskId);
  const zipPath = path.join(workspaceDir, 'download.zip');
  const { default: archiver } = await import('archiver');

  return new Promise((resolve) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(zipPath));
    archive.on('warning', (err) => logger.warn('ZIP warning', { taskId, error: err.message }));
    archive.on('error', (err) => {
      logger.error('Failed to create ZIP', { taskId, error: err.message });
      resolve(null);
    });

    archive.pipe(output);
    archive.directory(path.join(workspaceDir, 'outputs'), 'outputs');
    archive.file(path.join(workspaceDir, 'manifest.json'), { name: 'manifest.json' });
    archive.file(path.join(workspaceDir, 'agent.log'), { name: 'agent.log' });
    archive.file(path.join(workspaceDir, 'request.json'), { name: 'request.json' });
    archive.finalize();
  });
}

/**
 * Recover tasks from filesystem on server startup.
 * Scans WORKSPACE_ROOT for existing task directories and loads them
 * into memory and SQLite. Any task still marked 'running' is
 * marked as 'interrupted' since the previous process died.
 */
export async function recoverTasks(): Promise<number> {
  let recovered = 0;
  try {
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    for (const dir of dirs) {
      const taskId = dir.name;
      if (tasks.has(taskId)) continue;

      const statusPath = path.join(WORKSPACE_ROOT, taskId, 'status.json');
      try {
        const raw = await fs.readFile(statusPath, 'utf-8');
        const parsed = JSON.parse(raw) as ExecutionState;

        // If it was running when the server died, mark as interrupted
        if (parsed.status === 'running') {
          parsed.status = 'interrupted';
          parsed.error = 'Server restarted while task was running';
          parsed.endTime = Date.now();
          await persistStatus(taskId, parsed);
        }

        tasks.set(taskId, parsed);

        // Sync to SQLite if not already there
        const existing = getDbTask(taskId);
        if (!existing) {
          createTask({
            id: taskId,
            query: parsed.query,
            skillName: parsed.skillName,
            workspacePath: getWorkspaceDir(taskId),
          });
          syncTaskToDb(taskId, parsed);
        }

        recovered++;
      } catch {
        // Not a valid task directory, skip
      }
    }

    if (recovered > 0) {
      logger.info('Recovered tasks from filesystem', { recovered });
    }
  } catch (err) {
    logger.warn('Failed to recover tasks', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return recovered;
}

// In-memory cache cleanup (keeps hot tasks in memory)
setInterval(() => {
  const now = Date.now();
  for (const [taskId, state] of tasks.entries()) {
    if (state.endTime && now - state.endTime > EXECUTION_CONFIG.taskMaxAgeMs) {
      tasks.delete(taskId);
      logger.debug('Cleaned up old task record from memory', { taskId });
    }
  }
}, EXECUTION_CONFIG.cleanupIntervalMs);
