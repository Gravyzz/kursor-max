import type { Db } from '../db/pool.js';
import { many, one, pool, tx } from '../db/pool.js';
import { AppError, notFound } from '../lib/errors.js';
import type { UserRow } from './identity.js';
import { stripNul } from '../lib/sanitize.js';
import { audit, getUniversity } from './common.js';
import { daysBetween, todayIn } from '../domain/dates.js';
import { deepLink, getBotIdentity } from '../max/bot.js';
import {
  audienceMatches, blocksSchema, checklistItems, normalizeQuery, pageSnippet, visibleBlocks,
  type Audience, type Block, type ReaderProfile,
} from '../domain/handbook.js';

export interface HandbookRow {
  id: string;
  university_id: string;
  institute_id: string | null;
  parent_id: string | null;
  slug: string;
  title: string;
  subtitle: string | null;
  emoji: string;
  settings: { synonyms?: Record<string, string>; dutyContact?: string };
}

export interface ReaderRow {
  id: string;
  handbook_id: string;
  user_id: number;
  person_id: string | null;
  course: number | null;
  program: string | null;
  dorm: boolean | null;
  tags: string[];
  reminders: boolean;
}

export interface HandbookContext {
  handbook: HandbookRow;
  reader: ReaderRow;
  chain: string[];
  timezone: string;
  today: string;
  profile: ReaderProfile;
}

const HANDBOOK_SELECT = `
  SELECT h.id, h.university_id, h.institute_id, h.parent_id, h.slug, h.title, h.subtitle, h.emoji, h.settings
    FROM handbooks h WHERE h.status = 'active'`;

/**
 * Справочник, который открывает читатель: только справочник факультета.
 * Общая база университета — внутренний слой: студент видит её страницы внутри своего справочника,
 * а не как отдельный справочник (D3).
 */
const READER_SELECT = `${HANDBOOK_SELECT} AND h.institute_id IS NOT NULL`;

/**
 * Каталог справочников. Демо-песочницы видны только своему владельцу:
 * у каждого аккаунта свой «Модельный университет», и чужие в каталог не попадают.
 */
export async function listHandbooks(db: Db, userId: number, universityId?: string | null) {
  return many<{ id: string; slug: string; title: string; subtitle: string | null; emoji: string; university: string; institute: string | null; is_demo: boolean }>(
    db,
    `SELECT h.id, h.slug, h.title, h.subtitle, h.emoji, u.name AS university, i.name AS institute, u.is_demo
       FROM handbooks h
       JOIN universities u ON u.id = h.university_id
       LEFT JOIN institutes i ON i.id = h.institute_id
      WHERE h.status = 'active' AND h.institute_id IS NOT NULL
        AND (NOT u.is_demo OR u.demo_owner_user_id = $1)
        AND ($2::uuid IS NULL OR h.university_id = $2)
      ORDER BY u.is_demo, u.name, h.title
      LIMIT 100`,
    [userId, universityId ?? null],
  );
}

export async function findHandbook(db: Db, ref: { id?: string | null; slug?: string | null }, options: { reader?: boolean } = {}): Promise<HandbookRow | undefined> {
  const select = options.reader ? READER_SELECT : HANDBOOK_SELECT;
  if (ref.id) return one<HandbookRow>(db, `${select} AND h.id = $1`, [ref.id]);
  if (ref.slug) return one<HandbookRow>(db, `${select} AND h.slug = $1 ORDER BY h.created_at LIMIT 1`, [ref.slug]);
  return undefined;
}

/** Общая база университета (справочник без института) или undefined, если её ещё нет. */
export async function baseHandbook(db: Db, universityId: string): Promise<HandbookRow | undefined> {
  return one<HandbookRow>(db, `${HANDBOOK_SELECT} AND h.university_id = $1 AND h.institute_id IS NULL ORDER BY h.created_at LIMIT 1`, [universityId]);
}

/** Цепочка наследования: справочник факультета и общеуниверситетский над ним. */
export async function handbookChain(db: Db, handbook: HandbookRow): Promise<string[]> {
  if (!handbook.parent_id) return [handbook.id];
  return [handbook.id, handbook.parent_id];
}

/**
 * Подключает читателя к справочнику: любой пользователь MAX может открыть справочник факультета.
 * Если аккаунт уже связан с записью вуза (студент из списков деканата) — подставляем курс и группу.
 */
export async function ensureReader(db: Db, handbook: HandbookRow, user: UserRow): Promise<ReaderRow> {
  const person = await one<{ id: string; course: number | null }>(
    db,
    `SELECT p.id, g.course FROM persons p LEFT JOIN groups g ON g.id = p.group_id
      WHERE p.user_id = $1 AND p.role = 'student' AND p.university_id = $2
      ORDER BY p.created_at LIMIT 1`,
    [user.id, handbook.university_id],
  );
  const existing = await one<ReaderRow>(
    db,
    'SELECT id, handbook_id, user_id, person_id, course, program, dorm, tags, reminders FROM handbook_readers WHERE handbook_id = $1 AND user_id = $2',
    [handbook.id, user.id],
  );
  if (existing) {
    await db.query(
      `UPDATE handbook_readers SET last_seen_at = now(),
              person_id = COALESCE($2, person_id),
              course = COALESCE(course, $3)
        WHERE id = $1`,
      [existing.id, person?.id ?? null, person?.course ?? null],
    );
    return { ...existing, person_id: existing.person_id ?? person?.id ?? null, course: existing.course ?? person?.course ?? null };
  }
  // Бот и мини-приложение могут открыть справочник одновременно: второй запрос не должен падать на уникальности
  const created = await one<ReaderRow>(
    db,
    `INSERT INTO handbook_readers(handbook_id, user_id, person_id, course)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (handbook_id, user_id) DO UPDATE
        SET last_seen_at = now(), person_id = COALESCE(handbook_readers.person_id, EXCLUDED.person_id),
            course = COALESCE(handbook_readers.course, EXCLUDED.course)
     RETURNING id, handbook_id, user_id, person_id, course, program, dorm, tags, reminders`,
    [handbook.id, user.id, person?.id ?? null, person?.course ?? null],
  );
  return created!;
}

