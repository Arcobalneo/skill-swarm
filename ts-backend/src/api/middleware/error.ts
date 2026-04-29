import type { Context, Next } from 'hono';
import { logger } from '@/lib/logger.js';
import { errMsg } from '@/lib/helpers.js';

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (err) {
    const message = errMsg(err);
    logger.error('HTTP error', { path: c.req.path, status: 500, message });
    return c.json({ error: message }, 500);
  }
}
