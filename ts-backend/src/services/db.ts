import Database from 'better-sqlite3';
import { logger } from '@/lib/logger.js';

let db: Database.Database | null = null;

export interface DbTask {
  id: string;
  query: string;
  skill_name: string;
  subagent: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error_message: string | null;
  artifact_count: number;
  total_size_bytes: number;
  workspace_path: string;
  tool_call_count: number;
}

export interface DbTaskEvent {
  id: number;
  task_id: string;
  event_type: string;
  timestamp: number;
  payload: string | null;
}

export interface CreateTaskInput {
  id: string;
  query: string;
  skillName: string;
  subagent?: string;
  workspacePath: string;
}

export interface ListTasksOptions {
  status?: string;
  skill?: string;
  limit?: number;
  offset?: number;
}

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      subagent TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','interrupted')),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      error_message TEXT,
      artifact_count INTEGER DEFAULT 0,
      total_size_bytes INTEGER DEFAULT 0,
      workspace_path TEXT NOT NULL,
      tool_call_count INTEGER DEFAULT 0
    )
  `);

  // Task events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      payload TEXT
    )
  `);

  // Indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, timestamp)`);

  logger.info('SQLite initialized', { path: dbPath });
  return db;
}

export function getDb(): Database.Database | null {
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite connection closed');
  }
}

// --- Tasks ---

export function createTask(input: CreateTaskInput): void {
  const d = getDb();
  if (!d) throw new Error('Database not initialized. Call initDb() first.');
  const stmt = d.prepare(`
    INSERT INTO tasks (id, query, skill_name, subagent, status, created_at, workspace_path)
    VALUES (?, ?, ?, ?, 'queued', ?, ?)
  `);
  stmt.run(input.id, input.query, input.skillName, input.subagent ?? null, Date.now(), input.workspacePath);
}

export function updateTaskStatus(
  id: string,
  status: DbTask['status'],
  fields?: Partial<Omit<DbTask, 'id' | 'status'>>,
): void {
  const d = getDb();
  if (!d) throw new Error('Database not initialized. Call initDb() first.');
  const updates: string[] = ['status = ?'];
  const values: (string | number | null)[] = [status];

  if (fields) {
    for (const [key, val] of Object.entries(fields)) {
      updates.push(`${key} = ?`);
      values.push(val ?? null);
    }
  }

  values.push(id);
  const stmt = d.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

export function getTask(id: string): DbTask | null {
  const d = getDb();
  if (!d) return null;
  const stmt = d.prepare('SELECT * FROM tasks WHERE id = ?');
  const row = stmt.get(id) as DbTask | undefined;
  return row ?? null;
}

export function listTasks(opts: ListTasksOptions = {}): { tasks: DbTask[]; total: number } {
  const d = getDb();
  if (!d) return { tasks: [], total: 0 };
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (opts.status) {
    conditions.push('status = ?');
    values.push(opts.status);
  }
  if (opts.skill) {
    conditions.push('skill_name = ?');
    values.push(opts.skill);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const countStmt = d.prepare(`SELECT COUNT(*) as total FROM tasks ${where}`);
  const { total } = countStmt.get(...values) as { total: number };

  const query = `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const stmt = d.prepare(query);
  const tasks = stmt.all(...values, limit, offset) as DbTask[];

  return { tasks, total };
}

export function deleteTask(id: string): void {
  const d = getDb();
  if (!d) throw new Error('Database not initialized. Call initDb() first.');
  const stmt = d.prepare('DELETE FROM tasks WHERE id = ?');
  stmt.run(id);
}

export function getRunningTasks(): DbTask[] {
  const d = getDb();
  if (!d) return [];
  const stmt = d.prepare("SELECT * FROM tasks WHERE status = 'running'");
  return stmt.all() as DbTask[];
}

export function getTaskStats(): { total: number; running: number; completed: number; failed: number } {
  const d = getDb();
  if (!d) return { total: 0, running: 0, completed: 0, failed: 0 };
  const stmt = d.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) as running,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
    FROM tasks
  `);
  return stmt.get() as { total: number; running: number; completed: number; failed: number };
}

// --- Events ---

export function recordEvent(
  taskId: string,
  eventType: string,
  payload?: Record<string, unknown>,
): void {
  const d = getDb();
  if (!d) return; // Silently skip if DB not initialized (e.g., tests)
  const stmt = d.prepare(`
    INSERT INTO task_events (task_id, event_type, timestamp, payload)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(taskId, eventType, Date.now(), payload ? JSON.stringify(payload) : null);
}

export function getTaskEvents(taskId: string): DbTaskEvent[] {
  const d = getDb();
  if (!d) return [];
  const stmt = d.prepare(`
    SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp ASC
  `);
  return stmt.all(taskId) as DbTaskEvent[];
}

export function deleteOldTasks(beforeTimestamp: number): string[] {
  const d = getDb();
  if (!d) return [];
  const select = d.prepare('SELECT id FROM tasks WHERE created_at < ?');
  const rows = select.all(beforeTimestamp) as { id: string }[];
  const ids = rows.map((r) => r.id);

  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const del = d.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`);
    del.run(...ids);
    logger.info('Deleted old tasks from database', { count: ids.length });
  }

  return ids;
}

export function getOldestTasks(limit: number): string[] {
  const d = getDb();
  if (!d) return [];
  const stmt = d.prepare('SELECT id FROM tasks ORDER BY created_at ASC LIMIT ?');
  const rows = stmt.all(limit) as { id: string }[];
  return rows.map((r) => r.id);
}
