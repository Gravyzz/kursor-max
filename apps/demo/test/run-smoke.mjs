// Собирает демо-бэкенд под Node теми же подменами, что и браузерную версию, и запускает проверку.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { nodePaths, paths, shimPlugin } from '../esbuild.shared.mjs';

const outfile = path.join(paths.demo, 'test/.smoke.mjs');
await build({
  entryPoints: [path.join(paths.demo, 'test/smoke.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  plugins: [shimPlugin],
  nodePaths,
  loader: { '.sql': 'text' },
  // PGlite в Node сам находит свои файлы рядом с пакетом
  external: ['@electric-sql/pglite', '@electric-sql/pglite/*'],
  logLevel: 'warning',
  banner: { js: "import { Buffer as __B } from 'node:buffer'; globalThis.Buffer ??= __B;" },
});
const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: paths.demo });
process.exit(result.status ?? 1);
