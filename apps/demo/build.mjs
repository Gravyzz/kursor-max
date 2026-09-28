/**
 * Сборка демо в один HTML-файл: мини-приложение и «сервер» (бот, API, воркер, PostgreSQL в WebAssembly)
 * работают в браузере посетителя. Результат — dist/demo.html без внешних зависимостей,
 * кроме шрифтов Google Fonts; тело страницы без <html>/<head> — его оборачивает хостинг артефактов.
 *
 *   npm run build            → dist/demo.html
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { nodePaths, paths, shimPlugin } from './esbuild.shared.mjs';

const require = createRequire(import.meta.url);
const out = path.join(paths.demo, 'dist');
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  write: false,
  minify: true,
  target: ['es2022', 'chrome110', 'safari16', 'firefox115'],
  jsx: 'automatic',
  nodePaths,
  logLevel: 'warning',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  outdir: out,
};

// 1. Мини-приложение — тот же код, что apps/miniapp; запускается во фрейме «телефона»
const app = await build({
  ...common,
  entryPoints: [path.join(paths.demo, 'src/app-entry.tsx')],
  format: 'iife',
  platform: 'browser',
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
});

// 2. Страница-хозяин: чат, «телефон» и весь серверный код поверх PGlite
const host = await build({
  ...common,
  entryPoints: [path.join(paths.demo, 'src/host.tsx')],
  format: 'iife',
  platform: 'browser',
  plugins: [shimPlugin],
  loader: { '.sql': 'text' },
  // PGlite строит адреса своих файлов от import.meta.url; сами файлы мы передаём из страницы,
  // но адрес должен быть корректным — берём адрес документа
  define: { ...common.define, 'import.meta.url': 'document.baseURI' },
  // PGlite содержит ветки для Node — в браузере они не выполняются
  external: ['fs', 'fs/promises', 'path', 'url', 'module', 'crypto', 'child_process', 'worker_threads', 'os', 'util', 'stream', 'zlib'],
  mainFields: ['browser', 'module', 'main'],
});

const pick = (result, ext) => {
  const file = result.outputFiles.find((f) => f.path.endsWith(ext));
  if (!file) throw new Error(`Нет выходного файла ${ext}`);
  return file.text;
};
// Внутри <script> последовательность «</script» закрыла бы тег раньше времени
const safe = (text) => text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

const pgliteDir = path.dirname(require.resolve('@electric-sql/pglite'));
const gz64 = async (file) => gzipSync(await readFile(path.join(pgliteDir, file)), { level: 9 }).toString('base64');
const raw64 = async (file) => (await readFile(path.join(pgliteDir, file))).toString('base64');

const [wasm, initdb, data, trgm] = await Promise.all([gz64('pglite.wasm'), gz64('initdb.wasm'), gz64('pglite.data'), raw64('pg_trgm.tar.gz')]);

const blob = (id, text) => `<script type="application/octet-stream" id="${id}">${text}</script>`;

const html = `<title>Курсор — демо</title>
<meta name="description" content="Демо Курсора — конструктора справочников для факультетов в MAX: сервер, база данных и бот работают прямо в браузере.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap">
<style>${pick(host, '.css')}</style>
<div id="host"></div>
${blob('pg-wasm', wasm)}
${blob('pg-initdb', initdb)}
${blob('pg-data', data)}
${blob('pg-trgm', trgm)}
<script type="text/plain" id="app-css">${safe(pick(app, '.css'))}</script>
<script type="text/plain" id="app-js">${safe(pick(app, '.js'))}</script>
<script>${safe(pick(host, '.js'))}</script>
`;

const target = path.join(out, 'demo.html');
await writeFile(target, html);
const mb = (n) => (n / 1024 / 1024).toFixed(2);
console.log(`dist/demo.html: ${mb(Buffer.byteLength(html))} МБ (PostgreSQL ${mb(wasm.length + initdb.length + data.length)} МБ, мини-приложение ${mb(pick(app, '.js').length)} МБ, хост ${mb(pick(host, '.js').length)} МБ)`);
