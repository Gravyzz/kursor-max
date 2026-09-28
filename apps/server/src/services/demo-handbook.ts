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
          { id: 'u3', type: 'alert', tone: 'info', text: 'В институтах порядок может отличаться — смотрите страницу своего факультета.' },
        ],
      },
      {
        slug: 'spravka-v-voenkomat',
        title: 'Справка в военкомат',
        summary: 'Форма 4: где взять и в какие сроки подать',
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
        slug: 'spravka-ob-obuchenii',
        title: 'Справка об обучении',
        summary: 'В ИИТ — через чат учебного офиса, без личного визита за заявкой',
        overrides: 'spravka-ob-obuchenii',
        views: 340,
        helpful: 58,
        notHelpful: 2,
        blocks: [
          text('s0', 'В нашем институте заявку принимают в чате учебного офиса — приходить дважды не нужно.'),
          {
            id: 's1',
            type: 'steps',
            title: 'Как получить',
            items: [
              { id: 'p1', text: 'Написать в чат учебного офиса: ФИО, группа, куда нужна справка' },
              { id: 'p2', text: 'Дождаться ответа «готова»', hint: 'Обычно на следующий рабочий день' },
              { id: 'p3', text: 'Забрать в каб. 121 со студенческим билетом' },
            ],
          },
          { id: 's2', type: 'chat', title: 'Учебный офис ИИТ', url: 'https://max.ru/join/iit-office-demo', note: 'Отвечают в рабочие дни до 17:00' },
          { id: 's3', type: 'alert', tone: 'info', text: 'Для банка и визы просите «справку с указанием периода обучения» — обычной формы им обычно не хватает.' },
        ],
      },
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

async function insertSections(client: pg.PoolClient, handbookId: string, sections: Section[], ownerPersonId: string | null) {
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
                           owner_person_id, views, helpful, not_helpful, search_text, search_title, published_at, checked_at, review_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::jsonb, '{}'::jsonb), $7, 'published', $8, $9, $10, $11, $12, $13, $15,
                 now() - make_interval(days => $14), now() - make_interval(days => $14), (now() + make_interval(days => 180 - $14))::date)
         RETURNING id`,
        [
          handbookId, sectionRow!.id, page.slug, page.title, page.summary,
          page.audience ? JSON.stringify(page.audience) : null, position,
          JSON.stringify(page.blocks), ownerPersonId,
          page.views ?? 0, page.helpful ?? 0, page.notHelpful ?? 0,
          pageSearchText(page.summary, page.blocks),
          page.staleDays ?? 20,
          pageSearchTitle(page.title, section.title),
        ],
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
  input: { universityId: string; instituteId: string; editorPersonId: string; deanPersonId: string; readerPersonIds: string[] },
): Promise<DemoHandbookResult> {
  // У каждой песочницы свои слаги: диплинк hb_<слаг> должен вести ровно в один справочник
  const suffix = input.universityId.replace(/-/g, '').slice(0, 8);
  const universityHandbookId = await insertHandbook(client, {
    universityId: input.universityId,
    instituteId: null,
    parentId: null,
    slug: `mu-demo-${suffix}`,
    title: 'Модельный университет',
    subtitle: 'Общее для всех институтов',
    emoji: '🏛',
  });
  await insertSections(client, universityHandbookId, UNIVERSITY, input.deanPersonId);

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
  const pages = await insertSections(client, handbookId, FACULTY, input.editorPersonId);

  // Переопределение страницы вуза: та же тема, но порядок в институте свой
  const override = pages.get('spravka-ob-obuchenii');
  const parentPage = await one<{ id: string }>(
    client,
    "SELECT id FROM pages WHERE handbook_id = $1 AND slug = 'spravka-ob-obuchenii'",
    [universityHandbookId],
  );
  if (override && parentPage) {
    await client.query('UPDATE pages SET inherited_from = $2 WHERE id = $1', [override, parentPage.id]);
  }

  await client.query(
    "INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'editor') ON CONFLICT DO NOTHING",
    [handbookId, input.deanPersonId, input.editorPersonId],
  );

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

  return { handbookId, slug: `iit-demo-${suffix}`, universityHandbookId };
}
