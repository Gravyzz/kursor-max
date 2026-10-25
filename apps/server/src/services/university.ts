import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { many, one, tx } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { audit, getUniversity, shortName } from './common.js';
import { ensureInvite, type UserRow } from './identity.js';
import { createHandbookIn } from './handbook-editor.js';
import { RETENTION_DAYS, closedFaculties } from './lifecycle.js';
import { slugify } from '../domain/handbook.js';
import { todayIn } from '../domain/dates.js';
import { deepLink, getBotIdentity } from '../max/bot.js';

/**
 * Пространство университета: администратор ведёт общую базу, подключает факультеты
 * и назначает их администраторов. Права — назначение org_roles, а не поле записи вуза.
 */

export interface UniversityScope {
  universityId: string;
  personId: string;
  userId: number;
  name: string;
  shortName: string;
  isDemo: boolean;
}

/**
 * Университет, которым пользователь управляет. Записей в разных вузах может быть несколько:
 * сначала — вуз активной записи, затем любой, где есть действующее назначение.
 */
export async function universityRole(db: Db, user: UserRow, activePersonId?: string | null): Promise<UniversityScope | null> {
  const row = await one<{ university_id: string; person_id: string; name: string; short_name: string; is_demo: boolean }>(
    db,
    `SELECT r.university_id, r.person_id, u.name, u.short_name, u.is_demo
       FROM org_roles r JOIN persons p ON p.id = r.person_id JOIN universities u ON u.id = r.university_id
      WHERE p.user_id = $1 AND r.role = 'university_admin' AND r.revoked_at IS NULL AND p.university_id = r.university_id
      ORDER BY (p.id = $2) DESC, r.created_at
      LIMIT 1`,
    [user.id, activePersonId ?? null],
  );
  return row ? { universityId: row.university_id, personId: row.person_id, userId: user.id, name: row.name, shortName: row.short_name, isDemo: row.is_demo } : null;
}

export async function requireUniversity(db: Db, user: UserRow, activePersonId?: string | null): Promise<UniversityScope> {
  const scope = await universityRole(db, user, activePersonId);
  if (!scope) throw forbidden('Кабинет открыт администратору университета. Доступ выдаёт команда Курсора личной ссылкой');
  return scope;
}

/**
 * Общая база вуза; если её ещё нет — создаётся пустой. Справочники факультетов, созданные раньше базы,
 * подключаются к ней: студенты начнут видеть общие страницы по мере их публикации.
 */
export async function ensureBase(db: Db, scope: UniversityScope): Promise<string> {
  return tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hb_base:${scope.universityId}`]);
    const existing = await one<{ id: string }>(
      client,
      "SELECT id FROM handbooks WHERE university_id = $1 AND institute_id IS NULL AND status = 'active' ORDER BY created_at LIMIT 1",
      [scope.universityId],
    );
    if (existing) return existing.id;
    const code = await one<{ code: string }>(client, 'SELECT code FROM universities WHERE id = $1', [scope.universityId]);
    let slug = `base-${slugify(code?.code ?? scope.shortName, 'vuz')}`;
    for (let i = 2; await one(client, 'SELECT 1 FROM handbooks WHERE slug = $1', [slug]); i += 1) slug = `base-${slugify(code?.code ?? scope.shortName, 'vuz')}-${i}`;
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO handbooks(university_id, institute_id, parent_id, slug, title, subtitle, emoji)
       VALUES ($1, NULL, NULL, $2, 'Общая база', $3, '🏛') RETURNING id`,
      [scope.universityId, slug, `Единые инструкции · ${scope.shortName}`],
    );
    await client.query(
      "UPDATE handbooks SET parent_id = $2 WHERE university_id = $1 AND institute_id IS NOT NULL AND parent_id IS NULL AND status = 'active'",
      [scope.universityId, row!.id],
    );
    await audit(client, { universityId: scope.universityId, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'university.base.create', entity: 'handbook', entityId: row!.id });
    return row!.id;
  });
}

