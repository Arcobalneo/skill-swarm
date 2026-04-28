import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { routeQuery } from '@/services/router.js';
import { enqueueTask, getStatus, createZip, getWorkspaceDir } from '@/services/task-manager.js';
import { getTaskStats, getTaskEvents, listTasks } from '@/services/db.js';
import { errorHandler } from '@/api/middleware/error.js';
import { validateQueryRequest } from '@/api/middleware/validate.js';
import { logger } from '@/lib/logger.js';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import type { Context } from 'hono';

function getBaseUrl(c: Context): string {
  const host = c.req.header('host') || 'localhost:8000';
  const proto = c.req.header('x-forwarded-proto') || 'http';
  return `${proto}://${host}`;
}

function buildTaskReminder(
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted',
  baseUrl: string,
  taskId: string,
  artifactCount: number,
): { reminder: string; next_step?: string } {
  const statusUrl = `${baseUrl}/api/v1/tasks/${taskId}`;
  const artifactsUrl = `${baseUrl}/api/v1/tasks/${taskId}/artifacts`;
  const eventsUrl = `${baseUrl}/api/v1/tasks/${taskId}/events`;

  switch (status) {
    case 'queued':
      return {
        reminder: `任务已排队，正在等待执行资源。`,
        next_step: `请轮询 GET ${statusUrl} 查询状态，当 status 变为 "completed" 后调用 GET ${artifactsUrl} 获取产物下载链接。`,
      };
    case 'running':
      return {
        reminder: `任务正在执行中，典型耗时 1~4 分钟（复杂任务可能更长）。`,
        next_step: `请继续轮询 GET ${statusUrl} 查询状态，建议间隔 3~5 秒，避免频繁调用。也可 GET ${eventsUrl} 查看实时事件 trace。`,
      };
    case 'completed':
      return {
        reminder: `任务已完成，共产出 ${artifactCount} 个产物。`,
        next_step: `调用 GET ${artifactsUrl} 获取 ZIP 下载链接（30 分钟有效），或 GET ${eventsUrl} 查看执行事件 trace。`,
      };
    case 'failed':
      return {
        reminder: `任务执行失败，请查看 message 和 error 字段了解具体原因。`,
        next_step: `可检查 GET ${statusUrl} 获取完整状态，GET ${eventsUrl} 查看执行 trace，或查看服务端日志排查问题。`,
      };
    case 'interrupted':
      return {
        reminder: `任务在执行过程中被中断（服务器重启）。`,
        next_step: `请重新提交任务。可 GET ${eventsUrl} 查看中断前的执行 trace。`,
      };
    default:
      return { reminder: '' };
  }
}

type Variables = {
  validatedBody: { query: string; product_config?: Record<string, unknown> };
};

const app = new Hono<{ Variables: Variables }>();

app.use('*', cors());
app.use('*', errorHandler);

app.get('/health', (c) => {
  const stats = getTaskStats();
  return c.json({
    status: 'ok',
    timestamp: Date.now(),
    version: '1.0.0',
    db: {
      connected: true,
      tasks_total: stats.total,
      tasks_running: stats.running,
    },
    reminder: '服务正常运行。使用 POST /api/v1/query 提交任务，GET /api/v1/tasks/:task_id 查询状态。',
  });
});

// List tasks with pagination and filtering
app.get('/api/v1/tasks', async (c) => {
  const status = c.req.query('status');
  const skill = c.req.query('skill');
  const limit = Math.min(Number(c.req.query('limit') || 50), 100);
  const offset = Number(c.req.query('offset') || 0);

  const { tasks, total } = listTasks({ status, skill, limit, offset });

  return c.json({
    tasks: tasks.map((t) => ({
      task_id: t.id,
      status: t.status,
      skill: t.skill_name,
      subagent: t.subagent,
      query: t.query.slice(0, 200),
      created_at: t.created_at,
      started_at: t.started_at,
      completed_at: t.completed_at,
      artifact_count: t.artifact_count,
      error_message: t.error_message,
    })),
    total,
    limit,
    offset,
  });
});

