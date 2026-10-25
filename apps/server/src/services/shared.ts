import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { many, one, tx } from '../db/pool.js';
import { AppError, notFound } from '../lib/errors.js';
import { audit, getUniversity } from './common.js';
import { todayIn } from '../domain/dates.js';
import {
  BLOCK_LABEL, blockText, blocksSchema, draftBlocksSchema, pageSearchText, publishIssues, slugify, type Block,
} from '../domain/handbook.js';
import { localizeBlocks } from './handbook.js';
import { handbookAdmins, requireAdmin, syncDeadlines, type EditorScope } from './handbook-editor.js';
import { enqueue } from '../notify/outbox.js';

/**
 * Общая база университета глазами факультета и университета:
 * влияние общей страницы, уточнение факультета, своя версия и её сверка с общей.
 */

interface BasePage {
  id: string;
  handbook_id: string;
  section_id: string;
  section_slug: string;
  section_title: string;
  section_emoji: string;
  section_position: number;
  slug: string;
  title: string;
  summary: string | null;
  blocks: Block[];
  status: string;
  version_no: number;
  institute_ids: string[] | null;
  checked_at: Date | null;
  review_at: string | null;
  owner_unit: string | null;
  owner_name: string | null;
}

const BASE_SELECT = `
  SELECT p.id, p.handbook_id, p.section_id, s.slug AS section_slug, s.title AS section_title, s.emoji AS section_emoji,
         s.position AS section_position, p.slug, p.title, p.summary, p.blocks, p.status, p.version_no, p.institute_ids, p.checked_at,
         to_char(p.review_at, 'YYYY-MM-DD') AS review_at, p.owner_unit, ow.full_name AS owner_name
    FROM pages p JOIN sections s ON s.id = p.section_id
    LEFT JOIN persons ow ON ow.id = p.owner_person_id`;

/** Страница общей базы, над которой стоит справочник факультета. */
async function baseOf(db: Db, scope: EditorScope, basePageId: string, options: { published?: boolean } = {}): Promise<BasePage> {
  if (!scope.handbook.parent_id) throw new AppError('no_base', 'У этого справочника нет общей базы университета', 409);
  const page = await one<BasePage>(db, `${BASE_SELECT} WHERE p.id = $1 AND p.handbook_id = $2`, [basePageId, scope.handbook.parent_id]);
  if (!page || page.status === 'archived' || (options.published !== false && page.status !== 'published')) {
    throw notFound('Общая страница не найдена или снята с публикации');
  }
  // Страница «только для выбранных факультетов», а этого факультета среди них нет
  if (page.institute_ids && !page.institute_ids.includes(scope.handbook.institute_id ?? '')) {
    throw notFound('Эта общая страница не для вашего факультета — университет показывает её только выбранным факультетам');
  }
  return page;
}

// ─── Университет: кто использует общую страницу ───

export interface FacultyUsage {
  handbookId: string;
  title: string;
  shortName: string;
  relation: 'inherit' | 'supplement' | 'override';
  supplementStatus: string | null;
  supplementText: string | null;
  anchorLabel: string | null;
  overridePageId: string | null;
  overrideBehind: boolean;
  overrideReason: string | null;
}

