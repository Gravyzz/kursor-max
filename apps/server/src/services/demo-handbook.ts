import type pg from 'pg';
import { one } from '../db/pool.js';
import type { Block } from '../domain/handbook.js';
import { pageSearchText, pageSearchTitle } from '../domain/handbook.js';
import { syncDeadlines } from './handbook-editor.js';
import { addDays, daysBetween } from '../domain/dates.js';

/**
 * Демо-справочник: «Модельный университет» + справочник Института информационных технологий.
 * Показывает главное: наследование (страница вуза переопределяется факультетом), адресность
 * (общежитие — только живущим в нём), сроки, чеклисты, объявления и аналитику редактора.
 * Все контакты и ссылки вымышлены.
 */

interface Page {
  slug: string;
  title: string;
  summary: string;
  blocks: Block[];
  audience?: Record<string, unknown>;
  /** Переопределяет одноимённую страницу вуза. */
  overrides?: string;
  views?: number;
  helpful?: number;
  notHelpful?: number;
  /** Для аналитики: страницу давно не проверяли. */
  staleDays?: number;
  /** Подразделение, которое отвечает за страницу общей базы. */
  ownerUnit?: string;
}

interface Section {
  slug: string;
  title: string;
  emoji: string;
  summary: string;
  position: number;
  audience?: Record<string, unknown>;
  pages: Page[];
}

const text = (id: string, value: string): Block => ({ id, type: 'text', text: value });

const AKADEM_SLUG = 'akademicheskiy-otpusk';

/** Академический отпуск в версии 1: с неё экономический факультет сделал свою версию. */
const AKADEM_V1: Block[] = [
  text('a1', 'Академический отпуск дают до двух лет: по болезни, по семейным обстоятельствам или в связи с призывом. Место и форма обучения сохраняются.'),
  {
    id: 'a2',
    type: 'steps',
    title: 'Как оформить',
    items: [
      { id: 'p1', text: 'Написать заявление на имя ректора' },
      { id: 'p2', text: 'Принести медицинское заключение в учебный офис', hint: 'Если отпуск по болезни' },
      { id: 'p3', text: 'Дождаться приказа — обычно 5 рабочих дней' },
    ],
  },
];

/** Версия 2 (14 октября): заключение загружают в личный кабинет, бумагу больше не принимают. */
const AKADEM_V2: Block[] = [
  AKADEM_V1[0]!,
  {
    id: 'a2',
    type: 'steps',
    title: 'Как оформить',
    items: [
      { id: 'p1', text: 'Написать заявление на имя ректора' },
      { id: 'p2', text: 'Загрузить медицинское заключение в личный кабинет', hint: 'Если отпуск по болезни' },
      { id: 'p3', text: 'Дождаться приказа — обычно 5 рабочих дней' },
    ],
  },
  { id: 'a3', type: 'alert', tone: 'warn', text: 'С 2026/27 учебного года заключения на бумаге не принимают.' },
];

// ─── Общеуниверситетский справочник: то, что одинаково для всех факультетов ───

const UNIVERSITY: Section[] = [
  {
    slug: 'spravki-i-dokumenty',
    title: 'Справки и документы',
    emoji: '📄',
    summary: 'Что можно заказать и сколько это занимает',
    position: 30,
    pages: [
      {
        slug: 'spravka-ob-obuchenii',
        title: 'Справка об обучении',
        summary: 'Общий порядок по университету',
        ownerUnit: 'Учебно-методическое управление',
        staleDays: 16,
        views: 180,
        helpful: 22,
        notHelpful: 6,
        blocks: [
          text('u1', 'Справка об обучении подтверждает, что вы студент: её просят в банке, на работе, в МФЦ и для льгот на проезд.'),
          {
            id: 'u2',
            type: 'steps',
            title: 'Общий порядок',
            items: [
              { id: 'p1', text: 'Оставить заявку в учебном офисе своего института' },
              { id: 'p2', text: 'Дождаться уведомления о готовности', hint: 'Обычно 3 рабочих дня' },
              { id: 'p3', text: 'Забрать справку с паспортом или студенческим' },
            ],
          },
          { id: 'u3', type: 'alert', tone: 'info', text: 'Для банка и визы просите справку с указанием периода обучения — обычной формы им обычно не хватает.' },
        ],
      },
      {
        slug: 'spravka-v-voenkomat',
        title: 'Справка в военкомат',
        summary: 'Форма 4: где взять и в какие сроки подать',
        ownerUnit: 'Отдел воинского учёта',
        staleDays: 178,
        views: 96,
        helpful: 14,
        notHelpful: 1,
        blocks: [
          text('v1', 'Справка по форме 4 подтверждает отсрочку на время обучения. Её оформляет отдел воинского учёта университета, а не деканат.'),
          {
            id: 'v2',
            type: 'contact',
            name: 'Отдел воинского учёта',
            role: 'Справки формы 4, приписные',
            room: 'Главный корпус, каб. 108',
            hours: 'Пн–Чт 10:00–16:00, перерыв 13:00–14:00',
            email: 'vu@example.edu',
          },
          { id: 'v3', type: 'checklist', title: 'Что взять с собой', items: [{ id: 'c1', text: 'Паспорт' }, { id: 'c2', text: 'Приписное свидетельство или военный билет' }, { id: 'c3', text: 'Студенческий билет' }] },
        ],
      },
      {
        slug: AKADEM_SLUG,
        title: 'Академический отпуск',
        summary: 'По болезни, семейным обстоятельствам, призыву',
        ownerUnit: 'Учебно-методическое управление',
        staleDays: 4,
        views: 74,
        helpful: 9,
        notHelpful: 1,
        blocks: AKADEM_V2,
      },
    ],
  },
  {
    slug: 'dengi',
    title: 'Деньги и поддержка',
    emoji: '💳',
    summary: 'Стипендии, материальная помощь, льготы',
    position: 60,
    pages: [
      {
        slug: 'materialnaya-pomoshch',
        title: 'Материальная помощь',
        summary: 'Разовая выплата в трудной ситуации',
        ownerUnit: 'Профком студентов',
        staleDays: 185,
        views: 210,
        helpful: 31,
        notHelpful: 3,
        blocks: [
          text('m1', 'Материальная помощь — разовая выплата студентам бюджетной формы в трудной жизненной ситуации. Решение принимает комиссия, заседания проходят раз в месяц.'),
          {
            id: 'm2',
            type: 'steps',
            title: 'Как подать',
            items: [
              { id: 'p1', text: 'Написать заявление в профкоме или учебном офисе' },
              { id: 'p2', text: 'Приложить подтверждающие документы', hint: 'Какие именно — подскажут там же, список зависит от основания' },
              { id: 'p3', text: 'Дождаться заседания комиссии', hint: 'Обычно до конца следующего месяца' },
            ],
          },
          { id: 'm3', type: 'alert', tone: 'info', text: 'Подать заявление можно несколько раз в год, но не чаще одного раза в семестр.' },
        ],
      },
      {
        slug: 'lgoty-i-proezd',
        title: 'Льготы и проезд',
        summary: 'Транспортная карта, музеи, скидки',
        ownerUnit: 'Управление по работе со студентами',
        views: 140,
        helpful: 19,
        notHelpful: 2,
        blocks: [
          {
            id: 'l1',
            type: 'steps',
            title: 'Льготный проезд',
            items: [
              { id: 'p1', text: 'Заказать транспортную карту студента через портал перевозчика' },
              { id: 'p2', text: 'Привязать номер студенческого билета' },
              { id: 'p3', text: 'Пополнять помесячно — льгота действует в учебные месяцы' },
            ],
          },
          text('l2', 'По студенческому билету бесплатный вход в городские музеи в третье воскресенье месяца и скидка в столовых всех корпусов.'),
        ],
      },
    ],
  },
];

