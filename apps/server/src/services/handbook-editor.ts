import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { many, one, tx } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { audit, getUniversity } from './common.js';
import { todayIn, zonedToUtc } from '../domain/dates.js';
import { cancelPending, enqueue, enqueueToReader, retractSent } from '../notify/outbox.js';
import {
  audienceSchema, blocksSchema, calendarDate, deadlineBlocks, describeBlockIssue, draftBlocksSchema, pageSearchText, pageSearchTitle, publishIssues, slugify,
  type Block,
} from '../domain/handbook.js';
import type { HandbookRow } from './handbook.js';
import { isTemplateHint, seedTemplate } from './handbook-template.js';
import { ensureInvite } from './identity.js';
import { deepLink, getBotIdentity } from '../max/bot.js';

export type MemberRole = 'admin' | 'editor';

/**
 * Версия страницы для защиты от затирания правок (C1): время последнего изменения строкой ISO
 * с микросекундами. Два изменения подряд не получают одинаковую версию, даже если прошла доля миллисекунды.
 */
const PAGE_VERSION = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const PAGE_CONFLICT_MESSAGE = 'Страницу уже изменил другой участник команды. Обновите её, чтобы не потерять правки.';

/** baseUpdatedAt — updatedAt страницы, с которой начиналась правка (из последнего GET или PATCH). */
export const pageVersionSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/, 'Обновите страницу: не удалось понять, какую версию вы правите');

export const sectionInputSchema = z.object({
  title: z.string().trim().min(2, 'Название раздела от 2 символов').max(80),
  emoji: z.string().trim().max(8).optional(),
  summary: z.string().trim().max(200).optional().nullable(),
  position: z.coerce.number().int().min(0).max(1000).optional(),
  audience: audienceSchema.optional(),
  visible: z.boolean().optional(),
});

export const pageInputSchema = z.object({
  sectionId: z.string().uuid('Выберите раздел'),
  title: z.string().trim().min(3, 'Заголовок от 3 символов').max(120),
  summary: z.string().trim().max(300).optional().nullable(),
  audience: audienceSchema.optional(),
  blocks: draftBlocksSchema.optional(),
});

export const pageDraftSchema = z.object({
  title: z.string().trim().min(3, 'Заголовок от 3 символов').max(120).optional(),
  summary: z.string().trim().max(300).optional().nullable(),
  audience: audienceSchema.optional(),
  blocks: draftBlocksSchema.optional(),
  note: z.string().trim().max(300).optional().nullable(),
  /** updatedAt страницы, от которой начиналась правка: не совпадает — 409 page_conflict (C1). */
  baseUpdatedAt: pageVersionSchema.optional().nullable(),
});

/** Разбор тела запроса редактора с понятными сообщениями про блоки. */
export function parsePageDraft(body: unknown): z.infer<typeof pageDraftSchema> {
  const parsed = pageDraftSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const blocks = (body as { blocks?: unknown })?.blocks;
  const details = [
    ...new Set(
      parsed.error.issues.map((issue) =>
        issue.path[0] === 'blocks' ? describeBlockIssue({ path: issue.path.slice(1), message: issue.message }, blocks) : issue.message,
      ),
    ),
  ]
    .slice(0, 4)
    .join('; ');
  throw new AppError('validation_error', `Проверьте страницу: ${details}`, 400);
}

export interface EditorScope {
  handbook: HandbookRow;
  role: MemberRole;
  personId: string | null;
  userId: number;
}

export function requireAdmin(scope: EditorScope) {
  if (scope.role !== 'admin') throw forbidden('Публикация доступна администратору справочника');
}

/**
 * Страницу изменили после того, как её открыли: сохранение затёрло бы чужую правку (ответ дежурного в FAQ,
 * правку второго редактора, публикацию). Версию сравниваем точно; если клиент прислал время с точностью
 * до миллисекунды (переформатировал через Date), — с этой точностью.
 */
function assertPageVersion(page: { version: string }, base: string | null | undefined) {
  if (!base || base === page.version) return;
  const fraction = /\.(\d+)/.exec(base)?.[1] ?? '';
  const sameMs = fraction.length <= 3 && Date.parse(base) === Date.parse(`${page.version.slice(0, 23)}Z`);
  if (!sameMs) throw new AppError('page_conflict', PAGE_CONFLICT_MESSAGE, 409);
}

async function ownPage(db: Db, scope: EditorScope, pageId: string, options: { lock?: boolean } = {}) {
  const page = await one<{
    id: string; handbook_id: string; section_id: string; slug: string; title: string; summary: string | null;
    audience: Record<string, unknown>; status: string; blocks: Block[]; draft_title: string | null;
    draft_summary: string | null; draft_blocks: Block[] | null; draft_note: string | null; owner_person_id: string | null;
    review_at: string | null; checked_at: Date | null; updated_at: Date; published_at: Date | null; review_requested_at: Date | null;
    return_note: string | null; returned_at: Date | null; version: string;
    version_no: number; inherited_from: string | null; base_version: number | null; override_reason: string | null;
    owner_unit: string | null; backup_owner_person_id: string | null; review_interval_days: number;
  }>(db, `SELECT *, ${PAGE_VERSION} AS version FROM pages WHERE id = $1${options.lock ? ' FOR UPDATE' : ''}`, [pageId]);
  if (!page) throw notFound('Страница не найдена');
  if (page.handbook_id !== scope.handbook.id) throw forbidden('Страница другого справочника');
  return page;
}

/**
 * Что мешает опубликовать страницу: незаполненные блоки, пустая страница (APP-25)
 * и подсказка шаблона, которую так и не заменили своим текстом (APP-19).
 */
export function pageIssues(blocks: unknown, note?: string | null): string[] {
  const issues = publishIssues(blocks);
  if (Array.isArray(blocks)) {
    const hint = blocks.findIndex((block) => {
      const value = block as { id?: string; type?: string; text?: unknown } | null;
      // Заметка страницы сравнивается только с блоком-подсказкой заготовки (id «hint»)
      return value?.type === 'text' && isTemplateHint(value.text, value.id === 'hint' ? note : null);
    });
    if (hint >= 0) issues.unshift(`Текст (блок ${hint + 1}): Замените подсказку шаблона своим текстом — иначе студенты увидят её вместо ответа`);
  }
  return [...new Set(issues)].slice(0, 4);
}

/**
 * Статус для редактора. Правки опубликованной страницы, отправленные на проверку, показываются как «на проверке»,
 * но в базе страница остаётся опубликованной: студенты видят прежнюю версию, пока администратор не опубликует новую.
 */
const EDITOR_STATUS = "CASE WHEN status = 'published' AND review_requested_at IS NOT NULL THEN 'review' ELSE status END";
const editorStatus = (page: { status: string; review_requested_at: Date | null }) =>
  page.status === 'published' && page.review_requested_at ? 'review' : page.status;

/** Структура справочника для редактора: разделы, страницы, статусы и черновики. */
export async function editorStructure(db: Db, scope: EditorScope) {
  const sections = await many<{ id: string; slug: string; title: string; emoji: string; position: number; visible: boolean; audience: Record<string, unknown> }>(
    db,
    'SELECT id, slug, title, emoji, position, visible, audience FROM sections WHERE handbook_id = $1 ORDER BY position, title',
    [scope.handbook.id],
  );
  // Заголовок — как в конструкторе: у черновика свой, ещё не опубликованный (APP-7); опубликованный — отдельно
  const pages = await many<{
    id: string; section_id: string; title: string; published_title: string; status: string; updated_at: Date; checked_at: Date | null;
    review_at: string | null; has_draft: boolean; views: number; helpful: number; not_helpful: number;
    recent_helpful: number; recent_not_helpful: number;
    owner_unit: string | null; owner_name: string | null; inherited_from: string | null; base_behind: boolean;
    scoped: boolean;
  }>(
    db,
    `SELECT pg.id, pg.section_id, COALESCE(pg.draft_title, pg.title) AS title, pg.title AS published_title,
            CASE WHEN pg.status = 'published' AND pg.review_requested_at IS NOT NULL THEN 'review' ELSE pg.status END AS status,
            pg.updated_at, pg.checked_at, to_char(pg.review_at, 'YYYY-MM-DD') AS review_at, (pg.draft_blocks IS NOT NULL) AS has_draft,
            pg.views, pg.helpful, pg.not_helpful, pg.owner_unit, ow.full_name AS owner_name, pg.inherited_from,
            -- Оценки после последней публикации: по ним решаем, «требует ли страница внимания»
            GREATEST(pg.helpful - pg.helpful_before, 0) AS recent_helpful,
            GREATEST(pg.not_helpful - pg.not_helpful_before, 0) AS recent_not_helpful,
            (bp.id IS NOT NULL AND bp.version_no > COALESCE(pg.base_version, 0)) AS base_behind,
            (pg.institute_ids IS NOT NULL) AS scoped
       FROM pages pg
       LEFT JOIN persons ow ON ow.id = pg.owner_person_id
       LEFT JOIN pages bp ON bp.id = pg.inherited_from AND bp.status = 'published'
      WHERE pg.handbook_id = $1 ORDER BY pg.position, COALESCE(pg.draft_title, pg.title)`,
    [scope.handbook.id],
  );
  return sections.map((section) => ({
    ...section,
    pages: pages.filter((page) => page.section_id === section.id),
  }));
}

/**
 * Сроки справочника для команды: что студенты увидят в «Ближайших сроках» и о чём напомнит бот.
 * Срок — это блок «Срок» на странице: здесь он виден списком, а создаётся на странице.
 * Черновые сроки (страница ещё не опубликована или правки не опубликованы) — отдельно: студенты их пока не видят.
 */