/** Факультеты, которые показывают общую страницу, и как: как есть, с уточнением или своей версией. */
export async function pageImpact(db: Db, baseHandbookId: string, basePageId: string) {
  const page = await one<{ blocks: Block[]; version_no: number; institute_ids: string[] | null }>(
    db, 'SELECT blocks, version_no, institute_ids FROM pages WHERE id = $1 AND handbook_id = $2', [basePageId, baseHandbookId],
  );
  if (!page) throw notFound('Страница не найдена');
  // Факультеты, которым страница не показывается: для подписи «не показывается: ФП»
  const excluded = page.institute_ids
    ? await many<{ id: string; short_name: string }>(
        db,
        `SELECT DISTINCT i.id, i.short_name FROM handbooks h JOIN institutes i ON i.id = h.institute_id
          WHERE h.parent_id = $1 AND h.status = 'active' AND NOT (i.id = ANY($2::uuid[])) ORDER BY i.short_name`,
        [baseHandbookId, page.institute_ids],
      )
    : [];
  const rows = await many<{
    handbook_id: string; title: string; short_name: string; sup_status: string | null; sup_blocks: Block[] | null; sup_draft: Block[] | null;
    anchor: string | null; override_id: string | null; base_version: number | null; override_reason: string | null;
  }>(
    db,
    `SELECT h.id AS handbook_id, h.title, i.short_name, sup.status AS sup_status, sup.blocks AS sup_blocks, sup.draft_blocks AS sup_draft,
            sup.anchor_block_id AS anchor, ov.id AS override_id, ov.base_version, ov.override_reason
       FROM handbooks h JOIN institutes i ON i.id = h.institute_id
       LEFT JOIN page_supplements sup ON sup.handbook_id = h.id AND sup.base_page_id = $2 AND sup.status <> 'archived'
       LEFT JOIN pages ov ON ov.handbook_id = h.id AND ov.inherited_from = $2 AND ov.status <> 'archived'
      WHERE h.parent_id = $1 AND h.status = 'active' AND ($3::uuid[] IS NULL OR h.institute_id = ANY($3::uuid[]))
      ORDER BY i.short_name`,
    [baseHandbookId, basePageId, page.institute_ids],
  );
  const faculties: FacultyUsage[] = rows.map((row) => {
    const supBlocks = row.sup_status === 'published' ? row.sup_blocks : row.sup_draft ?? row.sup_blocks;
    const anchorBlock = row.anchor ? page.blocks.find((block) => block.id === row.anchor) : undefined;
    return {
      handbookId: row.handbook_id,
      title: row.title,
      shortName: row.short_name,
      relation: row.override_id ? 'override' : row.sup_status === 'published' ? 'supplement' : 'inherit',
      supplementStatus: row.sup_status,
      supplementText: supBlocks?.length ? supBlocks.map(blockText).join(' ').replace(/\s+/g, ' ').slice(0, 140) : null,
      anchorLabel: anchorBlock ? blockTitle(anchorBlock) : null,
      overridePageId: row.override_id,
      overrideBehind: Boolean(row.override_id) && page.version_no > (row.base_version ?? 0),
      overrideReason: row.override_reason,
    };
  });
  return {
    version: page.version_no,
    faculties,
    /** null — для всех факультетов; иначе id выбранных институтов. */
    instituteIds: page.institute_ids,
    excluded: excluded.map((row) => ({ id: row.id, shortName: row.short_name })),
    /** Блоки, к которым факультеты прикрепили уточнения: редактор видит их в конструкторе. */
    anchors: [...new Set(rows.filter((row) => row.sup_status === 'published' && row.anchor && !row.override_id).map((row) => row.anchor!))],
  };
}

/** Короткое имя блока для подписей: «Пошаговая инструкция «Как заказать»». */
function blockTitle(block: Block): string {
  const label = BLOCK_LABEL[block.type] ?? 'Блок';
  const title = 'title' in block && typeof block.title === 'string' && block.title ? block.title : null;
  return title ?? label;
}

/** Метки использования для списка общей базы: сколько факультетов, уточнений, своих версий и отставших. */
export async function baseUsage(db: Db, baseHandbookId: string) {
  const rows = await many<{ page_id: string; faculties: number; supplements: number; overrides: number; behind: number }>(
    db,
    `SELECT p.id AS page_id,
            (SELECT count(DISTINCT h.institute_id)::int FROM handbooks h WHERE h.parent_id = $1 AND h.status = 'active'
               AND page_for_handbook(p.institute_ids, h.id)
               AND NOT EXISTS (SELECT 1 FROM pages ov WHERE ov.handbook_id = h.id AND ov.inherited_from = p.id AND ov.status = 'published')) AS faculties,
            (SELECT count(*)::int FROM page_supplements s JOIN handbooks h ON h.id = s.handbook_id AND h.status = 'active'
              WHERE s.base_page_id = p.id AND s.status = 'published') AS supplements,
            (SELECT count(*)::int FROM pages ov JOIN handbooks h ON h.id = ov.handbook_id AND h.status = 'active'
              WHERE ov.inherited_from = p.id AND ov.status <> 'archived') AS overrides,
            (SELECT count(*)::int FROM pages ov JOIN handbooks h ON h.id = ov.handbook_id AND h.status = 'active'
              WHERE ov.inherited_from = p.id AND ov.status <> 'archived' AND COALESCE(ov.base_version, 0) < p.version_no) AS behind
       FROM pages p WHERE p.handbook_id = $1 AND p.status <> 'archived'`,
    [baseHandbookId],
  );
  return Object.fromEntries(rows.map((row) => [row.page_id, { faculties: row.faculties, supplements: row.supplements, overrides: row.overrides, behind: row.behind }]));
}

