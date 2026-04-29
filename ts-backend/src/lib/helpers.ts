/**
 * Shared utility functions used across the codebase.
 * All functions are pure or have minimal, documented side effects.
 */

/** Extract a human-readable message from any thrown value. */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Parse JSON with a fallback value on failure. */
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Truncate a string to maxLen characters. */
export function truncate(str: string, maxLen = 100): string {
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

/** JSON.stringify with standard pretty-print (2-space indent). */
export function prettyJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/** ISO-8601 timestamp string for the current moment. */
export function isoNow(): string {
  return new Date().toISOString();
}