export async function editorDeadlines(db: Db, scope: EditorScope) {
  const university = await getUniversity(db, scope.handbook.university_id);
  const today = todayIn(university.timezone);
  const chain = scope.handbook.parent_id ? [scope.handbook.id, scope.handbook.parent_id] : [scope.handbook.id];
  const live = await many<{ id: string; page_id: string; title: string; starts_on: string; ends_on: string | null; page_title: string; shared: boolean; remind_days: number[] }>(
    db,
    `SELECT d.id, d.page_id, d.title, to_char(d.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(d.ends_on, 'YYYY-MM-DD') AS ends_on,
            p.title AS page_title, (d.handbook_id <> $1) AS shared, d.remind_days
       FROM handbook_deadlines d
       JOIN pages p ON p.id = d.page_id AND p.status = 'published'
      WHERE d.handbook_id = ANY($2::uuid[])
        AND COALESCE(d.ends_on, d.starts_on) >= $3::date
        AND (d.handbook_id = $1 OR page_for_handbook(p.institute_ids, $1))
        AND NOT EXISTS (SELECT 1 FROM pages ov WHERE ov.handbook_id = $1 AND ov.inherited_from = d.page_id AND ov.status = 'published')
      ORDER BY d.starts_on, d.title
      LIMIT 60`,
    [scope.handbook.id, chain, today],
  );
  const drafts = await many<{ page_id: string; page_title: string; block_id: string; title: string | null; starts_on: string | null }>(
    db,
    `SELECT p.id AS page_id, COALESCE(p.draft_title, p.title) AS page_title, b->>'id' AS block_id, b->>'title' AS title, b->>'startsOn' AS starts_on
       FROM pages p CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.draft_blocks) = 'array' THEN p.draft_blocks ELSE '[]'::jsonb END) b
      WHERE p.handbook_id = $1 AND p.status <> 'archived' AND b->>'type' = 'deadline'
        AND NOT EXISTS (SELECT 1 FROM handbook_deadlines d WHERE d.page_id = p.id AND d.block_id = b->>'id')
      ORDER BY b->>'startsOn' NULLS LAST
      LIMIT 30`,
    [scope.handbook.id],
  );
  return {
    today,
    deadlines: live.map((row) => ({
      id: row.id, pageId: row.page_id, pageTitle: row.page_title, title: row.title,
      startsOn: row.starts_on, endsOn: row.ends_on, remindDays: row.remind_days,
      /** Срок с общей страницы университета: правит университет, факультет может завести свою версию страницы. */
      shared: row.shared,
    })),
    drafts: drafts.map((row) => ({ pageId: row.page_id, pageTitle: row.page_title, blockId: row.block_id, title: row.title ?? '', startsOn: row.starts_on })),
  };
}

/** Правка раздела: любые поля по отдельности, непереданные не меняются (API-13). */
export const sectionPatchSchema = sectionInputSchema.partial();

export async function createSection(_db: Db, scope: EditorScope, input: z.infer<typeof sectionInputSchema>) {
  requireAdmin(scope);
  return tx((db) =>
    insertWithUniqueSlug(slugify(input.title, 'section'), (slug) =>
      one<{ id: string }>(
        db,
        `INSERT INTO sections(handbook_id, slug, title, emoji, summary, position, audience, visible)
         VALUES ($1, $2, $3, COALESCE($4, '📄'), $5, COALESCE($6, 100), COALESCE($7, '{}'::jsonb), COALESCE($8, true))
         ON CONFLICT (handbook_id, slug) DO NOTHING
         RETURNING id`,
        [scope.handbook.id, slug, input.title, input.emoji ?? null, input.summary ?? null, input.position ?? null, input.audience ? JSON.stringify(input.audience) : null, input.visible ?? null],
      ),
    ),
  );
}

export async function updateSection(_db: Db, scope: EditorScope, sectionId: string, input: z.infer<typeof sectionPatchSchema>) {
  requireAdmin(scope);
  return tx(async (db) => {
    const row = await one<{ id: string }>(
      db,
      `UPDATE sections SET title = COALESCE($2, title), emoji = COALESCE($3, emoji),
              summary = CASE WHEN $4::boolean THEN $5 ELSE summary END,
              position = COALESCE($6, position), audience = COALESCE($7, audience), visible = COALESCE($8, visible)
        WHERE id = $1 AND handbook_id = $9 RETURNING id`,
      [
        sectionId, input.title ?? null, input.emoji ?? null, input.summary !== undefined, input.summary ?? null, input.position ?? null,
        input.audience ? JSON.stringify(input.audience) : null, input.visible ?? null, scope.handbook.id,
      ],
    );
    if (!row) throw notFound('Раздел не найден');
    // Название раздела входит в поисковый текст страниц — после переименования его надо обновить
    if (input.title !== undefined) await refreshSectionSearchText(db, sectionId);
    return row;
  });
}

/** Перестраивает поисковый текст всех страниц раздела (после переименования раздела). */
async function refreshSectionSearchText(db: Db, sectionId: string): Promise<void> {
  const section = await one<{ title: string }>(db, 'SELECT title FROM sections WHERE id = $1', [sectionId]);
  if (!section) return;
  const pages = await many<{ id: string; title: string; summary: string | null; blocks: Block[] }>(
    db,
    "SELECT id, title, summary, blocks FROM pages WHERE section_id = $1 AND status = 'published'",
    [sectionId],
  );
  for (const page of pages) {
    await db.query('UPDATE pages SET search_text = $2, search_title = $3 WHERE id = $1', [
      page.id,
      pageSearchText(page.summary, page.blocks),
      pageSearchTitle(page.title, section.title),
    ]);
  }
}

/**
 * Вставка с подбором свободного слага. Занятость проверяет сама вставка (ON CONFLICT DO NOTHING):
 * при одновременном создании двух страниц, разделов или справочников с одним названием
 * второй запрос берёт следующий слаг, а не падает на уникальности (API-11).
 */
async function insertWithUniqueSlug<T>(base: string, insert: (slug: string) => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = await insert(attempt === 0 ? base : `${base}-${attempt + 1}`);
    if (row) return row;
  }
  const row = await insert(`${base}-${Date.now().toString(36)}`);
  if (!row) throw new AppError('slug_taken', 'Не получилось подобрать адрес — попробуйте другое название', 409);
  return row;
}

export async function createPage(db: Db, scope: EditorScope, input: z.infer<typeof pageInputSchema>) {
  // Кому показывать страницу, решает администратор — и при создании тоже (API-18)
  if (input.audience && scope.role !== 'admin' && !sameAudience(input.audience, {})) {
    throw forbidden('Кому показывать страницу, решает администратор справочника. Отправьте страницу на проверку с комментарием');
  }
  return tx(async (client) => {
    const section = await one<{ id: string; slug: string }>(client, 'SELECT id, slug FROM sections WHERE id = $1 AND handbook_id = $2', [input.sectionId, scope.handbook.id]);
    if (!section) throw notFound('Раздел не найден');
    // Такая страница уже есть в общей базе: вторая копия разошлась бы с общей при первом обновлении.
    // Факультет добавляет к ней уточнение или явно заводит свою версию (D1, D2)
    if (scope.handbook.parent_id) {
      const shared = await one<{ id: string; title: string }>(
        client,
        `SELECT bp.id, bp.title FROM pages bp JOIN sections bs ON bs.id = bp.section_id
          WHERE bp.handbook_id = $1 AND bp.status = 'published' AND bs.slug = $2 AND bp.slug = $3
            AND page_for_handbook(bp.institute_ids, $4)`,
        [scope.handbook.parent_id, section.slug, slugify(input.title), scope.handbook.id],
      );
      if (shared) {
        throw new AppError('shared_page_exists', `«${shared.title}» уже есть в общей базе университета. Добавьте к ней уточнение или создайте свою версию`, 409, { basePageId: shared.id });
      }
    }
    const blocks = input.blocks ?? [];
    const row = await insertWithUniqueSlug(slugify(input.title), (slug) =>
      one<{ id: string }>(
        client,
        `INSERT INTO pages(handbook_id, section_id, slug, title, summary, audience, status, draft_title, draft_summary, draft_blocks, owner_person_id)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, '{}'::jsonb), 'draft', $4, $5, $7, $8)
         ON CONFLICT (handbook_id, slug) DO NOTHING
         RETURNING id`,
        [scope.handbook.id, input.sectionId, slug, input.title, input.summary ?? null, input.audience ? JSON.stringify(input.audience) : null, JSON.stringify(blocks), scope.personId],
      ),
    );
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.page.create', entity: 'page', entityId: row!.id });
    return row!;
  });
}

/** Сравнение аудиторий без учёта порядка ключей и значений. */
function sameAudience(a: unknown, b: unknown): boolean {
  const canon = (value: unknown): string => {
    const obj = (value ?? {}) as Record<string, unknown>;
    return JSON.stringify(
      Object.keys(obj)
        .filter((key) => obj[key] !== undefined && !(Array.isArray(obj[key]) && (obj[key] as unknown[]).length === 0))
        .sort()
        .map((key) => [key, Array.isArray(obj[key]) ? [...(obj[key] as unknown[])].map(String).sort() : obj[key]]),
    );
  };
  return canon(a) === canon(b);
}

