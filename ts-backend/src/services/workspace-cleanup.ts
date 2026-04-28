import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '@/lib/logger.js';
import { WORKSPACE_ROOT, WORKSPACE_CONFIG } from '@/config/index.js';
import { deleteOldTasks, getOldestTasks } from '@/services/db.js';

/**
 * Run workspace cleanup: delete tasks older than maxAgeDays
 * and enforce maxCount limit.
 */
export async function runCleanup(): Promise<{ deleted: number; ids: string[] }> {
  const deletedIds: string[] = [];

  // 1. Age-based cleanup
  const cutoff = Date.now() - WORKSPACE_CONFIG.maxAgeDays * 24 * 60 * 60 * 1000;
  const ageIds = deleteOldTasks(cutoff);
  deletedIds.push(...ageIds);

  // 2. Count-based cleanup: if total still exceeds maxCount, delete oldest
  try {
    const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true });
    const taskDirs = entries.filter((e) => e.isDirectory());
    const excess = taskDirs.length - WORKSPACE_CONFIG.maxCount;

    if (excess > 0) {
      const oldest = getOldestTasks(excess + 10); // fetch a few extra in case some are already gone
      for (const id of oldest) {
        if (deletedIds.includes(id)) continue;
        await deleteWorkspace(id);
        deletedIds.push(id);
        if (deletedIds.length >= taskDirs.length - WORKSPACE_CONFIG.maxCount) break;
      }
    }
  } catch (err) {
    logger.warn('Failed to count workspace directories', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Delete workspace directories for all removed DB records
  for (const id of deletedIds) {
    await deleteWorkspace(id);
  }

  if (deletedIds.length > 0) {
    logger.info('Workspace cleanup completed', { deleted: deletedIds.length });
  }

  return { deleted: deletedIds.length, ids: deletedIds };
}

async function deleteWorkspace(taskId: string): Promise<void> {
  const dir = path.join(WORKSPACE_ROOT, taskId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('Failed to delete workspace directory', {
      taskId,
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Schedule periodic cleanup.
 */
export function scheduleCleanup(): void {
  const interval = WORKSPACE_CONFIG.cleanupIntervalMs;
  setInterval(() => {
    runCleanup().catch((err) => {
      logger.error('Scheduled workspace cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, interval);
  logger.info('Workspace cleanup scheduled', { intervalMs: interval });
}
