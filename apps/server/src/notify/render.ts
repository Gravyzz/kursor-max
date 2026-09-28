import type { Db } from '../db/pool.js';
import { one } from '../db/pool.js';
import { daysBetween, formatDateRu, pluralDays, todayIn, zonedToUtc } from '../domain/dates.js';
import { shortName } from '../services/common.js';
import type { BotIdentity } from '../max/bot.js';
import { appButton, keyboard, type InlineButton } from '../max/buttons.js';

export interface RenderedMessage {
  text: string;
  attachments: ReturnType<typeof keyboard>[];
}

/**
 * Пользовательский текст (заголовки, ответы дежурного, объявления, выдержки страниц) внутри сообщения
 * с format: 'markdown'. MAX разбирает Markdown по CommonMark и не обещает экранирования обратной косой
 * чертой, поэтому разметку обезвреживаем так, чтобы текст остался прежним на вид и не сломался:
 *  - ссылки, почта и @упоминания передаются как есть — иначе перестанут открываться;
 *  - `*`, `~` и `` ` `` заменяются похожими знаками, `_` — только на границе слова
 *    (внутри слова, как в office_iit, CommonMark его разметкой не считает);
 *  - в `++` и `^^`, после `]` перед `(`, `[` или `:`, после `\` и `<` вставляется невидимый пробел
 *    нулевой ширины — так не получится ни ссылка, ни подчёркивание, ни HTML;
 *  - так же — перед `#`, `>` и строкой из `=` или `-` в начале строки: не будет заголовка и цитаты.
 * Скобки, `+`, `#` посреди строки и телефоны не трогаются: разметки из них не получится.
 */
const ZERO_WIDTH = '\u200B';
const LOOKALIKE: Record<string, string> = { '*': '∗', '~': '∼', '`': 'ˋ', _: 'ˍ' };
const WORD_CHAR = /[\p{L}\p{N}]/u;
/**
 * Группы: 1 — ссылка (до пробела, без угловых скобок и знаков разметки * ` [ ]), почта или @упоминание;
 * 2 — подчёркивания; 3 — знаки выделения; 4 — ++подчёркнутый++ и ^^важное^^;
 * 5 — `]` в [текст](ссылка), [текст][метка], [метка]: ссылка; 6 — обратная косая черта; 7 — начало HTML-тега.
 */
