import { createHmac, randomBytes } from 'node:crypto';
import { derivedSecret } from '../config.js';
import type { Db } from '../db/pool.js';
import { many, one, pool, tx } from '../db/pool.js';
import { AppError, forbidden } from '../lib/errors.js';
import type { Role } from '../domain/types.js';
import { audit } from './common.js';
import { enqueue } from '../notify/outbox.js';
import { stripNul } from '../lib/sanitize.js';

export interface MaxUserInput {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  name?: string | null;
}

export interface UserRow {
  id: number;
  max_user_id: number;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  active_person_id: string | null;
}

export interface PersonSummary {
  id: string;
  role: Role;
  fullName: string;
  universityId: string;
  universityName: string;
  universityShortName: string;
  isDemo: boolean;
  instituteId: string | null;
  instituteName: string | null;
  groupName: string | null;
}

export async function upsertUser(db: Db, input: MaxUserInput): Promise<UserRow> {
  // Имя из профиля MAX пишется в базу как есть: нулевой байт в нём уронил бы вход (API-2)
  const user = stripNul(input);
  const firstName = user.first_name ?? user.name ?? null;
  const row = await one<UserRow>(
    db,
    `INSERT INTO users(max_user_id, first_name, last_name, username)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (max_user_id) DO UPDATE
       SET first_name = COALESCE(EXCLUDED.first_name, users.first_name),
           last_name = COALESCE(EXCLUDED.last_name, users.last_name),
           username = COALESCE(EXCLUDED.username, users.username),
           last_seen_at = now()
     RETURNING id, max_user_id, first_name, last_name, username, active_person_id`,
    [user.id, firstName, user.last_name ?? null, user.username ?? null],
  );
  return row!;
}

export async function personsForUser(db: Db, userId: number): Promise<PersonSummary[]> {
  return many<PersonSummary>(
    db,
    `SELECT p.id, p.role, p.full_name AS "fullName", p.university_id AS "universityId",
            u.name AS "universityName", u.short_name AS "universityShortName", u.is_demo AS "isDemo",
            p.institute_id AS "instituteId", i.name AS "instituteName", g.name AS "groupName"
       FROM persons p
       JOIN universities u ON u.id = p.university_id
       LEFT JOIN institutes i ON i.id = p.institute_id
       LEFT JOIN groups g ON g.id = p.group_id
      WHERE p.user_id = $1
      ORDER BY u.is_demo, CASE p.role WHEN 'dean' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END`,
    [userId],
  );
}

/** Выбирает, от чьего имени действует пользователь: явно указанная запись или последняя активная. */
export async function resolvePerson(db: Db, user: UserRow, requestedPersonId?: string | null): Promise<PersonSummary | null> {
  const persons = await personsForUser(db, user.id);
  if (persons.length === 0) return null;
  if (requestedPersonId) {
    const requested = persons.find((person) => person.id === requestedPersonId);
    if (!requested) {
      // Обычная ситуация после пересоздания демо: у открытого приложения остался
      // идентификатор старой роли. Отдельный код нужен, чтобы клиент просто перезагрузился.
      throw new AppError('person_gone', 'Роль недоступна — обновите приложение', 409, { reload: true });
    }
    return requested;
  }
  return persons.find((person) => person.id === user.active_person_id) ?? persons[0]!;
}

export async function setActivePerson(db: Db, userId: number, personId: string): Promise<void> {
  const owned = await one(db, 'SELECT 1 FROM persons WHERE id = $1 AND user_id = $2', [personId, userId]);
  if (!owned) throw forbidden('Эта роль вам недоступна');
  await db.query('UPDATE users SET active_person_id = $2 WHERE id = $1', [userId, personId]);
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateInviteCode(): string {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) code += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length];
  return `H-${code.slice(0, 4)}-${code.slice(4)}`;
}

export const normalizeInviteCode = (raw: string) =>
  raw.trim().toUpperCase().replace(/^INV_/, '').replace(/[^A-Z0-9-]/g, '');

