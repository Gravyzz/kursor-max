import { z } from 'zod';

/**
 * Модель контента справочника: страница собирается из блоков.
 * Блоки — простые структуры, поэтому их можно редактировать с телефона,
 * искать полнотекстовым поиском и превращать в напоминания (deadline) и чеклисты.
 */

/** Разумные границы года: «0000-01-01» или «0202-09-01» — опечатка, а PostgreSQL такие даты не принимает. */
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;

/**
 * Настоящая дата календаря в формате ГГГГ-ММ-ДД: «2026-02-30» и «2026-13-45» не проходят.
 * Одна понятная ошибка на поле: пустое — «Укажите дату», а не сразу две про формат и календарь.
 */
export function calendarDateWith(emptyMessage: string) {
  return z.string().superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!value.trim()) return fail(emptyMessage);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('Дата в формате ГГГГ-ММ-ДД');
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return fail('Такой даты нет в календаре');
    const year = Number(value.slice(0, 4));
    if (year < YEAR_MIN || year > YEAR_MAX) return fail(`Проверьте год: дата должна быть между ${YEAR_MIN} и ${YEAR_MAX} годом`);
  });
}
export const calendarDate = calendarDateWith('Укажите дату');

/** Ссылка, которую можно отдать студенту: только https, без логина в адресе («https://max.ru@evil.example»). */
export function isHttpsUrl(value: string): boolean {
  if (!/^https:\/\//i.test(value) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Ссылка на чат или профиль в MAX: https://max.ru/… */
export function isMaxUrl(value: string): boolean {
  return isHttpsUrl(value) && new URL(value).hostname.toLowerCase() === 'max.ru';
}

export const audienceSchema = z
  .object({
    courses: z.array(z.number().int().min(1).max(6)).max(6).optional(),
    dorm: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  })
  .strict();
export type Audience = z.infer<typeof audienceSchema>;

// Сообщения об ошибках видит редактор справочника — студсовет или учебный офис, а не программист.
// Поля в сообщениях названы так же, как в форме конструктора (miniapp BlockEditor.tsx).
// Схема строится в двух вариантах: строгая — для публикации и проверки, мягкая — для черновика:
// недописанный блок можно сохранить и дописать потом, но опубликовать его нельзя.
function makeBlockSchema(strict: boolean) {
  const id = z.string().trim().min(1, 'Пустой идентификатор блока').max(40, 'Слишком длинный идентификатор');
  const tooLong = (label: string, max: number) => `«${label}» — не длиннее ${max} символов`;
  /** Обязательное поле: для публикации — непустое, в черновике — любое. */
  const required = (label: string, emptyMessage: string, max: number) =>
    strict ? z.string().trim().min(1, emptyMessage).max(max, tooLong(label, max)) : z.string().max(max, tooLong(label, max));
  const optional = (label: string, max: number) => z.string().trim().max(max, tooLong(label, max)).optional();
  /** Пустая строка в необязательном поле — то же, что его отсутствие: пустой заголовок чеклиста не мешает публикации. */
  const blankAsMissing = <T extends z.ZodTypeAny>(schema: T) =>
    z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema);
  const date = (emptyMessage: string) => (strict ? calendarDateWith(emptyMessage) : z.string().max(10, 'Дата в формате ГГГГ-ММ-ДД'));
  const optionalDate = () => blankAsMissing(date('Укажите дату').optional());
  const link = (check: (value: string) => boolean, message: string) =>
    strict
      ? z.string().trim().min(1, 'Вставьте ссылку').max(1024, 'Слишком длинная ссылка').refine(check, message)
      : z.string().max(1024, 'Слишком длинная ссылка');
  const httpsLink = () => link(isHttpsUrl, 'Ссылка должна начинаться с https://');
  const maxLink = () => link(isMaxUrl, 'Ссылка на чат в MAX должна начинаться с https://max.ru/');
  const list = <T extends z.ZodTypeAny>(item: T, emptyMessage: string, max: number, maxMessage: string) =>
    strict ? z.array(item).min(1, emptyMessage).max(max, maxMessage) : z.array(item).max(max, maxMessage);

  const base = { id, audience: audienceSchema.optional() };

  return z.discriminatedUnion('type', [
    z.object({ ...base, type: z.literal('text'), text: required('Текст', 'Текст не может быть пустым', 4000) }),
    z.object({
      ...base,
      type: z.literal('steps'),
      title: blankAsMissing(optional('Заголовок', 200)),
      items: list(
        z.object({ id, text: required('Что сделать', 'Впишите, что сделать', 200), hint: optional('Подсказка', 400) }),
        'Добавьте хотя бы один шаг',
        20,
        'Не больше 20 шагов',
      ),
    }),
    z.object({
      ...base,
      type: z.literal('checklist'),
      title: blankAsMissing(optional('Заголовок', 200)),
      items: list(
        z.object({ id, text: required('Что нужно сделать', 'Впишите, что нужно сделать', 200), dueOn: optionalDate() }),
        'Добавьте хотя бы один пункт',
        20,
        'Не больше 20 пунктов',
      ),
    }),
    z.object({
      ...base,
      type: z.literal('faq'),
      items: list(
        z.object({ id, question: required('Вопрос', 'Заполните вопрос', 200), answer: required('Ответ', 'Заполните ответ', 2000) }),
        'Добавьте хотя бы один вопрос',
        20,
        'Не больше 20 вопросов',
      ),
    }),
    z.object({
      ...base,
      type: z.literal('contact'),
      name: required('Кто', 'Заполните поле «Кто»', 200),
      role: optional('Должность или с чем помогает', 120),
      room: optional('Где', 120),
      hours: optional('Когда', 200),
      phone: optional('Телефон', 40),
      email: optional('Почта', 120),
      maxLink: blankAsMissing(link(isMaxUrl, 'Ссылка «Написать в MAX» должна начинаться с https://max.ru/').optional()),
    }),
    z.object({
      ...base,
      type: z.literal('place'),
      title: required('Название', 'Заполните название', 200),
      address: optional('Адрес', 300),
      howTo: optional('Как найти', 600),
      mapLink: blankAsMissing(httpsLink().optional()),
    }),
    z.object({
      ...base,
      type: z.literal('deadline'),
      title: required('Что нужно успеть', 'Заполните, что нужно успеть', 200),
      startsOn: date('Укажите дату начала'),
      endsOn: optionalDate(),
      remindDays: z.array(z.number().int().min(0).max(30)).max(4).optional(),
    }),
    z.object({ ...base, type: z.literal('link'), title: required('Название', 'Заполните название', 200), url: httpsLink(), note: optional('Пояснение', 300) }),
    z.object({ ...base, type: z.literal('file'), title: required('Название', 'Заполните название', 200), url: httpsLink(), note: optional('Пояснение', 300) }),
    z.object({
      ...base,
      type: z.literal('alert'),
      tone: z.enum(['info', 'warn']).default('info'),
      text: required('Текст', 'Текст не может быть пустым', 1000),
      endsOn: optionalDate(),
    }),
    z.object({ ...base, type: z.literal('chat'), title: required('Название', 'Заполните название', 200), url: maxLink(), note: optional('Пояснение', 300) }),
    z.object({
      ...base,
      type: z.literal('glossary'),
      items: list(
        z.object({ id, term: required('Термин', 'Заполните термин', 80), meaning: required('Что это значит', 'Заполните, что значит термин', 600) }),
        'Добавьте хотя бы один термин',
        30,
        'Не больше 30 терминов',
      ),
    }),
  ]);
}

export const blockSchema = makeBlockSchema(true);
/** Черновик: структура блоков та же, но пустые поля разрешены — дописать можно позже. */
export const draftBlockSchema = makeBlockSchema(false);
export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block['type'];

export const blocksSchema = z
  .array(blockSchema)
  .max(60, 'Не больше 60 блоков на странице')
  .superRefine((blocks, ctx) => {
    // Идентификаторы блоков и пунктов уникальны на странице: по id блока «Срок» живёт календарь,
    // по id пункта — отметки чеклистов (у пунктов чеклистов и шагов общий счёт на всю страницу)
    const blockIds = new Map<string, number>();
    const progressIds = new Set<string>();
    blocks.forEach((block, index) => {
      if (block.type === 'deadline' && block.endsOn && block.endsOn < block.startsOn) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'endsOn'], message: 'Дата окончания раньше даты начала' });
      }
      const first = blockIds.get(block.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Повторяется идентификатор блока «${block.id}» (такой же у блока ${first + 1}) — удалите этот блок и добавьте заново`,
        });
      } else {
        blockIds.set(block.id, index);
      }
      if (!('items' in block)) return;
      const shared = block.type === 'checklist' || block.type === 'steps';
      const own = new Set<string>();
      block.items.forEach((item, itemIndex) => {
        const seen = shared ? progressIds : own;
        if (seen.has(item.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'items', itemIndex, 'id'],
            message: `Повторяется идентификатор «${item.id}» — удалите пункт и добавьте заново`,
          });
        }
        seen.add(item.id);
      });
    });
  });
export const draftBlocksSchema = z.array(draftBlockSchema).max(60, 'Не больше 60 блоков на странице');

/** Страница без блоков — пустой лист у студента: опубликовать её нельзя. */
export const EMPTY_PAGE_ISSUE = 'Добавьте хотя бы один блок';

/** Что мешает опубликовать страницу — понятными словами, не больше четырёх пунктов. */
export function publishIssues(blocks: unknown): string[] {
  if (Array.isArray(blocks) && blocks.length === 0) return [EMPTY_PAGE_ISSUE];
  const parsed = blocksSchema.safeParse(blocks);
  if (parsed.success) return [];
  return [...new Set(parsed.error.issues.map((issue) => describeBlockIssue(issue, blocks)))].slice(0, 4);
}

/** Как в форме называется элемент списка блока: «Чеклист (блок 2): Пункт 3: впишите…». */
const ITEM_LABEL: Partial<Record<BlockType, string>> = { steps: 'Шаг', checklist: 'Пункт', faq: 'Вопрос', glossary: 'Термин' };

/**
 * Ошибку валидации блока редактор должен понять без словаря:
 * «Срок (блок 3): Заполните, что нужно успеть» вместо пути вида blocks.2.title.
 * Формат «<блок> (блок N): <что не так>» разбирает конструктор, чтобы показать ошибку у самого блока.
 */
export function describeBlockIssue(issue: { path: Array<string | number>; message: string }, blocks: unknown): string {
  const index = typeof issue.path[0] === 'number' ? issue.path[0] : undefined;
  const block = index !== undefined && Array.isArray(blocks) ? (blocks[index] as { type?: BlockType } | undefined) : undefined;
  const label = block?.type ? BLOCK_LABEL[block.type] : null;
  if (!label) return issue.message;
  const itemIndex = issue.path[1] === 'items' && typeof issue.path[2] === 'number' ? issue.path[2] : undefined;
  const itemLabel = block?.type ? ITEM_LABEL[block.type] : undefined;
  const message = itemIndex !== undefined && itemLabel
    ? `${itemLabel} ${itemIndex + 1}: ${issue.message.charAt(0).toLowerCase()}${issue.message.slice(1)}`
    : issue.message;
  return `${label}${index !== undefined ? ` (блок ${index + 1})` : ''}: ${message}`;
}

export const BLOCK_LABEL: Record<BlockType, string> = {
  text: 'Текст',
  steps: 'Пошаговая инструкция',
  checklist: 'Чеклист',
  faq: 'Вопросы и ответы',
  contact: 'Контакт',
  place: 'Место',
  deadline: 'Срок',
  link: 'Ссылка',
  file: 'Файл',
  alert: 'Важное',
  chat: 'Чат в MAX',
  glossary: 'Словарь терминов',
};

/** Весь человекочитаемый текст блока — для поиска и для краткого ответа бота. */
export function blockText(block: Block): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'steps':
      return [block.title, ...block.items.map((i) => [i.text, i.hint].filter(Boolean).join(' '))].filter(Boolean).join('\n');
    case 'checklist':
      return [block.title, ...block.items.map((i) => i.text)].filter(Boolean).join('\n');
    case 'faq':
      return block.items.map((i) => `${i.question} ${i.answer}`).join('\n');
    case 'contact':
      return [block.name, block.role, block.room, block.hours, block.phone, block.email].filter(Boolean).join(' ');
    case 'place':
      return [block.title, block.address, block.howTo].filter(Boolean).join(' ');
    case 'deadline':
      return `${block.title} ${block.startsOn}${block.endsOn ? ` ${block.endsOn}` : ''}`;
    case 'link':
    case 'file':
    case 'chat':
      return [block.title, block.note].filter(Boolean).join(' ');
    case 'alert':
      return block.text;
    case 'glossary':
      return block.items.map((i) => `${i.term} ${i.meaning}`).join('\n');
    default:
      return '';
  }
}

/**
 * Заголовочная часть поискового текста (вес A). Название раздела входит в неё намеренно:
 * студент ищет «физра отработки», а слово «физкультура» стоит в названии раздела, а не на странице.
 */
export function pageSearchTitle(title: string, sectionTitle?: string | null): string {
  return [title, sectionTitle ?? ''].filter(Boolean).join('\n').slice(0, 500);
}

/** Остальной текст страницы (вес B): краткое описание и содержимое блоков. */
export function pageSearchText(summary: string | null, blocks: Block[]): string {
  return [summary ?? '', ...blocks.map(blockText)].filter(Boolean).join('\n').slice(0, 20000);
}

/** Короткая выжимка страницы для ответа в чате и карточек поиска. */
export function pageSnippet(summary: string | null, blocks: Block[], limit = 240): string {
  const source = summary?.trim() || blocks.map(blockText).find((text) => text.trim().length > 0) || '';
  const flat = source.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

export interface ReaderProfile {
  course: number | null;
  dorm: boolean | null;
  tags: string[];
}

/** Та же логика, что в SQL-функции audience_matches: пустая аудитория — для всех. */
export function audienceMatches(audience: Audience | null | undefined, profile: ReaderProfile): boolean {
  if (!audience) return true;
  if (audience.courses?.length && profile.course !== null && !audience.courses.includes(profile.course)) return false;
  if (audience.dorm !== undefined && profile.dorm !== null && audience.dorm !== profile.dorm) return false;
  if (audience.tags?.length && profile.tags.length > 0 && !audience.tags.some((tag) => profile.tags.includes(tag))) return false;
  return true;
}

/** Блоки, актуальные для читателя: по аудитории и по сроку показа (сезонность). */
export function visibleBlocks(blocks: Block[], profile: ReaderProfile, today: string): Block[] {
  return blocks.filter((block) => {
    if (!audienceMatches(block.audience, profile)) return false;
    if (block.type === 'alert' && block.endsOn && block.endsOn < today) return false;
    return true;
  });
}

export function checklistItems(blocks: Block[]): Array<{ blockId: string; itemId: string; text: string; dueOn?: string }> {
  const items: Array<{ blockId: string; itemId: string; text: string; dueOn?: string }> = [];
  for (const block of blocks) {
    if (block.type === 'checklist') {
      for (const item of block.items) items.push({ blockId: block.id, itemId: item.id, text: item.text, ...(item.dueOn ? { dueOn: item.dueOn } : {}) });
    }
    if (block.type === 'steps') {
      for (const item of block.items) items.push({ blockId: block.id, itemId: item.id, text: item.text });
    }
  }
  return items;
}

export function deadlineBlocks(blocks: Block[]): Array<Extract<Block, { type: 'deadline' }>> {
  return blocks.filter((block): block is Extract<Block, { type: 'deadline' }> => block.type === 'deadline');
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function slugify(value: string, fallback = 'page'): string {
  const slug = value
    .toLowerCase()
    .split('')
    .map((char) => TRANSLIT[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** Разговорные формы, по которым студенты ищут. Дополняется настройками справочника. */
export const DEFAULT_SYNONYMS: Record<string, string> = {
  физра: 'физкультура',
  общага: 'общежитие',
  общеж: 'общежитие',
  зачётка: 'зачётная книжка',
  зачетка: 'зачётная книжка',
  матпомощь: 'материальная помощь',
  стипуха: 'стипендия',
  стипа: 'стипендия',
  бумажка: 'справка',
  академ: 'академический отпуск',
  хвост: 'академическая задолженность',
  хвосты: 'академическая задолженность',
  пересдача: 'пересдача задолженность',
  военка: 'военный учёт',
  военник: 'военный билет',
  проездной: 'транспортная карта',
  столовка: 'столовая',
  деканат: 'деканат учебный офис',
  курсач: 'курсовая работа',
  диплом: 'выпускная квалификационная работа',
  препод: 'преподаватель',
  брс: 'балльно-рейтинговая система',
};

/**
 * Окончания, с которыми сленговое слово встречается в запросе: «физрой», «общагу», «стипухи», «хвостов».
 * Список закрытый, а не «любое продолжение»: иначе «академия» превратилась бы в «академ» (академический отпуск).
 */
const SLANG_ENDINGS = new Set([
  '', 'а', 'я', 'у', 'ю', 'е', 'ё', 'и', 'ы', 'о', 'ь', 'ой', 'ою', 'ей', 'ею', 'ом', 'ем', 'ём', 'ам', 'ям', 'ами', 'ями',
  'ах', 'ях', 'ов', 'ев', 'ью', 'ого', 'его', 'ому', 'ему', 'ым', 'им', 'ых', 'их', 'ую', 'ая', 'ое', 'ые', 'ие',
]);

/** Основа сленгового слова без конечных гласных: «общага» → «общаг», «хвосты» → «хвост». */
function slangStem(key: string): string | null {
  if (key.length < 4 || /\s/.test(key)) return null;
  const stem = key.replace(/[аяоеёиыуюьй]+$/u, '');
  return stem.length >= 3 ? stem : null;
}

/** Сленг в любой словоформе: сначала точное совпадение, иначе — самая длинная основа с обычным окончанием. */
function expandSlang(token: string, map: Record<string, string>): string {
  if (typeof map[token] === 'string') return map[token]!;
  let best: { length: number; value: string } | null = null;
  for (const key of Object.keys(map)) {
    const stem = slangStem(key);
    if (!stem || !token.startsWith(stem) || !SLANG_ENDINGS.has(token.slice(stem.length))) continue;
    if (!best || stem.length > best.length) best = { length: stem.length, value: map[key]! };
  }
  return best?.value ?? token;
}

/** Нормализация запроса: приводим сленг к словам, которыми написан справочник. */
export function normalizeQuery(query: string, synonyms: Record<string, string> = {}): string {
  // Без прототипа: токен «constructor» не должен превращаться в функцию Object
  const map: Record<string, string> = Object.assign(Object.create(null), DEFAULT_SYNONYMS, synonyms);
  const tokens = query
    .toLowerCase()
    .replace(/[«»"'`]/g, ' ')
    .split(/[^0-9a-zа-яё]+/i)
    .filter((token) => token.length > 1);
  const expanded = tokens.map((token) => expandSlang(token, map));
  return [...new Set(expanded.join(' ').split(/\s+/).filter(Boolean))].join(' ').slice(0, 200);
}
