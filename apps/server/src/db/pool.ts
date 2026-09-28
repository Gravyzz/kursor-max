import pg from 'pg';
import { config } from '../config.js';

// DATE → 'YYYY-MM-DD' без сдвига часового пояса; BIGINT → number (id пользователей MAX < 2^53).
pg.types.setTypeParser(1082, (value) => value);
pg.types.setTypeParser(20, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export type Db = pg.Pool | pg.PoolClient;

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T>(db: Db, text: string, values: unknown[] = []): Promise<T | undefined> {
  const result = await db.query(text, values);
  return result.rows[0] as T | undefined;
}

export async function many<T>(db: Db, text: string, values: unknown[] = []): Promise<T[]> {
  const result = await db.query(text, values);
  return result.rows as T[];
}
