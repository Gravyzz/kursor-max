/** Журнал в консоль браузера вместо JSON-строк в stdout. */
type Level = 'error' | 'warn' | 'info' | 'debug';
const threshold: Record<Level, number> = { error: 1, warn: 2, info: 3, debug: 4 };
const LEVEL = 2;

export function createLogger(scope: string) {
  const write = (level: Level, message: string, data?: unknown) => {
    if (threshold[level] > LEVEL) return;
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[${scope}] ${message}`, data ?? '');
  };
  return {
    error: (message: string, data?: unknown) => write('error', message, data),
    warn: (message: string, data?: unknown) => write('warn', message, data),
    info: (message: string, data?: unknown) => write('info', message, data),
    debug: (message: string, data?: unknown) => write('debug', message, data),
  };
}
export type Logger = ReturnType<typeof createLogger>;