/** Ответ «Обзора»: что подключено, что требует внимания, что недавно изменилось. */
export async function overview(db: Db, scope: UniversityScope) {
  const baseId = await ensureBase(db, scope);
  const university = await getUniversity(db, scope.universityId);
  const today = todayIn(university.timezone);
  const base = await one<{ published: number; drafts: number; review: number; overdue: number; soon: number; fresh: number }>(
    db,
    `SELECT count(*) FILTER (WHERE status = 'published')::int AS published,
            count(*) FILTER (WHERE status IN ('draft', 'review') OR (status = 'published' AND draft_blocks IS NOT NULL AND review_requested_at IS NULL))::int AS drafts,
            count(*) FILTER (WHERE status = 'review' OR (status = 'published' AND review_requested_at IS NOT NULL))::int AS review,
            count(*) FILTER (WHERE status = 'published' AND review_at < $2::date)::int AS overdue,
            count(*) FILTER (WHERE status = 'published' AND review_at >= $2::date AND review_at <= ($2::date + 14))::int AS soon,
            count(*) FILTER (WHERE status = 'published' AND (review_at IS NULL OR review_at >= $2::date))::int AS fresh
       FROM pages WHERE handbook_id = $1`,
    [baseId, today],
  );
  const due = await many<{ id: string; title: string; review_at: string; owner_unit: string | null; total: number }>(
    db,
    `SELECT id, title, to_char(review_at, 'YYYY-MM-DD') AS review_at, owner_unit, count(*) OVER ()::int AS total FROM pages
      WHERE handbook_id = $1 AND status = 'published' AND review_at <= ($2::date + 14)
      ORDER BY review_at LIMIT 5`,
    [baseId, today],
  );
  const faculties = await many<{ id: string; short_name: string }>(
    db,
    // Факультет подключён, как только заведён: справочник деканат может создать позже
    `SELECT i.id, i.short_name FROM institutes i WHERE i.university_id = $1 AND i.closed_at IS NULL ORDER BY i.short_name`,
    [scope.universityId],
  );
  const behind = await many<{ page_id: string; title: string; handbook_title: string; short_name: string; changed_at: Date | null; total: number }>(
    db,
    `SELECT ov.id AS page_id, bp.title, h.title AS handbook_title, i.short_name,
            (SELECT max(v.created_at) FROM page_versions v WHERE v.page_id = bp.id) AS changed_at, count(*) OVER ()::int AS total
       FROM pages ov JOIN pages bp ON bp.id = ov.inherited_from AND bp.handbook_id = $1 AND bp.status = 'published'
       JOIN handbooks h ON h.id = ov.handbook_id AND h.status = 'active' JOIN institutes i ON i.id = h.institute_id
      WHERE ov.status <> 'archived' AND COALESCE(ov.base_version, 0) < bp.version_no
      ORDER BY changed_at DESC NULLS LAST LIMIT 5`,
    [baseId],
  );
  const pending = await many<{ person_id: string; full_name: string; short_name: string | null; created_at: Date; total: number }>(
    db,
    `SELECT p.id AS person_id, p.full_name, i.short_name, r.created_at, count(*) OVER ()::int AS total
       FROM org_roles r JOIN persons p ON p.id = r.person_id LEFT JOIN institutes i ON i.id = r.institute_id
      WHERE r.university_id = $1 AND r.revoked_at IS NULL AND p.user_id IS NULL AND i.closed_at IS NULL
      ORDER BY r.created_at LIMIT 5`,
    [scope.universityId],
  );
  const found = await one<{ searches: number; found: number }>(
    db,
    `SELECT count(*)::int AS searches, count(*) FILTER (WHERE l.results > 0)::int AS found
       FROM search_log l JOIN handbooks h ON h.id = l.handbook_id
      WHERE h.university_id = $1 AND l.normalized <> '' AND l.created_at > now() - interval '30 days'`,
    [scope.universityId],
  );
  return {
    university: { id: scope.universityId, name: scope.name, shortName: scope.shortName, isDemo: scope.isDemo },
    today,
    baseHandbookId: baseId,
    base: {
      published: base?.published ?? 0,
      drafts: base?.drafts ?? 0,
      review: base?.review ?? 0,
      overdue: base?.overdue ?? 0,
      soon: base?.soon ?? 0,
      freshShare: base?.published ? Math.round(((base.fresh ?? 0) / base.published) * 100) : null,
    },
    faculties: faculties.map((row) => ({ id: row.id, shortName: row.short_name })),
    foundShare: found?.searches ? Math.round((found.found / found.searches) * 100) : null,
    searches: found?.searches ?? 0,
    attention: {
      due: due.map((row) => ({ id: row.id, title: row.title, reviewAt: row.review_at, ownerUnit: row.owner_unit, overdue: row.review_at < today })),
      behind: behind.map((row) => ({ pageId: row.page_id, title: row.title, handbook: row.handbook_title, shortName: row.short_name, changedAt: row.changed_at })),
      pendingInvites: pending.map((row) => ({ personId: row.person_id, name: shortName(row.full_name), faculty: row.short_name, since: row.created_at })),
      /** Полные числа: в списках выше — не больше пяти строк. */
      totals: { due: due[0]?.total ?? 0, behind: behind[0]?.total ?? 0, pendingInvites: pending[0]?.total ?? 0 },
    },
    recent: await recentChanges(db, scope.universityId, baseId),
  };
}