// ─── Факультет: общие страницы в редакции ───

/** Общие страницы в разделах редакции факультета: как они показаны студентам этого факультета. */
export async function sharedForFaculty(db: Db, scope: EditorScope) {
  if (!scope.handbook.parent_id) return [];
  const rows = await many<BasePage>(
    db,
    `${BASE_SELECT} WHERE p.handbook_id = $1 AND p.status = 'published' AND s.visible AND page_for_handbook(p.institute_ids, $2)
      ORDER BY s.position, p.position, p.title`,
    [scope.handbook.parent_id, scope.handbook.id],
  );
  const extra = await many<{ id: string; sup_status: string | null; sup_draft: boolean; sup_review: boolean; override_id: string | null; override_status: string | null; base_version: number | null }>(
    db,
    `SELECT p.id, sup.status AS sup_status, (sup.draft_blocks IS NOT NULL) AS sup_draft, (sup.review_requested_at IS NOT NULL) AS sup_review,
            ov.id AS override_id, ov.status AS override_status, ov.base_version
       FROM pages p
       LEFT JOIN page_supplements sup ON sup.base_page_id = p.id AND sup.handbook_id = $2 AND sup.status <> 'archived'
       LEFT JOIN pages ov ON ov.inherited_from = p.id AND ov.handbook_id = $2 AND ov.status <> 'archived'
      WHERE p.handbook_id = $1 AND p.status = 'published'`,
    [scope.handbook.parent_id, scope.handbook.id],
  );
  const byId = new Map(extra.map((row) => [row.id, row]));
  const today = todayIn((await getUniversity(db, scope.handbook.university_id)).timezone);
  return rows.map((page) => {
    const rel = byId.get(page.id);
    return {
      id: page.id,
      sectionSlug: page.section_slug,
      sectionTitle: page.section_title,
      sectionEmoji: page.section_emoji,
      sectionPosition: page.section_position,
      title: page.title,
      ownerUnit: page.owner_unit,
      checkedAt: page.checked_at,
      reviewAt: page.review_at,
      overdue: Boolean(page.review_at && page.review_at < today),
      relation: rel?.override_id ? 'override' : rel?.sup_status === 'published' ? 'supplement' : 'inherit',
      supplementDraft: Boolean(rel?.sup_draft),
      /** Редактор отправил уточнение на публикацию — администратору факультета нужно его проверить. */
      supplementReview: Boolean(rel?.sup_review) && !rel?.override_id,
      overridePageId: rel?.override_id ?? null,
      overrideStatus: rel?.override_status ?? null,
      overrideBehind: Boolean(rel?.override_id) && page.version_no > (rel?.base_version ?? 0),
    };
  });
}

