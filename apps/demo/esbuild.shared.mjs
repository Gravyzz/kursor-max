/**
 * Общая настройка сборки демо: серверный код подключается как есть, а модули,
 * завязанные на Node (pg, переменные окружения, stdout, SDK MAX), подменяются браузерными.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const paths = {
  demo: here,
  server: path.resolve(here, '../server'),
  miniapp: path.resolve(here, '../miniapp'),
};

const backend = (file) => path.join(here, 'src/backend', file);
const serverSrc = (file) => path.join(paths.server, 'src', file);

// Серверный модуль → браузерная замена
const REPLACE = new Map([
  [serverSrc('db/pool.ts'), backend('pool.ts')],
  [serverSrc('config.ts'), backend('config.ts')],
  [serverSrc('lib/logger.ts'), backend('logger.ts')],
  [serverSrc('max/bot.ts'), backend('max-bot.ts')],
  [serverSrc('api/server.ts'), backend('api-server.ts')],
  [serverSrc('api/auth.ts'), backend('auth.ts')],
]);

export const shimPlugin = {
  name: 'handbook-demo-shims',
  setup(build) {
    build.onResolve({ filter: /^node:crypto$|^crypto$/ }, () => ({ path: backend('crypto.ts') }));
    build.onResolve({ filter: /^@maxhub\/max-bot-api$/ }, () => ({ path: backend('max-bot-api.ts') }));
    build.onResolve({ filter: /^pg$/ }, (args) => ({ errors: [{ text: `pg не должен попадать в демо (импорт из ${args.importer})` }] }));
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (!args.importer.startsWith(path.join(paths.server, 'src'))) return undefined;
      const target = path.resolve(path.dirname(args.importer), args.path).replace(/\.js$/, '.ts');
      const replacement = REPLACE.get(target);
      return replacement ? { path: replacement } : undefined;
    });
  },
};

export const nodePaths = [
  path.join(paths.demo, 'node_modules'),
  path.join(paths.miniapp, 'node_modules'),
  path.join(paths.server, 'node_modules'),
];
