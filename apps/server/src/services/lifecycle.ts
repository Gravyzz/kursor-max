import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { many, one, tx } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { audit } from './common.js';
import type { UserRow } from './identity.js';
import { membership } from './handbook.js';
import type { UniversityScope } from './university.js';

/**
 * Закрытие справочников и отключение факультетов. Ничего не удаляется сразу: студенты теряют доступ
 * с первой минуты, а команда 90 дней может вернуть всё одним нажатием. Потом worker удаляет закрытые
 * справочники насовсем (purgeClosed). Общую базу университета закрыть нельзя — на ней держатся все факультеты.
 */
export const RETENTION_DAYS = 90;

const restoreUntil = (closedAt: Date | string | null) =>
  closedAt ? new Date(new Date(closedAt).getTime() + RETENTION_DAYS * 86_400_000).toISOString() : null;
const expired = (closedAt: Date | string | null) => Boolean(closedAt && Date.now() - new Date(closedAt).getTime() > RETENTION_DAYS * 86_400_000);

/**
 * Справочники факультетов, которыми человек управляет (деканат, администратор факультета, админ справочника),
 * вместе с закрытыми — их можно восстановить, пока не истёк срок хранения.
 */
export async function manageableHandbooks(db: Db, user: UserRow) {
  const rows = await many<{
    id: string; title: string; subtitle: string | null; slug: string; status: string; closed_at: Date | null; closed_with_faculty: boolean;
    inherited: boolean; institute_id: string; institute: string; institute_closed: boolean; active_in_institute: number; readers: number; is_admin: boolean;
  }>(
    db,
    `SELECT * FROM (
       SELECT h.id, h.title, h.subtitle, h.slug, h.status, h.closed_at, h.closed_with_faculty, h.created_at, (h.parent_id IS NOT NULL) AS inherited,
              i.id AS institute_id, i.name AS institute, (i.closed_at IS NOT NULL) AS institute_closed,
              (SELECT count(*)::int FROM handbooks x WHERE x.institute_id = h.institute_id AND x.status = 'active') AS active_in_institute,
              (SELECT count(*)::int FROM handbook_readers r WHERE r.handbook_id = h.id) AS readers,
              (EXISTS (SELECT 1 FROM handbook_members m JOIN persons p ON p.id = m.person_id
                        WHERE m.handbook_id = h.id AND m.role = 'admin' AND p.user_id = $1 AND p.university_id = h.university_id)
               OR EXISTS (SELECT 1 FROM org_roles r JOIN persons p ON p.id = r.person_id
                           WHERE p.user_id = $1 AND r.revoked_at IS NULL AND r.role = 'faculty_admin' AND r.institute_id = h.institute_id)
               OR EXISTS (SELECT 1 FROM persons p WHERE p.user_id = $1 AND p.role = 'dean' AND p.institute_id = h.institute_id AND p.university_id = h.university_id)) AS is_admin,
              EXISTS (SELECT 1 FROM handbook_members m JOIN persons p ON p.id = m.person_id
                       WHERE m.handbook_id = h.id AND p.user_id = $1 AND p.university_id = h.university_id) AS is_member
         FROM handbooks h JOIN institutes i ON i.id = h.institute_id
        WHERE h.institute_id IS NOT NULL AND i.purged_at IS NULL
          AND (h.status = 'active' OR h.closed_at > now() - make_interval(days => $2))
     ) x
      -- Редактор видит справочники, где он в команде, но закрыть и вернуть может только администратор
      WHERE x.is_admin OR (x.is_member AND x.status = 'active')
      ORDER BY x.status, x.institute, x.created_at`,
    [user.id, RETENTION_DAYS],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    institute: row.institute,
    status: row.status as 'active' | 'archived',
    /** Подключены ли общие страницы университета. */
    inherited: row.inherited,
    readers: row.readers,
    closedAt: row.closed_at,
    restoreUntil: restoreUntil(row.closed_at),
    /** Закрыт вместе с факультетом: вернётся, когда факультет восстановят в кабинете университета. */
    closedWithFaculty: row.closed_with_faculty && row.institute_closed,
    /** Последний открытый справочник факультета закрыть нельзя — для этого факультет отключает университет. */
    canClose: row.is_admin && row.status === 'active' && row.active_in_institute > 1,
    /** Деканат или администратор справочника; редактор — только видит. */
    canManage: row.is_admin,
  }));
}