// ─── Справочник факультета: «хитсовник» Института информационных технологий ───

const FACULTY: Section[] = [
  {
    slug: 'pervokursniku',
    title: 'Первокурснику',
    emoji: '🎒',
    summary: 'Первые недели: куда идти и к кому обращаться',
    position: 10,
    pages: [
      {
        slug: 'chek-list-pervoy-nedeli',
        title: 'Чек-лист первой недели',
        summary: 'Всё, что нужно успеть до конца первой недели',
        audience: { courses: [1] },
        views: 420,
        helpful: 64,
        notHelpful: 2,
        blocks: [
          text('h1', 'Ничего страшного, если что-то не успели: почти всё можно сделать и на второй неделе. Главное — пропуск и чат группы, без них будет неудобно.'),
          {
            id: 'h2',
            type: 'checklist',
            title: 'До конца первой недели',
            items: [
              { id: 'i1', text: 'Получить студенческий билет и зачётную книжку в учебном офисе' },
              { id: 'i2', text: 'Оформить пропуск в корпус 2' },
              { id: 'i3', text: 'Вступить в чат группы и чат курса' },
              { id: 'i4', text: 'Проверить расписание и найти аудитории заранее' },
              { id: 'i5', text: 'Узнать куратора и старосту группы' },
              { id: 'i6', text: 'Подключить университетский Wi-Fi и почту' },
              { id: 'i7', text: 'Пройти медосмотр для допуска к физкультуре' },
            ],
          },
          { id: 'h3', type: 'alert', tone: 'warn', text: 'Медосмотр — единственный пункт со сроком: без него не допустят к занятиям по физкультуре, а пропуски придётся отрабатывать.' },
        ],
      },
      {
        slug: 'kto-est-kto',
        title: 'Кто есть кто',
        summary: 'С каким вопросом к кому идти',
        views: 310,
        helpful: 48,
        notHelpful: 4,
        blocks: [
          text('k0', 'Короткое правило: бытовое и организационное — старосте и куратору, документы и справки — в учебный офис, оценки и допуск — преподавателю, конфликт и «всё сложно» — заместителю директора.'),
          { id: 'k1', type: 'contact', name: 'Учебный офис ИИТ', role: 'Справки, документы, приказы, зачётки', room: 'Корпус 2, каб. 121', hours: 'Пн–Пт 10:00–17:00, перерыв 13:00–14:00', email: 'office.iit@example.edu' },
          { id: 'k2', type: 'contact', name: 'Орлова Марина Викторовна', role: 'Заместитель директора по учебной работе', room: 'Корпус 2, каб. 124', hours: 'Вт и Чт 14:00–16:00' },
          { id: 'k3', type: 'contact', name: 'Тьюторы первого курса', role: 'Вопросы «как здесь всё устроено»', hours: 'Отвечают в чате курса' },
        ],
      },
      {
        slug: 'slovar-terminov',
        title: 'Словарь терминов',
        summary: 'БРС, модуль, аттестация, ВКР и другие слова',
        views: 265,
        helpful: 41,
        notHelpful: 1,
        blocks: [
          {
            id: 'g1',
            type: 'glossary',
            items: [
              { id: 't1', term: 'БРС', meaning: 'Балльно-рейтинговая система: баллы за работу в семестре, из них складывается допуск и итоговая оценка.' },
              { id: 't2', term: 'Аттестация', meaning: 'Промежуточная проверка в середине семестра. Не экзамен, но её результат видят в учебном офисе.' },
              { id: 't3', term: 'Хвост', meaning: 'Разговорное название академической задолженности — несданной дисциплины.' },
              { id: 't4', term: 'Допуск', meaning: 'Минимум баллов и выполненных работ, без которого не пустят на экзамен или зачёт.' },
              { id: 't5', term: 'ВКР', meaning: 'Выпускная квалификационная работа, она же диплом.' },
              { id: 't6', term: 'Учебный офис', meaning: 'То, что в других вузах называют деканатом: документы, справки, приказы.' },
            ],
          },
        ],
      },
      {
        slug: 'chaty-i-kanaly',
        title: 'Чаты и каналы',
        summary: 'Официальные чаты института в MAX',
        views: 198,
        helpful: 27,
        notHelpful: 3,
        blocks: [
          text('c0', 'Всё важное дублируется в чате курса. Если вас добавили в чат, которого нет в этом списке, — он неофициальный.'),
          { id: 'c1', type: 'chat', title: 'ИИТ · Объявления', url: 'https://max.ru/join/iit-news-demo', note: 'Только объявления, писать нельзя' },
          { id: 'c2', type: 'chat', title: 'ИИТ · Первый курс', url: 'https://max.ru/join/iit-course1-demo', note: 'Вопросы и взаимопомощь' },
          { id: 'c3', type: 'chat', title: 'Студсовет ИИТ', url: 'https://max.ru/join/iit-studsovet-demo' },
        ],
      },
    ],
  },
  {
    slug: 'ucheba',
    title: 'Учёба',
    emoji: '📚',
    summary: 'Расписание, БРС, сессия, задолженности, практика',
    position: 20,
    pages: [
      {
        slug: 'sessiya-i-brs',
        title: 'Сессия и БРС',
        summary: 'Как считаются баллы и что нужно для допуска',
        views: 380,
        helpful: 52,
        notHelpful: 9,
        blocks: [
          text('b1', 'За семестр по каждой дисциплине можно набрать 100 баллов: 60 за работу в семестре и 40 за экзамен. Допуск к экзамену — от 30 баллов и все лабораторные сданы.'),
          {
            id: 'b2',
            type: 'faq',
            items: [
              { id: 'f1', question: 'Что если не хватает баллов для допуска?', answer: 'До конца семестра можно добрать баллы отработками — сроки назначает преподаватель. После начала сессии добрать уже нельзя.' },
              { id: 'f2', question: 'Можно ли пересдать на оценку выше?', answer: 'Нет. Пересдача существует только для закрытия задолженности, а не для улучшения оценки.' },
              { id: 'f3', question: 'Где смотреть свои баллы?', answer: 'В личном кабинете, раздел «Успеваемость». Преподаватель обязан выставить баллы до конца зачётной недели.' },
            ],
          },
          { id: 'b3', type: 'deadline', title: 'Зимняя сессия', startsOn: '2027-01-11', endsOn: '2027-01-30', remindDays: [7, 1] },
        ],
      },
      {
        slug: 'akademicheskie-zadolzhennosti',
        title: 'Академические задолженности',
        summary: 'Не сдал вовремя: сроки, попытки, комиссия',
        views: 455,
        helpful: 71,
        notHelpful: 5,
        blocks: [
          text('z1', 'Если дисциплина не сдана в сессию, появляется академическая задолженность. По закону закрыть её можно не больше чем за две попытки в течение года с момента появления: первая — у преподавателя, вторая — перед комиссией.'),
          {
            id: 'z2',
            type: 'steps',
            title: 'Что делать',
            items: [
              { id: 'p1', text: 'Узнать крайний срок в учебном офисе или в личном кабинете', hint: 'Он указан в приказе о ликвидации задолженностей' },
              { id: 'p2', text: 'Договориться с преподавателем о дате первой пересдачи' },
              { id: 'p3', text: 'Если не сдал — записаться на комиссию до крайнего срока', hint: 'Это последняя попытка по закону' },
            ],
          },
          { id: 'z5', type: 'contact', name: 'Учебный офис ИИТ', role: 'Сроки ликвидации задолженностей, направления на пересдачу', room: 'Корпус 2, каб. 121', hours: 'Пн–Пт 10:00–17:00' },
          {
            id: 'z3',
            type: 'faq',
            items: [
              { id: 'f1', question: 'Сгорает ли попытка, если я заболел?', answer: 'Нет. Принесите справку в учебный офис — неявка по уважительной причине попытку не расходует.' },
              { id: 'f2', question: 'Что делать, если не сдал комиссию?', answer: 'Это крайний случай: попытки исчерпаны. Сразу идите в учебный офис — возможны академический отпуск или перевод на другой профиль.' },
            ],
          },
          { id: 'z4', type: 'alert', tone: 'warn', text: 'Не тяните до последней недели: преподаватели назначают пересдачи заранее, а крайний срок продлить нельзя.' },
        ],
      },
      {
        slug: 'raspisanie-i-korpusa',
        title: 'Расписание и корпуса',
        summary: 'Где смотреть расписание и как не заблудиться',
        views: 290,
        helpful: 33,
        notHelpful: 7,
        staleDays: 200,
        blocks: [
          { id: 'r1', type: 'link', title: 'Расписание ИИТ', url: 'https://example.edu/schedule/iit', note: 'Обновляется по понедельникам' },
          { id: 'r2', type: 'place', title: 'Корпус 2 — основной корпус института', address: 'ул. Университетская, 12', howTo: 'Вход со стороны сквера, по пропуску. Аудитории 1хх — первый этаж, 2хх — второй.' },
          { id: 'r3', type: 'place', title: 'Спорткомплекс', address: 'ул. Университетская, 18', howTo: '7 минут пешком от корпуса 2, мимо столовой.' },
          text('r4', 'Первая цифра номера аудитории — этаж. Если аудитория начинается с «О» — занятие онлайн, ссылка приходит в чат курса.'),
        ],
      },
      {
        slug: 'praktika',
        title: 'Практика',
        summary: 'Как выбрать место и какие документы сдать',
        audience: { courses: [2, 3, 4] },
        views: 160,
        helpful: 18,
        notHelpful: 6,
        blocks: [
          {
            id: 'pr1',
            type: 'steps',
            title: 'Порядок',
            items: [
              { id: 'p1', text: 'Выбрать место из списка партнёров или найти своё' },
              { id: 'p2', text: 'Согласовать руководителя практики от института' },
              { id: 'p3', text: 'Принести договор в учебный офис до начала практики' },
              { id: 'p4', text: 'Сдать отчёт и отзыв руководителя в течение двух недель после окончания' },
            ],
          },
          { id: 'pr2', type: 'deadline', title: 'Сдать договор на практику', startsOn: '2027-04-15', remindDays: [14, 3] },
        ],
      },
    ],
  },
  {
    slug: 'spravki-i-dokumenty',
    title: 'Справки и документы',
    emoji: '📄',
    summary: 'Справки, зачётка, потерянные документы',
    position: 30,
    pages: [
      {
        slug: 'vosstanovlenie-dokumentov',
        title: 'Потерял студенческий или зачётку',
        summary: 'Что делать и сколько это займёт',
        views: 120,
        helpful: 15,
        notHelpful: 4,
        blocks: [
          {
            id: 'd1',
            type: 'steps',
            title: 'Порядок',
            items: [
              { id: 'p1', text: 'Написать заявление на восстановление в каб. 121' },
              { id: 'p2', text: 'Дождаться приказа', hint: 'До 10 рабочих дней' },
              { id: 'p3', text: 'Получить дубликат' },
            ],
          },
          text('d2', 'Пока дубликата нет, для прохода в корпус в бюро пропусков выдают временный пропуск на две недели.'),
        ],
      },
    ],
  },
  {
    slug: 'fizkultura',
    title: 'Физкультура',
    emoji: '🏃',
    summary: 'Зачёт, секции, освобождение',
    position: 40,
    pages: [
      {
        slug: 'kak-poluchit-zachet',
        title: 'Как получить зачёт',
        summary: 'Посещения, нормативы, отработки',
        views: 395,
        helpful: 44,
        notHelpful: 12,
        blocks: [
          text('f1', 'Зачёт ставят за посещения и нормативы: нужно не меньше 80% занятий за семестр. Занятия в секции засчитываются как посещения.'),
          {
            id: 'f2',
            type: 'faq',
            items: [
              { id: 'q1', question: 'Пропустил занятия — что делать?', answer: 'Отработки проходят по субботам в зале 1 с 10:00. Одна отработка закрывает одно занятие, записываться не нужно.' },
              { id: 'q2', question: 'Занимаюсь в своём клубе, это считается?', answer: 'Да, если принести справку из клуба с расписанием. Оформляют в каб. 3 спорткомплекса.' },
            ],
          },
          { id: 'f3', type: 'alert', tone: 'warn', text: 'Отработки закрываются за две недели до конца семестра — в последнюю неделю закрыть пропуски уже нельзя.' },
        ],
      },
      {
        slug: 'sekcii-i-zaly',
        title: 'Секции и залы',
        summary: 'Куда записаться и где что находится',
        views: 175,
        helpful: 21,
        notHelpful: 3,
        blocks: [
          text('se1', 'Записаться в секцию можно в любой момент семестра, места есть почти всегда. Волейбол и настольный теннис — самые свободные.'),
          { id: 'se2', type: 'place', title: 'Спорткомплекс', address: 'ул. Университетская, 18', howTo: 'Зал 1 — игровые виды, зал 2 — тренажёрный, бассейн — цокольный этаж.' },
          { id: 'se3', type: 'contact', name: 'Кузнецов Павел Сергеевич', role: 'Кафедра физического воспитания, запись в секции', room: 'Спорткомплекс, каб. 3', hours: 'Пн–Пт 12:00–17:00' },
        ],
      },
      {
        slug: 'osvobozhdenie',
        title: 'Освобождение и спецгруппа',
        summary: 'Какие документы нужны и куда их нести',
        views: 145,
        helpful: 17,
        notHelpful: 5,
        blocks: [
          text('o1', 'Освобождение и перевод в специальную медицинскую группу оформляет кафедра физвоспитания на основании заключения из студенческой поликлиники. Само освобождение зачёт не заменяет: вместо нормативов сдаётся реферат и теоретический зачёт.'),
          { id: 'o2', type: 'deadline', title: 'Сдать документы на спецгруппу', startsOn: '2026-10-01', endsOn: '2026-10-15', remindDays: [7, 2] },
        ],
      },
    ],
  },
  {
    slug: 'obshchezhitie',
    title: 'Общежитие',
    emoji: '🏠',
    summary: 'Заселение, оплата, пропуска, правила',
    position: 50,
    audience: { dorm: true },
    pages: [
      {
        slug: 'zaselenie',
        title: 'Заселение',
        summary: 'Документы, очередь, даты',
        audience: { dorm: true },
        views: 230,
        helpful: 29,
        notHelpful: 8,
        blocks: [
          {
            id: 'zs1',
            type: 'checklist',
            title: 'Документы для заселения',
            items: [
              { id: 'i1', text: 'Паспорт и копия первой страницы с пропиской' },
              { id: 'i2', text: 'Медицинская справка формы 086/у' },
              { id: 'i3', text: 'Флюорография не старше года' },
              { id: 'i4', text: 'Две фотографии 3×4' },
              { id: 'i5', text: 'Договор найма, подписанный в двух экземплярах' },
            ],
          },
          { id: 'zs2', type: 'deadline', title: 'Подать заявление на место в общежитии', startsOn: '2026-10-05', endsOn: '2026-10-20', remindDays: [7, 2] },
          { id: 'zs3', type: 'place', title: 'Общежитие № 3', address: 'ул. Студенческая, 7', howTo: 'Комендант — комната 101, слева от входа.' },
        ],
      },
      {
        slug: 'oplata-i-pravila',
        title: 'Оплата и правила',
        summary: 'Сколько платить, до какого числа и что нельзя',
        audience: { dorm: true },
        views: 190,
        helpful: 22,
        notHelpful: 6,
        blocks: [
          text('op1', 'Оплата вносится до 10 числа каждого месяца через личный кабинет. Квитанция появляется там же первого числа.'),
          { id: 'op2', type: 'deadline', title: 'Оплата общежития за месяц', startsOn: '2026-10-10', remindDays: [3, 1] },
          {
            id: 'op3',
            type: 'faq',
            items: [
              { id: 'q1', question: 'Можно ли позвать гостей?', answer: 'Да, до 22:00 и с записью в журнале на вахте. Гость оставляет документ.' },
              { id: 'q2', question: 'Уезжаю на каникулы — платить?', answer: 'Если написать заявление на временное выбытие до отъезда, месяц не начисляется.' },
            ],
          },
          { id: 'op4', type: 'contact', name: 'Комендант общежития № 3', room: 'Общежитие № 3, комната 101', hours: 'Пн–Пт 9:00–18:00' },
        ],
      },
    ],
  },
  {
    slug: 'vozmozhnosti',
    title: 'Возможности',
    emoji: '🚀',
    summary: 'Профсоюз, студсовет, олимпиады и проекты',
    position: 70,
    pages: [
      {
        slug: 'profsoyuz',
        title: 'Профсоюз',
        summary: 'Что реально даёт членство',
        views: 155,
        helpful: 16,
        notHelpful: 9,
        blocks: [
          text('pf1', 'Взнос — 1% от стипендии. Взамен: путёвки со скидкой, материальная помощь через профком (рассматривают быстрее), юридическая консультация и билеты на городские мероприятия.'),
          { id: 'pf2', type: 'contact', name: 'Профком студентов', room: 'Главный корпус, каб. 12', hours: 'Пн–Пт 11:00–17:00' },
          { id: 'pf3', type: 'alert', tone: 'info', text: 'Членство добровольное. Если вступили и передумали — заявление о выходе принимают в любой момент.' },
        ],
      },
      {
        slug: 'olimpiady-i-proekty',
        title: 'Олимпиады и проекты',
        summary: 'Куда податься и что это даёт',
        views: 135,
        helpful: 14,
        notHelpful: 4,
        blocks: [
          text('ol1', 'Победа в олимпиаде по профилю даёт баллы к портфолио при поступлении в магистратуру, а участие в проектной лаборатории засчитывается как практика.'),
          { id: 'ol2', type: 'deadline', title: 'Заявки на студенческую олимпиаду', startsOn: '2026-11-01', endsOn: '2026-11-20', remindDays: [7, 1] },
          { id: 'ol3', type: 'link', title: 'Проектные лаборатории ИИТ', url: 'https://example.edu/iit/labs' },
        ],
      },
    ],
  },
  {
    slug: 'esli-problema',
    title: 'Если что-то случилось',
    emoji: '🆘',
    summary: 'Куда обращаться, когда непонятно или тяжело',
    position: 80,
    pages: [
      {
        slug: 'kuda-obratitsya',
        title: 'Куда обратиться',
        summary: 'Короткий список: кто с чем помогает',
        views: 275,
        helpful: 39,
        notHelpful: 2,
        blocks: [
          text('ku0', 'Если не знаете, с чего начать, — начните со старосты или куратора. Это не «беспокоить»: они для этого и есть.'),
          { id: 'ku1', type: 'contact', name: 'Учебный офис ИИТ', role: 'Документы, справки, пропуски занятий', room: 'Корпус 2, каб. 121', hours: 'Пн–Пт 10:00–17:00' },
          { id: 'ku2', type: 'contact', name: 'Психологическая служба университета', role: 'Бесплатно и конфиденциально, по записи', room: 'Главный корпус, каб. 7', hours: 'Пн–Пт 10:00–18:00' },
          { id: 'ku3', type: 'contact', name: 'Студенческая поликлиника', role: 'Справки о болезни, медосмотр', room: 'ул. Университетская, 20', hours: 'Пн–Пт 8:00–19:00' },
          { id: 'ku4', type: 'alert', tone: 'info', text: 'Не нашли, к кому идти, — спросите прямо в чате бота: вопрос уйдёт дежурному по справочнику, ответ придёт сюда же.' },
        ],
      },
      {
        slug: 'propustil-zanyatiya',
        title: 'Пропустил занятия',
        summary: 'Болезнь, справка, отработки',
        views: 205,
        helpful: 24,
        notHelpful: 7,
        blocks: [
          {
            id: 'pz1',
            type: 'steps',
            title: 'Если болели',
            items: [
              { id: 'p1', text: 'Предупредить старосту в первый день' },
              { id: 'p2', text: 'Взять справку в поликлинике' },
              { id: 'p3', text: 'Принести справку в каб. 121 в течение трёх дней после выхода', hint: 'Позже справку могут не принять' },
            ],
          },
          text('pz2', 'Справка снимает пропуски, но не отменяет задания: по каждой дисциплине нужно договориться с преподавателем об отработке.'),
        ],
      },
    ],
  },
];

