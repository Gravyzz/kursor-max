/**
 * Запуск «сервера» в браузере: PostgreSQL (PGlite) из встроенных в страницу файлов,
 * миграции репозитория, демо-вуз через настоящий /start demo бота и воркер уведомлений.
 */
import { Buffer } from 'buffer';
import { closeDatabase, openDatabase, serial } from './backend/pool';
import { migrate } from './backend/migrate';
import { chat, startBot, startWorker, stopWorker } from './backend/chat';
import { setLaunchParam } from './backend/auth';

export type Stage = 'engine' | 'database' | 'schema' | 'university' | 'ready';

export const STAGES: Array<{ id: Exclude<Stage, 'ready'>; label: string }> = [
  { id: 'engine', label: 'Запускаю PostgreSQL в браузере' },
  { id: 'database', label: 'Создаю базу данных' },
  { id: 'schema', label: 'Применяю миграции из репозитория' },
  { id: 'university', label: 'Бот создаёт модельный университет' },
];

const TRGM_URL = 'https://demo.invalid/pg_trgm.tar.gz';

interface Assets {
  pglite: WebAssembly.Module;
  initdb: WebAssembly.Module;
  data: Blob;
  trgm: Uint8Array;
}

let assets: Assets | null = null;

function base64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (native) return native(text);
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Встроенный файл: base64 внутри <script type="application/octet-stream">. После чтения освобождаем память. */
function embedded(id: string): Uint8Array {
  const element = document.getElementById(id);
  const text = element?.textContent?.trim();
  if (!text) throw new Error(`В странице нет встроенного файла ${id}`);
  const bytes = base64(text);
  element!.textContent = '';
  return bytes;
}

async function loadAssets(): Promise<Assets> {
  if (assets) return assets;
  const [wasm, initdb, data] = await Promise.all([
    gunzip(embedded('pg-wasm')),
    gunzip(embedded('pg-initdb')),
    gunzip(embedded('pg-data')),
  ]);
  const [pglite, initdbModule] = await Promise.all([WebAssembly.compile(wasm), WebAssembly.compile(initdb)]);
  assets = { pglite, initdb: initdbModule, data: new Blob([data]), trgm: embedded('pg-trgm') };
  return assets;
}

// PGlite скачивает архивы расширений через fetch: отдаём pg_trgm из памяти, без сети
let fetchPatched = false;
function patchFetch() {
  if (fetchPatched) return;
  fetchPatched = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === TRGM_URL && assets) {
      return Promise.resolve(new Response(assets.trgm.slice(), { status: 200, headers: { 'content-type': 'application/gzip' } }));
    }
    return original(input, init);
  };
}

export async function boot(onStage: (stage: Stage) => void): Promise<void> {
  onStage('engine');
  patchFetch();
  const loaded = await loadAssets();

  onStage('database');
  await openDatabase({
    pgliteWasmModule: loaded.pglite,
    initdbWasmModule: loaded.initdb,
    fsBundle: loaded.data,
    trgmBundleUrl: TRGM_URL,
  });
  // Серверный код QR-отметки читает байты подписи через Buffer
  (globalThis as unknown as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

  onStage('schema');
  await serial(() => migrate());

  onStage('university');
  setLaunchParam(null);
  // Сразу открываем демо за деканат — телефон не пустой; роль меняется кнопкой «Сменить роль» в чате
  await startBot('demo_dean');
  startWorker();

  onStage('ready');
}

/** «Начать заново»: новая пустая база, заново /start demo. */
export async function restart(onStage: (stage: Stage) => void): Promise<void> {
  stopWorker();
  await serial(async () => {
    await closeDatabase();
  });
  chat.clear();
  await boot(onStage);
}