/**
 * Какой справочник открыть по параметру запуска мини-приложения:
 * hb_<слаг справочника>, hbp_<id страницы>, hbe_<id страницы в редакторе>, hbs_<id уточнения факультета>.
 */
export function startRef(start: string | null | undefined): { slug: string | null; pageId: string | null; supplementId: string | null } {
  const value = start ?? '';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const page = value.startsWith('hbp_') ? value.slice(4) : value.startsWith('hbe_') ? value.slice(4) : null;
  const supplement = value.startsWith('hbs_') ? value.slice(4) : null;
  return {
    slug: value.startsWith('hb_') && value !== 'hb_edit' ? value.slice(3) : null,
    pageId: page && uuid.test(page) ? page : null,
    supplementId: supplement && uuid.test(supplement) ? supplement : null,
  };
}

/** Справочник для пользователя: по ссылке, по прошлому визиту или по институту его записи в вузе. */
export async function contextFor(
  user: UserRow,
  ref: { handbookId?: string | null; slug?: string | null; pageId?: string | null; supplementId?: string | null } = {},
): Promise<HandbookContext | null> {
  let handbook = await findHandbook(pool, { id: ref.handbookId ?? null, slug: ref.slug ?? null }, { reader: true });
  // Уточнение факультета (из сообщения «ждёт публикации») открывается в справочнике этого факультета
  if (!handbook && ref.supplementId) {
    handbook = await one<HandbookRow>(pool, `${READER_SELECT} AND h.id = (SELECT handbook_id FROM page_supplements WHERE id = $1)`, [ref.supplementId]);
  }
  if (!handbook && ref.pageId) {
    // Ссылка на страницу вуза из справочника факультета не должна «переселять» студента в справочник вуза:
    // сначала ищем справочник, который читатель уже открывал и в цепочке которого есть эта страница
    handbook = await one<HandbookRow>(
      pool,
      `${READER_SELECT} AND h.id = (
         SELECT r.handbook_id FROM handbook_readers r
           JOIN handbooks rh ON rh.id = r.handbook_id
           JOIN pages pg ON pg.id = $2 AND (pg.handbook_id = rh.id OR pg.handbook_id = rh.parent_id)
          WHERE r.user_id = $1
          ORDER BY (pg.handbook_id = rh.id) DESC, r.last_seen_at DESC LIMIT 1)`,
      [user.id, ref.pageId],
    );
    handbook ??= await one<HandbookRow>(pool, `${READER_SELECT} AND h.id = (SELECT handbook_id FROM pages WHERE id = $1)`, [ref.pageId]);
  }
  if (!handbook) {
    handbook = await one<HandbookRow>(
      pool,
      `${READER_SELECT} AND h.id = (SELECT r.handbook_id FROM handbook_readers r JOIN handbooks rh ON rh.id = r.handbook_id AND rh.institute_id IS NOT NULL
                                     WHERE r.user_id = $1 ORDER BY r.last_seen_at DESC LIMIT 1)`,
      [user.id],
    );
  }
  if (!handbook) {
    handbook = await one<HandbookRow>(
      pool,
      `${READER_SELECT} AND h.institute_id = (
         SELECT p.institute_id FROM persons p WHERE p.user_id = $1 AND p.institute_id IS NOT NULL ORDER BY p.created_at LIMIT 1)
       ORDER BY h.created_at LIMIT 1`,
      [user.id],
    );
  }
  if (!handbook) return null;
  const reader = await ensureReader(pool, handbook, user);
  const university = await getUniversity(pool, handbook.university_id);
  return {
    handbook,
    reader,
    chain: await handbookChain(pool, handbook),
    timezone: university.timezone,
    today: todayIn(university.timezone),
    profile: { course: reader.course, dorm: reader.dorm, tags: reader.tags ?? [] },
  };
}

/**
 * Профиль читателя. Меняются только переданные поля; явный null снимает выбор (API-4):
 * повторное нажатие на выбранный курс или вариант общежития в «О себе» присылает null.
 */
export async function updateProfile(db: Db, reader: ReaderRow, input: { course?: number | null; dorm?: boolean | null; program?: string | null; tags?: string[]; reminders?: boolean }) {
  const row = await one<ReaderRow>(
    db,
    `UPDATE handbook_readers
        SET course = CASE WHEN $7::boolean THEN $2::smallint ELSE course END,
            dorm = CASE WHEN $8::boolean THEN $3::boolean ELSE dorm END,
            program = CASE WHEN $9::boolean THEN $4::text ELSE program END,
            tags = COALESCE($5, tags),
            reminders = COALESCE($6, reminders),
            last_seen_at = now()
      WHERE id = $1
      RETURNING id, handbook_id, user_id, person_id, course, program, dorm, tags, reminders`,
    [
      reader.id, input.course ?? null, input.dorm ?? null, input.program || null, input.tags ?? null, input.reminders ?? null,
      input.course !== undefined, input.dorm !== undefined, input.program !== undefined,
    ],
  );
  return row!;
}

interface PageRow {
  id: string;
  handbook_id: string;
  section_id: string;
  section_slug: string;
  section_title: string;
  section_emoji: string;
  section_position: number;
  section_audience: Audience;
  slug: string;
  title: string;
  summary: string | null;
  audience: Audience;
  position: number;
  blocks: Block[];
  updated_at: Date;
  checked_at: Date | null;
  helpful: number;
  not_helpful: number;
  inherited_from: string | null;
  own: boolean;
  /** Опубликованное уточнение факультета к общей странице (только для страниц базы). */
  sup_blocks: Block[] | null;
  sup_anchor: string | null;
  sup_text: string;
}