export async function saveDraft(_db: Db, scope: EditorScope, pageId: string, input: z.infer<typeof pageDraftSchema>) {
  return tx(async (db) => {
    const page = await ownPage(db, scope, pageId, { lock: true });
    assertPageVersion(page, input.baseUpdatedAt);
    // Вернуть страницу из архива (правка архивной делает её черновиком) может только тот, кто архивирует, — администратор
    if (page.status === 'archived' && scope.role !== 'admin') {
      throw new AppError('page_archived', 'Страница в архиве — вернуть её может администратор справочника', 409);
    }
    // Аудитория меняет видимость уже опубликованной страницы сразу, без проверки — это право администратора
    if (input.audience && scope.role !== 'admin' && !sameAudience(input.audience, page.audience)) {
      throw forbidden('Кому показывать страницу, решает администратор справочника. Отправьте страницу на проверку с комментарием');
    }
    const blocks = input.blocks ?? page.draft_blocks ?? page.blocks;
    const row = await one<{ id: string; status: string; version: string }>(
      db,
      `UPDATE pages
          SET draft_title = COALESCE($2, draft_title, title),
              draft_summary = CASE WHEN $7::boolean THEN $3 WHEN draft_blocks IS NOT NULL THEN draft_summary ELSE summary END,
              draft_blocks = $4,
              draft_note = COALESCE($5, draft_note),
              audience = COALESCE($6, audience),
              status = CASE WHEN status = 'published' THEN 'published' ELSE 'draft' END,
              review_requested_at = NULL,
              updated_at = now()
        WHERE id = $1 RETURNING id, status, ${PAGE_VERSION} AS version`,
      [pageId, input.title ?? null, input.summary ?? null, JSON.stringify(blocks), input.note ?? null, input.audience && scope.role === 'admin' ? JSON.stringify(input.audience) : null, input.summary !== undefined],
    );
    // Черновик сохраняется всегда; что мешает публикации — подсказываем сразу, а не при нажатии «Опубликовать»
    return { id: row!.id, status: row!.status, updatedAt: row!.version, issues: pageIssues(blocks, page.draft_note) };
  });
}

export async function submitForReview(db: Db, scope: EditorScope, pageId: string, note: string | null) {
  return tx(async (client) => {
    const page = await ownPage(client, scope, pageId, { lock: true });
    if (page.status === 'archived' && scope.role !== 'admin') {
      throw new AppError('page_archived', 'Страница в архиве — вернуть её может администратор справочника', 409);
    }
    if (!page.draft_blocks) throw new AppError('nothing_to_review', 'Нет изменений: сначала отредактируйте страницу', 409);
    // Повтор не начинает новый цикл и не дублирует уведомления. Но последний отправитель
    // важен: при возврате на доработку именно ему придёт сообщение с причиной.
    if (page.review_requested_at) {
      await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.page.review', entity: 'page', entityId: pageId });
      return { id: pageId, notified: 0, updatedAt: page.version };
    }
    const issues = pageIssues(page.draft_blocks, page.draft_note);
    if (issues.length) throw new AppError('blocks_invalid', `Перед отправкой на проверку заполните: ${issues.join('; ')}`, 400);
    // Опубликованная страница остаётся у студентов в прежнем виде, пока правки не проверят.
    // Причина прошлого возврата на доработку больше не актуальна — страницу доработали и прислали снова.
    const updated = await one<{ version: string }>(
      client,
      `UPDATE pages SET status = CASE WHEN status = 'published' THEN 'published' ELSE 'review' END,
              review_requested_at = now(), draft_note = COALESCE($2, draft_note), return_note = NULL, returned_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING ${PAGE_VERSION} AS version`,
      [pageId, note],
    );
    const admins = await many<{ person_id: string }>(
      client,
      `SELECT m.person_id FROM handbook_members m WHERE m.handbook_id = $1 AND m.role = 'admin'
        UNION
       SELECT p.id FROM persons p JOIN handbooks h ON h.institute_id = p.institute_id
        WHERE h.id = $1 AND p.role = 'dean' AND p.university_id = h.university_id`,
      [scope.handbook.id],
    );
    for (const admin of admins) {
      await enqueue(client, {
        personId: admin.person_id,
        kind: 'handbook_review',
        payload: { pageId, handbookId: scope.handbook.id, note: note ?? page.draft_note ?? null },
        // Отдельный цикл проверки может начаться в тот же день после доработки.
        dedupeKey: `hb_review:${pageId}:${admin.person_id}:${updated!.version}`,
      });
    }
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.page.review', entity: 'page', entityId: pageId });
    return { id: pageId, notified: admins.length, updatedAt: updated!.version };
  });
}

/**
 * Вернуть страницу с проверки на доработку (C2, APP-11). Черновик на проверке снова становится черновиком;
 * у опубликованной страницы снимается запрос проверки, а студенты по-прежнему видят опубликованную версию.
 * Причина видна в редакторе (returnNote), пока страницу не отправят на проверку снова или не опубликуют;
 * тот, кто отправлял страницу на проверку, получает сообщение в чат.
 */
export const returnPageSchema = z.object({
  note: z.string().trim().max(500, 'Причина — не длиннее 500 символов').optional().nullable(),
});

export async function returnPage(_db: Db, scope: EditorScope, pageId: string, note: string | null) {
  if (scope.role !== 'admin') throw forbidden('Вернуть страницу на доработку может администратор справочника');
  return tx(async (client) => {
    const page = await ownPage(client, scope, pageId, { lock: true });
    if (editorStatus(page) !== 'review') {
      throw new AppError('not_in_review', 'Страница не на проверке — возвращать на доработку нечего. Обновите страницу', 409);
    }
    const updated = await one<{ version: string }>(
      client,
      `UPDATE pages SET status = CASE WHEN status = 'review' THEN 'draft' ELSE status END,
              review_requested_at = NULL, return_note = $2, returned_at = now(), updated_at = now()
        WHERE id = $1 RETURNING ${PAGE_VERSION} AS version`,
      [pageId, note || null],
    );
    // Сообщение получает тот, кто отправил страницу на проверку (иначе — автор страницы), если это не сам администратор
    const submitter = await one<{ person_id: string | null }>(
      client,
      `SELECT actor_person_id AS person_id FROM audit_log
        WHERE entity = 'page' AND entity_id = $1 AND action = 'handbook.page.review'
        ORDER BY at DESC, id DESC LIMIT 1`,
      [pageId],
    );
    const authorId = submitter?.person_id ?? page.owner_person_id;
    if (authorId && authorId !== scope.personId) {
      await enqueue(client, {
        personId: authorId,
        kind: 'handbook_return',
        payload: { pageId, handbookId: scope.handbook.id, note: note || null },
        dedupeKey: `hb_return:${pageId}:${updated!.version}`,
      });
    }
    await audit(client, {
      universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId,
      action: 'handbook.page.return', entity: 'page', entityId: pageId, data: { note: note || null },
    });
    return { ok: true as const, updatedAt: updated!.version };
  });
}

/** Публикация: версия в историю, синхронизация сроков, обновление поискового текста. */
export async function publishPage(db: Db, scope: EditorScope, pageId: string, baseUpdatedAt?: string | null) {
  requireAdmin(scope);
  return tx(async (client) => {
    const page = await ownPage(client, scope, pageId, { lock: true });
    // Админ публикует ровно то, что видел: если черновик успели изменить, он сначала посмотрит правки
    assertPageVersion(page, baseUpdatedAt);
    const title = page.draft_title ?? page.title;
    const summary = page.draft_blocks !== null ? page.draft_summary : page.summary;
    const source = page.draft_blocks ?? page.blocks;
    const issues = pageIssues(source, page.draft_note);
    const parsed = blocksSchema.safeParse(source);
    if (issues.length || !parsed.success) {
      throw new AppError('blocks_invalid', `Не получилось опубликовать — ${(issues.length ? issues : ['проверьте блоки страницы']).join('; ')}`, 400);
    }
    const blocks = parsed.data as Block[];
    const section = await one<{ title: string }>(client, 'SELECT title FROM sections WHERE id = $1', [page.section_id]);
    const previousBlocks = page.published_at ? page.blocks : [];
    const updated = await one<{ version: string; version_no: number }>(
      client,
      `UPDATE pages
          SET title = $2, summary = $3, blocks = $4, draft_title = NULL, draft_summary = NULL, draft_blocks = NULL,
              draft_note = NULL, status = 'published', review_requested_at = NULL, published_at = now(), updated_at = now(), checked_at = now(),
              review_at = (now() + make_interval(days => review_interval_days))::date, search_text = $5, search_title = $6,
              return_note = NULL, returned_at = NULL, version_no = version_no + 1,
              -- Страницу исправили и опубликовали: прежние «не помогла» больше не про неё, считаем оценки заново
              helpful_before = helpful, not_helpful_before = not_helpful
        WHERE id = $1 RETURNING ${PAGE_VERSION} AS version, version_no`,
      [pageId, title, summary, JSON.stringify(blocks), pageSearchText(summary, blocks), pageSearchTitle(title, section?.title ?? null)],
    );
    await client.query(
      'INSERT INTO page_versions(page_id, title, summary, blocks, author_person_id, note, version_no) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      // Подсказка шаблона в заметке — не комментарий к версии
      [pageId, title, summary, JSON.stringify(blocks), scope.personId, isTemplateHint(page.draft_note) ? null : page.draft_note, updated!.version_no],
    );
    await syncDeadlines(client, scope.handbook.id, pageId, blocks);
    // Своя версия опубликована — уточнение к общей странице больше не нужно: студенты видят только свою версию
    if (page.inherited_from) {
      await client.query(
        "UPDATE page_supplements SET status = 'archived', updated_at = now() WHERE handbook_id = $1 AND base_page_id = $2 AND status <> 'archived'",
        [scope.handbook.id, page.inherited_from],
      );
      await client.query('DELETE FROM handbook_deadlines WHERE handbook_id = $1 AND page_id = $2', [scope.handbook.id, page.inherited_from]);
    }
    const affected = scope.handbook.institute_id === null && page.published_at
      ? await notifyBaseChange(client, scope, pageId, updated!.version_no, previousBlocks, blocks, page.draft_note)
      : { faculties: 0, overrides: 0, anchorsLost: 0 };
    await audit(client, {
      universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.page.publish', entity: 'page', entityId: pageId,
      data: { version: updated!.version_no, ...(scope.handbook.institute_id === null ? { base: true, ...affected } : {}) },
    });
    return { id: pageId, status: 'published' as const, updatedAt: updated!.version, version: updated!.version_no, affected };
  });
}

