/**
 * Замена db/pool.ts: тот же интерфейс, что у node-postgres (query → { rows, rowCount }),
 * но поверх PGlite — настоящего PostgreSQL, собранного в WebAssembly.
 *
 * В браузере одно соединение, поэтому все входы (API, бот, воркер) выполняются
 * строго по очереди (см. serial), а вложенные транзакции превращаются в точки сохранения.
 */
import { PGlite } from '@electric-sql/pglite';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export interface PoolClient extends Queryable {
  release(): void;
}

let db: PGlite | null = null;

export interface DatabaseAssets {
  pgliteWasmModule?: WebAssembly.Module;
  initdbWasmModule?: WebAssembly.Module;
  fsBundle?: Blob;
  /** Адрес архива расширения pg_trgm (опечаточный поиск); без него поиск работает без опечаток. */
  trgmBundleUrl?: string;
  /** Для проверки в Node: расширения из пакета PGlite. */
  extensions?: Record<string, unknown>;
}

export async function openDatabase(assets: DatabaseAssets = {}): Promise<void> {
  const extensions =
    assets.extensions ??
    (assets.trgmBundleUrl
      ? { pg_trgm: { name: 'pg_trgm', setup: async () => ({ bundlePath: new URL(assets.trgmBundleUrl!) }) } }
      : {});
  db = await PGlite.create({
    ...(assets.pgliteWasmModule ? { pgliteWasmModule: assets.pgliteWasmModule } : {}),
    ...(assets.initdbWasmModule ? { initdbWasmModule: assets.initdbWasmModule } : {}),
    ...(assets.fsBundle ? { fsBundle: assets.fsBundle } : {}),
    extensions: extensions as never,
    // Как на сервере: DATE → 'ГГГГ-ММ-ДД' без сдвига часового пояса, BIGINT → number
    parsers: { 1082: (value: string) => value, 20: (value: string) => Number(value) },
  });
}

export async function closeDatabase(): Promise<void> {
  if (db) await db.close();
  db = null;
}

function database(): PGlite {
  if (!db) throw new Error('База ещё не запущена');
  return db;
}

// node-postgres сам приводит undefined к NULL; PGlite — нет
const normalize = (value: unknown) => (value === undefined ? null : value);

async function run<T>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
  const pg = database();
  if (values && values.length > 0) {
    const result = await pg.query<T>(text, values.map(normalize));
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
  // Без параметров — простой протокол: так выполняются миграции из нескольких команд
  const results = await pg.exec(text);
  const last = results[results.length - 1];
  return { rows: (last?.rows ?? []) as T[], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 };
}

const client: PoolClient = {
  query: run,
  release() {
    // одно соединение на всё приложение
  },
};

export const pool = {
  query: run,
  async connect(): Promise<PoolClient> {
    return client;
  },
  async end(): Promise<void> {
    await closeDatabase();
  },
};

export type Db = Queryable;

let depth = 0;

export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (depth > 0) {
    // Вложенная транзакция: на сервере это было бы отдельное соединение, здесь — точка сохранения
    const name = `sp_${depth}`;
    depth += 1;
    await run(`SAVEPOINT ${name}`);
    try {
      const result = await fn(client);
      await run(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await run(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
      throw error;
    } finally {
      depth -= 1;
    }
  }
  depth += 1;
  await run('BEGIN');
  try {
    const result = await fn(client);
    await run('COMMIT');
    return result;
  } catch (error) {
    await run('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    depth -= 1;
  }
}

export async function one<T>(db: Db, text: string, values: unknown[] = []): Promise<T | undefined> {
  const result = await db.query<T>(text, values);
  return result.rows[0];
}

export async function many<T>(db: Db, text: string, values: unknown[] = []): Promise<T[]> {
  const result = await db.query<T>(text, values);
  return result.rows;
}

/**
 * Очередь входов: запросы мини-приложения, сообщения боту и тики воркера
 * выполняются по одному, как если бы каждый держал своё соединение с сервером.
 */
let chain: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}
