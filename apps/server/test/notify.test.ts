/**
 * Бот и уведомления: что видит студент в чате.
 * Экранирование пользовательского текста, вопрос дежурному из чата, кнопка редактора, сброс демо,
 * перепроверка уведомлений перед отправкой (объявления, напоминания о сроках) и очередь при двух worker.
 * Бот проверяется настоящими обработчиками (registerHandlers) с подменённым API MAX.
 * Запуск: TEST_DATABASE_URL=postgres://user:pass@host:5432/db node --import tsx --test test/notify.test.ts
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = process.env.TEST_NOTIFY_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const BOT_TOKEN = 'notify-test-token';
const BOT_ID = 900002;
Object.assign(process.env, {
  NODE_ENV: 'test',
  // Без базы работают только проверки экранирования: подключение к базе ленивое
  DATABASE_URL: DB_URL ?? 'postgres://unused:unused@127.0.0.1:1/unused',
  BOT_TOKEN,
  APP_SECRET: 'notify-app-secret-0123456789abcdef',
  DEV_AUTH: 'false',
  LOG_LEVEL: 'silent',
  APP_TIMEZONE: 'Europe/Moscow',
  BOT_USERNAME: 'notify_test_bot',
  BOT_USER_ID: String(BOT_ID),
  DEMO_ENABLED: 'true',
  MINIAPP_BUTTON: 'open_app',
});

/** Как текст выглядит для человека: без невидимых пробелов и с исходными знаками вместо похожих. */
const LOOKS_LIKE: Record<string, string> = { '∗': '*', '∼': '~', 'ˋ': '`', 'ˍ': '_' };
const visible = (text: string) => text.replace(/​/g, '').replace(/[∗∼ˋˍ]/g, (char) => LOOKS_LIKE[char] ?? char);