const PAGE_SELECT = `
  SELECT p.id, p.handbook_id, p.section_id, s.slug AS section_slug, s.title AS section_title, s.emoji AS section_emoji,
         s.position AS section_position, s.audience AS section_audience, p.slug, p.title, p.summary, p.audience, p.position,
         p.blocks, p.updated_at, p.checked_at, p.helpful, p.not_helpful, p.inherited_from,
         (p.handbook_id = $1) AS own, sup.blocks AS sup_blocks, sup.anchor_block_id AS sup_anchor, COALESCE(sup.search_text, '') AS sup_text
    FROM pages p JOIN sections s ON s.id = p.section_id
    -- уточнение факультета к общей странице: общая часть не копируется, блоки факультета встают рядом
    LEFT JOIN page_supplements sup ON sup.base_page_id = p.id AND sup.handbook_id = $1 AND sup.status = 'published' AND p.handbook_id <> $1
   WHERE p.handbook_id = ANY($2::uuid[]) AND p.status = 'published' AND s.visible
     -- общая страница «только для выбранных факультетов» видна лишь им
     AND page_for_handbook(p.institute_ids, $1)
     -- страница вуза, которую факультет переписал, не показывается ни в списках, ни в поиске
     AND NOT EXISTS (
       SELECT 1 FROM pages ov
        WHERE ov.handbook_id = $1 AND ov.id <> p.id AND ov.inherited_from = p.id AND ov.status = 'published')`;

/**
 * Убирает перекрытые страницы: если факультет завёл свою версию страницы вуза,
 * студент должен увидеть одну — факультетскую. Строки должны идти «свои впереди».
 */