async function insertHandbook(
  client: pg.PoolClient,
  input: { universityId: string; instituteId: string | null; parentId: string | null; slug: string; title: string; subtitle: string; emoji: string; settings?: Record<string, unknown> },
): Promise<string> {
  const row = await one<{ id: string }>(
    client,
    `INSERT INTO handbooks(university_id, institute_id, parent_id, slug, title, subtitle, emoji, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::jsonb, '{}'::jsonb)) RETURNING id`,
    [input.universityId, input.instituteId, input.parentId, input.slug, input.title, input.subtitle, input.emoji, input.settings ? JSON.stringify(input.settings) : null],
  );
  return row!.id;
}

/**
 * Даты в демо написаны от 24 сентября 2026. В любой следующий день все сроки сдвигаются на прошедшее время,
 * чтобы «Ближайшие сроки» и напоминания в демо всегда были впереди — и на проверке, и на финале.
 */
const DEMO_BASE_DATE = '2026-09-24';

export function demoDateShift(today = new Date().toISOString().slice(0, 10)): number {
  return Math.max(0, daysBetween(DEMO_BASE_DATE, today));
}

export function shiftDemoBlocks(blocks: Block[], days: number): Block[] {
  if (days === 0) return blocks;
  const shift = (date: string | undefined) => (date ? addDays(date, days) : date);
  return blocks.map((block) => {
    if (block.type === 'deadline') return { ...block, startsOn: shift(block.startsOn)!, endsOn: shift(block.endsOn) };
    if (block.type === 'alert') return { ...block, endsOn: shift(block.endsOn) };
    if (block.type === 'checklist') return { ...block, items: block.items.map((item) => ({ ...item, dueOn: shift(item.dueOn) })) };
    return block;
  });
}