/** Общая страница в редакторе факультета: общая часть (только чтение), уточнение и своя версия. */
export async function sharedPage(db: Db, scope: EditorScope, basePageId: string) {
  const page = await baseOf(db, scope, basePageId);
  const supplement = await one<{
    id: string; status: string; blocks: Block[]; draft_blocks: Block[] | null; anchor_block_id: string | null; draft_anchor_block_id: string | null;
    updated_at: Date; published_at: Date | null; owner: string | null;
    review_requested_at: Date | null; review_note: string | null; review_by: string | null;
  }>(
    db,
    `SELECT s.id, s.status, s.blocks, s.draft_blocks, s.anchor_block_id, s.draft_anchor_block_id, s.updated_at, s.published_at, p.full_name AS owner,
            s.review_requested_at, s.review_note, rb.full_name AS review_by
       FROM page_supplements s LEFT JOIN persons p ON p.id = s.owner_person_id LEFT JOIN persons rb ON rb.id = s.review_requested_by
      WHERE s.handbook_id = $1 AND s.base_page_id = $2 AND s.status <> 'archived'`,
    [scope.handbook.id, basePageId],
  );
  const override = await one<{ id: string; status: string; base_version: number | null }>(
    db,
    "SELECT id, status, base_version FROM pages WHERE handbook_id = $1 AND inherited_from = $2 AND status <> 'archived'",
    [scope.handbook.id, basePageId],
  );
  const lastChange = await one<{ created_at: Date; note: string | null; author: string | null }>(
    db,
    `SELECT v.created_at, v.note, p.full_name AS author FROM page_versions v LEFT JOIN persons p ON p.id = v.author_person_id
      WHERE v.page_id = $1 ORDER BY v.created_at DESC LIMIT 1`,
    [basePageId],
  );
  const draftBlocks = supplement?.draft_blocks ?? supplement?.blocks ?? [];
  const anchor = supplement ? (supplement.draft_blocks ? supplement.draft_anchor_block_id : supplement.anchor_block_id) : null;
  return {
    role: scope.role,
    base: {
      id: page.id,
      title: page.title,
      summary: page.summary,
      section: { slug: page.section_slug, title: page.section_title },
      blocks: page.blocks,
      ownerUnit: page.owner_unit,
      ownerName: page.owner_name,
      checkedAt: page.checked_at,
      reviewAt: page.review_at,
      version: page.version_no,
      lastChange: lastChange ? { at: lastChange.created_at, note: lastChange.note, author: lastChange.author } : null,
    },
    supplement: supplement
      ? {
          id: supplement.id,
          status: supplement.status,
          hasDraft: supplement.draft_blocks !== null,
          blocks: draftBlocks,
          publishedBlocks: supplement.status === 'published' ? supplement.blocks : [],
          anchorBlockId: anchor,
          publishedAnchorBlockId: supplement.anchor_block_id,
          /** Блок-якорь пропал из общей версии: уточнение стоит в конце страницы. */
          anchorLost: Boolean(supplement.anchor_block_id) && !page.blocks.some((block) => block.id === supplement.anchor_block_id),
          updatedAt: supplement.updated_at,
          publishedAt: supplement.published_at,
          owner: supplement.owner,
          /** Отправлено администратору на публикацию: когда, кем и с каким комментарием. */
          review: supplement.review_requested_at
            ? { at: supplement.review_requested_at, by: supplement.review_by, note: supplement.review_note }
            : null,
          issues: draftBlocks.length ? publishIssues(draftBlocks) : [],
          /** Обновили ли общую страницу после публикации уточнения: показываем «общая часть обновлена». */
          baseChangedSince: Boolean(supplement.published_at && lastChange && lastChange.created_at > supplement.published_at),
        }
      : null,
    override: override
      ? { pageId: override.id, status: override.status, behind: page.version_no > (override.base_version ?? 0) }
      : null,
  };
}

export const supplementInputSchema = z.object({
  blocks: draftBlocksSchema,
  anchorBlockId: z.string().trim().max(80).nullable().optional(),
});