function applyInheritance<T extends Pick<PageRow, 'id' | 'section_slug' | 'slug' | 'inherited_from' | 'own'>>(rows: T[]): T[] {
  const overridden = new Set(rows.filter((row) => row.inherited_from).map((row) => row.inherited_from!));
  // Страховка от двух страниц с одним адресом: побеждает страница факультета, в каком бы порядке ни пришли строки.
  // Раньше поиск шёл по рангу, и в нём побеждала общая страница, которую список уже скрыл (D1)
  const ownKeys = new Set(rows.filter((row) => row.own).map((row) => `${row.section_slug}/${row.slug}`));
  const seen = new Set<string>();
  const result: T[] = [];
  for (const row of rows) {
    const key = `${row.section_slug}/${row.slug}`;
    if (seen.has(key) || overridden.has(row.id) || (!row.own && ownKeys.has(key))) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

/** Идентификатор блока уточнения в собранной странице: свой у каждого факультета, не пересекается с блоками общей. */
export function localBlockId(handbookId: string, id: string): string {
  return `l${handbookId.replace(/-/g, '').slice(0, 8)}-${id}`;
}

/**
 * Блоки уточнения с идентификаторами факультета: отметки чек-листа и сроки уточнения
 * не смешиваются ни с общей страницей, ни с уточнениями других факультетов.
 */
export function localizeBlocks(handbookId: string, blocks: Block[]): Block[] {
  return blocks.map((block) => {
    const next = { ...block, id: localBlockId(handbookId, block.id), origin: 'local' } as Block & { origin: 'local' };
    if ('items' in next && Array.isArray(next.items)) {
      (next as { items: Array<{ id: string }> }).items = next.items.map((item: { id: string }) => ({ ...item, id: localBlockId(handbookId, item.id) }));
    }
    return next;
  });
}

/** Общая страница + уточнение факультета: блоки встают после блока-якоря, без якоря — в конец. */
export function mergeSupplement(blocks: Block[], local: Block[], anchor: string | null): Block[] {
  if (!local.length) return blocks;
  const at = anchor ? blocks.findIndex((block) => block.id === anchor) : -1;
  if (at < 0) return [...blocks, ...local];
  return [...blocks.slice(0, at + 1), ...local, ...blocks.slice(at + 1)];
}

function withSupplement<T extends PageRow>(row: T, handbookId: string): T {
  if (!row.sup_blocks || row.own) return row;
  return { ...row, blocks: mergeSupplement(row.blocks, localizeBlocks(handbookId, row.sup_blocks), row.sup_anchor) };
}

/** Страницы с учётом наследования: страница факультета перекрывает общеуниверситетскую с тем же slug. */
async function effectivePages(db: Db, ctx: HandbookContext): Promise<PageRow[]> {
  const rows = await many<PageRow>(db, `${PAGE_SELECT} ORDER BY own DESC, s.position, p.position, p.title`, [ctx.handbook.id, ctx.chain]);
  return applyInheritance(rows).map((row) => withSupplement(row, ctx.handbook.id));
}

function matchesReader(row: PageRow, profile: ReaderProfile): boolean {
  return audienceMatches(row.section_audience, profile) && audienceMatches(row.audience, profile);
}

export async function sectionsWithPages(db: Db, ctx: HandbookContext) {
  const pages = (await effectivePages(db, ctx)).filter((row) => matchesReader(row, ctx.profile));
  const sections = new Map<string, { slug: string; title: string; emoji: string; position: number; pages: Array<{ id: string; slug: string; title: string; summary: string | null; snippet: string; inherited: boolean; local: boolean }> }>();
  for (const page of pages) {
    const section = sections.get(page.section_slug) ?? {
      slug: page.section_slug,
      title: page.section_title,
      emoji: page.section_emoji,
      position: page.section_position,
      pages: [],
    };
    section.pages.push({
      id: page.id,
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      snippet: pageSnippet(page.summary, visibleBlocks(page.blocks, ctx.profile, ctx.today), 110),
      inherited: !page.own,
      local: Boolean(page.sup_blocks),
    });
    sections.set(page.section_slug, section);
  }
  return [...sections.values()].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
}

/** Опубликованная страница из цепочки справочника; ссылка на перекрытую страницу вуза ведёт на версию факультета. */
async function findEffectivePage(db: Db, ctx: HandbookContext, pageId: string) {
  const pages = await effectivePages(db, ctx);
  const page = pages.find((row) => row.id === pageId) ?? pages.find((row) => row.inherited_from === pageId && row.own);
  return { pages, page };
}

export async function getPage(db: Db, ctx: HandbookContext, pageId: string) {
  const { pages, page } = await findEffectivePage(db, ctx, pageId);
  if (!page) throw notFound('Страница не найдена или ещё не опубликована');
  const blocks = visibleBlocks(page.blocks, ctx.profile, ctx.today);
  const progressRows = await many<{ item_id: string; done: boolean }>(
    db,
    'SELECT item_id, done FROM reader_progress WHERE reader_id = $1 AND page_id = $2',
    [ctx.reader.id, page.id],
  );
  const feedback = await one<{ helpful: boolean }>(db, 'SELECT helpful FROM page_feedback WHERE page_id = $1 AND reader_id = $2', [page.id, ctx.reader.id]);
  await db.query('UPDATE pages SET views = views + 1 WHERE id = $1', [page.id]);
  const identity = await getBotIdentity();
  const institute = !page.own && page.sup_blocks && ctx.handbook.institute_id
    ? await one<{ short_name: string }>(db, 'SELECT short_name FROM institutes WHERE id = $1', [ctx.handbook.institute_id])
    : undefined;
  const siblings = pages
    .filter((row) => row.section_slug === page.section_slug && row.id !== page.id && matchesReader(row, ctx.profile))
    .slice(0, 6)
    .map((row) => ({ id: row.id, title: row.title }));
  return {
    page: {
      id: page.id,
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      section: { slug: page.section_slug, title: page.section_title, emoji: page.section_emoji },
      blocks,
      updatedAt: page.updated_at,
      checkedAt: page.checked_at,
      inherited: !page.own,
      /** Откуда текст: общая инструкция, страница факультета или общая с уточнением факультета. */
      source: page.own ? 'faculty' : page.sup_blocks ? 'university+local' : 'university',
      /** Подпись уточнения у студента: «В ИИТ». */
      localLabel: institute?.short_name ?? null,
      helpful: page.helpful,
      notHelpful: page.not_helpful,
    },
    progress: progressRows.filter((row) => row.done).map((row) => row.item_id),
    myFeedback: feedback?.helpful ?? null,
    siblings,
    /** Ссылка, по которой страница откроется в MAX: «Поделиться» и QR-плакат. */
    link: deepLink(identity, 'startapp', `hbp_${page.id}`),
    /** «Сегодня» в часовом поясе вуза — для подписей сроков. */
    today: ctx.today,
  };
}

export async function setProgress(db: Db, ctx: HandbookContext, pageId: string, itemId: string, done: boolean) {
  const { page } = await findEffectivePage(db, ctx, pageId);
  if (!page || page.id !== pageId) throw notFound('Страница не найдена или ещё не опубликована');
  await db.query(
    `INSERT INTO reader_progress(reader_id, page_id, item_id, done, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (reader_id, page_id, item_id) DO UPDATE SET done = EXCLUDED.done, updated_at = now()`,
    [ctx.reader.id, pageId, itemId, done],
  );
  return { itemId, done };
}

export async function setFeedback(db: Db, ctx: HandbookContext, pageId: string, helpful: boolean, comment: string | null) {
  const { page } = await findEffectivePage(db, ctx, pageId);
  if (!page || page.id !== pageId) throw notFound('Страница не найдена или ещё не опубликована');
  return tx(async (client) => {
    // Двойное нажатие «Помогла» не должно считаться дважды: без блокировки первого отзыва ещё нет строки, которую можно запереть
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hb_feedback:' || $1 || ':' || $2))", [pageId, ctx.reader.id]);
    const previous = await one<{ helpful: boolean }>(client, 'SELECT helpful FROM page_feedback WHERE page_id = $1 AND reader_id = $2 FOR UPDATE', [pageId, ctx.reader.id]);
    await client.query(
      `INSERT INTO page_feedback(page_id, reader_id, helpful, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (page_id, reader_id) DO UPDATE SET helpful = EXCLUDED.helpful, comment = COALESCE(EXCLUDED.comment, page_feedback.comment), created_at = now()`,
      [pageId, ctx.reader.id, helpful, comment?.slice(0, 500) ?? null],
    );
    if (previous?.helpful !== helpful) {
      await client.query(
        `UPDATE pages SET helpful = helpful + $2, not_helpful = not_helpful + $3 WHERE id = $1`,
        [pageId, helpful ? 1 : previous ? -1 : 0, helpful ? (previous ? -1 : 0) : 1],
      );
    }
    return { helpful };
  });
}

export interface SearchHit {
  pageId: string;
  slug: string;
  title: string;
  snippet: string;
  section: string;
  score: number;
  /** false — точного совпадения не было, это лишь похожее: так и говорим студенту. */
  exact: boolean;
}

let trigramReady: boolean | null = null;
async function hasTrigram(db: Db): Promise<boolean> {
  if (trigramReady === null) {
    const row = await one<{ ok: boolean }>(db, "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS ok");
    trigramReady = row?.ok ?? false;
  }
  return trigramReady;
}

/**
 * Слова вопроса, которые не несут темы: «где взять справку об обучении» — это про справку об обучении.
 * Строгий поиск требует всех слов, и «взять» уводило бы к случайной странице, где это слово есть.
 */
const QUESTION_FILLER = new Set(['взять', 'брать', 'получить', 'найти', 'достать', 'оформить', 'сделать', 'делать', 'узнать', 'можно', 'нужно', 'надо']);

/** Поиск по справочнику: полнотекстовый, с приведением сленга и запасным поиском по опечаткам. */
export async function search(db: Db, ctx: HandbookContext, rawQuery: string, limit = 8): Promise<SearchHit[]> {
  const full = normalizeQuery(rawQuery, ctx.handbook.settings?.synonyms ?? {});
  if (full.length < 2) return [];
  const normalized = full.split(' ').filter((word) => !QUESTION_FILLER.has(word)).join(' ') || full;
  // Берём с запасом: после снятия перекрытых страниц результатов станет меньше
  const params = [ctx.handbook.id, ctx.chain, normalized, ctx.profile.course, ctx.profile.dorm, ctx.profile.tags, limit * 2 + 4];
  const rows = await many<PageRow & { score: number }>(
    db,
    `${PAGE_SELECT}
       AND (p.search_vector @@ websearch_to_tsquery('russian', $3) OR sup.search_vector @@ websearch_to_tsquery('russian', $3))
       AND audience_matches(p.audience, $4::int, $5::boolean, $6::text[])
       AND audience_matches(s.audience, $4::int, $5::boolean, $6::text[])
     -- уточнение факультета весит как своя страница: «каб. 214» находит общую справку только у студентов ИИТ
     ORDER BY GREATEST(ts_rank(p.search_vector, websearch_to_tsquery('russian', $3)) * (CASE WHEN p.handbook_id = $1 THEN 1.2 ELSE 1 END),
                       COALESCE(ts_rank(sup.search_vector, websearch_to_tsquery('russian', $3)), 0) * 1.2) DESC,
              own DESC, p.views DESC
     LIMIT $7`,
    params,
  );
  let found = rows;
  let exact = rows.length > 0;
  // Строгий поиск требует всех слов сразу. Если ничего не нашлось — ищем по любому слову,
  // а точность обеспечивает ранжирование: «физра отработки» должно находить страницу про отработки.
  if (found.length === 0) {
    const anyWord = normalized.split(/\s+/).filter(Boolean).slice(0, 6).join(' | ');
    if (anyWord.includes('|')) {
      exact = false;
      found = await many<PageRow & { score: number }>(
        db,
        `${PAGE_SELECT}
           AND (p.search_vector @@ to_tsquery('russian', $3) OR sup.search_vector @@ to_tsquery('russian', $3))
           AND audience_matches(p.audience, $4::int, $5::boolean, $6::text[])
           AND audience_matches(s.audience, $4::int, $5::boolean, $6::text[])
         ORDER BY GREATEST(ts_rank(p.search_vector, to_tsquery('russian', $3)) * (CASE WHEN p.handbook_id = $1 THEN 1.2 ELSE 1 END),
                           COALESCE(ts_rank(sup.search_vector, to_tsquery('russian', $3)), 0) * 1.2) DESC,
                  own DESC, p.views DESC
         LIMIT $7`,
        [ctx.handbook.id, ctx.chain, anyWord, ctx.profile.course, ctx.profile.dorm, ctx.profile.tags, limit * 2 + 4],
      );
    }
  }
  // Опечатки («стипендея», «расписане»): сходство запроса с самым похожим фрагментом страницы.
  // Заголовок весит больше: слово из заголовка — почти наверняка тема страницы.
  if (found.length === 0 && (await hasTrigram(db))) {
    exact = false;
    found = await many<PageRow & { score: number }>(
      db,
      `SELECT * FROM (
         ${PAGE_SELECT}
           AND audience_matches(p.audience, $4::int, $5::boolean, $6::text[])
           AND audience_matches(s.audience, $4::int, $5::boolean, $6::text[])
       ) p
       CROSS JOIN LATERAL (
         SELECT GREATEST(word_similarity($3, pg.search_title) * 1.15, word_similarity($3, pg.search_text), word_similarity($3, p.sup_text)) AS score
           FROM pages pg WHERE pg.id = p.id
       ) sim
       WHERE sim.score >= 0.55
       ORDER BY sim.score DESC, p.own DESC
       LIMIT $7`,
      params,
    );
  }
  // Страница факультета перекрывает общеуниверситетскую: в выдаче она должна быть одна
  const deduped = applyInheritance(found).slice(0, limit).map((row) => withSupplement(row, ctx.handbook.id));
  return deduped.map((row, index) => ({
    pageId: row.id,
    slug: row.slug,
    title: row.title,
    section: row.section_title,
    snippet: pageSnippet(row.summary, visibleBlocks(row.blocks, ctx.profile, ctx.today), 200),
    score: 1 - index / (deduped.length + 1),
    exact,
  }));
}

/** Повтор того же запроса тем же читателем в этот срок — не новый поиск, а возврат к результатам. */
const SEARCH_REPEAT_WINDOW = "interval '10 minutes'";

/**
 * Журнал поиска — бэклог редактора («Что ищут и не находят») и метрика «нашли ответ сами».
 * Запрос без букв и цифр («!!!», «😀») поиском не был: его не пишем (API-5, APP-10).
 * Тот же запрос того же читателя в течение 10 минут — возврат «Назад» к результатам или повторная отправка,
 * а не новый поиск: обновляем прежнюю запись вместо новой (APP-2).
 */
export async function logSearch(db: Db, ctx: HandbookContext, rawQuery: string, results: number, source: 'app' | 'bot') {
  const query = stripNul(rawQuery).trim().slice(0, 200);
  const normalized = normalizeQuery(query, ctx.handbook.settings?.synonyms ?? {});
  if (normalized.length < 2) return;
  const repeated = await one(
    db,
    `UPDATE search_log SET created_at = now(), results = $5, query = $3
      WHERE id = (SELECT id FROM search_log
                   WHERE handbook_id = $1 AND reader_id = $2 AND normalized = $4 AND source = $6
                     AND created_at > now() - ${SEARCH_REPEAT_WINDOW}
                   ORDER BY created_at DESC LIMIT 1)
      RETURNING id`,
    [ctx.handbook.id, ctx.reader.id, query, normalized, results, source],
  );
  if (repeated) return;
  await db.query(
    'INSERT INTO search_log(handbook_id, reader_id, query, normalized, results, source) VALUES ($1, $2, $3, $4, $5, $6)',
    [ctx.handbook.id, ctx.reader.id, query, normalized, results, source],
  );
}

export async function markSearchOpened(db: Db, ctx: HandbookContext, pageId: string) {
  await db.query(
    `UPDATE search_log SET opened_page_id = $3
      WHERE id = (SELECT id FROM search_log WHERE handbook_id = $1 AND reader_id = $2 ORDER BY created_at DESC LIMIT 1)`,
    [ctx.handbook.id, ctx.reader.id, pageId],
  );
}

export async function upcomingDeadlines(db: Db, ctx: HandbookContext, days = 45) {
  const rows = await many<{ id: string; page_id: string; title: string; starts_on: string; ends_on: string | null; page_title: string }>(
    db,
    `SELECT d.id, d.page_id, d.title, d.starts_on, d.ends_on, p.title AS page_title
       FROM handbook_deadlines d
       JOIN pages p ON p.id = d.page_id
       JOIN sections s ON s.id = p.section_id AND s.visible
      WHERE d.handbook_id = ANY($1::uuid[]) AND p.status = 'published'
        AND COALESCE(d.ends_on, d.starts_on) >= $2::date
        AND d.starts_on <= ($2::date + $3::int)
        -- срок виден тем, кому видны блок, страница и раздел (WRK-2, API-10): аудитория страницы
        -- проверяется здесь, а не копируется в срок, поэтому её смена сразу меняет календарь
        AND audience_matches(d.audience, $4::int, $5::boolean, $6::text[])
        AND audience_matches(p.audience, $4::int, $5::boolean, $6::text[])
        AND audience_matches(s.audience, $4::int, $5::boolean, $6::text[])
        AND page_for_handbook(p.institute_ids, $7)
        -- срок со страницы вуза, которую факультет переписал, берём из версии факультета
        AND NOT EXISTS (
          SELECT 1 FROM pages ov WHERE ov.handbook_id = $7 AND ov.inherited_from = d.page_id AND ov.status = 'published')
      ORDER BY d.starts_on
      LIMIT 20`,
    [ctx.chain, ctx.today, days, ctx.profile.course, ctx.profile.dorm, ctx.profile.tags, ctx.handbook.id],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    daysLeft: daysBetween(ctx.today, row.ends_on ?? row.starts_on),
    pageId: row.page_id,
    pageTitle: row.page_title,
  }));
}

