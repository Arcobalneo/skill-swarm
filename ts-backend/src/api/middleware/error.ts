import type { Context, Next } from 'hono';
import { logger } from '@/lib/logger.js';

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    logger.error('HTTP error', { path: c.req.path, status: 500, message });
    return c.json({ error: message }, 500);
  }
}
