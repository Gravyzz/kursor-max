import type { Db } from '../db/pool.js';
import { many, one } from '../db/pool.js';
import type { Block } from '../domain/handbook.js';
import { pageSearchText, pageSearchTitle } from '../domain/handbook.js';

/**
 * Стартовый скелет справочника — то, ради чего задуман конструктор.
 * Факультет не начинает с пустого листа: он получает готовую структуру разделов
 * и страницы-заготовки с подсказками, что вписать. Заготовки создаются черновиками,
 * поэтому студенты видят только то, что редактор осознанно опубликовал.
 */

export interface TemplatePage {
  slug: string;
  title: string;
  summary: string;
  /** Подсказка редактору: что обязательно должно оказаться на странице. */
  hint: string;
  blocks?: Block[];
}

export interface TemplateSection {
  slug: string;
  title: string;
  emoji: string;
  summary: string;
  position: number;
  pages: TemplatePage[];
}

const t = (id: string, text: string): Block => ({ id, type: 'text', text });

export const HANDBOOK_TEMPLATE: TemplateSection[] = [
  {
    slug: 'pervokursniku',
    title: 'Первокурснику',
    emoji: '🎒',
    summary: 'Первые недели: куда идти, что получить, к кому обращаться',
    position: 10,
    pages: [
      {
        slug: 'chek-list-pervoy-nedeli',
        title: 'Чек-лист первой недели',
        summary: 'Всё, что нужно успеть до конца первой недели',
        hint: 'Соберите чеклист из 5–10 пунктов: пропуск, студенческий, чаты, справки, медосмотр.',
        blocks: [
          {
            id: 'c1',
            type: 'checklist',
            title: 'До конца первой недели',
            items: [
              { id: 'i1', text: 'Получить студенческий билет и зачётную книжку' },
              { id: 'i2', text: 'Оформить пропуск в корпус' },
              { id: 'i3', text: 'Вступить в чат группы и чат курса' },
              { id: 'i4', text: 'Проверить расписание и узнать номера аудиторий' },
              { id: 'i5', text: 'Узнать своего куратора и старосту' },
            ],
          },
        ],
      },
      { slug: 'slovar-terminov', title: 'Словарь терминов', summary: 'БРС, модуль, аттестация, ВКР — что это значит', hint: 'Добавьте блок «Словарь терминов» с внутренним жаргоном факультета.' },
      { slug: 'kto-est-kto', title: 'Кто есть кто', summary: 'Деканат, кураторы, староста, тьюторы', hint: 'Добавьте контакты: кто за что отвечает и когда к нему можно прийти.' },
      { slug: 'chaty-i-kanaly', title: 'Чаты и каналы', summary: 'Официальные чаты факультета в MAX', hint: 'Добавьте блоки «Чат в MAX» — только проверенные ссылки.' },
    ],
  },
  {
    slug: 'ucheba',
    title: 'Учёба',
    emoji: '📚',
    summary: 'Расписание, сессия, БРС, задолженности, практика',
    position: 20,
    pages: [
      { slug: 'raspisanie-i-korpusa', title: 'Расписание и корпуса', summary: 'Где смотреть расписание и как найти аудиторию', hint: 'Дайте ссылку на расписание и блок «Место» для каждого корпуса.' },
      { slug: 'sessiya-i-brs', title: 'Сессия и БРС', summary: 'Как считаются баллы и что нужно для допуска', hint: 'Опишите правила БРС, пороги допуска, даты сессии (блок «Срок»).' },
      {
        slug: 'akademicheskie-zadolzhennosti',
        title: 'Академические задолженности',
        summary: 'Что делать, если не сдал: сроки, попытки, комиссия',
        hint: 'Добавьте крайние сроки (блок «Срок»), контакт учебного офиса и частые вопросы: что будет при болезни, что после комиссии.',
        blocks: [
          t('d1', 'Если дисциплина не сдана вовремя, появляется академическая задолженность. По закону её можно закрыть не более чем за две попытки в течение года с момента появления: первая — у преподавателя, вторая — перед комиссией.'),
        ],
      },
      { slug: 'praktika', title: 'Практика', summary: 'Как выбрать место, какие документы сдать и когда', hint: 'Добавьте пошаговую инструкцию и сроки сдачи документов.' },
      { slug: 'perevod-i-akadem', title: 'Перевод и академический отпуск', summary: 'Смена профиля, перевод, академический отпуск', hint: 'Опишите порядок и к кому идти; приложите шаблоны заявлений.' },
    ],
  },
  {
    slug: 'spravki-i-dokumenty',
    title: 'Справки и документы',
    emoji: '📄',
    summary: 'Какие справки бывают, где заказать и сколько ждать',
    position: 30,
    pages: [
      {
        slug: 'spravka-ob-obuchenii',
        title: 'Справка об обучении',
        summary: 'Самая частая справка: где заказать и когда забрать',
        hint: 'Укажите точное место, часы приёма и срок изготовления.',
        blocks: [
          {
            id: 's1',
            type: 'steps',
            title: 'Как получить',
            items: [
              { id: 'p1', text: 'Оставить заявку в учебном офисе', hint: 'Возьмите с собой студенческий билет' },
              { id: 'p2', text: 'Дождаться уведомления о готовности' },
              { id: 'p3', text: 'Забрать справку в часы приёма' },
            ],
          },
        ],
      },
      { slug: 'spravka-v-voenkomat', title: 'Справка в военкомат', summary: 'Форма 4 и сроки', hint: 'Добавьте сроки подачи и контакт ответственного.' },
      { slug: 'vosstanovlenie-dokumentov', title: 'Потерял студенческий или зачётку', summary: 'Что делать при утере документов', hint: 'Опишите порядок восстановления и стоимость, если она есть.' },
    ],
  },
  {
    slug: 'fizkultura',
    title: 'Физкультура',
    emoji: '🏃',
    summary: 'Секции, зачёт, освобождение, спортивные залы',
    position: 40,
    pages: [
      { slug: 'kak-poluchit-zachet', title: 'Как получить зачёт', summary: 'Посещения, нормативы, отработки', hint: 'Опишите, сколько занятий нужно и как закрыть пропуски.' },
      { slug: 'sekcii-i-zaly', title: 'Секции и залы', summary: 'Куда записаться и где что находится', hint: 'Добавьте блоки «Место» с адресами залов и расписанием секций.' },
      { slug: 'osvobozhdenie', title: 'Освобождение и спецгруппа', summary: 'Какие документы нужны и куда их нести', hint: 'Укажите, какие документы принимают и до какой даты.' },
    ],
  },
  {
    slug: 'obshchezhitie',
    title: 'Общежитие',
    emoji: '🏠',
    summary: 'Заселение, оплата, пропуска, правила',
    position: 50,
    pages: [
      { slug: 'zaselenie', title: 'Заселение', summary: 'Документы, очередь, даты', hint: 'Добавьте сроки подачи (блок «Срок») и список документов.' },
      { slug: 'oplata', title: 'Оплата', summary: 'Сколько стоит и как платить', hint: 'Опишите способ оплаты и срок; не публикуйте чужие реквизиты.' },
      { slug: 'pravila-i-propusk', title: 'Правила и пропуск', summary: 'Гости, режим, что нельзя', hint: 'Коротко перечислите правила и контакт коменданта.' },
    ],
  },
  {
    slug: 'dengi',
    title: 'Деньги и поддержка',
    emoji: '💳',
    summary: 'Стипендии, материальная помощь, льготы',
    position: 60,
    pages: [
      { slug: 'stipendii', title: 'Стипендии', summary: 'Какие бывают и кому положены', hint: 'Перечислите виды стипендий и условия назначения.' },
      { slug: 'materialnaya-pomoshch', title: 'Материальная помощь', summary: 'Кому положена и как оформить', hint: 'Добавьте пошаговую инструкцию и список документов.' },
      { slug: 'lgoty-i-proezd', title: 'Льготы и проезд', summary: 'Транспортная карта, музеи, скидки', hint: 'Добавьте, где оформить льготный проезд.' },
    ],
  },
  {
    slug: 'vozmozhnosti',
    title: 'Возможности',
    emoji: '🚀',
    summary: 'Профсоюз, студсовет, олимпиады, проекты',
    position: 70,
    pages: [
      { slug: 'profsoyuz', title: 'Профсоюз', summary: 'Что даёт членство и как вступить', hint: 'Опишите, что реально получает студент, и куда идти.' },
      { slug: 'studsovet-i-aktiv', title: 'Студсовет и актив', summary: 'Кто это и как присоединиться', hint: 'Добавьте контакты и ближайшие наборы.' },
      { slug: 'olimpiady-i-proekty', title: 'Олимпиады и проекты', summary: 'Куда податься и что это даёт', hint: 'Добавьте сроки подачи заявок как блоки «Срок».' },
    ],
  },
  {
    slug: 'esli-problema',
    title: 'Если что-то случилось',
    emoji: '🆘',
    summary: 'Куда обращаться, когда непонятно или тяжело',
    position: 80,
    pages: [
      { slug: 'kuda-obratitsya', title: 'Куда обратиться', summary: 'Короткий список: кто поможет с чем', hint: 'Самая важная страница. Дайте 5–7 контактов с ясным «с чем сюда».' },
      { slug: 'propustil-zanyatiya', title: 'Пропустил занятия', summary: 'Болезнь, справка, отработки', hint: 'Опишите, какие документы принимают и в какой срок.' },
    ],
  },
];