export interface ReaderAnnouncement {
  id: string;
  title: string;
  body: string;
  pageId: string | null;
  createdAt: Date;
  readAt: Date | null;
  /** Срок показа прошёл — объявление живёт только в архиве. */
  expired: boolean;
}

/**
 * Объявления читателя: новые (на главной) и архив — прочитанные им или с истёкшим сроком.
 * Не начавшиеся ещё объявления не показываются нигде.
 */
export async function announcementsFeed(db: Db, ctx: HandbookContext) {
  const rows = await many<{ id: string; title: string; body: string; page_id: string | null; created_at: Date; read_at: Date | null; expired: boolean }>(
    db,
    `SELECT a.id, a.title, a.body, pg.id AS page_id, a.created_at, r.read_at,
            (a.ends_on IS NOT NULL AND a.ends_on < $2::date) AS expired
       FROM announcements a
       -- ссылка ведёт только на опубликованную страницу: снятая с публикации дала бы «не найдено»
       LEFT JOIN pages pg ON pg.id = a.page_id AND pg.status = 'published'
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.reader_id = $6
      WHERE a.handbook_id = ANY($1::uuid[])
        AND (a.starts_on IS NULL OR a.starts_on <= $2::date)
        AND a.created_at > now() - interval '180 days'
        AND audience_matches(a.audience, $3::int, $4::boolean, $5::text[])
      ORDER BY a.created_at DESC
      LIMIT 60`,
    [ctx.chain, ctx.today, ctx.profile.course, ctx.profile.dorm, ctx.profile.tags, ctx.reader.id],
  );
  const items: ReaderAnnouncement[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    pageId: row.page_id,
    createdAt: row.created_at,
    readAt: row.read_at,
    expired: row.expired,
  }));
  return {
    active: items.filter((item) => !item.readAt && !item.expired),
    archive: items.filter((item) => item.readAt || item.expired),
  };
}