const INLINE_MARKUP =
  /((?:https?:\/\/|www\.)[^\s<>*`[\]]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+|@[\p{L}\p{N}_.]+)|(_+)|([*~`])|(\+{2,}|\^{2,})|(\](?=[([:]))|(\\)|(<(?=[\p{L}/!?]))/gu;
const LINE_MARKUP = /^([ \t]*)(?=[#>]|(?:=+|-+)[ \t]*$)/gm;

export function md(value: string | null | undefined): string {
  if (!value) return '';
  const inline = value.replace(
    INLINE_MARKUP,
    (match: string, verbatim?: string, underscores?: string, emphasis?: string, pair?: string, bracket?: string, backslash?: string, tag?: string, ...rest: unknown[]) => {
      if (verbatim) return match;
      if (underscores) {
        const offset = rest[0] as number;
        const inWord = WORD_CHAR.test(value[offset - 1] ?? '') && WORD_CHAR.test(value[offset + match.length] ?? '');
        return inWord ? match : LOOKALIKE._!.repeat(match.length);
      }
      if (emphasis) return LOOKALIKE[emphasis] ?? emphasis;
      if (pair) return [...pair].join(ZERO_WIDTH);
      if (bracket || backslash || tag) return match + ZERO_WIDTH;
      return match;
    },
  );
  return inline.replace(LINE_MARKUP, `$1${ZERO_WIDTH}`);
}

/** Жирный заголовок из пользовательского текста; пробелы по краям сломали бы разметку. */
const b = (value: string) => (value.trim() ? `**${md(value.trim())}**` : '');

function message(lines: Array<string | null | false | undefined>, rows: InlineButton[][] = []): RenderedMessage {
  return {
    text: lines.filter((line): line is string => typeof line === 'string').join('\n'),
    attachments: rows.length ? [keyboard(rows)] : [],
  };
}

/**
 * Приветствие после привязки аккаунта MAX к записи вуза по приглашению.
 * Чаще всего это новый редактор справочника: сразу говорим, что теперь можно.
 */
export async function welcomeMessage(db: Db, personId: string, role: string, identity: BotIdentity): Promise<RenderedMessage | null> {
  const row = await one<{ full_name: string; handbook_title: string | null; member_role: string | null }>(
    db,
    `SELECT p.full_name, h.title AS handbook_title, m.role AS member_role
       FROM persons p
       LEFT JOIN handbook_members m ON m.person_id = p.id
       LEFT JOIN handbooks h ON h.id = m.handbook_id
      WHERE p.id = $1
      ORDER BY (m.role = 'admin') DESC NULLS LAST
      LIMIT 1`,
    [personId],
  );
  if (!row) return null;
  if (row.handbook_title) {
    return message(
      [
        `Готово, ${md(shortName(row.full_name))}! Вы ${row.member_role === 'admin' ? 'администратор' : 'редактор'} справочника ${b(row.handbook_title)}.`,
        '',
        row.member_role === 'admin'
          ? 'Собирайте страницы из блоков прямо с телефона и публикуйте их — студенты увидят изменения сразу.'
          : 'Собирайте страницы из блоков прямо с телефона и отправляйте на проверку — после публикации их увидят студенты.',
        'Вопросы, на которые справочник не ответил, и запросы без результата — в разделе «Что ищут студенты».',
      ],
      [[appButton(identity, 'Открыть редактор', 'hbe')]],
    );
  }
  if (role === 'dean') {
    return message(
      ['Вы подключены как сотрудник деканата.', 'Создайте справочник факультета — он придёт с готовой структурой разделов и подсказками, что заполнить.'],
      [[appButton(identity, 'Создать справочник', 'dean')]],
    );
  }
  return message(['Готово, вы подключены.'], [[appButton(identity, 'Открыть справочник', 'hb')]]);
}

export interface NotificationInput {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  person_id: string | null;
  role: string;
  reader_id?: string | null;
  /** Ключ дедупликации; если не передан, берётся из очереди по id. */
  dedupe_key?: string | null;
}

/**
 * Что делать с уведомлением из очереди прямо сейчас:
 * send — отправить; skip — устарело или больше не касается адресата; defer — ещё рано, вернуть в очередь до until.
 */
export type PreparedNotification =
  | { action: 'send'; message: RenderedMessage }
  | { action: 'skip' }
  | { action: 'defer'; until: Date };

const skip: PreparedNotification = { action: 'skip' };
const sendIt = (rendered: RenderedMessage | null): PreparedNotification => (rendered ? { action: 'send', message: rendered } : skip);

/** Ключ напоминания о сроке: hb_deadline:<срок>:<дата срока>:u<пользователь>:<дней до срока>. */
export function parseDeadlineKey(key: string | null | undefined): { dueOn: string; days: number } | null {
  const match = /^hb_deadline:[^:]+:(\d{4}-\d{2}-\d{2}):u\d+:(-?\d+)$/.exec(key ?? '');
  return match ? { dueOn: match[1]!, days: Number(match[2]) } : null;
}

/** Текст уведомления из очереди. null — отправлять сейчас не нужно (устарело или ещё рано). */
export async function renderNotification(db: Db, input: NotificationInput, identity: BotIdentity): Promise<RenderedMessage | null> {
  const prepared = await prepareNotification(db, input, identity);
  return prepared.action === 'send' ? prepared.message : null;
}

/** Решение по уведомлению из очереди: условия проверяются заново в момент отправки, а не только при постановке. */
export async function prepareNotification(db: Db, input: NotificationInput, identity: BotIdentity): Promise<PreparedNotification> {
  const p = input.payload;
  switch (input.kind) {
    case 'welcome':
      return sendIt(input.person_id ? await welcomeMessage(db, input.person_id, input.role, identity) : null);
    case 'handbook_review': {
      const row = await one<{ title: string; handbook_title: string; handbook_slug: string; author: string | null }>(
        db,
        `SELECT pg.title, h.title AS handbook_title, h.slug AS handbook_slug, au.full_name AS author
           FROM pages pg JOIN handbooks h ON h.id = pg.handbook_id
           LEFT JOIN persons au ON au.id = pg.owner_person_id
          WHERE pg.id = $1 AND (pg.status = 'review' OR pg.review_requested_at IS NOT NULL)`,
        [String(p.pageId)],
      );
      if (!row) return skip;
      return sendIt(
        message(
          [
            `📝 Страница на проверке — ${b(row.handbook_title)}`,
            `${b(row.title)}${row.author ? ` · ${md(shortName(row.author))}` : ''}`,
            p.note ? `«${md(String(p.note))}»` : null,
            '\nПроверьте и опубликуйте — студенты увидят изменения сразу.',
          ],
          [[appButton(identity, 'Открыть в редакторе', `hbe_${String(p.pageId)}`)]],
        ),
      );
    }
    case 'handbook_return': {
      // Страницу вернули с проверки на доработку (C2): payload { pageId, handbookId, note }.
      // Если её уже снова отправили на проверку или убрали в архив, сообщение устарело
      const row = await one<{ title: string; status: string; handbook_title: string }>(
        db,
        `SELECT pg.title, pg.status, h.title AS handbook_title
           FROM pages pg JOIN handbooks h ON h.id = pg.handbook_id AND h.status = 'active'
          WHERE pg.id = $1 AND pg.status IN ('draft', 'published') AND pg.review_requested_at IS NULL AND pg.returned_at IS NOT NULL`,
        [String(p.pageId)],
      );
      if (!row) return skip;
      const note = typeof p.note === 'string' ? p.note.trim() : '';
      return sendIt(
        message(
          [
            `↩️ Страницу вернули на доработку — ${b(row.handbook_title)}`,
            b(row.title),
            note ? `Что поправить: «${md(note)}»` : null,
            row.status === 'published' ? 'Студенты пока видят прежнюю опубликованную версию.' : null,
            '\nПоправьте страницу и снова отправьте её на проверку.',
          ],
          [[appButton(identity, 'Открыть в редакторе', `hbe_${String(p.pageId)}`)]],
        ),
      );
    }
    case 'handbook_answer': {
      const row = await one<{ text: string; answer: string; page_id: string | null; page_title: string | null; handbook_title: string; handbook_slug: string; author: string | null }>(
        db,
        `SELECT q.text, q.answer, pg.id AS page_id, pg.title AS page_title, h.title AS handbook_title, h.slug AS handbook_slug, pr.full_name AS author
           FROM handbook_questions q JOIN handbooks h ON h.id = q.handbook_id
           LEFT JOIN pages pg ON pg.id = q.page_id
           LEFT JOIN persons pr ON pr.id = q.answered_by
          WHERE q.id = $1 AND q.status = 'answered'`,
        [String(p.questionId)],
      );
      if (!row?.answer) return skip;
      return sendIt(
        message(
          [
            `💬 Ответ на ваш вопрос — ${b(row.handbook_title)}`,
            `«${md(row.text)}»`,
            '',
            md(row.answer),
            row.page_title ? `\nПодробно: ${md(row.page_title)}` : null,
          ],
          [[appButton(identity, row.page_id ? 'Открыть страницу' : 'Открыть справочник', row.page_id ? `hbp_${row.page_id}` : `hb_${row.handbook_slug}`)]],
        ),
      );
    }
    case 'handbook_announcement': {
      // Флажок «Напоминать о сроках» (reminders) здесь не проверяется: он только про сроки, объявления приходят всем адресатам
      const row = await one<{
        title: string; body: string; handbook_title: string; handbook_slug: string; page_id: string | null;
        starts_on: string | null; timezone: string; early: boolean;
      }>(
        db,
        `SELECT a.title, a.body, h.title AS handbook_title, h.slug AS handbook_slug, pg.id AS page_id,
                to_char(a.starts_on, 'YYYY-MM-DD') AS starts_on, un.timezone,
                COALESCE(a.starts_on > (now() AT TIME ZONE un.timezone)::date, false) AS early
           FROM announcements a JOIN handbooks h ON h.id = a.handbook_id
           JOIN universities un ON un.id = h.university_id
           LEFT JOIN pages pg ON pg.id = a.page_id AND pg.status = 'published'
          WHERE a.id = $1 AND (a.ends_on IS NULL OR a.ends_on >= (now() AT TIME ZONE un.timezone)::date)`,
        [String(p.announcementId)],
      );
      if (!row) return skip;
      // Дату начала перенесли на потом: в ленте объявления ещё нет — и в чат оно придёт в день начала, в 10:00 по времени вуза
      if (row.early && row.starts_on) return { action: 'defer', until: zonedToUtc(row.starts_on, '10:00', row.timezone) };
      return sendIt(
        message(
          [`📣 ${b(row.title)}`, '', md(row.body), `\n_${md(row.handbook_title)}_`],
          [[appButton(identity, row.page_id ? 'Подробнее' : 'Открыть справочник', row.page_id ? `hbp_${row.page_id}` : `hb_${row.handbook_slug}`)]],
        ),
      );
    }
    case 'handbook_deadline':
      return prepareDeadline(db, input, identity);
    default:
      return skip;
  }
}

/**
 * Напоминание о сроке ждёт 10 утра до десяти часов. За это время читатель мог сменить курс, редактор — сузить
 * аудиторию или скрыть раздел, деканат — перенести срок или убрать справочник в архив. Поэтому перед отправкой
 * повторяем условия планировщика (worker/index.ts, enqueueDeadlineReminders) для этого читателя.
 */
async function prepareDeadline(db: Db, input: NotificationInput, identity: BotIdentity): Promise<PreparedNotification> {
  const queued = input.dedupe_key !== undefined && input.reader_id !== undefined
    ? { dedupe_key: input.dedupe_key, reader_id: input.reader_id }
    : await one<{ dedupe_key: string | null; reader_id: string | null }>(db, 'SELECT dedupe_key, reader_id FROM notifications WHERE id = $1', [input.id]);
  const readerId = input.reader_id ?? queued?.reader_id ?? null;
  const key = parseDeadlineKey(input.dedupe_key ?? queued?.dedupe_key);
  const row = await one<{
    title: string; starts_on: string; ends_on: string | null; due_on: string; remind_days: number[];
    page_id: string; page_title: string; handbook_title: string; timezone: string; is_demo: boolean;
  }>(
    db,
    `SELECT dl.title, to_char(dl.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(dl.ends_on, 'YYYY-MM-DD') AS ends_on,
            to_char(COALESCE(dl.ends_on, dl.starts_on), 'YYYY-MM-DD') AS due_on, dl.remind_days,
            pg.id AS page_id, pg.title AS page_title, h.title AS handbook_title, un.timezone, un.is_demo
       FROM handbook_deadlines dl
       JOIN pages pg ON pg.id = dl.page_id AND pg.status = 'published'
       JOIN sections sc ON sc.id = pg.section_id AND sc.visible
       JOIN handbooks h ON h.id = dl.handbook_id AND h.status = 'active'
       JOIN universities un ON un.id = h.university_id
      WHERE dl.id = $1
        AND ($2::uuid IS NULL OR EXISTS (
          SELECT 1 FROM handbook_readers r
            JOIN handbooks rh ON rh.id = r.handbook_id AND rh.status = 'active'
           WHERE r.id = $2 AND r.reminders
             AND (rh.id = dl.handbook_id OR rh.parent_id = dl.handbook_id)
             AND audience_matches(dl.audience, r.course::int, r.dorm, r.tags)
             AND audience_matches(pg.audience, r.course::int, r.dorm, r.tags)
             AND audience_matches(sc.audience, r.course::int, r.dorm, r.tags)
             -- факультет переписал страницу вуза — напоминает его версия, а не исходная
             AND NOT EXISTS (
               SELECT 1 FROM pages ov
                WHERE rh.id <> dl.handbook_id AND ov.handbook_id = rh.id
                  AND ov.inherited_from = dl.page_id AND ov.status = 'published'
             )
        ))`,
    [String(input.payload.deadlineId), readerId],
  );
  if (!row) return skip;
  // Срок перенесли: у нового срока своя дата в ключе, и планировщик поставит напоминание заново
  if (key && key.dueOn !== row.due_on) return skip;
  // Дни считаем в момент отправки: отложенное до утра напоминание не скажет «завтра» в сам день срока.
  // Если за ночь наступил другой день, это напоминание устарело: о новом дне напомнит своё (если он есть в remind_days)
  const days = daysBetween(todayIn(row.timezone), row.due_on);
  if (days < 0 || !row.remind_days.includes(days) || (key && key.days !== days)) return skip;
  const range = Boolean(row.ends_on && row.ends_on !== row.starts_on);
  // Для периода напоминаем о последнем дне: «осталось 3 дня», для одной даты — «через 3 дня»
  const when = days <= 0
    ? (range ? 'последний день' : 'сегодня')
    : days === 1
      ? (range ? 'остался один день' : 'завтра')
      : range ? `осталось ${pluralDays(days)}` : `через ${pluralDays(days)}`;
  return sendIt(
    message(
      [
        `⏰ ${b(row.title)} — ${when}`,
        range ? `Сроки: ${formatDateRu(row.starts_on)} — ${formatDateRu(row.ends_on!)}` : `Дата: ${formatDateRu(row.starts_on)}`,
        `\nЧто нужно сделать — на странице «${md(row.page_title)}».`,
        row.is_demo ? `_${md(row.handbook_title)} · демо, срок вымышленный_` : `_${md(row.handbook_title)}_`,
      ],
      [[appButton(identity, 'Открыть страницу', `hbp_${row.page_id}`)]],
    ),
  );
}
