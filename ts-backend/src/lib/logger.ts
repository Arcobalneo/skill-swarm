export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[MIN_LEVEL];
}

function format(level: LogLevel, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const extra = meta ? ' ' + JSON.stringify(meta) : '';
  return `[${ts}] [${level.toUpperCase()}] ${msg}${extra}`;
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog('debug')) console.debug(format('debug', msg, meta));
  },
  info: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog('info')) console.info(format('info', msg, meta));
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog('warn')) console.warn(format('warn', msg, meta));
  },
  error: (msg: string, meta?: Record<string, unknown>) => {
    if (shouldLog('error')) console.error(format('error', msg, meta));
  },
};
