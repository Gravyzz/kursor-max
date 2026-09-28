import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';

export type NotificationKind =
  | 'welcome'
  | 'handbook_review'
  | 'handbook_answer'
  | 'handbook_announcement'
  | 'handbook_deadline'
  /** Страницу вернули с проверки на доработку: payload { pageId, handbookId, note } — тому, кто отправлял на проверку. */
  | 'handbook_return';

export interface EnqueueInput {
  personId: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  sendAfter?: Date;
  dedupeKey?: string;
}

/**
 * Демо-песочница — игрушка одного человека. Настоящее сообщение от бота из неё получает только её владелец;
 * всем остальным (модельным людям, а также настоящим аккаунтам, которые открыли чужую песочницу по ссылке
 * или приняли приглашение из неё) доставка имитируется. Иначе через демо можно было бы рассылать
 * произвольные тексты от имени официального бота.
 */
export function simulatedInDemo(university: { is_demo: boolean; demo_owner_user_id: number | null }, userId: number | null): boolean {
  if (!university.is_demo) return false;
  return userId === null || university.demo_owner_user_id === null || Number(userId) !== Number(university.demo_owner_user_id);
}

/**
 * Кладёт уведомление в outbox в той же транзакции, что и изменение данных.
 * Если человек не подключён к MAX, запись сразу получает статус failed (not_connected).
 * В демо-вузе доставка настоящим сообщением — только владельцу песочницы, остальным — имитация (simulated).
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<number | null> {
  const person = await one<{ user_id: number | null; university_id: string; is_demo: boolean; demo_owner_user_id: number | null }>(
    db,
    `SELECT p.user_id, p.university_id, un.is_demo, un.demo_owner_user_id
       FROM persons p
       JOIN universities un ON un.id = p.university_id
      WHERE p.id = $1`,
    [input.personId],
  );
  if (!person) return null;

  const sendAfter = input.sendAfter ?? new Date();
  const simulated = simulatedInDemo(person, person.user_id);
  const connected = person.user_id !== null && !simulated;
  const status = connected || simulated ? 'pending' : 'failed';

  const row = await one<{ id: number }>(
    db,
    `INSERT INTO notifications(university_id, person_id, user_id, kind, payload, dedupe_key, send_after, status, simulated, last_error, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (dedupe_key) DO UPDATE
        SET status = EXCLUDED.status, payload = EXCLUDED.payload, send_after = EXCLUDED.send_after,
            simulated = EXCLUDED.simulated, last_error = EXCLUDED.last_error, attempts = 0, claimed_at = NULL
      WHERE notifications.status = 'cancelled'
     RETURNING id`,
    [
      person.university_id,
      input.personId,
      person.user_id,
      input.kind,
      JSON.stringify(input.payload),
      input.dedupeKey ?? null,
      sendAfter,
      status,
      simulated,
      connected || simulated ? null : 'not_connected',
      null,
    ],
  );
  return row?.id ?? null;
}

/** Отменяет ещё не отправленные уведомления по префиксу ключа (например, напоминания отменённой записи). */
export async function cancelPending(db: Db, dedupePrefix: string): Promise<void> {
  await db.query(
    `UPDATE notifications SET status = 'cancelled'
      WHERE status = 'pending' AND dedupe_key LIKE $1`,
    [`${dedupePrefix}%`],
  );
}

export interface EnqueueReaderInput {
  readerId: string;
  userId: number;
  universityId: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  sendAfter?: Date;
  dedupeKey?: string;
}

/**
 * Уведомление читателю справочника. Читатель — любой пользователь MAX, открывший справочник,
 * поэтому person_id остаётся пустым: адресат определяется парой (reader_id, user_id).
 */
export async function enqueueToReader(db: Db, input: EnqueueReaderInput): Promise<number | null> {
  const reader = await one<{ user_id: number; is_demo: boolean; demo_owner_user_id: number | null }>(
    db,
    `SELECT r.user_id, un.is_demo, un.demo_owner_user_id
       FROM handbook_readers r
       JOIN handbooks h ON h.id = r.handbook_id
       JOIN universities un ON un.id = h.university_id
      WHERE r.id = $1`,
    [input.readerId],
  );
  if (!reader) return null;

  // Читатель демо-песочницы, который не её владелец (модельный или посторонний по ссылке), получает имитацию
  const simulated = simulatedInDemo(reader, reader.user_id);

  const row = await one<{ id: number }>(
    db,
    `INSERT INTO notifications(university_id, person_id, reader_id, user_id, kind, payload, dedupe_key, send_after, status, simulated)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, 'pending', $8)
     ON CONFLICT (dedupe_key) DO UPDATE
        SET status = 'pending', payload = EXCLUDED.payload, send_after = EXCLUDED.send_after,
            simulated = EXCLUDED.simulated, last_error = NULL, attempts = 0, claimed_at = NULL
      WHERE notifications.status = 'cancelled'
     RETURNING id`,
    [
      input.universityId,
      input.readerId,
      input.userId,
      input.kind,
      JSON.stringify(input.payload),
      input.dedupeKey ?? null,
      input.sendAfter ?? new Date(),
      simulated,
    ],
  );
  return row?.id ?? null;
}

export async function acknowledge(db: Db, notificationId: number, userId: number, ack: string): Promise<void> {
  await db.query(
    `UPDATE notifications SET acknowledged_at = COALESCE(acknowledged_at, now()), ack = $3
      WHERE id = $1 AND user_id = $2`,
    [notificationId, userId, ack],
  );
}