describe('текст пользователя в сообщениях бота', () => {
  let md: typeof import('../src/notify/render.js')['md'];
  before(async () => {
    md = (await import('../src/notify/render.js')).md;
  });

  it('ссылки, почта, телефоны и упоминания остаются рабочими', () => {
    const samples = [
      'https://forms.example.edu/spravka_en?lang=en#top',
      'Анкета: https://forms.example.edu/a_b/c_d?x=1&y=(2)#part_3 — до пятницы',
      'www.example.edu/rules_2026',
      'office_iit@example.edu',
      'Пишите на office_iit@example.edu или dekanat+iit@mail.example.edu',
      '+7 (495) 123-45-67 (без выходных)',
      'Телефон учебного офиса: 8 (3822) 52-98-00, доб. 2#',
      'Староста — @anna_ivanova, чат — @iit_2026.',
      'Файл snake_case_name.pdf лежит в папке 2026_осень',
    ];
    for (const sample of samples) assert.equal(md(sample), sample, sample);
  });

  it('разметка из пользовательского текста не срабатывает, а на вид текст прежний', () => {
    const cases: Array<[string, RegExp]> = [
      ['**форма 4** обязательна', /\*/],
      ['__важно__ и _курсив_', /(^|[\s(])_|_($|[\s).,])/],
      ['~~отменено~~', /~/],
      ['`код` и ```блок```', /`/],
      ['++подчёркнуто++', /\+\+/],
      ['^^выделено^^', /\^\^/],
      ['[жми сюда](https://evil.example/login)', /\]\(/],
      ['[жми][1]\n[1]: https://evil.example', /\][[:]/],
      ['# Заголовок', /^[ \t]*#/m],
      ['> цитата', /^[ \t]*>/m],
      ['Текст\n===', /^[ \t]*=+[ \t]*$/m],
      ['Текст\n---', /^[ \t]*-+[ \t]*$/m],
      ['<b>жирный</b> <https://evil.example>', /<[a-z/]/i],
      ['\\*не экранировать\\*', /\\[*\\]/],
    ];
    for (const [input, markup] of cases) {
      const out = md(input);
      assert.doesNotMatch(out, markup, `${JSON.stringify(input)} → ${JSON.stringify(out)}`);
      assert.equal(visible(out), input, 'на вид текст не меняется');
    }
    assert.equal(md(null), '');
    assert.equal(md(''), '');
  });
});

describe('бот и уведомления', { skip: !DB_URL && 'TEST_DATABASE_URL не задан' }, () => {
  let m: {
    pool: typeof import('../src/db/pool.js')['pool'];
    migrate: typeof import('../src/db/migrate.js')['migrate'];
    identity: typeof import('../src/services/identity.js');
    demo: typeof import('../src/services/demo.js');
    handbook: typeof import('../src/services/handbook.js');
    editor: typeof import('../src/services/handbook-editor.js');
    outbox: typeof import('../src/notify/outbox.js');
    render: typeof import('../src/notify/render.js');
    worker: typeof import('../src/worker/index.js');
    bot: typeof import('../src/bot/index.js');
    dates: typeof import('../src/domain/dates.js');
    maxApi: typeof import('@maxhub/max-bot-api');
  };
  type UserRow = import('../src/services/identity.js').UserRow;
  type Scope = import('../src/services/handbook-editor.js').EditorScope;
  let student: UserRow;
  let ids: import('../src/services/demo.js').DemoSandbox;
  let admin: Scope;
  let studentCtx: import('../src/services/handbook.js').HandbookContext;
  let timezone: string;
  const identity = { username: 'notify_test_bot', userId: BOT_ID, name: 'Курсор' };

  const q = async <T>(sql: string, values: unknown[] = []) => (await m.pool.query(sql, values)).rows as T[];
  const day = async (offset: number) =>
    (await q<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date + $2::int, 'YYYY-MM-DD') AS d`, [timezone, offset]))[0]!.d;

  // ----- worker с подменённой отправкой в MAX -----
  type Send = (userId: number, text: string) => Promise<{ body: { mid: string } }>;
  const fakeBot = (send: Send) =>
    ({ api: { sendMessageToUser: send, getMyInfo: async () => ({ username: identity.username, user_id: BOT_ID }) } }) as unknown as import('@maxhub/max-bot-api').Bot;
  /** Оставить в очереди только эти уведомления и сделать их готовыми к отправке. */
  const onlyDue = async (notificationIds: number[]) => {
    await m.pool.query("UPDATE notifications SET status = 'cancelled' WHERE status = 'pending' AND NOT (id = ANY($1::bigint[]))", [notificationIds]);
    await m.pool.query(
      "UPDATE notifications SET status = 'pending', attempts = 0, claimed_at = NULL, send_after = now() - interval '1 second' WHERE id = ANY($1::bigint[])",
      [notificationIds],
    );
  };
  const row = async (id: number) =>
    (await q<{ status: string; attempts: number; send_after: Date; max_message_id: string | null; last_error: string | null }>(
      'SELECT status, attempts, send_after, max_message_id, last_error FROM notifications WHERE id = $1',
      [id],
    ))[0]!;
  const prepare = async (id: number) => {
    const [n] = await q<{ id: number; kind: string; payload: Record<string, unknown>; person_id: string | null; reader_id: string | null; dedupe_key: string | null }>(
      'SELECT id, kind, payload, person_id, reader_id, dedupe_key FROM notifications WHERE id = $1',
      [id],
    );
    return m.render.prepareNotification(m.pool, { ...n!, role: 'reader' }, identity);
  };
  const toStudent = (kind: 'handbook_announcement', payload: Record<string, unknown>, dedupeKey: string) =>
    m.outbox.enqueueToReader(m.pool, {
      readerId: studentCtx.reader.id,
      userId: student.id,
      universityId: ids.universityId,
      kind,
      payload,
      dedupeKey,
    }).then((id) => id!);

  // ----- бот с подменённым API MAX -----
  interface Sent { userId: number; text: string; buttons: Array<{ text: string; type: string; payload?: string }> }
  const sent: Sent[] = [];
  const answers: Array<{ callbackId: string; notification?: string }> = [];
  let bot: import('@maxhub/max-bot-api').Bot;
  let seq = 0;
  const chatOf = (uid: number) => 700_000 + uid;
  const person = (uid: number) => ({ user_id: uid, first_name: 'Тест', name: 'Тест', is_bot: false, last_activity_time: Date.now() });
  const record = (userId: number, text: string, extra?: { attachments?: Array<{ payload?: { buttons?: Sent['buttons'][] } }> }) => {
    sent.push({ userId, text, buttons: (extra?.attachments ?? []).flatMap((a) => (a.payload?.buttons ?? []).flat()) });
    return { body: { mid: `out.${++seq}` } };
  };
  const deliver = async (update: Record<string, unknown>) => {
    const before = sent.length;
    await (bot as unknown as { handleUpdate(update: unknown): Promise<void> }).handleUpdate(update);
    return sent.slice(before);
  };
  const say = (uid: number, text: string | null, extra: { chatType?: string; attachments?: unknown[] } = {}) =>
    deliver({
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        sender: person(uid),
        recipient: { chat_id: chatOf(uid), chat_type: extra.chatType ?? 'dialog', user_id: BOT_ID },
        timestamp: Date.now(),
        body: { mid: `in.${++seq}`, seq, text, attachments: extra.attachments ?? [] },
      },
    });
  const press = async (uid: number, payload: string, extra: { chatType?: string } = {}) => {
    const callbackId = `cb.${++seq}`;
    const out = await deliver({
      update_type: 'message_callback',
      timestamp: Date.now(),
      callback: { timestamp: Date.now(), callback_id: callbackId, payload, user: person(uid) },
      message: {
        sender: { user_id: BOT_ID, name: 'Курсор', is_bot: true },
        recipient: { chat_id: chatOf(uid), chat_type: extra.chatType ?? 'dialog', user_id: uid },
        timestamp: Date.now(),
        body: { mid: `out.old.${++seq}`, seq, text: '…', attachments: [] },
      },
    });
    return { out, answers: answers.filter((a) => a.callbackId === callbackId).map((a) => a.notification) };
  };
  const startBot = (uid: number, payload: string | null) =>
    deliver({ update_type: 'bot_started', timestamp: Date.now() + ++seq, chat_id: chatOf(uid), user: person(uid), payload });
  const button = (messages: Sent[], label: string) => messages.flatMap((msg) => msg.buttons).find((b) => b.text === label);
  const questions = async (userId: number) =>
    (await q<{ text: string }>('SELECT text FROM handbook_questions WHERE user_id = $1 ORDER BY created_at', [userId])).map((r) => r.text);

  before(async () => {
    m = {
      pool: (await import('../src/db/pool.js')).pool,
      migrate: (await import('../src/db/migrate.js')).migrate,
      identity: await import('../src/services/identity.js'),
      demo: await import('../src/services/demo.js'),
      handbook: await import('../src/services/handbook.js'),
      editor: await import('../src/services/handbook-editor.js'),
      outbox: await import('../src/notify/outbox.js'),
      render: await import('../src/notify/render.js'),
      worker: await import('../src/worker/index.js'),
      bot: await import('../src/bot/index.js'),
      dates: await import('../src/domain/dates.js'),
      maxApi: await import('@maxhub/max-bot-api'),
    };
    await m.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await m.migrate();
    // Адресат уведомлений — владелец демо-песочницы: в демо настоящие сообщения получает только он,
    // остальным доставка имитируется (API-6), и worker их не отправлял бы в MAX вовсе
    student = await m.identity.upsertUser(m.pool, { id: 626262, first_name: 'Пётр', last_name: 'Студентов' });
    ids = await m.demo.createDemoSandbox(student, 'student');
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    // Действия деканата — от записи деканата песочницы
    admin = { handbook, role: 'admin', personId: ids.deanId, userId: student.id };
    timezone = (await q<{ timezone: string }>('SELECT timezone FROM universities WHERE id = $1', [ids.universityId]))[0]!.timezone;
    studentCtx = (await m.handbook.contextFor(student, { handbookId: ids.handbookId }))!;
    studentCtx = { ...studentCtx, reader: await m.handbook.updateProfile(m.pool, studentCtx.reader, { course: 1, reminders: true }) };

    bot = new m.maxApi.Bot(BOT_TOKEN, { clientOptions: { baseUrl: 'http://127.0.0.1:9' } });
    Object.assign(bot.api, {
      sendMessageToChat: async (chatId: number, text: string, extra?: never) => record(chatId - 700_000, text, extra),
      sendMessageToUser: async (userId: number, text: string, extra?: never) => record(userId, text, extra),
      answerOnCallback: async (callbackId: string, extra?: { notification?: string }) => {
        answers.push({ callbackId, notification: extra?.notification });
        return { success: true };
      },
    });
    m.bot.registerHandlers(bot);
  });

  after(async () => {
    await m?.pool.end();
  });

  it('ответ дежурного и объявление: ссылка, почта и телефон доходят целыми, разметка не срабатывает', async () => {
    const question = await m.handbook.askQuestion(m.pool, studentCtx, 'Можно ли получить справку на английском?', 'справка английский');
    const reply = [
      'Можно: заполните **форму 4** на https://forms.example.edu/spravka_en?lang=en#top',
      'Вопросы — office_iit@example.edu или +7 (495) 123-45-67 (без выходных).',
      '[Не ссылка](https://evil.example)',
    ].join('\n');
    await m.editor.answerQuestion(m.pool, admin, question.id, reply, null);
    const [answer] = await q<{ id: number }>("SELECT id FROM notifications WHERE kind = 'handbook_answer' AND user_id = $1 ORDER BY id DESC LIMIT 1", [student.id]);
    const prepared = await prepare(answer!.id);
    assert.equal(prepared.action, 'send');
    const text = prepared.action === 'send' ? prepared.message.text : '';
    for (const verbatim of ['https://forms.example.edu/spravka_en?lang=en#top', 'office_iit@example.edu', '+7 (495) 123-45-67 (без выходных)']) {
      assert.ok(text.includes(verbatim), `в сообщении нет «${verbatim}»:\n${text}`);
    }
    assert.ok(!text.includes('**форму 4**') && !text.includes(']('), 'разметка из ответа не срабатывает');
    assert.match(text, /^💬 Ответ на ваш вопрос — \*\*/, 'своя разметка бота остаётся');

    const announcement = await m.editor.announce(m.pool, admin, {
      title: 'Приём заявлений (до 20.10)',
      body: 'Форма: https://forms.example.edu/zayavlenie_2026#start, телефон +7 (3822) 12-34-56.',
      notify: false,
    });
    const id = await toStudent('handbook_announcement', { announcementId: announcement.id }, `test:escape:${announcement.id}`);
    const ann = await prepare(id);
    assert.equal(ann.action, 'send');
    const annText = ann.action === 'send' ? ann.message.text : '';
    assert.ok(annText.includes('**Приём заявлений (до 20.10)**'), annText);
    assert.ok(annText.includes('https://forms.example.edu/zayavlenie_2026#start') && annText.includes('+7 (3822) 12-34-56'), annText);
  });

  it('страницу вернули на доработку: автору — причина и кнопка редактора, устаревшее не уходит (C2)', async () => {
    const [section] = await q<{ id: string }>("SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'ucheba'", [ids.handbookId]);
    const page = await m.editor.createPage(m.pool, admin, {
      sectionId: section!.id,
      title: 'Перевод на бюджет',
      blocks: [{ id: 't1', type: 'text', text: 'Раз в семестр освобождаются бюджетные места.' }],
    });
    // Вид handbook_return ставит сервер (returnPage) и отмечает возврат в returned_at; здесь делаем так же
    await m.pool.query('UPDATE pages SET returned_at = now() WHERE id = $1', [page.id]);
    const id = (await m.outbox.enqueue(m.pool, {
      personId: ids.editorIds[0]!,
      kind: 'handbook_return' as never,
      payload: { pageId: page.id, handbookId: ids.handbookId, note: 'Добавьте **срок** и форму https://forms.example.edu/budget_2026#top' },
    }))!;
    const prepared = await prepare(id);
    assert.equal(prepared.action, 'send');
    const text = prepared.action === 'send' ? prepared.message.text : '';
    assert.match(text, /^↩️ Страницу вернули на доработку — \*\*Справочник ИИТ\*\*\n\*\*Перевод на бюджет\*\*/);
    assert.ok(text.includes('https://forms.example.edu/budget_2026#top') && !text.includes('**срок**'), text);
    assert.doesNotMatch(text, /опубликованную/, 'черновик студенты не видели');
    const buttons = prepared.action === 'send' ? prepared.message.attachments.flatMap((a) => a.payload.buttons.flat()) : [];
    assert.deepEqual(buttons.map((b) => [b.text, 'payload' in b ? b.payload : null]), [['Открыть в редакторе', `hbe_${page.id}`]]);

    await m.pool.query("UPDATE pages SET status = 'review' WHERE id = $1", [page.id]);
    assert.equal((await prepare(id)).action, 'skip', 'страницу уже снова отправили на проверку');
    await m.pool.query("UPDATE pages SET status = 'published', review_requested_at = NULL WHERE id = $1", [page.id]);
    const published = await prepare(id);
    assert.ok(published.action === 'send' && /прежнюю опубликованную версию/.test(published.message.text));
    await m.pool.query("UPDATE pages SET status = 'archived' WHERE id = $1", [page.id]);
    assert.equal((await prepare(id)).action, 'skip', 'страницу убрали в архив');
  });

  it('объявление приходит, даже если читатель выключил напоминания о сроках (APP-22)', async () => {
    const announcement = await m.editor.announce(m.pool, admin, { title: 'Библиотека до 20:00', body: 'С понедельника читальный зал работает дольше.', notify: false });
    await m.handbook.updateProfile(m.pool, studentCtx.reader, { reminders: false });
    try {
      const id = await toStudent('handbook_announcement', { announcementId: announcement.id }, `hb_ann:${announcement.id}:${studentCtx.reader.id}`);
      await onlyDue([id]);
      const delivered: string[] = [];
      await m.worker.dispatchDue(fakeBot(async (_userId, text) => (delivered.push(text), { body: { mid: 'mid-app22' } })), async () => undefined);
      assert.equal((await row(id)).status, 'sent', 'флажок «Напоминать о сроках» — только про сроки');
      assert.ok(delivered.some((text) => text.includes('Библиотека до 20:00')));
    } finally {
      await m.handbook.updateProfile(m.pool, studentCtx.reader, { reminders: true });
    }
  });

  it('объявление с будущей датой начала не уходит раньше, а откладывается до 10:00 дня начала (WRK-1)', async () => {
    const today = await day(0);
    const later = await day(5);
    const announcement = await m.editor.announce(m.pool, admin, { title: 'Дни карьеры', body: 'Ярмарка вакансий в главном корпусе.', startsOn: today, notify: false });
    const id = await toStudent('handbook_announcement', { announcementId: announcement.id }, `hb_ann:${announcement.id}:${studentCtx.reader.id}`);
    // Дату начала перенесли, а уведомление уже пора отправлять (например, его поставили раньше переноса)
    await m.pool.query('UPDATE announcements SET starts_on = $2 WHERE id = $1', [announcement.id, later]);
    await onlyDue([id]);
    const prepared = await prepare(id);
    assert.equal(prepared.action, 'defer');
    const until = m.dates.zonedToUtc(later, '10:00', timezone);
    assert.equal(prepared.action === 'defer' ? prepared.until.getTime() : 0, until.getTime());

    const delivered: string[] = [];
    const recorder = fakeBot(async (_userId, text) => (delivered.push(text), { body: { mid: `mid-wrk1-${delivered.length}` } }));
    await m.worker.dispatchDue(recorder, async () => undefined);
    let state = await row(id);
    assert.equal(delivered.length, 0, 'в чат объявление не ушло');
    assert.equal(state.status, 'pending', 'осталось в очереди');
    assert.equal(state.send_after.getTime(), until.getTime(), 'ждёт 10:00 дня начала');
    assert.equal(state.attempts, 0, 'откладывание — не неудачная попытка');

    // Дата начала наступила — уходит
    await m.pool.query('UPDATE announcements SET starts_on = $2 WHERE id = $1', [announcement.id, today]);
    await onlyDue([id]);
    await m.worker.dispatchDue(recorder, async () => undefined);
    state = await row(id);
    assert.equal(state.status, 'sent');
    assert.ok(delivered.some((text) => text.includes('Дни карьеры')));
  });

  it('напоминание о сроке перепроверяется перед отправкой: аудитория, раздел, справочник, дата (WRK-3)', async () => {
    const [section] = await q<{ id: string }>("SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'ucheba'", [ids.handbookId]);
    const due = await day(3);
    const page = await m.editor.createPage(m.pool, admin, {
      sectionId: section!.id,
      title: 'Заселение первого курса',
      blocks: [{ id: 'w3', type: 'deadline', title: 'Заселение первого курса', startsOn: due, remindDays: [3, 1], audience: { courses: [1] } }],
    });
    await m.editor.publishPage(m.pool, admin, page.id);
    await m.worker.enqueueDeadlineReminders();
    const [reminder] = await q<{ id: number; dedupe_key: string }>(
      `SELECT n.id, n.dedupe_key FROM notifications n JOIN handbook_deadlines dl ON dl.id::text = n.payload->>'deadlineId'
        WHERE dl.page_id = $1 AND n.user_id = $2`,
      [page.id, student.id],
    );
    assert.ok(reminder, 'первокурснику поставлено напоминание');
    const [deadline] = await q<{ id: string }>('SELECT id FROM handbook_deadlines WHERE page_id = $1', [page.id]);
    const expect = async (action: 'send' | 'skip', why: string) => assert.equal((await prepare(reminder!.id)).action, action, why);

    const fresh = await prepare(reminder!.id);
    assert.ok(fresh.action === 'send' && /Заселение первого курса\*\* — через 3 дня/.test(fresh.message.text), 'пока всё в силе — уходит');

    // Читатель перешёл на второй курс, пока напоминание ждало 10:00
    await m.handbook.updateProfile(m.pool, studentCtx.reader, { course: 2 });
    await expect('skip', 'срок больше не касается читателя');
    await onlyDue([reminder!.id]);
    const delivered: string[] = [];
    await m.worker.dispatchDue(fakeBot(async (_userId, text) => (delivered.push(text), { body: { mid: 'mid-wrk3' } })), async () => undefined);
    assert.equal((await row(reminder!.id)).status, 'skipped');
    assert.equal(delivered.length, 0, 'второкурснику ничего не ушло');
    await m.handbook.updateProfile(m.pool, studentCtx.reader, { course: 1 });
    await expect('send', 'снова первый курс');

    const flip = async (sql: string, undo: string, values: unknown[], why: string) => {
      await m.pool.query(sql, values);
      try {
        await expect('skip', why);
      } finally {
        await m.pool.query(undo, values);
      }
      await expect('send', `после отмены: ${why}`);
    };
    await flip('UPDATE sections SET visible = false WHERE id = $1', 'UPDATE sections SET visible = true WHERE id = $1', [section!.id], 'раздел скрыт');
    await flip("UPDATE handbooks SET status = 'archived' WHERE id = $1", "UPDATE handbooks SET status = 'active' WHERE id = $1", [ids.handbookId], 'справочник в архиве');
    await flip(
      "UPDATE handbook_deadlines SET starts_on = starts_on + 7 WHERE id = $1",
      "UPDATE handbook_deadlines SET starts_on = starts_on - 7 WHERE id = $1",
      [deadline!.id],
      'срок перенесли — о новой дате напомнит новое напоминание',
    );
    await flip("UPDATE handbook_deadlines SET remind_days = '{1}' WHERE id = $1", "UPDATE handbook_deadlines SET remind_days = '{3,1}' WHERE id = $1", [deadline!.id], 'за 3 дня больше не напоминаем');
    await flip("UPDATE pages SET audience = '{\"courses\":[4]}' WHERE id = $1", "UPDATE pages SET audience = '{}' WHERE id = $1", [page.id], 'страницу сузили до 4 курса');
    await flip('UPDATE handbook_readers SET reminders = false WHERE id = $1', 'UPDATE handbook_readers SET reminders = true WHERE id = $1', [studentCtx.reader.id], 'напоминания выключены');
  });

  it('два worker: чужая строка не перезаписывается, зависшие возвращаются только после порога (WRK-4)', async () => {
    assert.ok(m.worker.STALE_SENDING_MINUTES * 60_000 > 25 * m.worker.SEND_TIMEOUT_MS, 'порог возврата больше, чем пачка × таймаут');
    const announcement = await m.editor.announce(m.pool, admin, { title: 'Собрание старост', body: 'В четверг в 15:00, ауд. 214.', notify: false });
    const first = await toStudent('handbook_announcement', { announcementId: announcement.id }, 'test:wrk4:1');
    const second = await toStudent('handbook_announcement', { announcementId: announcement.id }, 'test:wrk4:2');
    await onlyDue([first, second]);
    await m.pool.query("UPDATE notifications SET send_after = now() - interval '2 minutes' WHERE id = $1", [first]);

    // Worker A забрал пачку и завис на первом сообщении: MAX не отвечает
    let release!: () => void;
    const hang = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const fromA: string[] = [];
    const runA = m.worker.dispatchDue(
      fakeBot(async (_userId, text) => {
        fromA.push(text);
        entered();
        await hang;
        return { body: { mid: 'mid-A' } };
      }),
      async () => undefined,
    );
    await inside;

    // Живую пачку не трогаем, даже если проверки по расписанию запустил другой экземпляр
    await m.worker.runScheduledChecks();
    assert.equal((await row(first)).status, 'sending');
    assert.equal((await row(second)).status, 'sending');

    // Прошло больше порога: процесс A считается упавшим, строки возвращаются в очередь и уходят через B
    await m.pool.query("UPDATE notifications SET claimed_at = claimed_at - interval '31 minutes' WHERE id = ANY($1::bigint[])", [[first, second]]);
    await m.worker.runScheduledChecks();
    assert.equal((await row(first)).status, 'pending');
    assert.equal((await row(second)).status, 'pending');
    await m.pool.query("UPDATE notifications SET status = 'cancelled' WHERE status = 'pending' AND NOT (id = ANY($1::bigint[]))", [[first, second]]);
    let fromB = 0;
    await m.worker.dispatchDue(fakeBot(async () => ({ body: { mid: `mid-B-${++fromB}` } })), async () => undefined);
    assert.equal((await row(first)).status, 'sent');
    assert.equal((await row(second)).status, 'sent');
    const sentByB = [(await row(first)).max_message_id, (await row(second)).max_message_id];

    // A «отвис»: его итог не перезаписывает строку B, а вторую строку пачки он уже не отправляет
    release();
    await runA;
    assert.equal(fromA.length, 1, 'A не отправил строку, которую уже отправил B');
    assert.deepEqual([(await row(first)).max_message_id, (await row(second)).max_message_id], sentByB, 'итог B не перезаписан');
    assert.equal((await row(first)).status, 'sent');
  });

  it('бот: «Спросить дежурного» можно отменить кнопкой, повторное нажатие не шлёт вторую подсказку (BOT-2)', async () => {
    const uid = student.max_user_id;
    const found = await say(uid, 'справка');
    const ask = button(found, 'Это не то, что я искал') ?? button(found, 'Спросить дежурного');
    assert.equal(ask?.payload, 'hb:q', 'под ответом — кнопка вопроса дежурному');

    const prompt = await press(uid, 'hb:q');
    assert.equal(prompt.out.length, 1);
    assert.match(prompt.out[0]!.text, /Напишите вопрос одним сообщением/);
    assert.equal(button(prompt.out, 'Отмена')?.payload, 'hb:q:cancel');
    const again = await press(uid, 'hb:q');
    assert.equal(again.out.length, 0, 'вторая подсказка не приходит');
    assert.match(again.answers.join(), /Жду ваш вопрос/);

    const cancelled = await press(uid, 'hb:q:cancel');
    assert.match(cancelled.out[0]?.text ?? '', /вопрос дежурному не отправляю/);
    const search = await say(uid, 'справка в военкомат');
    assert.doesNotMatch(search.map((s) => s.text).join('\n'), /Передал дежурному/, 'после отмены текст — снова поиск');
    assert.ok(button(search, 'Открыть страницу'), 'и находит страницу');
    const stale = await press(uid, 'hb:q:cancel');
    assert.equal(stale.out.length, 0, 'старая «Отмена» ничего не пишет');

    // Одновременное двойное нажатие — одна подсказка
    const both = await Promise.all([press(uid, 'hb:q'), press(uid, 'hb:q')]);
    assert.equal(both.flatMap((r) => r.out).length, 1, 'одна подсказка на двойное нажатие');
    const asked = await say(uid, 'Можно ли получить справку об обучении на английском?');
    assert.match(asked[0]!.text, /Передал дежурному/);
    assert.ok((await questions(student.id)).includes('Можно ли получить справку об обучении на английском?'));
  });

  it('бот: команда или новый запуск выводят из режима вопроса дежурному (BOT-2)', async () => {
    const reader = await m.identity.upsertUser(m.pool, { id: 636363, first_name: 'Вера' });
    await m.handbook.contextFor(reader, { handbookId: ids.handbookId });
    const leaves: Array<[string, () => Promise<unknown>]> = [
      ['/spravka', () => say(reader.max_user_id, '/spravka')],
      ['/help', () => say(reader.max_user_id, '/help')],
      ['/нет-такой', () => say(reader.max_user_id, '/menu')],
      ['новый запуск', () => startBot(reader.max_user_id, null)],
    ];
    for (const [label, leave] of leaves) {
      await press(reader.max_user_id, 'hb:q');
      await leave();
      const out = await say(reader.max_user_id, 'справка в военкомат');
      assert.doesNotMatch(out.map((s) => s.text).join('\n'), /Передал дежурному/, `после «${label}» текст — поиск, а не вопрос`);
    }
    assert.deepEqual(await questions(reader.id), [], 'ни одного случайного вопроса дежурному');

    assert.equal(m.bot.leavesQuestionMode({ update_type: 'message_callback', callback: { payload: 'demo:role' } }), true, 'кнопки демо тоже выходят');
    assert.equal(m.bot.leavesQuestionMode({ update_type: 'message_callback', callback: { payload: 'hb:q' } }), false);
    assert.equal(m.bot.leavesQuestionMode({ update_type: 'message_created', message: { body: { text: 'как получить справку' } } }), false);
  });

  it('бот: новичок получает подсказку о ссылке и демо без кнопки поиска факультета', async () => {
    for (const first of [() => startBot(696969, null), () => say(696969, '/spravka'), () => say(696969, 'как получить справку')]) {
      const out = await first();
      assert.equal(out.length, 1);
      assert.match(out[0]!.text, /^Здравствуйте! Я Курсор/);
      assert.match(out[0]!.text, /\n\n• отвечу/, 'абзацы на месте');
      assert.equal(button(out, 'Найти свой факультет'), undefined);
      assert.match(out[0]!.text, /Откройте ссылку на справочник своего факультета/);
      assert.doesNotMatch(out[0]!.text, /Найти свой факультет|Пришлите сюда код приглашения/);
      assert.equal(button(out, 'Попробовать демо')?.payload, 'demo:start');
    }
  });

  it('бот: в групповом чате молчит, на кнопки отвечает подсказкой', async () => {
    const uid = student.max_user_id;
    assert.equal((await say(uid, '/spravka', { chatType: 'chat' })).length, 0);
    assert.equal((await say(uid, 'как получить справку', { chatType: 'chat' })).length, 0);
    const tap = await press(uid, 'hb:q', { chatType: 'chat' });
    assert.equal(tap.out.length, 0);
    assert.match(tap.answers.join(), /личном чате/);
  });

  it('бот: /spravka администратору и редактору настоящего справочника — кнопка «Редактор справочника»', async () => {
    const [university] = await q<{ id: string }>("INSERT INTO universities(code, name, short_name, timezone) VALUES ('nt-real', 'Томский университет', 'ТУ', 'Asia/Tomsk') RETURNING id");
    const [institute] = await q<{ id: string }>("INSERT INTO institutes(university_id, name, short_name) VALUES ($1, 'Физический факультет', 'ФФ') RETURNING id", [university!.id]);
    const [handbook] = await q<{ id: string }>(
      "INSERT INTO handbooks(university_id, institute_id, slug, title) VALUES ($1, $2, 'ff-nt', 'Справочник ФФ') RETURNING id",
      [university!.id, institute!.id],
    );
    const editorUser = await m.identity.upsertUser(m.pool, { id: 646464, first_name: 'Олег' });
    const readerUser = await m.identity.upsertUser(m.pool, { id: 656565, first_name: 'Мария' });
    const [editorPerson] = await q<{ id: string }>(
      "INSERT INTO persons(university_id, institute_id, role, full_name, user_id) VALUES ($1, $2, 'student', 'Олегов Олег', $3) RETURNING id",
      [university!.id, institute!.id, editorUser.id],
    );
    await m.pool.query("INSERT INTO handbook_members(handbook_id, person_id, role) VALUES ($1, $2, 'editor')", [handbook!.id, editorPerson!.id]);
    await m.handbook.contextFor(editorUser, { handbookId: handbook!.id });
    await m.handbook.contextFor(readerUser, { handbookId: handbook!.id });

    const forEditor = await say(editorUser.max_user_id, '/spravka');
    assert.match(forEditor[0]!.text, /Справочник ФФ/);
    assert.deepEqual(button(forEditor, 'Редактор справочника'), { type: 'open_app', text: 'Редактор справочника', web_app: 'notify_test_bot', contact_id: BOT_ID, payload: 'hbe' });
    assert.ok(!button(forEditor, 'Сменить роль'), 'кнопки демо — только в демо');
    const forReader = await say(readerUser.max_user_id, '/spravka');
    assert.ok(button(forReader, 'Открыть справочник'));
    assert.ok(!button(forReader, 'Редактор справочника'), 'читателю редактор не показываем');
  });

  it('бот: сброс демо — только после подтверждения (APP-23)', async () => {
    const visitor = await m.identity.upsertUser(m.pool, { id: 676767, first_name: 'Жюри' });
    const opened = await startBot(visitor.max_user_id, 'demo_dean');
    assert.ok(button(opened, 'Сбросить демо'));
    const sandbox = async () => (await q<{ id: string }>('SELECT id FROM universities WHERE demo_owner_user_id = $1', [visitor.id]))[0]?.id;
    const original = await sandbox();
    assert.ok(original);

    const ask = await press(visitor.max_user_id, 'demo:reset');
    assert.match(ask.out[0]!.text, /Сбросить демо\?/);
    assert.ok(button(ask.out, 'Отмена'));
    const yes = button(ask.out, 'Сбросить');
    assert.ok(yes?.payload?.startsWith('demo:reset:yes'));
    assert.equal(await sandbox(), original, 'кнопка «Сбросить демо» сама ничего не стирает');

    const no = await press(visitor.max_user_id, 'demo:reset:no');
    assert.match(no.answers.join(), /остаётся/);
    assert.equal(await sandbox(), original);

    const done = await press(visitor.max_user_id, yes!.payload!);
    assert.match(done.out.at(-1)?.text ?? '', /Демо «Модельного университета»/);
    const recreated = await sandbox();
    assert.notEqual(recreated, original, 'после подтверждения — новая песочница');

    // Та же кнопка «Сбросить» в истории чата второй раз ничего не стирает
    const twice = await press(visitor.max_user_id, yes!.payload!);
    assert.equal(twice.out.length, 0);
    assert.match(twice.answers.join(), /уже сброшено/);
    assert.equal(await sandbox(), recreated);
    // Подтверждение старше 10 минут и кнопка прежнего формата — спросить заново, а не сбрасывать
    for (const stale of [`demo:reset:yes:${(Date.now() - 11 * 60_000).toString(36)}`, 'demo:reset:yes']) {
      const old = await press(visitor.max_user_id, stale);
      assert.match(old.out[0]?.text ?? '', /Сбросить демо\?/, stale);
      assert.equal(await sandbox(), recreated, stale);
    }
  });

  it('бот: стикер, фото, голосовое, геопозиция — просьба написать словами, без сбоя и без вопроса дежурному', async () => {
    const reader = await m.identity.upsertUser(m.pool, { id: 686868, first_name: 'Ника' });
    await m.handbook.contextFor(reader, { handbookId: ids.handbookId });
    const uid = reader.max_user_id;
    const kinds = [
      { type: 'sticker', payload: { url: 'https://i.example/s.webp', code: 'abc' }, width: 128, height: 128 },
      { type: 'image', payload: { photo_id: 1, token: 't', url: 'https://i.example/1.jpg' } },
      { type: 'audio', payload: { url: 'https://f.example/a.ogg', token: 't' } },
      { type: 'file', payload: { url: 'https://f.example/a.pdf', token: 't' }, filename: 'spravka.pdf', size: 1000 },
      { type: 'location', latitude: 56.46, longitude: 84.95 },
      { type: 'contact', payload: { vcf_info: 'BEGIN:VCARD\nVERSION:3.0\nFN:Иван\nTEL:+79001234567\nEND:VCARD' } },
    ];
    // MAX присылает такие сообщения с text: null — раньше обработчик команд падал и бот отвечал «Что-то пошло не так»
    for (const attachment of kinds) {
      const out = await say(uid, null, { attachments: [attachment] });
      assert.equal(out.length, 1, attachment.type);
      assert.match(out[0]!.text, /понимаю только текст/, attachment.type);
    }

    // Бот ждёт вопрос дежурному: вложение не становится вопросом, ожидание сохраняется
    await press(uid, 'hb:q');
    const photo = await say(uid, null, { attachments: [kinds[1]] });
    assert.match(photo[0]!.text, /передаю только текст/);
    assert.equal(button(photo, 'Отмена')?.payload, 'hb:q:cancel');
    assert.deepEqual(await questions(reader.id), []);
    const withCaption = await say(uid, 'Примут ли такую справку в военкомате?', { attachments: [kinds[1]] });
    assert.match(withCaption[0]!.text, /Передал дежурному/);
    assert.match(withCaption[0]!.text, /Фото и файлы дежурный не увидит/, 'человек знает, что фото не ушло');
    assert.deepEqual(await questions(reader.id), ['Примут ли такую справку в военкомате?']);

    // Подпись к фото без ожидания вопроса — обычный поиск
    const search = await say(uid, 'справка', { attachments: [kinds[1]] });
    assert.ok(button(search, 'Открыть страницу'));
  });
});