/** Лента «Последние изменения»: публикации общей базы, уточнения и свои версии факультетов. */
async function recentChanges(db: Db, universityId: string, baseId: string) {
  const rows = await many<{ action: string; at: Date; actor: string | null; title: string | null; handbook: string | null; short_name: string | null; data: Record<string, unknown> }>(
    db,
    `SELECT a.action, a.at, p.full_name AS actor, a.data,
            COALESCE(pg.title, bp.title) AS title, h.title AS handbook, i.short_name
       FROM audit_log a
       LEFT JOIN persons p ON p.id = a.actor_person_id
       LEFT JOIN pages pg ON a.entity = 'page' AND pg.id::text = a.entity_id
       LEFT JOIN page_supplements s ON a.entity = 'page_supplement' AND s.id::text = a.entity_id
       LEFT JOIN pages bp ON bp.id = s.base_page_id
       LEFT JOIN handbooks h ON h.id = COALESCE(pg.handbook_id, s.handbook_id)
       LEFT JOIN institutes i ON i.id = h.institute_id
      WHERE a.university_id = $1
        AND a.action IN ('handbook.page.publish', 'supplement.publish', 'override.create', 'override.revert', 'override.ack', 'handbook.page.verify', 'university.faculty.create')
        AND (a.action <> 'handbook.page.publish' OR pg.handbook_id = $2)
      ORDER BY a.at DESC LIMIT 6`,
    [universityId, baseId],
  );
  const text: Record<string, string> = {
    'handbook.page.publish': 'Общая часть обновлена',
    'supplement.publish': 'Уточнение опубликовано',
    'override.create': 'Создана своя версия',
    'override.revert': 'Вернулись к общей версии',
    'override.ack': 'Своя версия сверена с общей',
    'handbook.page.verify': 'Актуальность подтверждена',
    'university.faculty.create': 'Подключён факультет',
  };
  return rows.map((row) => ({
    action: row.action,
    what: text[row.action] ?? row.action,
    title: row.action === 'university.faculty.create' ? String(row.data?.name ?? '') : row.title,
    faculty: row.action === 'handbook.page.publish' || row.action === 'handbook.page.verify' ? null : row.short_name ?? (row.data?.shortName ? String(row.data.shortName) : null),
    affected: typeof row.data?.faculties === 'number' ? row.data.faculties : null,
    actor: row.actor ? shortName(row.actor) : null,
    at: row.at,
  }));
}

