import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { many, one, tx } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { deepLink, getBotIdentity } from '../max/bot.js';
import { audit } from './common.js';
import { ensureInvite } from './identity.js';

/**
 * Кабинет платформы — для команды Курсора: подключить вуз и выдать личную ссылку его администратору.
 * Дальше вуз работает сам: администратор университета подключает факультеты из своего кабинета.
 */

/** id пользователей MAX из PLATFORM_ADMIN_IDS. */
function platformIds(): Set<number> {
  return new Set(config.PLATFORM_ADMIN_IDS.split(/[\s,]+/).filter(Boolean).map(Number));
}

export function isPlatformAdmin(user: { max_user_id: number }): boolean {
  return platformIds().has(Number(user.max_user_id));
}

export function requirePlatform(user: { max_user_id: number }) {
  if (!isPlatformAdmin(user)) throw forbidden('Кабинет платформы открыт только команде Курсора');
}

const TIMEZONES = [
  'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk',
  'Asia/Tomsk', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka',
] as const;

export const universityInputSchema = z.object({
  name: z.string().trim().min(3, 'Название вуза — от 3 символов').max(200),
  shortName: z.string().trim().min(2, 'Короткое название — от 2 символов').max(24, 'Короткое название — до 24 символов'),
  timezone: z.enum(TIMEZONES, { errorMap: () => ({ message: 'Выберите часовой пояс из списка' }) }),
  adminFullName: z.string().trim().min(3, 'Укажите фамилию и имя администратора университета').max(120),
});

export const adminInputSchema = z.object({
  fullName: z.string().trim().min(3, 'Укажите фамилию и имя').max(120),
});

const link = async (code: string) => deepLink(await getBotIdentity(), 'start', `inv_${code}`);

/** Вузы платформы (без демо-песочниц) с администраторами и тем, насколько они уже работают. */
export async function listUniversities(db: Db) {
  const rows = await many<{
    id: string; name: string; short_name: string; timezone: string; created_at: Date;
    faculties: number; base_pages: number; readers: number;
  }>(
    db,
    `SELECT u.id, u.name, u.short_name, u.timezone, u.created_at,
            (SELECT count(*)::int FROM institutes i WHERE i.university_id = u.id) AS faculties,
            (SELECT count(*)::int FROM pages p JOIN handbooks h ON h.id = p.handbook_id
              WHERE h.university_id = u.id AND h.institute_id IS NULL AND p.status = 'published') AS base_pages,
            (SELECT count(*)::int FROM handbook_readers r JOIN handbooks h ON h.id = r.handbook_id WHERE h.university_id = u.id) AS readers
       FROM universities u
      WHERE NOT u.is_demo
      ORDER BY u.created_at DESC`,
  );
  const admins = await many<{ university_id: string; person_id: string; full_name: string; connected: boolean }>(
    db,
    `SELECT r.university_id, p.id AS person_id, p.full_name, (p.user_id IS NOT NULL) AS connected
       FROM org_roles r JOIN persons p ON p.id = r.person_id JOIN universities u ON u.id = r.university_id AND NOT u.is_demo
      WHERE r.role = 'university_admin' AND r.revoked_at IS NULL
      ORDER BY r.created_at`,
  );
  const demo = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM universities WHERE is_demo AND created_at > now() - interval '7 days'");
  return {
    timezones: TIMEZONES,
    demoSandboxes7d: demo?.n ?? 0,
    universities: rows.map((row) => ({
      id: row.id,
      name: row.name,
      shortName: row.short_name,
      timezone: row.timezone,
      createdAt: row.created_at,
      faculties: row.faculties,
      basePages: row.base_pages,
      readers: row.readers,
      admins: admins
        .filter((admin) => admin.university_id === row.id)
        .map((admin) => ({ personId: admin.person_id, name: admin.full_name, connected: admin.connected })),
    })),
  };
}