/** Сохранить черновик уточнения. Студенты видят опубликованное уточнение, пока администратор не опубликует новое. */
export async function saveSupplement(_db: Db, scope: EditorScope, basePageId: string, input: z.infer<typeof supplementInputSchema>) {
  return tx(async (client) => {
    const page = await baseOf(client, scope, basePageId);
    const override = await one(client, "SELECT 1 FROM pages WHERE handbook_id = $1 AND inherited_from = $2 AND status <> 'archived'", [scope.handbook.id, basePageId]);
    if (override) throw new AppError('override_exists', 'У факультета своя версия этой страницы — уточнение к общей не нужно. Правьте свою версию', 409);
    const anchor = input.anchorBlockId && page.blocks.some((block) => block.id === input.anchorBlockId) ? input.anchorBlockId : null;
    const row = await one<{ id: string; status: string; updated_at: Date }>(
      client,
      `INSERT INTO page_supplements(handbook_id, base_page_id, draft_blocks, draft_anchor_block_id, owner_person_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (handbook_id, base_page_id) DO UPDATE
         SET draft_blocks = EXCLUDED.draft_blocks, draft_anchor_block_id = EXCLUDED.draft_anchor_block_id,
             status = CASE WHEN page_supplements.status = 'archived' THEN 'draft' ELSE page_supplements.status END,
             owner_person_id = COALESCE(page_supplements.owner_person_id, EXCLUDED.owner_person_id), updated_at = now()
       RETURNING id, status, updated_at`,
      [scope.handbook.id, basePageId, JSON.stringify(input.blocks), anchor, scope.personId],
    );
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'supplement.save', entity: 'page_supplement', entityId: row!.id, data: { basePageId } });
    return { id: row!.id, status: row!.status, updatedAt: row!.updated_at, issues: publishIssues(input.blocks) };
  });
}

export const supplementReviewSchema = z.object({
  note: z.string().trim().max(300, 'Комментарий — не длиннее 300 символов').optional().nullable(),
});

/**
 * Редактор отправляет уточнение администратору факультета: опубликовать его сам он не может.
 * Администраторы получают сообщение в чате; в редакции уточнение помечено «Ждёт публикации».
 * Повторная отправка не дублирует сообщения. Публикация или удаление уточнения снимает отметку.
 */
export async function submitSupplement(_db: Db, scope: EditorScope, basePageId: string, note: string | null) {
  return tx(async (client) => {
    await baseOf(client, scope, basePageId);
    const sup = await one<{ id: string; draft_blocks: Block[] | null; blocks: Block[]; status: string; review_requested_at: Date | null }>(
      client,
      "SELECT id, draft_blocks, blocks, status, review_requested_at FROM page_supplements WHERE handbook_id = $1 AND base_page_id = $2 AND status <> 'archived' FOR UPDATE",
      [scope.handbook.id, basePageId],
    );
    if (!sup || (sup.draft_blocks === null && sup.status === 'published')) {
      throw new AppError('nothing_to_review', 'Нет новых правок уточнения — отправлять пока нечего', 409);
    }
    const source = sup.draft_blocks ?? sup.blocks;
    const issues = publishIssues(source);
    if (!source.length || issues.length) {
      throw new AppError('blocks_invalid', `Перед отправкой заполните: ${(issues.length ? issues : ['добавьте хотя бы один блок']).join('; ')}`, 400);
    }
    const first = !sup.review_requested_at;
    await client.query(
      `UPDATE page_supplements SET review_requested_at = COALESCE(review_requested_at, now()), review_requested_by = $2,
              review_note = COALESCE($3, review_note), updated_at = now() WHERE id = $1`,
      [sup.id, scope.personId, note || null],
    );
    let notified = 0;
    if (first) {
      for (const personId of await handbookAdmins(client, scope.handbook.id)) {
        if (personId === scope.personId) continue;
        await enqueue(client, {
          personId,
          kind: 'supplement_review',
          payload: { supplementId: sup.id, basePageId, handbookId: scope.handbook.id, note: note || null },
          dedupeKey: `sup_review:${sup.id}:${personId}:${Date.now()}`,
        });
        notified += 1;
      }
    }
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'supplement.review', entity: 'page_supplement', entityId: sup.id, data: { basePageId } });
    return { ok: true as const, notified };
  });
}

/** Ссылка из уведомления ведёт на уточнение (hbs_<id уточнения>): находим общую страницу, к которой оно относится. */
export async function sharedBaseId(db: Db, scope: EditorScope, id: string): Promise<string> {
  const row = await one<{ base_page_id: string }>(db, 'SELECT base_page_id FROM page_supplements WHERE id = $1 AND handbook_id = $2', [id, scope.handbook.id]);
  return row?.base_page_id ?? id;
}