app.post('/api/v1/query', validateQueryRequest, async (c) => {
  const body = c.get('validatedBody');
  logger.info('Received query request', { query: body.query.slice(0, 100) });

  const { skill, reasoning, confidence } = await routeQuery(body.query);
  if (!skill) {
    logger.warn('No matching skill found', { query: body.query.slice(0, 100), reasoning });
    return c.json({ error: 'No matching skill found', reasoning }, 400);
  }
  logger.info('Routed to skill', { skill: skill.name, reasoning });

  const taskId = await enqueueTask(body.query, skill.name, body.product_config);
  const baseUrl = getBaseUrl(c);
  const statusUrl = `${baseUrl}/api/v1/tasks/${taskId}`;
  const artifactsUrl = `${baseUrl}/api/v1/tasks/${taskId}/artifacts`;

  const response: Record<string, unknown> = {
    task_id: taskId,
    status: 'queued',
    skill: skill.name,
    routing_reasoning: reasoning,
    reminder: `任务已创建成功，正在排队等待执行。`,
    next_step: `请轮询 GET ${statusUrl} 查询执行状态，当 status 变为 "completed" 后调用 GET ${artifactsUrl} 获取产物 ZIP 下载链接（30分钟有效）。`,
  };
  if (confidence) {
    response.routing_confidence = confidence;
  }

  return c.json(response, 201);
});

app.get('/api/v1/tasks/:task_id', async (c) => {
  const taskId = c.req.param('task_id');
  const state = await getStatus(taskId);
  if (!state) {
    return c.json({ error: 'Task not found' }, 404);
  }
  const baseUrl = getBaseUrl(c);
  const { reminder, next_step } = buildTaskReminder(state.status, baseUrl, taskId, state.artifacts.length);

  return c.json({
    task_id: taskId,
    status: state.status,
    skill: state.skillName,
    query: state.query,
    artifacts: state.artifacts,
    message: state.message,
    error: state.error,
    start_time: state.startTime,
    end_time: state.endTime,
    reminder,
    next_step,
  });
});

// Get task execution events (trace timeline)
app.get('/api/v1/tasks/:task_id/events', async (c) => {
  const taskId = c.req.param('task_id');
  const state = await getStatus(taskId);
  if (!state) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const events = getTaskEvents(taskId);
  return c.json({
    task_id: taskId,
    events: events.map((e) => ({
      id: e.id,
      event_type: e.event_type,
      timestamp: e.timestamp,
      payload: e.payload ? JSON.parse(e.payload) : null,
    })),
  });
});

app.get('/api/v1/tasks/:task_id/artifacts', async (c) => {
  const taskId = c.req.param('task_id');
  const state = await getStatus(taskId);
  if (!state) {
    return c.json({ error: 'Task not found' }, 404);
  }
  if (state.status !== 'completed' && state.status !== 'failed') {
    return c.json({ error: 'Task not finished yet', status: state.status }, 409);
  }
  const zipPath = await createZip(taskId);
  if (!zipPath) {
    return c.json({ error: 'Failed to create download archive' }, 500);
  }
  const expiresAt = Date.now() + 30 * 60 * 1000;
  const baseUrl = getBaseUrl(c);
  return c.json({
    task_id: taskId,
    artifacts: [
      {
        name: 'outputs.zip',
        download_url: `${baseUrl}/api/v1/download/${taskId}?expires=${expiresAt}`,
        expires_at: expiresAt,
      },
    ],
    reminder: `产物打包完成，ZIP 文件包含 outputs/ 目录、manifest.json、agent.log 和执行记录。`,
    next_step: `下载链接有效期 30 分钟（至 ${new Date(expiresAt).toISOString()}），过期后请重新调用本接口生成新链接。`,
  });
});

app.get('/api/v1/download/:task_id', async (c) => {
  const taskId = c.req.param('task_id');
  const expires = Number(c.req.query('expires'));
  if (!expires || Date.now() > expires) {
    const baseUrl = getBaseUrl(c);
    return c.json({
      error: 'Download link expired',
      reminder: '下载链接已过期或无效。',
      next_step: `请重新调用 GET ${baseUrl}/api/v1/tasks/${taskId}/artifacts 生成新的下载链接。`,
    }, 410);
  }
  const state = await getStatus(taskId);
  if (!state) {
    return c.json({ error: 'Task not found' }, 404);
  }
  const zipPath = path.join(getWorkspaceDir(taskId), 'download.zip');
  const stream = createReadStream(zipPath);
  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', `attachment; filename="${taskId}.zip"`);
  return new Response(stream as unknown as ReadableStream, { status: 200 });
});

export default app;
