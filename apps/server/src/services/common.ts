import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';
import { notFound } from '../lib/errors.js';

export interface UniversityInfo {
  id: string;
  name: string;
  shortName: string;
  timezone: string;
  isDemo: boolean;
}

export async function getUniversity(db: Db, id: string): Promise<UniversityInfo> {
  const row = await one<{ id: string; name: string; short_name: string; timezone: string; is_demo: boolean }>(
    db,
    'SELECT id, name, short_name, timezone, is_demo FROM universities WHERE id = $1',
    [id],
  );
  if (!row) throw notFound('Вуз не найден');
  return { id: row.id, name: row.name, shortName: row.short_name, timezone: row.timezone, isDemo: row.is_demo };
}

export async function audit(
  db: Db,
  entry: {
    universityId: string | null;
    actorPersonId?: string | null;
    actorUserId?: number | null;
    action: string;
    entity: string;
    entityId?: string | null;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log(university_id, actor_person_id, actor_user_id, action, entity, entity_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.universityId,
      entry.actorPersonId ?? null,
      entry.actorUserId ?? null,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      JSON.stringify(entry.data ?? {}),
    ],
  );
}

export function shortName(fullName: string): string {
  const [last, first, middle] = fullName.trim().split(/\s+/);
  if (!last) return fullName;
  const initials = [first, middle].filter(Boolean).map((part) => `${part![0]}.`).join(' ');
  return initials ? `${last} ${initials}` : last;
}
