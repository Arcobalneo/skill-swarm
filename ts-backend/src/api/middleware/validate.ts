import type { Context, Next } from 'hono';

export async function validateQueryRequest(c: Context, next: Next) {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.query !== 'string' || body.query.length === 0) {
    return c.json({ error: "Missing or invalid 'query' field (must be non-empty string)" }, 400);
  }
  c.set('validatedBody', body);
  await next();
}
