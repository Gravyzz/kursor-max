/** Миграции те же, что на сервере: SQL-файлы подключаются в сборку как текст. */
import m001 from '../../../server/migrations/001_platform.sql';
import m002 from '../../../server/migrations/002_handbook.sql';
import m003 from '../../../server/migrations/003_chat_questions.sql';
import m004 from '../../../server/migrations/004_announcements.sql';
import m005 from '../../../server/migrations/005_review_keeps_published.sql';
import m006 from '../../../server/migrations/006_page_return.sql';
import m007 from '../../../server/migrations/007_deadline_block_audience.sql';
import m008 from '../../../server/migrations/008_university_layer.sql';
import m009 from '../../../server/migrations/009_platform_and_faculty_scope.sql';
import m010 from '../../../server/migrations/010_status_actions.sql';
import m011 from '../../../server/migrations/011_close_handbooks.sql';
import m012 from '../../../server/migrations/012_files_and_retract.sql';
import { pool } from './pool';

const MIGRATIONS: Array<[string, string]> = [
  ['001_platform.sql', m001],
  ['002_handbook.sql', m002],
  ['003_chat_questions.sql', m003],
  ['004_announcements.sql', m004],
  ['005_review_keeps_published.sql', m005],
  ['006_page_return.sql', m006],
  ['007_deadline_block_audience.sql', m007],
  ['008_university_layer.sql', m008],
  ['009_platform_and_faculty_scope.sql', m009],
  ['010_status_actions.sql', m010],
  ['011_close_handbooks.sql', m011],
  ['012_files_and_retract.sql', m012],
];

export async function migrate(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Миграция ${name}: ${(error as Error).message}`);
    }
  }
}