export async function archivePage(_db: Db, scope: EditorScope, pageId: string) {
  requireAdmin(scope);
  return tx(async (db) => {
    await ownPage(db, scope, pageId, { lock: true });
    await db.query("UPDATE pages SET status = 'archived', review_requested_at = NULL, updated_at = now() WHERE id = $1", [pageId]);
    await db.query('DELETE FROM handbook_deadlines WHERE page_id = $1', [pageId]);
    await audit(db, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.page.archive', entity: 'page', entityId: pageId });
    return { id: pageId, status: 'archived' as const };
  });
}

/**
 * Сроки живут в блоках страницы; здесь они превращаются в записи календаря и напоминаний.
 * В записи срока — только аудитория самого блока. Аудитории страницы и раздела проверяются при выдаче календаря
 * и постановке напоминаний (WRK-2): иначе смена аудитории опубликованной страницы не доходила бы до сроков.
 */
export async function syncDeadlines(db: Db, handbookId: string, pageId: string, blocks: Block[]) {
  const deadlines = deadlineBlocks(blocks);
  // Сроки уточнений факультетов к общей странице живут под той же страницей, но в своём справочнике — их не трогаем
  await db.query('DELETE FROM handbook_deadlines WHERE page_id = $1 AND handbook_id = $3 AND NOT (block_id = ANY($2::text[]))', [pageId, deadlines.map((block) => block.id), handbookId]);
  for (const block of deadlines) {
    await db.query(
      `INSERT INTO handbook_deadlines(handbook_id, page_id, block_id, title, starts_on, ends_on, remind_days, audience)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::int[], '{3,1}'), $8)
       ON CONFLICT (page_id, block_id) DO UPDATE
         SET title = EXCLUDED.title, starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on,
             remind_days = EXCLUDED.remind_days, audience = EXCLUDED.audience`,
      [
        handbookId,
        pageId,
        block.id,
        block.title,
        block.startsOn,
        block.endsOn ?? null,
        block.remindDays ?? null,
        JSON.stringify(block.audience ?? {}),
      ],
    );
  }
}

/** Администраторы справочника: участники-админы, администраторы факультета и деканат института. */
export async function handbookAdmins(db: Db, handbookId: string): Promise<string[]> {
  const rows = await many<{ person_id: string }>(
    db,
    `SELECT m.person_id FROM handbook_members m WHERE m.handbook_id = $1 AND m.role = 'admin'
      UNION
     SELECT r.person_id FROM org_roles r JOIN handbooks h ON h.institute_id = r.institute_id
      WHERE h.id = $1 AND r.role = 'faculty_admin' AND r.revoked_at IS NULL
      UNION
     SELECT p.id FROM persons p JOIN handbooks h ON h.institute_id = p.institute_id
      WHERE h.id = $1 AND p.role = 'dean' AND p.university_id = h.university_id`,
    [handbookId],
  );
  return rows.map((row) => row.person_id);
}

/**
 * Общую страницу опубликовали заново. Факультеты с уточнением получают новую общую часть сразу;
 * факультеты со своей версией — сообщение «общая обновилась, сравните»; факультеты, чьё уточнение
 * стояло после удалённого блока, — сообщение, что уточнение теперь в конце страницы.
 */
async function notifyBaseChange(client: Db, scope: EditorScope, pageId: string, version: number, before: Block[], after: Block[], note: string | null) {
  // Обновление видят факультеты без опубликованной своей версии этой страницы
  const faculties = await one<{ n: number }>(
    client,
    `SELECT count(DISTINCT h.institute_id)::int AS n FROM handbooks h
      WHERE h.parent_id = $1 AND h.status = 'active'
        AND page_for_handbook((SELECT institute_ids FROM pages WHERE id = $2), h.id)
        AND NOT EXISTS (SELECT 1 FROM pages ov WHERE ov.handbook_id = h.id AND ov.inherited_from = $2 AND ov.status = 'published')`,
    [scope.handbook.id, pageId],
  );
  const overrides = await many<{ id: string; handbook_id: string }>(
    client,
    `SELECT pg.id, pg.handbook_id FROM pages pg JOIN handbooks h ON h.id = pg.handbook_id AND h.status = 'active'
      WHERE pg.inherited_from = $1 AND pg.status <> 'archived'`,
    [pageId],
  );
  for (const override of overrides) {
    for (const admin of await handbookAdmins(client, override.handbook_id)) {
      await enqueue(client, {
        personId: admin,
        kind: 'handbook_base_changed',
        payload: { pageId: override.id, basePageId: pageId, version, note: isTemplateHint(note) ? null : note },
        dedupeKey: `hb_base:${override.id}:${version}:${admin}`,
      });
    }
  }
  const kept = new Set(after.map((block) => block.id));
  const removed = new Set(before.map((block) => block.id).filter((id) => !kept.has(id)));
  const lost = removed.size
    ? await many<{ handbook_id: string }>(
        client,
        "SELECT handbook_id FROM page_supplements WHERE base_page_id = $1 AND status = 'published' AND anchor_block_id = ANY($2::text[])",
        [pageId, [...removed]],
      )
    : [];
  for (const supplement of lost) {
    for (const admin of await handbookAdmins(client, supplement.handbook_id)) {
      await enqueue(client, {
        personId: admin,
        kind: 'supplement_anchor_lost',
        payload: { basePageId: pageId, handbookId: supplement.handbook_id, version },
        dedupeKey: `hb_anchor:${pageId}:${supplement.handbook_id}:${version}:${admin}`,
      });
    }
  }
  return { faculties: faculties?.n ?? 0, overrides: overrides.length, anchorsLost: lost.length };
}

/**
 * «Ничего не изменилось»: ответственный подтверждает актуальность без новой публикации.
 * Дата проверки у студентов обновляется, следующая проверка сдвигается на интервал страницы.
 */
export async function verifyPage(_db: Db, scope: EditorScope, pageId: string) {
  return tx(async (client) => {
    const page = await ownPage(client, scope, pageId, { lock: true });
    if (scope.role !== 'admin' && page.owner_person_id !== scope.personId && page.backup_owner_person_id !== scope.personId) {
      throw forbidden('Подтвердить актуальность может ответственный за страницу или администратор');
    }
    if (page.status !== 'published') throw new AppError('not_published', 'Подтвердить можно только опубликованную страницу', 409);
    const row = await one<{ checked_at: Date; review_at: string }>(
      client,
      `UPDATE pages SET checked_at = now(), review_at = (now() + make_interval(days => review_interval_days))::date
        WHERE id = $1 RETURNING checked_at, to_char(review_at, 'YYYY-MM-DD') AS review_at`,
      [pageId],
    );
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.page.verify', entity: 'page', entityId: pageId });
    return { checkedAt: row!.checked_at, reviewAt: row!.review_at };
  });
}

export const ownershipSchema = z.object({
  ownerPersonId: z.string().uuid().nullable().optional(),
  ownerUnit: z.string().trim().max(120).nullable().optional(),
  backupPersonId: z.string().uuid().nullable().optional(),
  reviewIntervalDays: z.coerce.number().int().min(7).max(730).optional(),
});

/** Для каких факультетов общая страница: null — для всех, иначе список институтов. */
export const facultyScopeSchema = z.object({
  instituteIds: z.array(z.string().uuid()).max(500).nullable(),
});

/**
 * Выбор факультетов для общей страницы. Действует сразу, без новой публикации: страница появляется
 * или пропадает у студентов выбранных факультетов. Уточнения и свои версии факультетов не удаляются.
 */
export async function setFacultyScope(_db: Db, scope: EditorScope, pageId: string, input: z.infer<typeof facultyScopeSchema>) {
  requireAdmin(scope);
  if (scope.handbook.institute_id !== null) throw new AppError('not_base', 'Выбор факультетов есть только у страниц общей базы', 409);
  const ids = input.instituteIds ? [...new Set(input.instituteIds)] : null;
  if (ids && ids.length === 0) throw new AppError('no_faculties', 'Выберите хотя бы один факультет или «Все факультеты»', 400);
  return tx(async (client) => {
    await ownPage(client, scope, pageId, { lock: true });
    if (ids) {
      const found = await one<{ n: number }>(client, 'SELECT count(*)::int AS n FROM institutes WHERE id = ANY($1::uuid[]) AND university_id = $2', [ids, scope.handbook.university_id]);
      if ((found?.n ?? 0) !== ids.length) throw notFound('Факультет не найден в этом вузе');
    }
    await client.query('UPDATE pages SET institute_ids = $2, updated_at = now() WHERE id = $1', [pageId, ids]);
    await audit(client, {
      universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId,
      action: 'handbook.page.faculties', entity: 'page', entityId: pageId, data: { instituteIds: ids },
    });
    return { instituteIds: ids };
  });
}

/** Кто отвечает за страницу и как часто её проверять. Меняет администратор справочника. */
export async function setOwnership(_db: Db, scope: EditorScope, pageId: string, input: z.infer<typeof ownershipSchema>) {
  requireAdmin(scope);
  if (input.ownerPersonId && input.ownerPersonId === input.backupPersonId) {
    throw new AppError('same_person', 'Замена — другой человек: выберите не того, кто уже отвечает за страницу', 400);
  }
  return tx(async (client) => {
    await ownPage(client, scope, pageId, { lock: true });
    for (const personId of [input.ownerPersonId, input.backupPersonId]) {
      if (!personId) continue;
      const person = await one(client, 'SELECT 1 FROM persons WHERE id = $1 AND university_id = $2', [personId, scope.handbook.university_id]);
      if (!person) throw notFound('Сотрудник не найден в этом вузе');
    }
    await client.query(
      `UPDATE pages
          SET owner_person_id = CASE WHEN $2::boolean THEN $3::uuid ELSE owner_person_id END,
              owner_unit = CASE WHEN $4::boolean THEN $5 ELSE owner_unit END,
              backup_owner_person_id = CASE WHEN $6::boolean THEN $7::uuid ELSE backup_owner_person_id END,
              review_interval_days = COALESCE($8, review_interval_days),
              review_at = CASE WHEN $8::int IS NOT NULL AND checked_at IS NOT NULL THEN (checked_at + make_interval(days => $8::int))::date ELSE review_at END
        WHERE id = $1`,
      [
        pageId,
        input.ownerPersonId !== undefined, input.ownerPersonId ?? null,
        input.ownerUnit !== undefined, input.ownerUnit || null,
        input.backupPersonId !== undefined, input.backupPersonId ?? null,
        input.reviewIntervalDays ?? null,
      ],
    );
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.page.owner', entity: 'page', entityId: pageId, data: input });
    return { ok: true as const };
  });
}

export async function pageForEditor(db: Db, scope: EditorScope, pageId: string) {
  const page = await ownPage(db, scope, pageId);
  const people = await one<{ owner: string | null; backup: string | null }>(
    db,
    'SELECT (SELECT full_name FROM persons WHERE id = $1) AS owner, (SELECT full_name FROM persons WHERE id = $2) AS backup',
    [page.owner_person_id, page.backup_owner_person_id],
  );
  const base = page.inherited_from
    ? await one<{ id: string; title: string; version_no: number; status: string; owner_unit: string | null }>(
        db, 'SELECT id, title, version_no, status, owner_unit FROM pages WHERE id = $1', [page.inherited_from],
      )
    : undefined;
  // Оценки студентов: всего и после последней публикации; комментарии «не помогла» — подсказка, что исправить
  const rating = await one<{ helpful: number; not_helpful: number; recent_helpful: number; recent_not_helpful: number }>(
    db,
    `SELECT helpful, not_helpful, GREATEST(helpful - helpful_before, 0) AS recent_helpful,
            GREATEST(not_helpful - not_helpful_before, 0) AS recent_not_helpful FROM pages WHERE id = $1`,
    [pageId],
  );
  const complaints = await many<{ comment: string; created_at: Date }>(
    db,
    `SELECT comment, created_at FROM page_feedback
      WHERE page_id = $1 AND NOT helpful AND comment IS NOT NULL AND btrim(comment) <> ''
        AND ($2::timestamptz IS NULL OR created_at > $2)
      ORDER BY created_at DESC LIMIT 5`,
    [pageId, page.published_at],
  );
  const versions = await many<{ id: number; title: string; created_at: Date; note: string | null; author: string | null }>(
    db,
    `SELECT v.id, v.title, v.created_at, v.note, p.full_name AS author
       FROM page_versions v LEFT JOIN persons p ON p.id = v.author_person_id
      WHERE v.page_id = $1 ORDER BY v.created_at DESC LIMIT 10`,
    [pageId],
  );
  return {
    page: {
      id: page.id,
      sectionId: page.section_id,
      title: page.draft_title ?? page.title,
      summary: page.draft_blocks !== null ? page.draft_summary : page.summary,
      audience: page.audience,
      status: editorStatus(page),
      hasDraft: page.draft_blocks !== null,
      blocks: page.draft_blocks ?? page.blocks,
      publishedTitle: page.title,
      publishedAt: page.published_at,
      checkedAt: page.checked_at,
      reviewAt: page.review_at,
      note: page.draft_note,
      updatedAt: page.version,
      returnNote: page.return_note,
      returnedAt: page.returned_at,
    },
    /** Версия страницы: её клиент присылает в PATCH и publish как baseUpdatedAt (C1). */
    updatedAt: page.version,
    /** Почему администратор вернул страницу на доработку (C2); null — не возвращали или уже отправили снова. */
    returnNote: page.return_note,
    /** Когда вернули на доработку (null — не возвращали): так видно возврат и без причины. */
    returnedAt: page.returned_at,
    versions,
    /** Оценки: recent* — после последней публикации, по ним ставится отметка «не помогла». */
    rating: {
      helpful: rating?.helpful ?? 0,
      notHelpful: rating?.not_helpful ?? 0,
      recentHelpful: rating?.recent_helpful ?? 0,
      recentNotHelpful: rating?.recent_not_helpful ?? 0,
      since: page.published_at,
      complaints: complaints.map((row) => ({ text: row.comment, at: row.created_at })),
    },
    /** Роль в справочнике: редактор отправляет на проверку, администратор публикует. */
    role: scope.role,
    /** Что мешает опубликовать черновик (пусто — можно публиковать). */
    issues: pageIssues(page.draft_blocks ?? page.blocks, page.draft_note),
    /** Ссылка на страницу для QR-плаката и «Поделиться». */
    link: deepLink(await getBotIdentity(), 'startapp', `hbp_${page.id}`),
    handbook: { title: scope.handbook.title, emoji: scope.handbook.emoji, isBase: scope.handbook.institute_id === null },
    /** Общая база: для каких факультетов страница (null — для всех) и из кого выбирать. */
    faculties: scope.handbook.institute_id === null
      ? {
          selected: (await one<{ institute_ids: string[] | null }>(db, 'SELECT institute_ids FROM pages WHERE id = $1', [page.id]))?.institute_ids ?? null,
          options: (await many<{ id: string; name: string; short_name: string }>(
            db, 'SELECT id, name, short_name FROM institutes WHERE university_id = $1 AND closed_at IS NULL ORDER BY short_name', [scope.handbook.university_id],
          )).map((row) => ({ id: row.id, name: row.name, shortName: row.short_name })),
        }
      : null,
    /** Ответственность за актуальность: кто, замена, как часто проверять. */
    ownership: {
      ownerPersonId: page.owner_person_id,
      ownerName: people?.owner ?? null,
      ownerUnit: page.owner_unit,
      backupPersonId: page.backup_owner_person_id,
      backupName: people?.backup ?? null,
      reviewIntervalDays: page.review_interval_days,
      checkedAt: page.checked_at,
      reviewAt: page.review_at,
    },
    /** Своя версия факультета: из какой общей версии создана и не обновилась ли общая с тех пор. */
    override: base
      ? {
          basePageId: base.id,
          baseTitle: base.title,
          baseVersion: base.version_no,
          fromVersion: page.base_version ?? 0,
          behind: base.status === 'published' && base.version_no > (page.base_version ?? 0),
          baseArchived: base.status === 'archived',
          baseOwnerUnit: base.owner_unit,
          reason: page.override_reason,
        }
      : null,
  };
}

/** Бэклог редактора: что искали и не нашли, вопросы без ответа, устаревшие страницы. */
export async function analytics(db: Db, scope: EditorScope) {
  const [gaps, top, stale, questions, weak] = await Promise.all([
    many<{ query: string; n: number; last_at: Date }>(
      db,
      `SELECT normalized AS query, count(*)::int AS n, max(created_at) AS last_at
         FROM search_log WHERE handbook_id = $1 AND results = 0 AND normalized <> '' AND created_at > now() - interval '90 days'
        GROUP BY normalized ORDER BY n DESC, last_at DESC LIMIT 15`,
      [scope.handbook.id],
    ),
    many<{ query: string; n: number }>(
      db,
      `SELECT normalized AS query, count(*)::int AS n FROM search_log
        WHERE handbook_id = $1 AND normalized <> '' AND created_at > now() - interval '90 days'
        GROUP BY normalized ORDER BY n DESC LIMIT 10`,
      [scope.handbook.id],
    ),
    many<{ id: string; title: string; checked_at: Date | null; review_at: string | null }>(
      db,
      `SELECT id, title, checked_at, review_at FROM pages
        WHERE handbook_id = $1 AND status = 'published'
          AND (checked_at IS NULL OR checked_at < now() - interval '180 days' OR (review_at IS NOT NULL AND review_at <= now()::date))
        ORDER BY checked_at NULLS FIRST LIMIT 10`,
      [scope.handbook.id],
    ),
    many<{ id: string; text: string; created_at: Date; query: string | null }>(
      db,
      "SELECT id, text, created_at, query FROM handbook_questions WHERE handbook_id = $1 AND status = 'open' ORDER BY created_at LIMIT 20",
      [scope.handbook.id],
    ),
    many<{ id: string; title: string; helpful: number; not_helpful: number }>(
      db,
      // Только оценки после последней публикации: исправленная страница уходит из списка
      `SELECT id, title, helpful - helpful_before AS helpful, not_helpful - not_helpful_before AS not_helpful FROM pages
        WHERE handbook_id = $1 AND status <> 'archived' AND not_helpful - not_helpful_before > helpful - helpful_before
          AND (helpful - helpful_before) + (not_helpful - not_helpful_before) >= 3
        ORDER BY not_helpful - not_helpful_before DESC LIMIT 5`,
      [scope.handbook.id],
    ),
  ]);
  const totals = await one<{ readers: number; views: number; published: number; drafts: number }>(
    db,
    `SELECT (SELECT count(*)::int FROM handbook_readers WHERE handbook_id = $1) AS readers,
            (SELECT COALESCE(sum(views), 0)::int FROM pages WHERE handbook_id = $1) AS views,
            (SELECT count(*)::int FROM pages WHERE handbook_id = $1 AND status = 'published') AS published,
            (SELECT count(*)::int FROM pages WHERE handbook_id = $1 AND status IN ('draft', 'review')) AS drafts`,
    [scope.handbook.id],
  );
  return { totals, gaps, top, stale, questions, weak, pilot: await pilotMetrics(db, scope.handbook.id) };
}

/**
 * Метрики пилота — те же, что обещаем в презентации (docs/HANDBOOK.md, «Метрики пилота»),
 * считаются из данных самого справочника: деканат видит эффект без выгрузок.
 */
export async function pilotMetrics(db: Db, handbookId: string) {
  const row = await one<{
    searches: number;
    found: number;
    helpful: number;
    not_helpful: number;
    answered: number;
    median_answer_minutes: number | null;
    published: number;
    fresh: number;
    active_readers: number;
  }>(
    db,
    `SELECT
       -- пустые запросы (одни знаки препинания), записанные до исправления API-5, метрику не портят
       (SELECT count(*)::int FROM search_log WHERE handbook_id = $1 AND normalized <> '' AND created_at > now() - interval '30 days') AS searches,
       (SELECT count(*)::int FROM search_log WHERE handbook_id = $1 AND normalized <> '' AND created_at > now() - interval '30 days' AND results > 0) AS found,
       (SELECT COALESCE(sum(helpful), 0)::int FROM pages WHERE handbook_id = $1 AND status = 'published') AS helpful,
       (SELECT COALESCE(sum(not_helpful), 0)::int FROM pages WHERE handbook_id = $1 AND status = 'published') AS not_helpful,
       (SELECT count(*)::int FROM handbook_questions
         WHERE handbook_id = $1 AND status = 'answered' AND answered_at > now() - interval '30 days') AS answered,
       (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - created_at)) / 60)::int
          FROM handbook_questions
         WHERE handbook_id = $1 AND status = 'answered' AND answered_at > now() - interval '30 days') AS median_answer_minutes,
       (SELECT count(*)::int FROM pages WHERE handbook_id = $1 AND status = 'published') AS published,
       (SELECT count(*)::int FROM pages WHERE handbook_id = $1 AND status = 'published' AND checked_at > now() - interval '180 days') AS fresh,
       (SELECT count(*)::int FROM handbook_readers WHERE handbook_id = $1 AND last_seen_at > now() - interval '14 days') AS active_readers`,
    [handbookId],
  );
  const r = row!;
  return {
    searches: r.searches,
    found: r.found,
    helpful: r.helpful,
    notHelpful: r.not_helpful,
    answered: r.answered,
    medianAnswerMinutes: r.median_answer_minutes,
    published: r.published,
    fresh: r.fresh,
    activeReaders: r.active_readers,
  };
}

export async function answerQuestion(db: Db, scope: EditorScope, questionId: string, answer: string, addToPageId: string | null) {
  return tx(async (client) => {
    const question = await one<{ id: string; reader_id: string | null; user_id: number | null; status: string; text: string }>(
      client,
      "SELECT id, reader_id, user_id, status, text FROM handbook_questions WHERE id = $1 AND handbook_id = $2 FOR UPDATE",
      [questionId, scope.handbook.id],
    );
    if (!question) throw notFound('Вопрос не найден');
    if (question.status === 'answered') throw new AppError('already_answered', 'На этот вопрос уже ответили', 409);
    const text = answer.trim().slice(0, 1500);
    if (text.length < 2) throw new AppError('answer_short', 'Напишите ответ — хотя бы пару слов', 400);
    const targetPage = addToPageId ? await ownPage(client, scope, addToPageId, { lock: true }) : null;
    // Ответ в архивной странице никто не увидит, а сама страница не должна «оживать» от ответа дежурного
    if (targetPage?.status === 'archived') {
      throw new AppError('page_archived', 'Эта страница в архиве — выберите для ответа другую страницу', 409);
    }
    await client.query(
      "UPDATE handbook_questions SET status = 'answered', answer = $2, answered_by = $3, answered_at = now(), page_id = $4 WHERE id = $1",
      [questionId, text, scope.personId, addToPageId],
    );
    if (addToPageId && targetPage) {
      const page = targetPage;
      const blocks: Block[] = (page.draft_blocks ?? page.blocks) as Block[];
      const faq = blocks.find((block) => block.type === 'faq');
      const item = { id: `q${Date.now().toString(36)}`, question: question.text.slice(0, 200), answer: text.slice(0, 2000) };
      // В блоке не больше 20 вопросов: если он заполнен, ответ уходит в новый блок, а не пропадает
      const next = faq && faq.items.length < 20
        ? blocks.map((block) => (block === faq ? { ...faq, items: [...faq.items, item] } : block))
        : [...blocks, { id: `faq${Date.now().toString(36)}`, type: 'faq' as const, items: [item] }];
      await client.query("UPDATE pages SET draft_blocks = $2, status = CASE WHEN status = 'published' THEN 'published' ELSE status END, updated_at = now() WHERE id = $1", [
        addToPageId,
        JSON.stringify(next),
      ]);
    }
    if (question.reader_id && question.user_id) {
      await enqueueToReader(client, {
        readerId: question.reader_id,
        userId: question.user_id,
        universityId: scope.handbook.university_id,
        kind: 'handbook_answer',
        payload: { questionId },
        dedupeKey: `hb_answer:${questionId}`,
      });
    }
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.question.answer', entity: 'handbook_question', entityId: questionId });
    return { id: questionId, addedToPage: Boolean(addToPageId) };
  });
}

export const announcementSchema = z.object({
  title: z.string().trim().min(3, 'Заголовок от 3 символов').max(120),
  body: z.string().trim().min(5, 'Текст объявления от 5 символов').max(1000),
  audience: audienceSchema.optional(),
  pageId: z.string().uuid('Выберите страницу из списка').optional().nullable(),
  startsOn: calendarDate.optional().nullable(),
  endsOn: calendarDate.optional().nullable(),
  notify: z.boolean().optional(),
});

/** Дата окончания не раньше даты начала — иначе объявление не покажется никому. */
function assertAnnouncementDates(startsOn: string | null | undefined, endsOn: string | null | undefined) {
  if (startsOn && endsOn && endsOn < startsOn) throw new AppError('validation_error', 'Дата окончания объявления раньше даты начала', 400);
}

/** «Подробнее» в объявлении ведёт только на свою опубликованную страницу или страницу вуза над справочником. */
async function assertAnnouncementPage(client: Db, scope: EditorScope, pageId: string | null | undefined) {
  if (!pageId) return;
  const page = await one(
    client,
    "SELECT 1 FROM pages WHERE id = $1 AND status = 'published' AND (handbook_id = $2 OR handbook_id = $3)",
    [pageId, scope.handbook.id, scope.handbook.parent_id],
  );
  if (!page) throw notFound('Страница для объявления не найдена или не опубликована');
}

export async function announce(db: Db, scope: EditorScope, input: z.infer<typeof announcementSchema>) {
  requireAdmin(scope);
  assertAnnouncementDates(input.startsOn, input.endsOn);
  return tx(async (client) => {
    await assertAnnouncementPage(client, scope, input.pageId);
    // Объявление с будущей датой начала приходит в чат в этот день в 10:00 по времени вуза, а не сразу
    const university = await getUniversity(client, scope.handbook.university_id);
    const sendAfter = input.startsOn && input.startsOn > todayIn(university.timezone) ? zonedToUtc(input.startsOn, '10:00', university.timezone) : undefined;
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO announcements(handbook_id, title, body, audience, page_id, starts_on, ends_on, created_by)
       VALUES ($1, $2, $3, COALESCE($4, '{}'::jsonb), $5, $6, $7, $8) RETURNING id`,
      [scope.handbook.id, input.title, input.body, input.audience ? JSON.stringify(input.audience) : null, input.pageId ?? null, input.startsOn ?? null, input.endsOn ?? null, scope.personId],
    );
    let notified = 0;
    if (input.notify !== false) {
      // Адресаты — читатели этого справочника и справочников факультетов, которые его наследуют
      // (объявление справочника вуза видно и им). Один человек — одно сообщение, даже если он читает оба.
      // Флажок «Напоминать о сроках» объявлений не касается: он только про сроки.
      const readers = await many<{ id: string; user_id: number }>(
        client,
        `SELECT DISTINCT ON (r.user_id) r.id, r.user_id
           FROM handbook_readers r
           JOIN handbooks rh ON rh.id = r.handbook_id AND rh.status = 'active'
          WHERE (rh.id = $1 OR rh.parent_id = $1)
            AND audience_matches($2::jsonb, r.course::int, r.dorm, r.tags)
          ORDER BY r.user_id, (rh.id = $1) DESC, r.last_seen_at DESC`,
        [scope.handbook.id, JSON.stringify(input.audience ?? {})],
      );
      for (const reader of readers) {
        const id = await enqueueToReader(client, {
          readerId: reader.id,
          userId: reader.user_id,
          universityId: scope.handbook.university_id,
          kind: 'handbook_announcement',
          payload: { announcementId: row!.id },
          dedupeKey: `hb_ann:${row!.id}:${reader.id}`,
          sendAfter,
        });
        if (id !== null) notified += 1;
      }
    }
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.announce', entity: 'announcement', entityId: row!.id, data: { notified } });
    return { id: row!.id, notified };
  });
}

export const announcementUpdateSchema = announcementSchema.omit({ notify: true });

/** Объявления справочника для редактора: действующие и прошедшие, сколько читателей отметили прочитанным. */
export async function listAnnouncements(db: Db, scope: EditorScope) {
  const university = await getUniversity(db, scope.handbook.university_id);
  const today = todayIn(university.timezone);
  const rows = await many<{
    id: string; title: string; body: string; audience: { courses?: number[] }; page_id: string | null; page_title: string | null;
    starts_on: string | null; ends_on: string | null; created_at: Date; updated_at: Date | null; reads: number; active: boolean;
  }>(
    db,
    `SELECT a.id, a.title, a.body, a.audience, a.page_id, p.title AS page_title,
            to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(a.ends_on, 'YYYY-MM-DD') AS ends_on,
            a.created_at, a.updated_at,
            (SELECT count(*)::int FROM announcement_reads r WHERE r.announcement_id = a.id) AS reads,
            (a.ends_on IS NULL OR a.ends_on >= $2::date) AS active
       FROM announcements a LEFT JOIN pages p ON p.id = a.page_id
      WHERE a.handbook_id = $1
      ORDER BY a.created_at DESC
      LIMIT 50`,
    [scope.handbook.id, today],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    courses: row.audience?.courses ?? [],
    pageId: row.page_id,
    pageTitle: row.page_title,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reads: row.reads,
    active: row.active,
  }));
}

/**
 * Правка объявления: читатели увидят новый текст на главной; повторно в чат оно не рассылается.
 * Не переданные поля не меняются. Курсы из формы заменяют прежние, остальная аудитория (общежитие, теги) сохраняется.
 * Если аудитория сузилась, ещё не отправленные уведомления тем, кого она больше не касается, отменяются.
 */
export async function updateAnnouncement(db: Db, scope: EditorScope, id: string, input: z.infer<typeof announcementUpdateSchema>) {
  requireAdmin(scope);
  return tx(async (client) => {
    const current = await one<{ audience: Record<string, unknown>; starts_on: string | null; ends_on: string | null }>(
      client,
      `SELECT audience, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on
         FROM announcements WHERE id = $1 AND handbook_id = $2 FOR UPDATE`,
      [id, scope.handbook.id],
    );
    if (!current) throw notFound('Объявление не найдено');
    if (input.pageId !== undefined) await assertAnnouncementPage(client, scope, input.pageId);
    const startsOn = input.startsOn !== undefined ? input.startsOn : current.starts_on;
    const endsOn = input.endsOn !== undefined ? input.endsOn : current.ends_on;
    assertAnnouncementDates(startsOn, endsOn);
    const { courses: _courses, ...rest } = (current.audience ?? {}) as { courses?: number[] };
    const audience = { ...rest, ...(input.audience ?? {}) };
    await client.query(
      `UPDATE announcements
          SET title = $3, body = $4, audience = $5::jsonb, page_id = CASE WHEN $6 THEN $7::uuid ELSE page_id END,
              starts_on = $8::date, ends_on = $9::date, updated_at = now()
        WHERE id = $1 AND handbook_id = $2`,
      [id, scope.handbook.id, input.title, input.body, JSON.stringify(audience), input.pageId !== undefined, input.pageId ?? null, startsOn, endsOn],
    );
    // Перенесли дату начала — ещё не отправленные уведомления уходят в новый день в 10:00 (или сразу, если он уже наступил)
    if ((startsOn ?? null) !== (current.starts_on ?? null)) {
      const university = await getUniversity(client, scope.handbook.university_id);
      const sendAfter = startsOn && startsOn > todayIn(university.timezone) ? zonedToUtc(startsOn, '10:00', university.timezone) : new Date();
      await client.query(
        "UPDATE notifications SET send_after = $2 WHERE status = 'pending' AND dedupe_key LIKE $1",
        [`hb_ann:${id}:%`, sendAfter],
      );
    }
    await client.query(
      `UPDATE notifications n SET status = 'cancelled'
        WHERE n.status = 'pending' AND n.dedupe_key LIKE $1
          AND NOT EXISTS (SELECT 1 FROM handbook_readers r
                           WHERE r.id = n.reader_id AND audience_matches($2::jsonb, r.course::int, r.dorm, r.tags))`,
      [`hb_ann:${id}:%`, JSON.stringify(audience)],
    );
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.announcement.update', entity: 'announcement', entityId: id });
    return { id };
  });
}

/** Удаление: объявление исчезает у всех, а ещё не отправленные уведомления о нём отменяются. */
export async function deleteAnnouncement(db: Db, scope: EditorScope, id: string) {
  requireAdmin(scope);
  return tx(async (client) => {
    const row = await one<{ id: string }>(client, 'DELETE FROM announcements WHERE id = $1 AND handbook_id = $2 RETURNING id', [id, scope.handbook.id]);
    if (!row) throw notFound('Объявление не найдено');
    await cancelPending(client, `hb_ann:${id}:`);
    // Объявление уже пришло в чаты — бот удалит эти сообщения, чтобы в чате не осталось того, чего нет в приложении
    const retracted = await retractSent(client, `hb_ann:${id}:`);
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.announcement.delete', entity: 'announcement', entityId: id, data: { retracted } });
    return { deleted: true, retracted };
  });
}

export const handbookInputSchema = z.object({
  instituteId: z.string().uuid('Выберите институт или факультет'),
  title: z.string().trim().min(3, 'Название справочника от 3 символов').max(120),
  subtitle: z.string().trim().max(200).optional().nullable(),
  emoji: z.string().trim().max(8).optional(),
  /** Развернуть стартовый скелет разделов и страниц-заготовок. */
  template: z.boolean().optional(),
  /** Наследовать общеуниверситетский справочник. */
  inherit: z.boolean().optional(),
});

/**
 * Создание справочника факультета — точка входа конструктора.
 * Деканат нажимает одну кнопку и получает готовую структуру разделов;
 * автор становится администратором справочника.
 */
export async function createHandbook(
  actor: { personId: string; userId: number; universityId: string; role: string; instituteId?: string | null; isDemo?: boolean },
  input: z.infer<typeof handbookInputSchema>,
) {
  if (actor.role !== 'dean' && !(actor.isDemo && actor.role === 'staff')) {
    throw forbidden('Создавать справочник может деканат или редактор своей демо-песочницы');
  }
  // Деканат без института не создаёт справочники за другие институты: их подключает администратор университета (D9)
  if (actor.instituteId !== undefined && actor.instituteId !== input.instituteId) {
    throw forbidden('Справочник создаётся для своего института: другой институт подключает администратор университета');
  }
  return tx(async (client) => {
    const university = await one<{ is_demo: boolean; demo_owner_user_id: number | null }>(
      client,
      'SELECT is_demo, demo_owner_user_id FROM universities WHERE id = $1',
      [actor.universityId],
    );
    if (actor.role === 'staff' && (!university?.is_demo || Number(university.demo_owner_user_id) !== actor.userId)) {
      throw forbidden('Редактор может создавать справочники только в своей демо-песочнице');
    }
    return createHandbookIn(client, { ...input, universityId: actor.universityId, ownerPersonId: actor.personId, actorUserId: actor.userId });
  });
}

/**
 * Справочник факультета в открытой транзакции: общий для деканата и администратора университета.
 * Заготовки шаблона, которые уже есть в общей базе, не создаются: общая страница и так видна студентам,
 * а копия-черновик разошлась бы с ней при первом обновлении (D2).
 */
export async function createHandbookIn(
  client: Db,
  input: z.infer<typeof handbookInputSchema> & { universityId: string; ownerPersonId: string; actorUserId: number },
) {
  const institute = await one<{ id: string; name: string }>(
    client,
    'SELECT id, name FROM institutes WHERE id = $1 AND university_id = $2',
    [input.instituteId, input.universityId],
  );
  if (!institute) throw notFound('Институт не найден');

  const parent = input.inherit === false
    ? null
    : await one<{ id: string }>(
        client,
        "SELECT id FROM handbooks WHERE university_id = $1 AND institute_id IS NULL AND status = 'active' ORDER BY created_at LIMIT 1",
        [input.universityId],
      );

  // Слаг справочника уникален на всей платформе: по нему работает диплинк hb_<слаг>.
  // Справочник из демо-песочницы получает служебный хвост, как у справочников самой песочницы:
  // иначе посетитель демо занял бы человекочитаемое имя («spravochnik-tgu») раньше настоящего вуза (API-7).
  const university = await one<{ is_demo: boolean }>(client, 'SELECT is_demo FROM universities WHERE id = $1', [input.universityId]);
  const base = slugify(input.title, 'handbook');
  const slugBase = university?.is_demo
    ? `${base.slice(0, 40).replace(/-+$/, '') || 'handbook'}-demo-${input.universityId.replace(/-/g, '').slice(0, 8)}`
    : base;
  const row = await insertWithUniqueSlug(slugBase, (slug) =>
    one<{ id: string; slug: string }>(
      client,
      `INSERT INTO handbooks(university_id, institute_id, parent_id, slug, title, subtitle, emoji)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, '📘'))
       ON CONFLICT (slug) DO NOTHING
       RETURNING id, slug`,
      [input.universityId, institute.id, parent?.id ?? null, slug, input.title, input.subtitle ?? null, input.emoji ?? null],
    ),
  );
  await client.query(
    "INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING",
    [row!.id, input.ownerPersonId],
  );
  const shared = parent
    ? new Set((await many<{ key: string }>(
        client,
        `SELECT bs.slug || '/' || bp.slug AS key FROM pages bp JOIN sections bs ON bs.id = bp.section_id
          WHERE bp.handbook_id = $1 AND bp.status <> 'archived' AND bp.institute_ids IS NULL`,
        [parent.id],
      )).map((r) => r.key))
    : new Set<string>();
  const seeded = input.template === false
    ? { sections: 0, pages: 0, skipped: 0 }
    : await seedTemplate(client, row!.id, { ownerPersonId: input.ownerPersonId, skip: shared });
  await audit(client, {
    universityId: input.universityId,
    actorPersonId: input.ownerPersonId,
    actorUserId: input.actorUserId,
    action: 'handbook.create',
    entity: 'handbook',
    entityId: row!.id,
    data: { institute: institute.name, ...seeded, inherited: Boolean(parent) },
  });
  return { ...row!, ...seeded, inherited: Boolean(parent) };
}

/**
 * Старшинство в команде справочника. Руководство (3) назначает университет или должность:
 * администратор университета — для общей базы, администратор факультета и деканат — для справочника факультета.
 * Ниже — администратор справочника (2) и редактор (1). Управлять можно только теми, кто младше:
 * администратор не меняет роль и не убирает другого администратора, а руководство — друг друга.
 */
export type TeamLead = 'university_admin' | 'faculty_admin' | 'dean';
const LEAD_TITLE: Record<TeamLead, string> = {
  university_admin: 'Администратор университета',
  faculty_admin: 'Администратор факультета',
  dean: 'Деканат',
};
const ROLE_TITLE: Record<MemberRole, string> = { admin: 'Администратор', editor: 'Редактор' };
const roleRank = (role: MemberRole | null) => (role === 'admin' ? 2 : role === 'editor' ? 1 : 0);

async function teamLeads(db: Db, handbook: HandbookRow, personIds: string[]): Promise<Map<string, TeamLead>> {
  if (!personIds.length) return new Map();
  const rows = await many<{ id: string; lead: TeamLead | null }>(
    db,
    `SELECT p.id,
            CASE
              WHEN EXISTS (SELECT 1 FROM org_roles r WHERE r.person_id = p.id AND r.revoked_at IS NULL AND r.university_id = $2
                             AND r.role = 'university_admin' AND $3::uuid IS NULL) THEN 'university_admin'
              WHEN EXISTS (SELECT 1 FROM org_roles r WHERE r.person_id = p.id AND r.revoked_at IS NULL AND r.university_id = $2
                             AND r.role = 'faculty_admin' AND r.institute_id = $3::uuid) THEN 'faculty_admin'
              WHEN p.role = 'dean' AND $3::uuid IS NOT NULL AND p.institute_id = $3::uuid THEN 'dean'
            END AS lead
       FROM persons p WHERE p.id = ANY($1::uuid[])`,
    [personIds, handbook.university_id, handbook.institute_id],
  );
  return new Map(rows.filter((r) => r.lead).map((r) => [r.id, r.lead!]));
}

/** Старшинство того, кто сейчас действует: руководство — 3, иначе по роли в справочнике. */
async function actorRank(db: Db, scope: EditorScope): Promise<number> {
  if (!scope.personId) return roleRank(scope.role);
  const leads = await teamLeads(db, scope.handbook, [scope.personId]);
  return leads.has(scope.personId) ? 3 : roleRank(scope.role);
}

async function targetRank(db: Db, scope: EditorScope, personId: string): Promise<number> {
  const leads = await teamLeads(db, scope.handbook, [personId]);
  if (leads.has(personId)) return 3;
  const member = await one<{ role: MemberRole }>(db, 'SELECT role FROM handbook_members WHERE handbook_id = $1 AND person_id = $2', [scope.handbook.id, personId]);
  return roleRank(member?.role ?? null);
}

const SENIOR = 'Управлять можно только теми, у кого роль ниже вашей: администратора назначает и убирает руководство справочника — деканат или администратор факультета';
const ADMIN_BY_LEAD = 'Назначить администратора может руководство справочника — деканат или администратор факультета. Вы можете пригласить редактора';

/** Добавить редактора: студсовет и тьюторы ведут справочник наравне с деканатом. */
export async function addMember(db: Db, scope: EditorScope, personId: string, role: MemberRole) {
  requireAdmin(scope);
  const person = await one<{ id: string; full_name: string }>(
    db,
    'SELECT id, full_name FROM persons WHERE id = $1 AND university_id = $2',
    [personId, scope.handbook.university_id],
  );
  if (!person) throw notFound('Человек не найден в вузе');
  const mine = await actorRank(db, scope);
  if (personId !== scope.personId && (await targetRank(db, scope, personId)) >= mine) throw forbidden(SENIOR);
  if (roleRank(role) >= mine) throw forbidden(ADMIN_BY_LEAD);
  await db.query(
    `INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (handbook_id, person_id) DO UPDATE SET role = EXCLUDED.role`,
    [scope.handbook.id, personId, role],
  );
  await audit(db, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.member.add', entity: 'person', entityId: personId, data: { role } });
  return { id: person.id, full_name: person.full_name, role };
}

export async function removeMember(db: Db, scope: EditorScope, personId: string) {
  requireAdmin(scope);
  if (personId === scope.personId) throw new AppError('self_remove', 'Нельзя удалить самого себя из редакторов', 409);
  if ((await targetRank(db, scope, personId)) >= (await actorRank(db, scope))) throw forbidden(SENIOR);
  return tx(async (client) => {
    const removed = await one(client, 'DELETE FROM handbook_members WHERE handbook_id = $1 AND person_id = $2 RETURNING person_id', [scope.handbook.id, personId]);
    if (!removed) throw notFound('Такого участника в команде нет');
    // Неиспользованная ссылка-приглашение больше не должна привязывать аккаунт
    await client.query('UPDATE invites SET expires_at = now() WHERE person_id = $1 AND used_at IS NULL', [personId]);
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.member.remove', entity: 'person', entityId: personId });
    return { ok: true };
  });
}

export const inviteSchema = z.object({
  fullName: z.string().trim().min(3, 'Укажите имя и фамилию').max(120),
  /** student — студсовет, staff — тьютор или сотрудник учебного офиса */
  kind: z.enum(['student', 'staff']).default('student'),
  role: z.enum(['editor', 'admin']).default('editor'),
});

/**
 * Пригласить редактора: студсовет, тьютора или сотрудника учебного офиса.
 * Создаётся запись вуза и персональная ссылка ?start=inv_<код>; открыв её в MAX,
 * человек становится редактором справочника — без регистрации и паролей.
 */
export async function inviteEditor(db: Db, scope: EditorScope, input: z.infer<typeof inviteSchema>) {
  requireAdmin(scope);
  if (roleRank(input.role) >= (await actorRank(db, scope))) throw forbidden(ADMIN_BY_LEAD);
  return tx(async (client) => {
    const identity = await getBotIdentity();
    // Двойное нажатие «Пригласить» не должно завести двух одинаковых участников (API-11):
    // то же приглашение в ближайшие минуты возвращает ту же ссылку
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hb_invite:${scope.handbook.id}`]);
    const recent = await one<{ id: string }>(
      client,
      `SELECT p.id FROM persons p JOIN handbook_members m ON m.person_id = p.id AND m.handbook_id = $1
        WHERE lower(p.full_name) = lower($2) AND p.role = $3 AND m.role = $4 AND p.user_id IS NULL
          AND p.created_at > now() - interval '10 minutes'
        ORDER BY p.created_at DESC LIMIT 1`,
      [scope.handbook.id, input.fullName, input.kind, input.role],
    );
    if (recent) {
      const code = await ensureInvite(client, recent.id, 30);
      return { personId: recent.id, code, link: deepLink(identity, 'start', `inv_${code}`) };
    }
    const person = await one<{ id: string }>(
      client,
      `INSERT INTO persons(university_id, institute_id, role, full_name) VALUES ($1, $2, $3, $4) RETURNING id`,
      [scope.handbook.university_id, scope.handbook.institute_id, input.kind, input.fullName],
    );
    await client.query('INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, $3)', [scope.handbook.id, person!.id, input.role]);
    const code = await ensureInvite(client, person!.id, 30);
    await audit(client, {
      universityId: scope.handbook.university_id,
      actorPersonId: scope.personId,
      actorUserId: scope.userId,
      action: 'handbook.member.invite',
      entity: 'person',
      entityId: person!.id,
      data: { role: input.role },
    });
    return { personId: person!.id, code, link: deepLink(identity, 'start', `inv_${code}`) };
  });
}