export async function ensureInvite(db: Db, personId: string, validDays = 90): Promise<string> {
  const existing = await one<{ code: string }>(
    db,
    `SELECT code FROM invites WHERE person_id = $1 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [personId],
  );
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInviteCode();
    const inserted = await one<{ code: string }>(
      db,
      `INSERT INTO invites(code, person_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))
       ON CONFLICT (code) DO NOTHING RETURNING code`,
      [code, personId, validDays],
    );
    if (inserted) return inserted.code;
  }
  throw new AppError('invite_generation_failed', 'Не удалось создать приглашение, попробуйте ещё раз', 500);
}

/**
 * Привязка аккаунта MAX к записи вуза по персональному приглашению.
 * notify: false — приветствие покажет сам вызывающий (бот отвечает им сразу), в очередь не кладём.
 */
export async function bindInvite(user: UserRow, rawCode: string, options: { notify?: boolean } = {}): Promise<PersonSummary> {
  const code = normalizeInviteCode(rawCode);
  return tx(async (client) => {
    // Привязки одного аккаунта идут по очереди: иначе две одновременные ссылки одного вуза
    // обошли бы правило «одна запись вуза на аккаунт» (API-17)
    await lockUser(client, user.id);
    const invite = await one<{ person_id: string; expires_at: Date; used_at: Date | null; used_by: number | null }>(
      client,
      'SELECT person_id, expires_at, used_at, used_by FROM invites WHERE code = $1 FOR UPDATE',
      [code],
    );
    if (!invite) throw new AppError('invite_not_found', 'Код приглашения не найден. Проверьте код или попросите новую ссылку', 404);
    if (invite.used_at && invite.used_by !== user.id) {
      throw new AppError('invite_used', 'Эта ссылка уже использована. Если это были не вы — попросите новую', 409);
    }
    // Повторное открытие своей уже принятой ссылки — не ошибка, даже если срок прошёл
    const reopening = Boolean(invite.used_at) && invite.used_by === user.id;
    if (!reopening && invite.expires_at.getTime() < Date.now()) {
      throw new AppError('invite_expired', 'Срок действия ссылки истёк. Попросите новую', 410);
    }
    const person = await one<{ user_id: number | null; university_id: string }>(
      client,
      'SELECT user_id, university_id FROM persons WHERE id = $1 FOR UPDATE',
      [invite.person_id],
    );
    if (person?.user_id && person.user_id !== user.id) {
      throw new AppError('person_already_bound', 'Это приглашение уже принято с другого аккаунта MAX. Попросите новое', 409);
    }
    // Одна запись вуза на аккаунт: иначе участник команды мог бы открыть чужую ссылку-приглашение
    // (например, с правами администратора) и получить её права в дополнение к своим
    if (!person?.user_id) {
      const other = await one(
        client,
        'SELECT 1 FROM persons WHERE user_id = $1 AND university_id = $2 AND id <> $3',
        [user.id, person?.university_id ?? null, invite.person_id],
      );
      if (other) {
        throw new AppError(
          'already_in_university',
          'Ваш аккаунт MAX уже подключён к этому вузу. Эту ссылку должен открыть тот, кому её отправили',
          409,
        );
      }
    }
    const firstBinding = !person?.user_id;
    await client.query('UPDATE persons SET user_id = $1 WHERE id = $2', [user.id, invite.person_id]);
    await client.query('UPDATE invites SET used_at = COALESCE(used_at, now()), used_by = $1 WHERE code = $2', [user.id, code]);
    await client.query('UPDATE users SET active_person_id = $2 WHERE id = $1', [user.id, invite.person_id]);
    await audit(client, {
      universityId: person?.university_id ?? null,
      actorUserId: user.id,
      actorPersonId: invite.person_id,
      action: 'invite.bind',
      entity: 'person',
      entityId: invite.person_id,
    });
    if (firstBinding && options.notify !== false) {
      await enqueue(client, { personId: invite.person_id, kind: 'welcome', payload: {}, dedupeKey: `welcome:${invite.person_id}` });
    }
    const persons = await personsForUser(client, user.id);
    return persons.find((p) => p.id === invite.person_id)!;
  });
}

/** Блокировка аккаунта MAX до конца транзакции: изменения его записей вуза не пересекаются. */
async function lockUser(db: Db, userId: number): Promise<void> {
  await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
}

export function hashPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
  // HMAC с секретом сервера: по утёкшей базе нельзя перебором восстановить номера телефонов
  return createHmac('sha256', derivedSecret('phone')).update(digits).digest('hex');
}

/** Привязка по подтверждённому номеру телефона (WebApp.requestContact + проверка HMAC). */
export async function bindByPhone(user: UserRow, phone: string): Promise<PersonSummary[]> {
  const phoneHash = hashPhone(phone);
  return tx(async (client) => {
    await lockUser(client, user.id);
    const candidates = await many<{ id: string; user_id: number | null; university_id: string }>(
      client,
      'SELECT id, user_id, university_id FROM persons WHERE phone_hash = $1 FOR UPDATE',
      [phoneHash],
    );
    const free = candidates.filter((person) => person.user_id === null || person.user_id === user.id);
    if (free.length === 0) {
      throw new AppError('phone_not_found', 'Номер не найден в списках вуза. Используйте ссылку-приглашение', 404);
    }
    for (const person of free) {
      await client.query('UPDATE persons SET user_id = $1 WHERE id = $2', [user.id, person.id]);
      await audit(client, {
        universityId: person.university_id,
        actorUserId: user.id,
        actorPersonId: person.id,
        action: 'phone.bind',
        entity: 'person',
        entityId: person.id,
      });
      await enqueue(client, { personId: person.id, kind: 'welcome', payload: {}, dedupeKey: `welcome:${person.id}` });
    }
    await client.query('UPDATE users SET active_person_id = $2 WHERE id = $1', [user.id, free[0]!.id]);
    return personsForUser(client, user.id);
  });
}

export async function findUserByMaxId(maxUserId: number): Promise<UserRow | undefined> {
  return one<UserRow>(
    pool,
    'SELECT id, max_user_id, first_name, last_name, username, active_person_id FROM users WHERE max_user_id = $1',
    [maxUserId],
  );
}