async function insertSections(client: pg.PoolClient, handbookId: string, sections: Section[], ownerPersonId: string | null, owners: Record<string, string> = {}) {
  const pageIds = new Map<string, string>();
  const days = demoDateShift();
  for (const section of sections) {
    const sectionRow = await one<{ id: string }>(
      client,
      `INSERT INTO sections(handbook_id, slug, title, emoji, summary, position, audience)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb)) RETURNING id`,
      [handbookId, section.slug, section.title, section.emoji, section.summary, section.position, section.audience ? JSON.stringify(section.audience) : null],
    );
    let position = 10;
    for (const source of section.pages) {
      const page = { ...source, blocks: shiftDemoBlocks(source.blocks, days) };
      const row = await one<{ id: string }>(
        client,
        `INSERT INTO pages(handbook_id, section_id, slug, title, summary, audience, position, status, blocks,
                           owner_person_id, views, helpful, not_helpful, search_text, search_title, published_at, checked_at, review_at,
                           owner_unit, version_no)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb), $7, 'published', $8, $9, $10, $11, $12, $13, $15,
                 now() - make_interval(days => $14), now() - make_interval(days => $14), (now() + make_interval(days => 180 - $14))::date,
                 $16, 1)
         RETURNING id`,
        [
          handbookId, sectionRow!.id, page.slug, page.title, page.summary,
          page.audience ? JSON.stringify(page.audience) : null, position,
          JSON.stringify(page.blocks), (page.ownerUnit && owners[page.ownerUnit]) || ownerPersonId,
          page.views ?? 0, page.helpful ?? 0, page.notHelpful ?? 0,
          pageSearchText(page.summary, page.blocks),
          page.staleDays ?? 20,
          pageSearchTitle(page.title, section.title),
          page.ownerUnit ?? null,
        ],
      );
      // Версия 1 в истории: с ней сверяются свои версии факультетов
      await client.query(
        `INSERT INTO page_versions(page_id, title, summary, blocks, author_person_id, version_no, created_at)
         VALUES ($1, $2, $3, $4, $5, 1, now() - make_interval(days => $6))`,
        [row!.id, page.title, page.summary, JSON.stringify(page.blocks), (page.ownerUnit && owners[page.ownerUnit]) || ownerPersonId, page.staleDays ?? 20],
      );
      pageIds.set(page.slug, row!.id);
      await syncDeadlines(client, handbookId, row!.id, page.blocks);
      position += 10;
    }
  }
  return pageIds;
}