/** Редакторы справочника: кто уже принял приглашение, а у кого ссылка ещё не открыта. */
export async function listMembers(db: Db, scope: EditorScope) {
  const identity = await getBotIdentity();
  const rows = await many<{ person_id: string; full_name: string; role: MemberRole; kind: string; connected: boolean; code: string | null }>(
    db,
    `SELECT m.person_id, p.full_name, m.role, p.role AS kind, (p.user_id IS NOT NULL) AS connected,
            (SELECT i.code FROM invites i WHERE i.person_id = p.id AND i.used_at IS NULL AND i.expires_at > now()
              ORDER BY i.created_at DESC LIMIT 1) AS code
       FROM handbook_members m JOIN persons p ON p.id = m.person_id
      WHERE m.handbook_id = $1
      ORDER BY (m.role = 'admin') DESC, p.full_name`,
    [scope.handbook.id],
  );
  const leads = await teamLeads(db, scope.handbook, rows.map((row) => row.person_id));
  const mine = await actorRank(db, scope);
  const members = rows.map((row) => {
    const lead = leads.get(row.person_id) ?? null;
    const rank = lead ? 3 : roleRank(row.role);
    const you = row.person_id === scope.personId;
    return {
      personId: row.person_id,
      fullName: row.full_name,
      role: row.role,
      /** Подпись по старшинству: «Деканат», «Администратор факультета», «Администратор», «Редактор». */
      title: lead ? LEAD_TITLE[lead] : ROLE_TITLE[row.role],
      /** Кто это по записи вуза: студсовет или сотрудник. Руководству подпись не нужна. */
      kind: lead ? null : row.kind === 'student' ? 'студсовет' : 'сотрудник',
      rank,
      connected: row.connected,
      you,
      /** Менять роль и убирать из команды можно только тех, кто младше. */
      canManage: !you && scope.role === 'admin' && rank < mine,
      // Ссылка-приглашение — это ключ к правам: показываем её только тем, кто может управлять человеком
      link: scope.role === 'admin' && rank < mine && !row.connected && row.code ? deepLink(identity, 'start', `inv_${row.code}`) : null,
    };
  });
  return members.sort((a, b) => b.rank - a.rank || a.fullName.localeCompare(b.fullName, 'ru'));
}

/** Что может текущий участник в команде: приглашать администраторов — только руководство. */
export async function teamPowers(db: Db, scope: EditorScope) {
  const mine = await actorRank(db, scope);
  const leads = scope.personId ? await teamLeads(db, scope.handbook, [scope.personId]) : new Map<string, TeamLead>();
  const lead = scope.personId ? leads.get(scope.personId) ?? null : null;
  return { canInviteAdmin: scope.role === 'admin' && mine > 2, myTitle: lead ? LEAD_TITLE[lead] : ROLE_TITLE[scope.role] };
}