export interface SeedOptions {
  /** true — создавать страницы-заготовки; false — только разделы. */
  withDrafts?: boolean;
  ownerPersonId?: string | null;
}

/** Все подсказки шаблона: страница-заготовка, где подсказка так и осталась текстом, не публикуется (APP-19). */
const TEMPLATE_HINTS = new Set(HANDBOOK_TEMPLATE.flatMap((section) => section.pages.map((page) => page.hint.trim())));

/**
 * Текст — нетронутая подсказка шаблона? Сравниваем с подсказками шаблона и с заметкой самой страницы
 * (при создании заготовки подсказка кладётся и в блок, и в draft_note): так узнаются и подсказки
 * из прежних версий шаблона.
 */
export function isTemplateHint(text: unknown, pageNote?: string | null): boolean {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  return TEMPLATE_HINTS.has(value) || Boolean(pageNote && value === pageNote.trim());
}

/** Разворачивает стартовый скелет в пустом справочнике. Существующие разделы не трогает. */
export async function seedTemplate(db: Db, handbookId: string, options: SeedOptions = {}): Promise<{ sections: number; pages: number }> {
  const existing = new Set((await many<{ slug: string }>(db, 'SELECT slug FROM sections WHERE handbook_id = $1', [handbookId])).map((r) => r.slug));
  let sections = 0;
  let pages = 0;
  for (const section of HANDBOOK_TEMPLATE) {
    if (existing.has(section.slug)) continue;
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO sections(handbook_id, slug, title, emoji, summary, position) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [handbookId, section.slug, section.title, section.emoji, section.summary, section.position],
    );
    sections += 1;
    if (options.withDrafts === false) continue;
    let position = 10;
    for (const page of section.pages) {
      const blocks = page.blocks ?? [t('hint', page.hint)];
      await db.query(
        `INSERT INTO pages(handbook_id, section_id, slug, title, summary, position, status, blocks, draft_title, draft_summary, draft_blocks, draft_note, owner_person_id, search_text, search_title)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', '[]'::jsonb, $4, $5, $7, $8, $9, $10, $11)
         ON CONFLICT (handbook_id, slug) DO NOTHING`,
        [
          handbookId,
          row!.id,
          page.slug,
          page.title,
          page.summary,
          position,
          JSON.stringify(blocks),
          page.hint,
          options.ownerPersonId ?? null,
          pageSearchText(page.summary, blocks),
          pageSearchTitle(page.title, section.title),
        ],
      );
      pages += 1;
      position += 10;
    }
  }
  return { sections, pages };
}