async function adminOf(db: Db, handbookId: string, user: UserRow) {
  const handbook = await one<{ id: string; title: string; status: string; institute_id: string | null; university_id: string; closed_at: Date | null; closed_with_faculty: boolean; institute_closed: boolean }>(
    db,
    `SELECT h.id, h.title, h.status, h.institute_id, h.university_id, h.closed_at, h.closed_with_faculty, (i.closed_at IS NOT NULL) AS institute_closed
       FROM handbooks h LEFT JOIN institutes i ON i.id = h.institute_id WHERE h.id = $1 FOR UPDATE OF h`,
    [handbookId],
  );
  if (!handbook) throw notFound('Справочник не найден');
  if (handbook.institute_id === null) throw new AppError('base_handbook', 'Общую базу университета закрыть нельзя: на ней держатся справочники всех факультетов', 409);
  const member = await membership(db, handbookId, user);
  if (member?.role !== 'admin') throw forbidden('Закрыть или вернуть справочник может деканат или администратор справочника');
  return { handbook, personId: member.personId };
}

/** Закрыть справочник: студенты сразу теряют доступ, команда может вернуть его в течение 90 дней. */
export async function closeHandbook(_db: Db, user: UserRow, handbookId: string) {
  return tx(async (client) => {
    const { handbook, personId } = await adminOf(client, handbookId, user);
    if (handbook.status !== 'active') throw new AppError('already_closed', 'Справочник уже закрыт', 409);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`institute_handbooks:${handbook.institute_id}`]);
    const active = await one<{ n: number }>(client, "SELECT count(*)::int AS n FROM handbooks WHERE institute_id = $1 AND status = 'active'", [handbook.institute_id]);
    if ((active?.n ?? 0) <= 1) {
      throw new AppError('last_handbook', 'Это единственный справочник факультета — закрыть его нельзя. Если факультет больше не работает с Курсором, его отключает администратор университета', 409);
    }
    const row = await one<{ closed_at: Date }>(
      client,
      "UPDATE handbooks SET status = 'archived', closed_at = now(), closed_by = $2, closed_with_faculty = false, updated_at = now() WHERE id = $1 RETURNING closed_at",
      [handbookId, personId],
    );
    await audit(client, { universityId: handbook.university_id, actorPersonId: personId, actorUserId: user.id, action: 'handbook.close', entity: 'handbook', entityId: handbookId, data: { title: handbook.title } });
    return { ok: true as const, restoreUntil: restoreUntil(row!.closed_at) };
  });
}

/** Вернуть закрытый справочник: всё на месте — страницы, команда, читатели, история. */
export async function reopenHandbook(_db: Db, user: UserRow, handbookId: string) {
  return tx(async (client) => {
    const { handbook, personId } = await adminOf(client, handbookId, user);
    if (handbook.status === 'active') return { ok: true as const };
    if (expired(handbook.closed_at)) throw new AppError('retention_expired', 'Срок хранения истёк — справочник уже нельзя вернуть', 410);
    if (handbook.institute_closed) {
      throw new AppError('faculty_closed', 'Факультет отключён — сначала его должен восстановить администратор университета', 409);
    }
    await client.query("UPDATE handbooks SET status = 'active', closed_at = NULL, closed_by = NULL, closed_with_faculty = false, updated_at = now() WHERE id = $1", [handbookId]);
    await audit(client, { universityId: handbook.university_id, actorPersonId: personId, actorUserId: user.id, action: 'handbook.reopen', entity: 'handbook', entityId: handbookId, data: { title: handbook.title } });
    return { ok: true as const };
  });
}

export const facultyCloseSchema = z.object({
  /** Название или короткое название факультета — защита от отключения не того факультета. */
  confirm: z.string().trim().min(1, 'Впишите название факультета, чтобы подтвердить'),
});

/**
 * Отключить факультет: все его справочники закрываются вместе с ним, студенты и команда факультета
 * теряют доступ. Общая база университета и другие факультеты не меняются. 90 дней можно восстановить.
 */
export async function closeFaculty(_db: Db, scope: UniversityScope, instituteId: string, confirm: string) {
  return tx(async (client) => {
    const institute = await one<{ id: string; name: string; short_name: string; closed_at: Date | null }>(
      client, 'SELECT id, name, short_name, closed_at FROM institutes WHERE id = $1 AND university_id = $2 FOR UPDATE', [instituteId, scope.universityId],
    );
    if (!institute) throw notFound('Факультет не найден');
    if (institute.closed_at) throw new AppError('already_closed', 'Факультет уже отключён', 409);
    const typed = confirm.trim().toLowerCase();
    if (typed !== institute.name.trim().toLowerCase() && typed !== institute.short_name.trim().toLowerCase()) {
      throw new AppError('confirm_mismatch', `Название не совпадает — впишите «${institute.short_name}» или полное название`, 400);
    }
    const row = await one<{ closed_at: Date }>(client, 'UPDATE institutes SET closed_at = now(), closed_by = $2 WHERE id = $1 RETURNING closed_at', [instituteId, scope.personId]);
    const closed = await many<{ id: string }>(
      client,
      "UPDATE handbooks SET status = 'archived', closed_at = now(), closed_by = $2, closed_with_faculty = true, updated_at = now() WHERE institute_id = $1 AND status = 'active' RETURNING id",
      [instituteId, scope.personId],
    );
    await audit(client, {
      universityId: scope.universityId, actorPersonId: scope.personId, actorUserId: scope.userId,
      action: 'university.faculty.close', entity: 'institute', entityId: instituteId, data: { name: institute.name, shortName: institute.short_name, handbooks: closed.length },
    });
    return { ok: true as const, handbooks: closed.length, restoreUntil: restoreUntil(row!.closed_at) };
  });
}