/** Опубликовать уточнение: студенты факультета сразу видят общую страницу с ним. */
export async function publishSupplement(_db: Db, scope: EditorScope, basePageId: string) {
  requireAdmin(scope);
  return tx(async (client) => {
    await baseOf(client, scope, basePageId);
    const sup = await one<{ id: string; draft_blocks: Block[] | null; blocks: Block[]; draft_anchor_block_id: string | null; anchor_block_id: string | null }>(
      client,
      "SELECT id, draft_blocks, blocks, draft_anchor_block_id, anchor_block_id FROM page_supplements WHERE handbook_id = $1 AND base_page_id = $2 AND status <> 'archived' FOR UPDATE",
      [scope.handbook.id, basePageId],
    );
    if (!sup) throw notFound('Уточнения ещё нет — сначала добавьте блок');
    const source = sup.draft_blocks ?? sup.blocks;
    const parsed = blocksSchema.safeParse(source);
    const issues = publishIssues(source);
    if (!source.length || issues.length || !parsed.success) {
      throw new AppError('blocks_invalid', `Не получилось опубликовать уточнение — ${(issues.length ? issues : ['добавьте и заполните хотя бы один блок']).join('; ')}`, 400);
    }
    const blocks = parsed.data as Block[];
    const anchor = sup.draft_blocks ? sup.draft_anchor_block_id : sup.anchor_block_id;
    await client.query(
      `UPDATE page_supplements SET blocks = $2, anchor_block_id = $3, draft_blocks = NULL, draft_anchor_block_id = NULL, status = 'published',
              review_requested_at = NULL, review_requested_by = NULL, review_note = NULL, search_text = $4, published_at = now(), checked_at = now(), updated_at = now()
        WHERE id = $1`,
      [sup.id, JSON.stringify(blocks), anchor, pageSearchText(null, blocks)],
    );
    // Сроки из уточнения — в календарь факультета: под общей страницей, но со своими идентификаторами
    await syncDeadlines(client, scope.handbook.id, basePageId, localizeBlocks(scope.handbook.id, blocks));
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'supplement.publish', entity: 'page_supplement', entityId: sup.id, data: { basePageId } });
    return { id: sup.id, status: 'published' as const };
  });
}

/** Убрать уточнение: студенты снова видят общую страницу как есть. */
export async function archiveSupplement(_db: Db, scope: EditorScope, basePageId: string) {
  requireAdmin(scope);
  return tx(async (client) => {
    const sup = await one<{ id: string }>(
      client,
      "UPDATE page_supplements SET status = 'archived', draft_blocks = NULL, review_requested_at = NULL, review_requested_by = NULL, review_note = NULL, updated_at = now() WHERE handbook_id = $1 AND base_page_id = $2 AND status <> 'archived' RETURNING id",
      [scope.handbook.id, basePageId],
    );
    if (!sup) throw notFound('Уточнения нет');
    await client.query('DELETE FROM handbook_deadlines WHERE handbook_id = $1 AND page_id = $2', [scope.handbook.id, basePageId]);
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'supplement.archive', entity: 'page_supplement', entityId: sup.id, data: { basePageId } });
    return { ok: true as const };
  });
}

// ─── Своя версия ───

export const overrideInputSchema = z.object({
  reason: z.string().trim().min(5, 'Напишите, чем порядок на факультете отличается — это увидит университет').max(300),
});

/**
 * Своя версия общей страницы: копия общей части (и уточнения, если было) в черновик факультета.
 * Студенты видят общую страницу, пока своя версия не опубликована. Номер общей версии запоминается.
 */