/** «Прочитано»: объявление уходит с главной в архив; read=false возвращает его обратно. */
export async function markAnnouncementRead(db: Db, ctx: HandbookContext, announcementId: string, read: boolean) {
  const visible = await one(db, 'SELECT 1 FROM announcements WHERE id = $1 AND handbook_id = ANY($2::uuid[])', [announcementId, ctx.chain]);
  if (!visible) throw notFound('Объявление не найдено');
  if (read) {
    await db.query(
      'INSERT INTO announcement_reads(announcement_id, reader_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [announcementId, ctx.reader.id],
    );
  } else {
    await db.query('DELETE FROM announcement_reads WHERE announcement_id = $1 AND reader_id = $2', [announcementId, ctx.reader.id]);
  }
  return { read };
}

/** Персональная главная: что важно сейчас, незакрытые чеклисты, разделы, популярные вопросы. */
export async function home(db: Db, ctx: HandbookContext) {
  const [sections, deadlines, feed] = await Promise.all([
    sectionsWithPages(db, ctx),
    upcomingDeadlines(db, ctx, 30),
    announcementsFeed(db, ctx),
  ]);
  const pages = (await effectivePages(db, ctx)).filter((row) => matchesReader(row, ctx.profile));
  const progress = await many<{ page_id: string; item_id: string; done: boolean }>(
    db,
    'SELECT page_id, item_id, done FROM reader_progress WHERE reader_id = $1',
    [ctx.reader.id],
  );
  const doneByPage = new Map<string, Set<string>>();
  for (const row of progress) {
    if (!row.done) continue;
    const set = doneByPage.get(row.page_id) ?? new Set<string>();
    set.add(row.item_id);
    doneByPage.set(row.page_id, set);
  }
  const checklists = pages
    .map((page) => {
      const items = checklistItems(visibleBlocks(page.blocks, ctx.profile, ctx.today));
      if (items.length === 0 || !page.blocks.some((block) => block.type === 'checklist')) return null;
      const done = doneByPage.get(page.id) ?? new Set<string>();
      const total = items.length;
      const completed = items.filter((item) => done.has(item.itemId)).length;
      return completed < total ? { pageId: page.id, title: page.title, total, completed } : null;
    })
    .filter((item): item is { pageId: string; title: string; total: number; completed: number } => item !== null)
    .slice(0, 3);
  const popular = await many<{ query: string; n: number }>(
    db,
    `SELECT normalized AS query, count(*)::int AS n FROM search_log
      WHERE handbook_id = $1 AND results > 0 AND normalized <> '' AND created_at > now() - interval '60 days'
      GROUP BY normalized ORDER BY n DESC LIMIT 5`,
    [ctx.handbook.id],
  );
  const openQuestions = await one<{ n: number }>(
    db,
    "SELECT count(*)::int AS n FROM handbook_questions WHERE handbook_id = $1 AND reader_id = $2 AND status = 'open'",
    [ctx.handbook.id, ctx.reader.id],
  );
  const identity = await getBotIdentity();
  return {
    handbook: {
      id: ctx.handbook.id,
      slug: ctx.handbook.slug,
      title: ctx.handbook.title,
      subtitle: ctx.handbook.subtitle,
      emoji: ctx.handbook.emoji,
      dutyContact: ctx.handbook.settings?.dutyContact ?? null,
      /** Ссылка на справочник для чата курса и QR-плаката. */
      link: deepLink(identity, 'start', `hb_${ctx.handbook.slug}`),
    },
    profile: { course: ctx.reader.course, dorm: ctx.reader.dorm, program: ctx.reader.program, tags: ctx.reader.tags ?? [], reminders: ctx.reader.reminders, filled: ctx.reader.course !== null },
    timezone: ctx.timezone,
    today: ctx.today,
    announcements: feed.active.slice(0, 5),
    archivedAnnouncements: feed.archive.length,
    deadlines,
    checklists,
    sections,
    popular: popular.map((row) => row.query),
    myOpenQuestions: openQuestions?.n ?? 0,
  };
}

