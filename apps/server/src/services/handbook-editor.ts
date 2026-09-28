import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { many, one, tx } from '../db/pool.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { audit, getUniversity } from './common.js';
import { todayIn, zonedToUtc } from '../domain/dates.js';
import { cancelPending, enqueue, enqueueToReader } from '../notify/outbox.js';
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
  }>(
    db,
    `SELECT id, section_id, COALESCE(draft_title, title) AS title, title AS published_title, ${EDITOR_STATUS} AS status,
            updated_at, checked_at, review_at, (draft_blocks IS NOT NULL) AS has_draft, views, helpful, not_helpful
       FROM pages WHERE handbook_id = $1 ORDER BY position, COALESCE(draft_title, title)`,
    [scope.handbook.id],
  );
  return sections.map((section) => ({
    ...section,
    pages: pages.filter((page) => page.section_id === section.id),
  }));
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
    const section = await one<{ id: string }>(client, 'SELECT id FROM sections WHERE id = $1 AND handbook_id = $2', [input.sectionId, scope.handbook.id]);
    if (!section) throw notFound('Раздел не найден');
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
    const updated = await one<{ version: string }>(
      client,
      `UPDATE pages
          SET title = $2, summary = $3, blocks = $4, draft_title = NULL, draft_summary = NULL, draft_blocks = NULL,
              draft_note = NULL, status = 'published', review_requested_at = NULL, published_at = now(), updated_at = now(), checked_at = now(),
              review_at = (now() + interval '180 days')::date, search_text = $5, search_title = $6,
              return_note = NULL, returned_at = NULL
        WHERE id = $1 RETURNING ${PAGE_VERSION} AS version`,
      [pageId, title, summary, JSON.stringify(blocks), pageSearchText(summary, blocks), pageSearchTitle(title, section?.title ?? null)],
    );
    await client.query(
      'INSERT INTO page_versions(page_id, title, summary, blocks, author_person_id, note) VALUES ($1, $2, $3, $4, $5, $6)',
      // Подсказка шаблона в заметке — не комментарий к версии
      [pageId, title, summary, JSON.stringify(blocks), scope.personId, isTemplateHint(page.draft_note) ? null : page.draft_note],
    );
    await syncDeadlines(client, scope.handbook.id, pageId, blocks);
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.page.publish', entity: 'page', entityId: pageId });
    return { id: pageId, status: 'published' as const, updatedAt: updated!.version };
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
  await db.query('DELETE FROM handbook_deadlines WHERE page_id = $1 AND NOT (block_id = ANY($2::text[]))', [pageId, deadlines.map((block) => block.id)]);
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

