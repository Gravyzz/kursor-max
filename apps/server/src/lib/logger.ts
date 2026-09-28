import { config } from '../config.js';

type Level = 'error' | 'warn' | 'info' | 'debug';
const order: Record<string, number> = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5, silent: -1 };

function write(level: Level, scope: string, message: string, data?: unknown) {
  const threshold = order[config.LOG_LEVEL] ?? 3;
  if (threshold < 0 || (order[level] ?? 3) > threshold) return;
  const line = {
    time: new Date().toISOString(),
    level,
    scope,
    message,
    ...(data === undefined ? {} : { data: data instanceof Error ? { name: data.name, message: data.message } : data }),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export function createLogger(scope: string) {
  return {
    error: (message: string, data?: unknown) => write('error', scope, message, data),
    warn: (message: string, data?: unknown) => write('warn', scope, message, data),
    info: (message: string, data?: unknown) => write('info', scope, message, data),
    debug: (message: string, data?: unknown) => write('debug', scope, message, data),
  };
}
export type Logger = ReturnType<typeof createLogger>;