/** Факультеты с их справочниками, администраторами и состоянием по общей базе. */
export async function listFaculties(db: Db, scope: UniversityScope) {
  const baseId = await ensureBase(db, scope);
  const identity = await getBotIdentity();
  const today = todayIn((await getUniversity(db, scope.universityId)).timezone);
  const rows = await many<{
    id: string; name: string; short_name: string; handbook_id: string | null; handbook_title: string | null; handbook_slug: string | null;
    own: number; supplements: number; overrides: number; behind: number; published: number; fresh: number; readers: number;
  }>(
    db,
    `SELECT i.id, i.name, i.short_name, h.id AS handbook_id, h.title AS handbook_title, h.slug AS handbook_slug,
            (SELECT count(*)::int FROM pages p WHERE p.handbook_id = h.id AND p.status = 'published' AND p.inherited_from IS NULL) AS own,
            (SELECT count(*)::int FROM page_supplements s WHERE s.handbook_id = h.id AND s.status = 'published') AS supplements,
            (SELECT count(*)::int FROM pages p WHERE p.handbook_id = h.id AND p.inherited_from IS NOT NULL AND p.status <> 'archived') AS overrides,
            (SELECT count(*)::int FROM pages p JOIN pages bp ON bp.id = p.inherited_from
              WHERE p.handbook_id = h.id AND p.status <> 'archived' AND COALESCE(p.base_version, 0) < bp.version_no) AS behind,
            (SELECT count(*)::int FROM pages p WHERE p.handbook_id = h.id AND p.status = 'published') AS published,
            (SELECT count(*)::int FROM pages p WHERE p.handbook_id = h.id AND p.status = 'published' AND (p.review_at IS NULL OR p.review_at >= $2::date)) AS fresh,
            (SELECT count(*)::int FROM handbook_readers r WHERE r.handbook_id = h.id) AS readers
       FROM institutes i
       LEFT JOIN LATERAL (SELECT * FROM handbooks hh WHERE hh.institute_id = i.id AND hh.status = 'active' ORDER BY hh.created_at LIMIT 1) h ON true
      WHERE i.university_id = $1 AND i.closed_at IS NULL
      ORDER BY i.short_name`,
    [scope.universityId, today],
  );
  const admins = await many<{ institute_id: string; person_id: string; full_name: string; connected: boolean; code: string | null }>(
    db,
    `SELECT DISTINCT ON (x.institute_id, p.id) x.institute_id, p.id AS person_id, p.full_name, (p.user_id IS NOT NULL) AS connected,
            (SELECT iv.code FROM invites iv WHERE iv.person_id = p.id AND iv.used_at IS NULL AND iv.expires_at > now() ORDER BY iv.created_at DESC LIMIT 1) AS code
       FROM (SELECT r.institute_id, r.person_id FROM org_roles r WHERE r.university_id = $1 AND r.role = 'faculty_admin' AND r.revoked_at IS NULL
              UNION SELECT p.institute_id, p.id FROM persons p WHERE p.university_id = $1 AND p.role = 'dean' AND p.institute_id IS NOT NULL) x
       JOIN persons p ON p.id = x.person_id
      ORDER BY x.institute_id, p.id`,
    [scope.universityId],
  );
  const basePublished = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM pages WHERE handbook_id = $1 AND status = 'published'", [baseId]);
  return {
    baseHandbookId: baseId,
    basePublished: basePublished?.n ?? 0,
    /** Отключённые факультеты: их можно восстановить, пока не истёк срок хранения. */
    closed: await closedFaculties(db, scope.universityId),
    retentionDays: RETENTION_DAYS,
    faculties: rows.map((row) => ({
      id: row.id,
      name: row.name,
      shortName: row.short_name,
      handbook: row.handbook_id ? { id: row.handbook_id, title: row.handbook_title, slug: row.handbook_slug, link: deepLink(identity, 'start', `hb_${row.handbook_slug}`) } : null,
      ownPages: row.own,
      supplements: row.supplements,
      overrides: row.overrides,
      behind: row.behind,
      readers: row.readers,
      freshShare: row.published ? Math.round((row.fresh / row.published) * 100) : null,
      admins: admins
        .filter((admin) => admin.institute_id === row.id)
        .map((admin) => ({
          personId: admin.person_id,
          name: admin.full_name,
          connected: admin.connected,
          link: !admin.connected && admin.code ? deepLink(identity, 'start', `inv_${admin.code}`) : null,
        })),
    })),
  };
}

export const facultyInputSchema = z.object({
  name: z.string().trim().min(3, 'Название факультета — от 3 символов').max(160),
  shortName: z.string().trim().min(2, 'Короткое название — от 2 символов').max(16, 'Короткое название — до 16 символов'),
  adminFullName: z.string().trim().min(3, 'Укажите имя и фамилию администратора').max(120),
  template: z.boolean().optional(),
});