export interface DemoHandbookResult {
  handbookId: string;
  slug: string;
  universityHandbookId: string;
}

export async function createDemoHandbook(
  client: pg.PoolClient,
  input: { universityId: string; instituteId: string; editorPersonId: string; deanPersonId: string; readerPersonIds: string[]; economicsModelUsers?: number[]; adminModelUsers?: number[] },
): Promise<DemoHandbookResult> {
  // У каждой песочницы свои слаги: диплинк hb_<слаг> должен вести ровно в один справочник
  const suffix = input.universityId.replace(/-/g, '').slice(0, 8);
  const universityHandbookId = await insertHandbook(client, {
    universityId: input.universityId,
    instituteId: null,
    parentId: null,
    slug: `mu-demo-${suffix}`,
    title: 'Общая база',
    subtitle: 'Единые инструкции · Модельный университет',
    emoji: '🏛',
  });
  // Ответственные за общие страницы — сотрудники подразделений университета (модельные, без аккаунтов MAX)
  const staff = async (fullName: string) =>
    (await one<{ id: string }>(
      client,
      "INSERT INTO persons(university_id, institute_id, role, full_name) VALUES ($1, NULL, 'staff', $2) RETURNING id",
      [input.universityId, fullName],
    ))!.id;
  const orlova = await staff('Орлова Марина Викторовна');
  const kim = await staff('Ким Алексей Сергеевич');
  const owners: Record<string, string> = {
    'Учебно-методическое управление': orlova,
    'Отдел воинского учёта': await staff('Лебедев Павел Андреевич'),
    'Профком студентов': await staff('Сафина Алия Рустемовна'),
    'Управление по работе со студентами': kim,
  };
  const basePages = await insertSections(client, universityHandbookId, UNIVERSITY, input.deanPersonId, owners);
  await client.query("UPDATE pages SET backup_owner_person_id = $2 WHERE handbook_id = $1 AND owner_unit = 'Учебно-методическое управление'", [universityHandbookId, kim]);
  // «Академический отпуск» обновили 14 октября: версия 1 — прежний порядок, версия 2 — личный кабинет
  const akadem = basePages.get(AKADEM_SLUG)!;
  await client.query("UPDATE page_versions SET blocks = $2, note = NULL WHERE page_id = $1 AND version_no = 1", [akadem, JSON.stringify(shiftDemoBlocks(AKADEM_V1, demoDateShift()))]);
  await client.query(
    `INSERT INTO page_versions(page_id, title, summary, blocks, author_person_id, note, version_no, created_at)
     VALUES ($1, 'Академический отпуск', 'По болезни, семейным обстоятельствам, призыву', $2, $3, 'Справку из поликлиники теперь загружают в личный кабинет', 2, now() - interval '4 days')`,
    [akadem, JSON.stringify(AKADEM_V2), orlova],
  );
  await client.query("UPDATE pages SET version_no = 2, published_at = now() - interval '4 days' WHERE id = $1", [akadem]);

  const handbookId = await insertHandbook(client, {
    universityId: input.universityId,
    instituteId: input.instituteId,
    parentId: universityHandbookId,
    slug: `iit-demo-${suffix}`,
    title: 'Справочник ИИТ',
    subtitle: 'Институт информационных технологий',
    emoji: '💻',
    settings: {
      dutyContact: 'Учебный офис ИИТ, корпус 2, каб. 121',
      synonyms: { каб: 'кабинет', лаба: 'лабораторная работа', лабы: 'лабораторная работа', вышка: 'высшая математика' },
    },
  });
  const facultyPages = await insertSections(client, handbookId, FACULTY, input.editorPersonId);
  // Страницы, которые студент ИИТ видит: свои и общие (для журнала поиска и объявлений)
  const pages = new Map([...basePages, ...facultyPages]);

  // Уточнение ИИТ к общей «Справке об обучении»: общая часть не копируется, кабинет выдачи — свой
  await insertSupplement(client, handbookId, basePages.get('spravka-ob-obuchenii')!, 'u2', input.deanPersonId, [
    { id: 's1', type: 'place', title: 'Где забрать справку в ИИТ', address: 'Корпус 2, каб. 214', howTo: 'Пн–пт 10:00–17:00. Готовность — по сообщению в чате учебного офиса.' },
  ]);

  await client.query(
    "INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'editor') ON CONFLICT DO NOTHING",
    [handbookId, input.deanPersonId, input.editorPersonId],
  );
  // Постоянный администратор ИИТ: в роли «Университет» посетитель смотрит справочник факультета со стороны,
  // а сообщения «общая страница обновилась» получает деканат ИИТ
  const iitAdmin = (await one<{ id: string }>(
    client,
    "INSERT INTO persons(university_id, institute_id, role, full_name, user_id) VALUES ($1, $2, 'dean', 'Сидоров Павел Андреевич', $3) RETURNING id",
    [input.universityId, input.instituteId, input.adminModelUsers?.[0] ?? null],
  ))!.id;
  await client.query("INSERT INTO org_roles(person_id, university_id, institute_id, role) VALUES ($1, $2, $3, 'faculty_admin')", [iitAdmin, input.universityId, input.instituteId]);
  await client.query("INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, 'admin')", [handbookId, iitAdmin]);

  // Страница на проверке: видно, как работает цикл «черновик → ревью → публикация»
  const reviewSection = await one<{ id: string }>(client, "SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'ucheba'", [handbookId]);
  if (reviewSection) {
    const draftBlocks: Block[] = [
      text('n1', 'С этого семестра заявление на перевод внутри института подаётся через личный кабинет, приносить бумагу в каб. 121 больше не нужно.'),
      {
        id: 'n2',
        type: 'steps',
        title: 'Как перевестись на другой профиль',
        items: [
          { id: 'p1', text: 'Подать заявление в личном кабинете до 20 числа' },
          { id: 'p2', text: 'Дождаться решения аттестационной комиссии' },
          { id: 'p3', text: 'Досдать разницу в учебных планах, если она есть' },
        ],
      },
    ];
    await client.query(
      `INSERT INTO pages(handbook_id, section_id, slug, title, summary, position, status, review_requested_at, blocks,
                         draft_title, draft_summary, draft_blocks, draft_note, owner_person_id, search_text)
       VALUES ($1, $2, 'perevod-na-drugoy-profil', 'Перевод на другой профиль', 'Сроки и порядок внутри института', 50, 'review', now(), '[]'::jsonb,
               'Перевод на другой профиль', 'Сроки и порядок внутри института', $3, 'Проверьте даты — уточняла в учебном офисе', $4, '')`,
      [handbookId, reviewSection.id, JSON.stringify(draftBlocks), input.editorPersonId],
    );
  }

  // Объявление на главной
  await client.query(
    `INSERT INTO announcements(handbook_id, title, body, audience, page_id, starts_on, ends_on, created_by)
     VALUES ($1, 'Отработки по физкультуре закрываются через две недели',
             'После этого закрыть пропуски за семестр будет нельзя. Отработки — по субботам в 10:00, зал 1.',
             '{}'::jsonb, $2, current_date - 2, current_date + 12, $3)`,
    [handbookId, pages.get('kak-poluchit-zachet') ?? null, input.deanPersonId],
  );

  // Живой след: что искали, что открывали, что не нашли — из этого редактор видит пробелы
  const readers: string[] = [];
  for (const personId of input.readerPersonIds.slice(0, 12)) {
    const row = await one<{ id: string; user_id: number }>(
      client,
      `INSERT INTO handbook_readers(handbook_id, user_id, person_id, course, dorm, last_seen_at)
       SELECT $1, p.user_id, p.id, g.course, ($2::int % 3 = 0), now() - make_interval(hours => $2)
         FROM persons p LEFT JOIN groups g ON g.id = p.group_id
        WHERE p.id = $3 AND p.user_id IS NOT NULL
       ON CONFLICT (handbook_id, user_id) DO NOTHING
       RETURNING id, user_id`,
      [handbookId, readers.length + 1, personId],
    );
    if (row) readers.push(row.id);
  }

  const found: Array<[string, string]> = [
    ['как получить справку', 'spravka-ob-obuchenii'],
    ['справка об обучении', 'spravka-ob-obuchenii'],
    ['физра отработки', 'kak-poluchit-zachet'],
    ['когда сессия', 'sessiya-i-brs'],
    ['хвосты пересдача', 'akademicheskie-zadolzhennosti'],
    ['общага оплата', 'oplata-i-pravila'],
    ['матпомощь', 'materialnaya-pomoshch'],
    ['брс баллы', 'sessiya-i-brs'],
  ];
  const missing = ['военная кафедра', 'где распечатать', 'перевод на бюджет', 'стажировка летом', 'вернуть деньги за общежитие'];
  let minutes = 40;
  for (let i = 0; i < 26; i += 1) {
    const reader = readers.length ? readers[i % readers.length]! : null;
    minutes += 53;
    if (i % 4 === 3) {
      const query = missing[i % missing.length]!;
      await client.query(
        `INSERT INTO search_log(handbook_id, reader_id, query, normalized, results, source, created_at)
         VALUES ($1, $2, $3, $3, 0, $4, now() - make_interval(mins => $5))`,
        [handbookId, reader, query, i % 2 === 0 ? 'bot' : 'app', minutes],
      );
      continue;
    }
    const [query, slug] = found[i % found.length]!;
    await client.query(
      `INSERT INTO search_log(handbook_id, reader_id, query, normalized, results, opened_page_id, source, created_at)
       VALUES ($1, $2, $3, $3, 3, $4, $5, now() - make_interval(mins => $6))`,
      [handbookId, reader, query, pages.get(slug) ?? null, i % 3 === 0 ? 'bot' : 'app', minutes],
    );
  }

  // Открытые вопросы дежурному — очередь редактора на главной
  const questions: Array<[string, string | null]> = [
    ['Есть ли у нас военная кафедра и как туда попасть?', 'военная кафедра'],
    ['Где в корпусе 2 можно распечатать документы?', 'где распечатать'],
    ['Можно ли перевестись с платного на бюджет и когда?', 'перевод на бюджет'],
  ];
  for (let i = 0; i < questions.length; i += 1) {
    const [text_, query] = questions[i]!;
    const reader = readers[i % Math.max(readers.length, 1)] ?? null;
    await client.query(
      `INSERT INTO handbook_questions(handbook_id, reader_id, user_id, text, query, created_at)
       SELECT $1, $2, r.user_id, $3, $4, now() - make_interval(hours => $5)
         FROM handbook_readers r WHERE r.id = $2`,
      [handbookId, reader, text_, query, (i + 1) * 5],
    );
  }

  // Отвеченные вопросы: из них считается метрика пилота «время ответа дежурного»
  const answered: Array<[string, string, number, number]> = [
    ['Во сколько открывается читальный зал?', 'Читальный зал в корпусе 2: пн–пт 9:00–20:00, сб 10:00–16:00.', 30, 2],
    ['Можно ли сдать справку для военкомата в электронном виде?', 'Нет, военкомат принимает только бумажную справку с печатью — заказывайте её в учебном офисе.', 52, 4],
    ['Где взять студенческий, если ещё не выдали?', 'Временную справку выдаёт учебный офис ИИТ, каб. 121, по паспорту.', 75, 6],
    ['Когда начисляют стипендию первокурсникам?', 'Первая стипендия приходит в конце сентября, дальше — до 25-го числа каждого месяца.', 98, 19],
  ];
  for (let i = 0; i < answered.length; i += 1) {
    const [text_, answer, hoursAgo, answerHours] = answered[i]!;
    const reader = readers[(i + 3) % Math.max(readers.length, 1)] ?? null;
    await client.query(
      `INSERT INTO handbook_questions(handbook_id, reader_id, user_id, text, status, answer, answered_by, answered_at, created_at)
       SELECT $1, $2, r.user_id, $3, 'answered', $4, $5, now() - make_interval(hours => $6::int - $7::int), now() - make_interval(hours => $6::int)
         FROM handbook_readers r WHERE r.id = $2`,
      [handbookId, reader, text_, answer, input.deanPersonId, hoursAgo, answerHours],
    );
  }

  // Оценки полезности: по ним видно слабые страницы
  for (let i = 0; i < readers.length; i += 1) {
    const slug = i % 5 === 0 ? 'profsoyuz' : i % 3 === 0 ? 'kak-poluchit-zachet' : 'chek-list-pervoy-nedeli';
    const pageId = pages.get(slug);
    if (!pageId) continue;
    await client.query(
      `INSERT INTO page_feedback(page_id, reader_id, helpful, comment)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [pageId, readers[i]!, slug !== 'profsoyuz', slug === 'profsoyuz' && i === 0 ? 'Непонятно, сколько именно взнос и как его платить' : null],
    );
  }

  await createEconomicsFaculty(client, {
    universityId: input.universityId,
    suffix,
    baseHandbookId: universityHandbookId,
    basePages,
    modelUsers: input.economicsModelUsers ?? [],
    adminUser: input.adminModelUsers?.[1] ?? null,
  });

  return { handbookId, slug: `iit-demo-${suffix}`, universityHandbookId };
}

/** Уточнение факультета к общей странице, сразу опубликованное. */
async function insertSupplement(client: pg.PoolClient, handbookId: string, basePageId: string, anchor: string | null, ownerPersonId: string, blocks: Block[]) {
  await client.query(
    `INSERT INTO page_supplements(handbook_id, base_page_id, anchor_block_id, blocks, status, owner_person_id, search_text, published_at, checked_at, updated_at)
     VALUES ($1, $2, $3, $4, 'published', $5, $6, now() - interval '1 day', now() - interval '1 day', now() - interval '1 day')`,
    [handbookId, basePageId, anchor, JSON.stringify(blocks), ownerPersonId, pageSearchText(null, blocks)],
  );
}

// ─── Второй факультет: экономический. Общие процедуры те же, отличия — уточнением и своей версией ───

const ECONOMICS: Section[] = [
  {
    slug: 'ucheba',
    title: 'Учёба',
    emoji: '🎓',
    summary: 'Сессия, пересдачи, кафедры',
    position: 20,
    pages: [
      {
        slug: 'peresdachi',
        title: 'Пересдачи и комиссии',
        summary: 'Как записаться на пересдачу в ЭФ',
        views: 64,
        helpful: 8,
        notHelpful: 1,
        blocks: [
          text('e1', 'На экономическом факультете пересдачи проходят по графику кафедр, вторая пересдача — только комиссией.'),
          {
            id: 'e2',
            type: 'steps',
            title: 'Как записаться',
            items: [
              { id: 'p1', text: 'Посмотреть график пересдач на стенде деканата или в чате курса' },
              { id: 'p2', text: 'Записаться у методиста кафедры не позже чем за два дня' },
              { id: 'p3', text: 'Прийти со студенческим и зачётной книжкой' },
            ],
          },
        ],
      },
      {
        slug: 'kontakty-dekanata',
        title: 'Контакты деканата',
        summary: 'Кабинет 305, часы приёма',
        views: 51,
        helpful: 7,
        notHelpful: 0,
        blocks: [
          { id: 'k1', type: 'contact', name: 'Деканат ЭФ', role: 'Справки, заявления, академические вопросы', room: 'Корпус 5, каб. 305', hours: 'Пн–чт 9:30–16:30, пятница — неприёмный день', email: 'ef@example.edu' },
        ],
      },
    ],
  },
];

async function createEconomicsFaculty(
  client: pg.PoolClient,
  input: { universityId: string; suffix: string; baseHandbookId: string; basePages: Map<string, string>; modelUsers: number[]; adminUser?: number | null },
) {
  const institute = (await one<{ id: string }>(
    client,
    "INSERT INTO institutes(university_id, name, short_name) VALUES ($1, 'Экономический факультет', 'ЭФ') RETURNING id",
    [input.universityId],
  ))!.id;
  const person = async (role: 'dean' | 'staff', fullName: string) =>
    (await one<{ id: string }>(
      client,
      'INSERT INTO persons(university_id, institute_id, role, full_name) VALUES ($1, $2, $3, $4) RETURNING id',
      [input.universityId, institute, role, fullName],
    ))!.id;
  const belova = await person('dean', 'Белова Нина Игоревна');
  if (input.adminUser) await client.query('UPDATE persons SET user_id = $2 WHERE id = $1', [belova, input.adminUser]);
  const gusev = await person('staff', 'Гусев Денис Олегович');
  await client.query(
    `INSERT INTO org_roles(person_id, university_id, institute_id, role, created_at)
     VALUES ($1, $3, $4, 'faculty_admin', now() - interval '14 days'), ($2, $3, $4, 'faculty_admin', now() - interval '3 days')`,
    [belova, gusev, input.universityId, institute],
  );
  // Приглашение второму администратору ещё не открыто — его видно на обзоре университета
  await client.query(
    `INSERT INTO invites(code, person_id, created_at, expires_at) VALUES ($1, $2, now() - interval '3 days', now() + interval '27 days')`,
    [`H-EF${input.suffix.slice(0, 2).toUpperCase()}-${input.suffix.slice(2, 6).toUpperCase()}`, gusev],
  );
  const handbookId = await insertHandbook(client, {
    universityId: input.universityId,
    instituteId: institute,
    parentId: input.baseHandbookId,
    slug: `ef-demo-${input.suffix}`,
    title: 'Справочник ЭФ',
    subtitle: 'Экономический факультет',
    emoji: '📈',
    settings: { dutyContact: 'Деканат ЭФ, корпус 5, каб. 305' },
  });
  await client.query("INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, 'admin')", [handbookId, belova]);
  const pages = await insertSections(client, handbookId, ECONOMICS, belova);
  await client.query("UPDATE handbooks SET created_at = now() - interval '14 days' WHERE id = $1", [handbookId]);

  // Своё уточнение к той же общей справке: другой кабинет и часы выдачи
  await insertSupplement(client, handbookId, input.basePages.get('spravka-ob-obuchenii')!, null, belova, [
    { id: 's1', type: 'place', title: 'Выдача справок на экономическом', address: 'Корпус 5, деканат, каб. 305', howTo: 'Пн–чт 9:30–16:30, в пятницу выдачи нет.' },
  ]);

  // Своя версия «Академического отпуска», сделанная 11 сентября из версии 1. Общую с тех пор обновили — версия ЭФ отстала
  const docs = (await one<{ id: string }>(
    client,
    "INSERT INTO sections(handbook_id, slug, title, emoji, summary, position) VALUES ($1, 'spravki-i-dokumenty', 'Справки и документы', '📄', 'Справки и заявления', 30) RETURNING id",
    [handbookId],
  ))!.id;
  const ownBlocks: Block[] = [
    AKADEM_V1[0]!,
    {
      id: 'a2',
      type: 'steps',
      title: 'Как оформить на экономическом',
      items: [
        { id: 'p1', text: 'Написать заявление на имя ректора и согласовать его с деканом' },
        { id: 'p2', text: 'Принести медицинское заключение в деканат ЭФ, каб. 305', hint: 'Если отпуск по болезни' },
        { id: 'p3', text: 'Дождаться приказа — обычно 5 рабочих дней' },
      ],
    },
  ];
  await client.query(
    `INSERT INTO pages(handbook_id, section_id, slug, title, summary, position, status, blocks, owner_person_id, inherited_from, base_version,
                       override_reason, version_no, search_text, search_title, published_at, checked_at, review_at)
     VALUES ($1, $2, $3, 'Академический отпуск', 'Порядок на экономическом факультете', 30, 'published', $4, $5, $6, 1,
             'Заявление согласует декан, документы принимает деканат ЭФ', 1, $7, $8,
             now() - interval '37 days', now() - interval '37 days', (now() + interval '143 days')::date)`,
    [handbookId, docs, AKADEM_SLUG, JSON.stringify(ownBlocks), belova, input.basePages.get(AKADEM_SLUG), pageSearchText(null, ownBlocks), pageSearchTitle('Академический отпуск', 'Справки и документы')],
  );

  // Немного жизни: читатели и запросы, чтобы метрики университета не были пустыми
  const readers: string[] = [];
  for (const [i, userId] of input.modelUsers.slice(0, 6).entries()) {
    const row = await one<{ id: string }>(
      client,
      `INSERT INTO handbook_readers(handbook_id, user_id, course, last_seen_at) VALUES ($1, $2, 1, now() - make_interval(hours => $3))
       ON CONFLICT (handbook_id, user_id) DO NOTHING RETURNING id`,
      [handbookId, userId, i + 2],
    );
    if (row) readers.push(row.id);
  }
  const queries: Array<[string, number, string | null]> = [
    ['справка об обучении', 2, input.basePages.get('spravka-ob-obuchenii') ?? null],
    ['пересдача', 1, pages.get('peresdachi') ?? null],
    ['академ', 1, null],
    ['где деканат', 1, pages.get('kontakty-dekanata') ?? null],
    ['стажировка в банке', 0, null],
  ];
  for (const [i, [query, results, opened]] of queries.entries()) {
    await client.query(
      `INSERT INTO search_log(handbook_id, reader_id, query, normalized, results, opened_page_id, source, created_at)
       VALUES ($1, $2, $3, $3, $4, $5, 'app', now() - make_interval(hours => $6))`,
      [handbookId, readers[i % Math.max(readers.length, 1)] ?? null, query, results, opened, (i + 1) * 7],
    );
  }
}