export async function askQuestion(db: Db, ctx: HandbookContext, rawText: string, rawQuery: string | null) {
  // Вопрос приходит и из чата, минуя API: нулевой байт PostgreSQL не примет (API-2)
  const text = stripNul(rawText);
  const query = stripNul(rawQuery);
  const trimmed = text.trim().slice(0, 1000);
  if (trimmed.length < 5) throw new AppError('question_short', 'Опишите вопрос подробнее — так дежурному будет понятнее', 400);
  // Вопросы дежурному задают студенты. Команда справочника отвечает на них, а не задаёт себе же
  if (await isStaffOf(db, ctx.handbook, ctx.reader.user_id)) {
    throw new AppError('team_question', 'Вопросы дежурному задают студенты. Вы в команде справочника — отвечайте на вопросы во вкладке «Вопросы»', 403);
  }
  return tx(async (client) => {
    // Двойное нажатие не должно создать два вопроса: проверки и вставка — под блокировкой читателя
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hbq:${ctx.reader.id}`]);
    // Тот же вопрос дважды — скорее всего двойное нажатие; несколько разных вопросов разрешаем
    const duplicate = await one(
      client,
      "SELECT 1 FROM handbook_questions WHERE reader_id = $1 AND status = 'open' AND lower(text) = lower($2)",
      [ctx.reader.id, trimmed],
    );
    if (duplicate) throw new AppError('question_duplicate', 'Этот вопрос уже отправлен — ответ придёт в чат', 409);
    const open = await one<{ n: number }>(
      client,
      "SELECT count(*)::int AS n FROM handbook_questions WHERE reader_id = $1 AND status = 'open'",
      [ctx.reader.id],
    );
    if ((open?.n ?? 0) >= MAX_OPEN_QUESTIONS) {
      throw new AppError('question_limit', 'У вас уже пять вопросов без ответа — дождитесь ответа дежурного', 409);
    }
    const row = await one<{ id: string }>(
      client,
      'INSERT INTO handbook_questions(handbook_id, reader_id, user_id, text, query) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [ctx.handbook.id, ctx.reader.id, ctx.reader.user_id, trimmed, query?.slice(0, 200) ?? null],
    );
    await audit(client, {
      universityId: ctx.handbook.university_id,
      actorUserId: ctx.reader.user_id,
      action: 'handbook.question',
      entity: 'handbook_question',
      entityId: row!.id,
    });
    return { id: row!.id };
  });
}

const MAX_OPEN_QUESTIONS = 5;

export async function openQuestionCount(db: Db, ctx: HandbookContext): Promise<number> {
  const row = await one<{ n: number }>(
    db,
    "SELECT count(*)::int AS n FROM handbook_questions WHERE reader_id = $1 AND status = 'open'",
    [ctx.reader.id],
  );
  return row?.n ?? 0;
}

export function questionLimitReached(count: number): boolean {
  return count >= MAX_OPEN_QUESTIONS;
}

/**
 * «Спросить дежурного» в чате: следующее сообщение пользователя (в течение 15 минут) — это текст вопроса.
 * Вопрос создаётся только когда пришёл текст: пустых заготовок в очереди дежурного не бывает.
 * К вопросу прикладываем последний поисковый запрос — дежурному видно, что человек уже искал.
 */
export async function awaitChatQuestion(db: Db, ctx: HandbookContext): Promise<void> {
  const last = await one<{ query: string }>(
    db,
    `SELECT query FROM search_log
      WHERE reader_id = $1 AND source = 'bot' AND created_at > now() - interval '15 minutes'
      ORDER BY created_at DESC LIMIT 1`,
    [ctx.reader.id],
  );
  await db.query(
    `INSERT INTO kv(key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`hbq:${ctx.reader.user_id}`, JSON.stringify({ handbookId: ctx.handbook.id, query: last?.query ?? null })],
  );
}

/** Забирает ожидание вопроса из чата, если оно ещё не истекло. */
export async function takeChatQuestion(db: Db, userId: number): Promise<{ handbookId: string; query: string | null } | null> {
  const row = await one<{ value: { handbookId: string; query: string | null }; fresh: boolean }>(
    db,
    `DELETE FROM kv WHERE key = $1 RETURNING value, updated_at > now() - interval '15 minutes' AS fresh`,
    [`hbq:${userId}`],
  );
  return row?.fresh ? row.value : null;
}

export async function myQuestions(db: Db, ctx: HandbookContext) {
  const rows = await many<{ id: string; text: string; status: 'open' | 'answered'; answer: string | null; created_at: Date; answered_at: Date | null }>(
    db,
    'SELECT id, text, status, answer, created_at, answered_at FROM handbook_questions WHERE reader_id = $1 ORDER BY created_at DESC LIMIT 20',
    [ctx.reader.id],
  );
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    status: row.status,
    answer: row.answer,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  }));
}