export async function pageForEditor(db: Db, scope: EditorScope, pageId: string) {
  const page = await ownPage(db, scope, pageId);
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
    /** Роль в справочнике: редактор отправляет на проверку, администратор публикует. */
    role: scope.role,
    /** Что мешает опубликовать черновик (пусто — можно публиковать). */
    issues: pageIssues(page.draft_blocks ?? page.blocks, page.draft_note),
    /** Ссылка на страницу для QR-плаката и «Поделиться». */
    link: deepLink(await getBotIdentity(), 'startapp', `hbp_${page.id}`),
    handbook: { title: scope.handbook.title, emoji: scope.handbook.emoji },
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
      `SELECT id, title, helpful, not_helpful FROM pages
        WHERE handbook_id = $1 AND not_helpful > helpful AND (helpful + not_helpful) >= 3
        ORDER BY not_helpful DESC LIMIT 5`,
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
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'handbook.announcement.delete', entity: 'announcement', entityId: id });
    return { deleted: true };
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
  if (actor.instituteId && actor.instituteId !== input.instituteId) {
    throw forbidden('Справочник создаётся для своего института: другой институт подключает его деканат');
  }
  return tx(async (client) => {
    const institute = await one<{ id: string; name: string }>(
      client,
      'SELECT id, name FROM institutes WHERE id = $1 AND university_id = $2',
      [input.instituteId, actor.universityId],
    );
    if (!institute) throw notFound('Институт не найден');

    const parent = input.inherit === false
      ? null
      : await one<{ id: string }>(
          client,
          "SELECT id FROM handbooks WHERE university_id = $1 AND institute_id IS NULL AND status = 'active' ORDER BY created_at LIMIT 1",
          [actor.universityId],
        );

    // Слаг справочника уникален на всей платформе: по нему работает диплинк hb_<слаг>.
    // Справочник из демо-песочницы получает служебный хвост, как у справочников самой песочницы:
    // иначе посетитель демо занял бы человекочитаемое имя («spravochnik-tgu») раньше настоящего вуза (API-7).
    const university = await one<{ is_demo: boolean; demo_owner_user_id: number | null }>(
      client,
      'SELECT is_demo, demo_owner_user_id FROM universities WHERE id = $1',
      [actor.universityId],
    );
    if (actor.role === 'staff' && (!university?.is_demo || Number(university.demo_owner_user_id) !== actor.userId)) {
      throw forbidden('Редактор может создавать справочники только в своей демо-песочнице');
    }
    const base = slugify(input.title, 'handbook');
    const slugBase = university?.is_demo
      ? `${base.slice(0, 40).replace(/-+$/, '') || 'handbook'}-demo-${actor.universityId.replace(/-/g, '').slice(0, 8)}`
      : base;
    const row = await insertWithUniqueSlug(slugBase, (slug) =>
      one<{ id: string; slug: string }>(
        client,
        `INSERT INTO handbooks(university_id, institute_id, parent_id, slug, title, subtitle, emoji)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, '📘'))
         ON CONFLICT (slug) DO NOTHING
         RETURNING id, slug`,
        [actor.universityId, institute.id, parent?.id ?? null, slug, input.title, input.subtitle ?? null, input.emoji ?? null],
      ),
    );
    await client.query(
      "INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING",
      [row!.id, actor.personId],
    );
    const seeded = input.template === false ? { sections: 0, pages: 0 } : await seedTemplate(client, row!.id, { ownerPersonId: actor.personId });
    await audit(client, {
      universityId: actor.universityId,
      actorPersonId: actor.personId,
      actorUserId: actor.userId,
      action: 'handbook.create',
      entity: 'handbook',
      entityId: row!.id,
      data: { institute: institute.name, ...seeded, inherited: Boolean(parent) },
    });
    return { ...row!, ...seeded, inherited: Boolean(parent) };
  });
}

/** Добавить редактора: студсовет и тьюторы ведут справочник наравне с деканатом. */
export async function addMember(db: Db, scope: EditorScope, personId: string, role: MemberRole) {
  requireAdmin(scope);
  const person = await one<{ id: string; full_name: string }>(
    db,
    'SELECT id, full_name FROM persons WHERE id = $1 AND university_id = $2',
    [personId, scope.handbook.university_id],
  );
  if (!person) throw notFound('Человек не найден в вузе');
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
  const rows = await many<{ person_id: string; full_name: string; role: MemberRole; connected: boolean; code: string | null }>(
    db,
    `SELECT m.person_id, p.full_name, m.role, (p.user_id IS NOT NULL) AS connected,
            (SELECT i.code FROM invites i WHERE i.person_id = p.id AND i.used_at IS NULL AND i.expires_at > now()
              ORDER BY i.created_at DESC LIMIT 1) AS code
       FROM handbook_members m JOIN persons p ON p.id = m.person_id
      WHERE m.handbook_id = $1
      ORDER BY (m.role = 'admin') DESC, p.full_name`,
    [scope.handbook.id],
  );
  return rows.map((row) => ({
    personId: row.person_id,
    fullName: row.full_name,
    role: row.role,
    connected: row.connected,
    you: row.person_id === scope.personId,
    // Ссылка-приглашение — это ключ к правам: показываем её только администратору
    link: scope.role === 'admin' && !row.connected && row.code ? deepLink(identity, 'start', `inv_${row.code}`) : null,
  }));
}