/** Восстановить факультет: возвращаются справочники, закрытые вместе с ним (закрытые деканатом раньше — нет). */
export async function reopenFaculty(_db: Db, scope: UniversityScope, instituteId: string) {
  return tx(async (client) => {
    const institute = await one<{ id: string; name: string; short_name: string; closed_at: Date | null; purged_at: Date | null }>(
      client, 'SELECT id, name, short_name, closed_at, purged_at FROM institutes WHERE id = $1 AND university_id = $2 FOR UPDATE', [instituteId, scope.universityId],
    );
    if (!institute) throw notFound('Факультет не найден');
    if (!institute.closed_at) return { ok: true as const, handbooks: 0 };
    if (institute.purged_at || expired(institute.closed_at)) throw new AppError('retention_expired', 'Срок хранения истёк — факультет уже нельзя восстановить, подключите его заново', 410);
    await client.query('UPDATE institutes SET closed_at = NULL, closed_by = NULL WHERE id = $1', [instituteId]);
    const reopened = await many<{ id: string }>(
      client,
      "UPDATE handbooks SET status = 'active', closed_at = NULL, closed_by = NULL, closed_with_faculty = false, updated_at = now() WHERE institute_id = $1 AND status = 'archived' AND closed_with_faculty RETURNING id",
      [instituteId],
    );
    await audit(client, {
      universityId: scope.universityId, actorPersonId: scope.personId, actorUserId: scope.userId,
      action: 'university.faculty.reopen', entity: 'institute', entityId: instituteId, data: { name: institute.name, shortName: institute.short_name, handbooks: reopened.length },
    });
    return { ok: true as const, handbooks: reopened.length };
  });
}

/** Отключённые факультеты университета: для блока «Отключённые» с восстановлением. */
export async function closedFaculties(db: Db, universityId: string) {
  const rows = await many<{ id: string; name: string; short_name: string; closed_at: Date }>(
    db,
    'SELECT id, name, short_name, closed_at FROM institutes WHERE university_id = $1 AND closed_at IS NOT NULL AND purged_at IS NULL ORDER BY closed_at DESC',
    [universityId],
  );
  return rows.map((row) => ({ id: row.id, name: row.name, shortName: row.short_name, closedAt: row.closed_at, restoreUntil: restoreUntil(row.closed_at) }));
}

/** Worker: по истечении срока хранения закрытые справочники удаляются насовсем, факультет помечается удалённым. */
export async function purgeClosed(db: Db): Promise<{ handbooks: number; faculties: number }> {
  return tx(async (client) => {
    const handbooks = await many<{ id: string; university_id: string; title: string }>(
      client,
      `DELETE FROM handbooks WHERE status = 'archived' AND institute_id IS NOT NULL AND closed_at < now() - make_interval(days => $1)
        RETURNING id, university_id, title`,
      [RETENTION_DAYS],
    );
    for (const row of handbooks) {
      await audit(client, { universityId: row.university_id, action: 'handbook.purge', entity: 'handbook', entityId: row.id, data: { title: row.title } });
    }
    const faculties = await many<{ id: string }>(
      client,
      'UPDATE institutes SET purged_at = now() WHERE closed_at < now() - make_interval(days => $1) AND purged_at IS NULL RETURNING id',
      [RETENTION_DAYS],
    );
    return { handbooks: handbooks.length, faculties: faculties.length };
  });
}

/** Почему справочник не открывается: закрыт — честно говорим об этом студенту, а не «не найден». */
export async function closedHandbookError(db: Db, ref: { id?: string | null; slug?: string | null }): Promise<AppError | null> {
  if (!ref.id && !ref.slug) return null;
  const row = await one<{ id: string }>(
    db,
    `SELECT id FROM handbooks WHERE status = 'archived' AND (${ref.id ? 'id = $1' : 'slug = $1'}) LIMIT 1`,
    [ref.id ?? ref.slug],
  );
  return row ? new AppError('handbook_closed', 'Этот справочник закрыт. Если он вам нужен — напишите в деканат своего факультета', 410) : null;
}