/** Новый администратор университета: запись вуза, назначение и личная ссылка на 30 дней. */
async function grantUniversityAdmin(client: Db, universityId: string, fullName: string, actorUserId: number) {
  const person = (await one<{ id: string }>(
    client,
    "INSERT INTO persons(university_id, institute_id, role, full_name) VALUES ($1, NULL, 'staff', $2) RETURNING id",
    [universityId, fullName],
  ))!;
  await client.query("INSERT INTO org_roles(person_id, university_id, institute_id, role) VALUES ($1, $2, NULL, 'university_admin')", [person.id, universityId]);
  const code = await ensureInvite(client, person.id, 30);
  await audit(client, { universityId, actorUserId, action: 'platform.admin.grant', entity: 'person', entityId: person.id, data: { fullName } });
  return { personId: person.id, code };
}

/** Подключить вуз: организация, часовой пояс и администратор университета с личной ссылкой. */
export async function createUniversity(db: Db, actorUserId: number, input: z.infer<typeof universityInputSchema>) {
  const result = await tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('platform_university'))");
    const same = await one(client, 'SELECT 1 FROM universities WHERE NOT is_demo AND (lower(name) = lower($1) OR lower(short_name) = lower($2))', [input.name, input.shortName]);
    if (same) throw new AppError('university_exists', 'Вуз с таким названием уже подключён', 409);
    // Тот же код, что у консольной команды bootstrap: повторный bootstrap этого вуза ничего не задвоит
    const code = `uni-${createHash('sha256').update(input.name.toLowerCase()).digest('hex').slice(0, 12)}`;
    const university = (await one<{ id: string }>(
      client,
      'INSERT INTO universities(code, name, short_name, timezone) VALUES ($1, $2, $3, $4) RETURNING id',
      [code, input.name, input.shortName, input.timezone],
    ))!;
    const admin = await grantUniversityAdmin(client, university.id, input.adminFullName, actorUserId);
    await audit(client, { universityId: university.id, actorUserId, action: 'platform.university.create', entity: 'university', entityId: university.id, data: { name: input.name } });
    return { universityId: university.id, ...admin };
  });
  return { universityId: result.universityId, adminPersonId: result.personId, link: await link(result.code) };
}

/** Ещё один администратор университета (например, замена на время отпуска). */
export async function addUniversityAdmin(db: Db, actorUserId: number, universityId: string, input: z.infer<typeof adminInputSchema>) {
  const result = await tx(async (client) => {
    const university = await one(client, 'SELECT 1 FROM universities WHERE id = $1 AND NOT is_demo', [universityId]);
    if (!university) throw notFound('Вуз не найден');
    return grantUniversityAdmin(client, universityId, input.fullName, actorUserId);
  });
  return { adminPersonId: result.personId, link: await link(result.code) };
}

/** Ссылка администратору, который ещё не вошёл: действующая — та же, истёкшая — новая. */
export async function resendUniversityInvite(db: Db, actorUserId: number, personId: string) {
  const result = await tx(async (client) => {
    const person = await one<{ user_id: number | null; university_id: string }>(
      client,
      `SELECT p.user_id, p.university_id FROM persons p
         JOIN org_roles r ON r.person_id = p.id AND r.role = 'university_admin' AND r.revoked_at IS NULL
         JOIN universities u ON u.id = p.university_id AND NOT u.is_demo
        WHERE p.id = $1`,
      [personId],
    );
    if (!person) throw notFound('Администратор не найден');
    if (person.user_id) throw new AppError('already_connected', 'Этот администратор уже вошёл по ссылке', 409);
    const before = await one(client, 'SELECT 1 FROM invites WHERE person_id = $1 AND used_at IS NULL AND expires_at > now()', [personId]);
    const code = await ensureInvite(client, personId, 30);
    const invite = await one<{ expires_at: string }>(client, "SELECT to_char(expires_at, 'YYYY-MM-DD') AS expires_at FROM invites WHERE code = $1", [code]);
    await audit(client, { universityId: person.university_id, actorUserId, action: 'invite.resend', entity: 'person', entityId: personId, data: { renewed: !before } });
    return { code, renewed: !before, expiresAt: invite?.expires_at ?? null };
  });
  return { link: await link(result.code), renewed: result.renewed, expiresAt: result.expiresAt };
}