/**
 * Подключить факультет: институт, справочник с общей базой и личное приглашение администратору —
 * одной транзакцией. Администратор открывает ссылку в MAX и сразу ведёт справочник факультета.
 */
export async function createFaculty(db: Db, scope: UniversityScope, input: z.infer<typeof facultyInputSchema>) {
  await ensureBase(db, scope);
  return tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`uni_faculty:${scope.universityId}`]);
    const same = await one<{ closed: boolean }>(
      client,
      'SELECT (closed_at IS NOT NULL) AS closed FROM institutes WHERE university_id = $1 AND purged_at IS NULL AND (lower(name) = lower($2) OR lower(short_name) = lower($3)) LIMIT 1',
      [scope.universityId, input.name, input.shortName],
    );
    if (same?.closed) throw new AppError('faculty_closed', 'Факультет с таким названием отключён — восстановите его в списке «Отключённые»: справочник и команда вернутся', 409);
    if (same) throw new AppError('faculty_exists', 'Факультет с таким названием уже подключён', 409);
    const institute = await one<{ id: string }>(
      client, 'INSERT INTO institutes(university_id, name, short_name) VALUES ($1, $2, $3) RETURNING id', [scope.universityId, input.name, input.shortName],
    );
    const admin = await one<{ id: string }>(
      client,
      "INSERT INTO persons(university_id, institute_id, role, full_name) VALUES ($1, $2, 'dean', $3) RETURNING id",
      [scope.universityId, institute!.id, input.adminFullName],
    );
    await client.query(
      "INSERT INTO org_roles(person_id, university_id, institute_id, role, granted_by) VALUES ($1, $2, $3, 'faculty_admin', $4)",
      [admin!.id, scope.universityId, institute!.id, scope.personId],
    );
    const handbook = await createHandbookIn(client, {
      instituteId: institute!.id,
      title: `Справочник ${input.shortName}`,
      subtitle: input.name,
      template: input.template !== false,
      inherit: true,
      universityId: scope.universityId,
      ownerPersonId: admin!.id,
      actorUserId: scope.userId,
    });
    const code = await ensureInvite(client, admin!.id, 30);
    const identity = await getBotIdentity();
    await audit(client, {
      universityId: scope.universityId, actorPersonId: scope.personId, actorUserId: scope.userId,
      action: 'university.faculty.create', entity: 'institute', entityId: institute!.id,
      data: { name: input.name, shortName: input.shortName, handbookId: handbook.id, admin: input.adminFullName, skipped: handbook.skipped ?? 0 },
    });
    return {
      instituteId: institute!.id,
      handbookId: handbook.id,
      inherited: handbook.inherited,
      sections: handbook.sections,
      skipped: handbook.skipped ?? 0,
      adminPersonId: admin!.id,
      link: deepLink(identity, 'start', `inv_${code}`),
    };
  });
}

/**
 * Ссылка администратору факультета, который ещё не вошёл: действующая — та же самая,
 * истёкшая — новая на 30 дней. Ответ говорит, какая, чтобы не обещать «новую» зря.
 */
export async function resendInvite(db: Db, scope: UniversityScope, personId: string) {
  return tx(async (client) => {
    const person = await one<{ id: string; user_id: number | null }>(
      client,
      `SELECT p.id, p.user_id FROM persons p JOIN org_roles r ON r.person_id = p.id AND r.revoked_at IS NULL
        WHERE p.id = $1 AND r.university_id = $2`,
      [personId, scope.universityId],
    );
    if (!person) throw notFound('Администратор не найден');
    if (person.user_id) throw new AppError('already_connected', 'Этот администратор уже вошёл по ссылке', 409);
    const before = await one<{ code: string }>(client, 'SELECT code FROM invites WHERE person_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1', [personId]);
    const code = await ensureInvite(client, personId, 30);
    const invite = await one<{ expires_at: string }>(client, "SELECT to_char(expires_at, 'YYYY-MM-DD') AS expires_at FROM invites WHERE code = $1", [code]);
    await audit(client, { universityId: scope.universityId, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'invite.resend', entity: 'person', entityId: personId, data: { renewed: !before } });
    return { link: deepLink(await getBotIdentity(), 'start', `inv_${code}`), renewed: !before, expiresAt: invite?.expires_at ?? null };
  });
}
