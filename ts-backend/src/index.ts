import { serve } from '@hono/node-server';
import app from '@/api/index.js';
import { logger } from '@/lib/logger.js';
import { HOST, PORT, DATA_DIR, DATABASE_PATH, WORKSPACE_ROOT } from '@/config/index.js';
import { initDb } from '@/services/db.js';
import { recoverTasks } from '@/services/task-manager.js';
import { scheduleCleanup } from '@/services/workspace-cleanup.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

async function bootstrap(): Promise<void> {
  // 1. Ensure data directories exist
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(path.dirname(DATABASE_PATH), { recursive: true });
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });

  // 2. Initialize SQLite
  initDb(DATABASE_PATH);

  // 3. Recover tasks from previous runs
  await recoverTasks();

  // 4. Schedule workspace cleanup
  scheduleCleanup();

  // 5. Start HTTP server
  serve({
    fetch: app.fetch,
    port: PORT,
    hostname: HOST,
  });

  logger.info('Forge Skill Swarm Backend running', {
    url: `http://${HOST}:${PORT}`,
    dataDir: DATA_DIR,
    dbPath: DATABASE_PATH,
    workspaceRoot: WORKSPACE_ROOT,
  });
}

bootstrap().catch((err) => {
  logger.error('Bootstrap failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