export async function createOverride(_db: Db, scope: EditorScope, basePageId: string, reason: string) {
  requireAdmin(scope);
  return tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hb_override:${scope.handbook.id}:${basePageId}`]);
    const page = await baseOf(client, scope, basePageId);
    const existing = await one<{ id: string }>(client, "SELECT id FROM pages WHERE handbook_id = $1 AND inherited_from = $2 AND status <> 'archived'", [scope.handbook.id, basePageId]);
    if (existing) throw new AppError('override_exists', 'Своя версия этой страницы уже есть', 409, { pageId: existing.id });
    // Раздел факультета с тем же адресом, что у общего: у студента страница остаётся в том же разделе
    let section = await one<{ id: string }>(client, 'SELECT id FROM sections WHERE handbook_id = $1 AND slug = $2', [scope.handbook.id, page.section_slug]);
    section ??= await one<{ id: string }>(
      client,
      `INSERT INTO sections(handbook_id, slug, title, emoji, position) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [scope.handbook.id, page.section_slug, page.section_title, page.section_emoji, page.section_position],
    );
    const sup = await one<{ blocks: Block[]; draft_blocks: Block[] | null; anchor_block_id: string | null }>(
      client,
      "SELECT blocks, draft_blocks, anchor_block_id FROM page_supplements WHERE handbook_id = $1 AND base_page_id = $2 AND status <> 'archived'",
      [scope.handbook.id, basePageId],
    );
    const local = (sup?.draft_blocks ?? sup?.blocks ?? []).map((block) => ({ ...block, id: `f${block.id}` }));
    const at = sup?.anchor_block_id ? page.blocks.findIndex((block) => block.id === sup.anchor_block_id) : -1;
    const blocks = at < 0 ? [...page.blocks, ...local] : [...page.blocks.slice(0, at + 1), ...local, ...page.blocks.slice(at + 1)];
    let slug = page.slug;
    for (let attempt = 2; await one(client, 'SELECT 1 FROM pages WHERE handbook_id = $1 AND slug = $2', [scope.handbook.id, slug]); attempt += 1) {
      slug = `${slugify(page.slug)}-${attempt}`;
    }
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO pages(handbook_id, section_id, slug, title, summary, status, blocks, draft_title, draft_summary, draft_blocks, draft_note,
                         owner_person_id, inherited_from, base_version, override_reason, search_title, search_text)
       VALUES ($1, $2, $3, $4, $5, 'draft', '[]'::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, '', '')
       RETURNING id`,
      [scope.handbook.id, section!.id, slug, page.title, page.summary, JSON.stringify(blocks), `Своя версия: ${reason}`, scope.personId, basePageId, page.version_no, reason],
    );
    await audit(client, {
      universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId,
      action: 'override.create', entity: 'page', entityId: row!.id, data: { basePageId, reason, baseVersion: page.version_no },
    });
    return { pageId: row!.id };
  });
}

async function ownOverride(client: Db, scope: EditorScope, pageId: string) {
  const row = await one<{ id: string; inherited_from: string | null; base_version: number | null; status: string; base_status: string | null; base_version_now: number | null }>(
    client,
    `SELECT pg.id, pg.inherited_from, pg.base_version, pg.status, bp.status AS base_status, bp.version_no AS base_version_now
       FROM pages pg LEFT JOIN pages bp ON bp.id = pg.inherited_from
      WHERE pg.id = $1 AND pg.handbook_id = $2 FOR UPDATE OF pg`,
    [pageId, scope.handbook.id],
  );
  if (!row) throw notFound('Страница не найдена');
  if (!row.inherited_from) throw new AppError('not_override', 'Это не своя версия общей страницы', 409);
  return row;
}

/** «Учтено, оставить как есть»: своя версия сверена с текущей общей. */
export async function ackOverride(_db: Db, scope: EditorScope, pageId: string) {
  requireAdmin(scope);
  return tx(async (client) => {
    const row = await ownOverride(client, scope, pageId);
    await client.query('UPDATE pages SET base_version = $2, updated_at = now() WHERE id = $1', [pageId, row.base_version_now ?? row.base_version]);
    await audit(client, {
      universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId,
      action: 'override.ack', entity: 'page', entityId: pageId, data: { from: row.base_version, to: row.base_version_now },
    });
    return { ok: true as const, baseVersion: row.base_version_now };
  });
}

/** «Вернуться к общей версии»: своя версия уходит в архив, студенты сразу видят общую страницу. */
export async function revertOverride(_db: Db, scope: EditorScope, pageId: string) {
  requireAdmin(scope);
  return tx(async (client) => {
    const row = await ownOverride(client, scope, pageId);
    if (row.status === 'archived') throw new AppError('already_archived', 'Своя версия уже в архиве', 409);
    await client.query("UPDATE pages SET status = 'archived', review_requested_at = NULL, updated_at = now() WHERE id = $1", [pageId]);
    await client.query('DELETE FROM handbook_deadlines WHERE page_id = $1', [pageId]);
    await audit(client, { universityId: scope.handbook.university_id, actorPersonId: scope.personId, actorUserId: scope.userId, action: 'override.revert', entity: 'page', entityId: pageId, data: { basePageId: row.inherited_from } });
    return { ok: true as const, basePageId: row.inherited_from };
  });
}

interface BlockChange {
  kind: 'changed' | 'added' | 'removed';
  label: string;
  before: string | null;
  after: string | null;
}

/** Поблочное сравнение двух версий: что изменили, добавили и убрали. */
export function diffBlocks(before: Block[], after: Block[]): BlockChange[] {
  const old = new Map(before.map((block) => [block.id, block]));
  const now = new Map(after.map((block) => [block.id, block]));
  const changes: BlockChange[] = [];
  for (const block of after) {
    const prev = old.get(block.id);
    const text = blockText(block).trim();
    if (!prev) changes.push({ kind: 'added', label: blockTitle(block), before: null, after: text });
    else if (JSON.stringify(prev) !== JSON.stringify(block)) changes.push({ kind: 'changed', label: blockTitle(block), before: blockText(prev).trim(), after: text });
  }
  for (const block of before) {
    if (!now.has(block.id)) changes.push({ kind: 'removed', label: blockTitle(block), before: blockText(block).trim(), after: null });
  }
  return changes;
}

/** Что изменилось в общей странице с той версии, из которой (или с которой последней) сверена своя версия. */
export async function compareOverride(db: Db, scope: EditorScope, pageId: string) {
  const row = await one<{ inherited_from: string | null; base_version: number | null }>(
    db, 'SELECT inherited_from, base_version FROM pages WHERE id = $1 AND handbook_id = $2', [pageId, scope.handbook.id],
  );
  if (!row?.inherited_from) throw new AppError('not_override', 'Это не своя версия общей страницы', 409);
  const current = await one<{ blocks: Block[]; version_no: number; title: string }>(db, 'SELECT blocks, version_no, title FROM pages WHERE id = $1', [row.inherited_from]);
  if (!current) throw notFound('Общая страница не найдена');
  const from = await one<{ blocks: Block[] }>(
    db, 'SELECT blocks FROM page_versions WHERE page_id = $1 AND version_no = $2 ORDER BY created_at DESC LIMIT 1', [row.inherited_from, row.base_version ?? 0],
  );
  const versions = await many<{ version_no: number; note: string | null; created_at: Date; author: string | null }>(
    db,
    `SELECT v.version_no, v.note, v.created_at, p.full_name AS author FROM page_versions v LEFT JOIN persons p ON p.id = v.author_person_id
      WHERE v.page_id = $1 AND v.version_no > $2 ORDER BY v.version_no`,
    [row.inherited_from, row.base_version ?? 0],
  );
  return {
    baseTitle: current.title,
    fromVersion: row.base_version ?? 0,
    toVersion: current.version_no,
    versions: versions.map((v) => ({ version: v.version_no, note: v.note, at: v.created_at, author: v.author })),
    changes: from ? diffBlocks(from.blocks, current.blocks) : [],
    /** Старой версии нет в истории (страницу создали до учёта версий): показываем общую целиком. */
    fullBase: from ? null : current.blocks.map((block) => ({ label: blockTitle(block), text: blockText(block).trim() })),
  };
}