export interface Membership {
  role: 'admin' | 'editor';
  /** Запись вуза, которая даёт это право: ею и подписываются правки, а не текущей выбранной ролью. */
  personId: string;
}

/**
 * Право пользователя на справочник. Возвращает и роль, и запись вуза, которая её даёт:
 * у одного аккаунта MAX может быть несколько записей в разных вузах, и подписывать правки
 * нужно именно той, что принадлежит этому справочнику.
 */
export async function membership(db: Db, handbookId: string, user: UserRow): Promise<Membership | null> {
  const row = await one<Membership>(
    db,
    `SELECT m.role, m.person_id AS "personId" FROM handbook_members m
       JOIN persons p ON p.id = m.person_id
       JOIN handbooks h ON h.id = m.handbook_id
      WHERE m.handbook_id = $1 AND p.user_id = $2 AND p.university_id = h.university_id
      ORDER BY (m.role = 'admin') DESC LIMIT 1`,
    [handbookId, user.id],
  );
  if (row) return row;
  // Назначения университета: администратор университета ведёт общую базу,
  // администратор факультета — справочники своего института. Справочники факультетов
  // администратор университета только смотрит: править их он может, назначив себя явно.
  const granted = await one<{ personId: string }>(
    db,
    `SELECT r.person_id AS "personId" FROM org_roles r
       JOIN persons p ON p.id = r.person_id
       JOIN handbooks h ON h.id = $1 AND h.university_id = r.university_id
      WHERE p.user_id = $2 AND r.revoked_at IS NULL AND p.university_id = h.university_id
        AND ((r.role = 'university_admin' AND h.institute_id IS NULL)
          OR (r.role = 'faculty_admin' AND r.institute_id = h.institute_id))
      LIMIT 1`,
    [handbookId, user.id],
  );
  if (granted) return { role: 'admin', personId: granted.personId };
  // Сотрудник деканата этого института — администратор справочника по должности (до перехода на назначения)
  const dean = await one<{ personId: string }>(
    db,
    `SELECT p.id AS "personId" FROM persons p JOIN handbooks h ON h.institute_id = p.institute_id
      WHERE h.id = $1 AND p.user_id = $2 AND p.role = 'dean' AND p.university_id = h.university_id
      LIMIT 1`,
    [handbookId, user.id],
  );
  return dean ? { role: 'admin', personId: dean.personId } : null;
}

/** Команда справочника или администрация вуза: деканат, редакторы, администратор факультета или университета. */
export async function isStaffOf(db: Db, handbook: Pick<HandbookRow, 'id' | 'university_id'>, userId: number): Promise<boolean> {
  if (await membership(db, handbook.id, { id: userId } as UserRow)) return true;
  const uni = await one(
    db,
    `SELECT 1 FROM org_roles r JOIN persons p ON p.id = r.person_id
      WHERE p.user_id = $1 AND r.university_id = $2 AND r.role = 'university_admin' AND r.revoked_at IS NULL LIMIT 1`,
    [userId, handbook.university_id],
  );
  return Boolean(uni);
}

/** Роль пользователя в справочнике: читатель, редактор раздела или администратор. */
export async function memberRole(db: Db, handbookId: string, user: UserRow): Promise<'admin' | 'editor' | null> {
  return (await membership(db, handbookId, user))?.role ?? null;
}

export { blocksSchema };
