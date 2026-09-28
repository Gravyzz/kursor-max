/**
 * Интеграционные тесты модуля «Справочник»: чтение, адресность, наследование,
 * поиск, цикл «черновик → ревью → публикация», вопросы дежурному и уведомления читателям.
 * Запуск: TEST_DATABASE_URL=postgres://user:pass@host:5432/db npm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = process.env.TEST_HANDBOOK_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const BOT_TOKEN = 'handbook-test-token';
if (DB_URL) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    BOT_TOKEN,
    APP_SECRET: 'handbook-app-secret-0123456789ab',
    DEV_AUTH: 'false',
    REVIEW_API_KEY: 'review-test-key-0123456789abcdef',
    REVIEW_USER_ID: '9000000001',
    LOG_LEVEL: 'silent',
    APP_TIMEZONE: 'Europe/Moscow',
    BOT_USERNAME: 'handbook_test_bot',
    BOT_USER_ID: '900001',
  });
}

describe('справочник факультета', { skip: !DB_URL && 'TEST_DATABASE_URL не задан' }, () => {
  let m: {
    pool: typeof import('../src/db/pool.js')['pool'];
    migrate: typeof import('../src/db/migrate.js')['migrate'];
    identity: typeof import('../src/services/identity.js');
    demo: typeof import('../src/services/demo.js');
    handbook: typeof import('../src/services/handbook.js');
    editor: typeof import('../src/services/handbook-editor.js');
    template: typeof import('../src/services/handbook-template.js');
    domain: typeof import('../src/domain/handbook.js');
    api: typeof import('../src/api/server.js');
    initData: typeof import('../src/auth/initData.js');
    worker: typeof import('../src/worker/index.js');
  };
  let user: import('../src/services/identity.js').UserRow;
  let ids: import('../src/services/demo.js').DemoSandbox;
  let ctx: import('../src/services/handbook.js').HandbookContext;

  const q = async <T>(sql: string, values: unknown[] = []) => (await m.pool.query(sql, values)).rows as T[];
  const signed = (id: number, name = 'Анна', startParam?: string) =>
    m.initData.signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id, first_name: name }),
        ...(startParam ? { start_param: startParam } : {}),
      },
      BOT_TOKEN,
    );

  before(async () => {
    m = {
      pool: (await import('../src/db/pool.js')).pool,
      migrate: (await import('../src/db/migrate.js')).migrate,
      identity: await import('../src/services/identity.js'),
      demo: await import('../src/services/demo.js'),
      handbook: await import('../src/services/handbook.js'),
      editor: await import('../src/services/handbook-editor.js'),
      template: await import('../src/services/handbook-template.js'),
      domain: await import('../src/domain/handbook.js'),
      api: await import('../src/api/server.js'),
      initData: await import('../src/auth/initData.js'),
      worker: await import('../src/worker/index.js'),
    };
    await m.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await m.migrate();
    user = await m.identity.upsertUser(m.pool, { id: 515151, first_name: 'Анна', last_name: 'Тестова' });
    ids = await m.demo.createDemoSandbox(user);
    ctx = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
  });

  after(async () => {
    await m?.pool.end();
  });

  it('ключ проверки изолирован своей демо-песочницей и не принимает приглашения', async () => {
    const app = await m.api.buildApi();
    const headers = { 'x-review-key': 'review-test-key-0123456789abcdef' };
    const created = await app.inject({ method: 'POST', url: '/api/demo', headers, payload: { role: 'dean' } });
    assert.equal(created.statusCode, 200, created.body);
    const ownId = created.json().handbookId as string;

    const own = await app.inject({ method: 'GET', url: `/api/handbook?handbookId=${ownId}`, headers });
    assert.equal(own.statusCode, 200, own.body);

    const otherUser = await m.identity.upsertUser(m.pool, { id: 7_070_707, first_name: 'Другой' });
    const other = await m.demo.createDemoSandbox(otherUser, 'dean');
    const foreign = await app.inject({ method: 'GET', url: `/api/handbook?handbookId=${other.handbookId}`, headers });
    assert.equal(foreign.statusCode, 403, foreign.body);
    const foreignEditor = await app.inject({ method: 'GET', url: `/api/handbook-editor/structure?handbookId=${other.handbookId}`, headers });
    assert.equal(foreignEditor.statusCode, 403, foreignEditor.body);

    const catalogue = await app.inject({ method: 'GET', url: '/api/handbooks', headers });
    assert.equal(catalogue.statusCode, 200, catalogue.body);
    assert.ok(catalogue.json().handbooks.length > 0);
    assert.ok(catalogue.json().handbooks.every((handbook: { is_demo: boolean }) => handbook.is_demo));

    const invite = await app.inject({ method: 'POST', url: '/api/bind/invite', headers, payload: { code: 'TEST-CODE' } });
    assert.equal(invite.statusCode, 403, invite.body);
    await app.close();
  });

  it('описание можно очистить в черновике и опубликовать без возврата старого текста', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const scope = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const [section] = await q<{ id: string }>('SELECT id FROM sections WHERE handbook_id = $1 LIMIT 1', [ids.handbookId]);
    const page = await m.editor.createPage(m.pool, scope, {
      sectionId: section!.id, title: 'Очистка описания', summary: 'Прежнее описание',
      blocks: [{ id: 't1', type: 'text', text: 'Актуальная инструкция для студентов.' }],
    });
    await m.editor.publishPage(m.pool, scope, page.id);
    // Непереданное поле сохраняется, явно переданный null очищает его.
    await m.editor.saveDraft(m.pool, scope, page.id, { title: 'Новое название' });
    assert.equal((await m.editor.pageForEditor(m.pool, scope, page.id)).page.summary, 'Прежнее описание');
    await m.editor.saveDraft(m.pool, scope, page.id, { summary: null });
    assert.equal((await m.editor.pageForEditor(m.pool, scope, page.id)).page.summary, null);
    await m.editor.saveDraft(m.pool, scope, page.id, { title: 'Описание очищено' });
    assert.equal((await m.editor.pageForEditor(m.pool, scope, page.id)).page.summary, null, 'следующий автосейв не возвращает описание');
    assert.equal((await q<{ summary: string | null }>('SELECT summary FROM pages WHERE id = $1', [page.id]))[0]!.summary, 'Прежнее описание', 'до публикации студент читает прежнюю версию');
    await m.editor.publishPage(m.pool, scope, page.id);
    assert.equal((await q<{ summary: string | null }>('SELECT summary FROM pages WHERE id = $1', [page.id]))[0]!.summary, null);
    const versions = await q<{ summary: string | null }>('SELECT summary FROM page_versions WHERE page_id = $1 ORDER BY created_at DESC', [page.id]);
    assert.equal(versions[0]!.summary, null, 'история публикаций хранит очищенное описание');
    await m.editor.archivePage(m.pool, scope, page.id);
  });

  it('новый цикл проверки уведомляет администраторов в тот же день, повтор запроса не дублирует', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const scope = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const [section] = await q<{ id: string }>('SELECT id FROM sections WHERE handbook_id = $1 LIMIT 1', [ids.handbookId]);
    const page = await m.editor.createPage(m.pool, scope, {
      sectionId: section!.id, title: 'Повторная проверка',
      blocks: [{ id: 't1', type: 'text', text: 'Время работы: с 10 до 18.' }],
    });
    const count = async () => (await q<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE kind = 'handbook_review' AND payload->>'pageId' = $1", [page.id]))[0]!.n;
    const first = await m.editor.submitForReview(m.pool, scope, page.id, 'Проверьте часы');
    assert.ok(first.notified > 0);
    assert.equal(await count(), first.notified);
    const repeated = await m.editor.submitForReview(m.pool, scope, page.id, 'Проверьте часы');
    assert.equal(repeated.updatedAt, first.updatedAt);
    assert.equal(repeated.notified, 0);
    assert.equal(await count(), first.notified);
    await m.editor.returnPage(m.pool, scope, page.id, 'Уточните выходные');
    await m.editor.saveDraft(m.pool, scope, page.id, { blocks: [{ id: 't1', type: 'text', text: 'По будням с 10 до 18. Выходные: суббота и воскресенье.' }] });
    const second = await m.editor.submitForReview(m.pool, scope, page.id, 'Уточнено');
    assert.notEqual(second.updatedAt, first.updatedAt);
    assert.equal(await count(), first.notified + second.notified);
    assert.equal((await m.editor.pageForEditor(m.pool, scope, page.id)).returnNote, null);
    await m.editor.archivePage(m.pool, scope, page.id);
  });

  it('весь демо-контент проходит схему блоков', async () => {
    const pages = await q<{ slug: string; blocks: unknown[]; draft_blocks: unknown[] | null }>('SELECT slug, blocks, draft_blocks FROM pages');
    assert.ok(pages.length >= 20, `страниц мало: ${pages.length}`);
    for (const page of pages) {
      const blocks = m.domain.blocksSchema.safeParse(page.blocks);
      assert.ok(blocks.success, `${page.slug}: ${blocks.success ? '' : JSON.stringify(blocks.error.issues)}`);
      if (page.draft_blocks) {
        const draft = m.domain.blocksSchema.safeParse(page.draft_blocks);
        assert.ok(draft.success, `${page.slug} (черновик): ${draft.success ? '' : JSON.stringify(draft.error.issues)}`);
      }
    }
    // Идентификаторы блоков уникальны внутри страницы — прогресс по чеклистам опирается на них
    for (const page of pages) {
      const ids_ = (page.blocks as Array<{ id: string }>).map((b) => b.id);
      assert.equal(new Set(ids_).size, ids_.length, `${page.slug}: повторяющиеся id блоков`);
    }
  });

  it('наследование: страница факультета перекрывает страницу вуза', async () => {
    const sections = await m.handbook.sectionsWithPages(m.pool, ctx);
    const docs = sections.find((s) => s.slug === 'spravki-i-dokumenty')!;
    const spravki = docs.pages.filter((p) => p.slug === 'spravka-ob-obuchenii');
    assert.equal(spravki.length, 1, 'страница должна быть одна, а не две');
    assert.match(spravki[0]!.summary ?? '', /ИИТ/, 'должна победить версия факультета');
    // Страница вуза без переопределения наследуется как есть
    assert.ok(docs.pages.some((p) => p.slug === 'spravka-v-voenkomat'), 'страница вуза должна наследоваться');
  });

  it('адресность: общежитие видно только живущим в нём', async () => {
    const sections = await m.handbook.sectionsWithPages(m.pool, ctx);
    assert.ok(sections.some((s) => s.slug === 'obshchezhitie'), 'без заполненного профиля скрывать нечего');

    const notDorm = await m.handbook.updateProfile(m.pool, ctx.reader, { dorm: false, course: 1 });
    const ctxNoDorm = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    assert.equal(notDorm.dorm, false);
    const hidden = await m.handbook.sectionsWithPages(m.pool, ctxNoDorm);
    assert.ok(!hidden.some((s) => s.slug === 'obshchezhitie'), 'не живущим в общежитии раздел не нужен');

    await m.handbook.updateProfile(m.pool, ctx.reader, { dorm: true });
    const ctxDorm = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const shown = await m.handbook.sectionsWithPages(m.pool, ctxDorm);
    assert.ok(shown.some((s) => s.slug === 'obshchezhitie'));
  });

  it('адресность по курсу: практика — со второго курса', async () => {
    await m.handbook.updateProfile(m.pool, ctx.reader, { course: 1, dorm: true });
    const first = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const learn1 = (await m.handbook.sectionsWithPages(m.pool, first)).find((s) => s.slug === 'ucheba')!;
    assert.ok(!learn1.pages.some((p) => p.slug === 'praktika'), 'первокурснику практика не нужна');

    await m.handbook.updateProfile(m.pool, ctx.reader, { course: 3 });
    const third = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const learn3 = (await m.handbook.sectionsWithPages(m.pool, third)).find((s) => s.slug === 'ucheba')!;
    assert.ok(learn3.pages.some((p) => p.slug === 'praktika'));
    await m.handbook.updateProfile(m.pool, ctx.reader, { course: 1 });
  });

  it('поиск понимает сленг и опечатки', async () => {
    const fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const slang = await m.handbook.search(m.pool, fresh, 'физра отработки');
    assert.ok(slang.some((hit) => hit.slug === 'kak-poluchit-zachet'), 'физра → физкультура');

    const hvost = await m.handbook.search(m.pool, fresh, 'хвосты');
    assert.ok(hvost.some((hit) => hit.slug === 'akademicheskie-zadolzhennosti'), 'хвосты → задолженность');

    const bumazhka = await m.handbook.search(m.pool, fresh, 'бумажка об обучении');
    assert.ok(bumazhka.some((hit) => hit.slug === 'spravka-ob-obuchenii'), 'бумажка → справка');

    // Перекрытая страница вуза не должна дублировать факультетскую в выдаче
    const spravki = await m.handbook.search(m.pool, fresh, 'справка об обучении');
    const overridden = spravki.filter((hit) => hit.slug === 'spravka-ob-obuchenii');
    assert.equal(overridden.length, 1, 'в поиске страница должна быть одна');
    assert.match(overridden[0]!.snippet, /ИИТ/, 'и это должна быть версия факультета');

    const typo = await m.handbook.search(m.pool, fresh, 'стипендея');
    assert.ok(Array.isArray(typo), 'опечатка не должна ломать поиск');

    const nothing = await m.handbook.search(m.pool, fresh, 'квантовая телепортация');
    assert.equal(nothing.length, 0);
  });

  it('поиск не выдаёт чужие и неопубликованные страницы', async () => {
    const fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const review = await m.handbook.search(m.pool, fresh, 'перевод на другой профиль');
    assert.ok(!review.some((hit) => hit.slug === 'perevod-na-drugoy-profil'), 'страница на проверке не видна студенту');

    const other = await m.identity.upsertUser(m.pool, { id: 626262, first_name: 'Борис' });
    const otherIds = await m.demo.createDemoSandbox(other);
    const otherCtx = (await m.handbook.contextFor(other, { handbookId: otherIds.handbookId }))!;
    const hits = await m.handbook.search(m.pool, otherCtx, 'справка');
    const pageIds = hits.map((hit) => hit.pageId);
    const foreign = await q<{ n: number }>(
      'SELECT count(*)::int AS n FROM pages WHERE id = ANY($1::uuid[]) AND handbook_id NOT IN (SELECT unnest($2::uuid[]))',
      [pageIds, otherCtx.chain],
    );
    assert.equal(foreign[0]!.n, 0, 'поиск не должен выходить за пределы своего справочника');
  });

  it('чеклист запоминает прогресс, страница собирает оценки', async () => {
    const fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const [page] = await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND slug = 'chek-list-pervoy-nedeli'", [ids.handbookId]);
    const before = await m.handbook.getPage(m.pool, fresh, page!.id);
    assert.ok(before.page, 'страница должна открываться');

    await m.handbook.setProgress(m.pool, fresh, page!.id, 'i1', true);
    await m.handbook.setProgress(m.pool, fresh, page!.id, 'i2', true);
    const mid = await m.handbook.getPage(m.pool, fresh, page!.id);
    assert.deepEqual([...mid.progress].sort(), ['i1', 'i2']);

    await m.handbook.setProgress(m.pool, fresh, page!.id, 'i1', false);
    const after = await m.handbook.getPage(m.pool, fresh, page!.id);
    assert.deepEqual(after.progress, ['i2']);

    const base = (await q<{ helpful: number; not_helpful: number }>('SELECT helpful, not_helpful FROM pages WHERE id = $1', [page!.id]))[0]!;
    await m.handbook.setFeedback(m.pool, fresh, page!.id, false, 'Не хватает про медосмотр');
    const negative = (await q<{ helpful: number; not_helpful: number }>('SELECT helpful, not_helpful FROM pages WHERE id = $1', [page!.id]))[0]!;
    assert.equal(negative.not_helpful, base.not_helpful + 1);

    await m.handbook.setFeedback(m.pool, fresh, page!.id, true, null);
    const flipped = (await q<{ helpful: number; not_helpful: number }>('SELECT helpful, not_helpful FROM pages WHERE id = $1', [page!.id]))[0]!;
    assert.equal(flipped.helpful, base.helpful + 1, 'смена оценки не должна удваивать счётчик');
    assert.equal(flipped.not_helpful, base.not_helpful, 'прежний минус должен сняться');

    await m.handbook.setFeedback(m.pool, fresh, page!.id, true, null);
    const again = (await q<{ helpful: number; not_helpful: number }>('SELECT helpful, not_helpful FROM pages WHERE id = $1', [page!.id]))[0]!;
    assert.equal(again.helpful, flipped.helpful, 'повторная та же оценка ничего не меняет');
  });

  it('цикл редактора: черновик → ревью → публикация', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const scope = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const section = (await q<{ id: string }>("SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'ucheba'", [ids.handbookId]))[0]!;

    const page = await m.editor.createPage(m.pool, scope, {
      sectionId: section.id,
      title: 'Где распечатать документы',
      summary: 'Принтеры в корпусе 2',
      blocks: [{ id: 'b1', type: 'text', text: 'Принтер для студентов — в библиотеке корпуса 2, печать по студенческому.' }],
    });

    const fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    await assert.rejects(() => m.handbook.getPage(m.pool, fresh, page.id), /не найдена/i, 'черновик студенту не виден');

    await m.editor.saveDraft(m.pool, scope, page.id, {
      blocks: [
        { id: 'b1', type: 'text', text: 'Принтер для студентов — в библиотеке корпуса 2, печать по студенческому билету.' },
        { id: 'b2', type: 'deadline', title: 'Оплата печати за семестр', startsOn: '2027-02-01', remindDays: [3] },
      ],
    });
    await m.editor.submitForReview(m.pool, scope, page.id, 'Проверьте часы работы библиотеки');
    const inReview = await q<{ status: string }>('SELECT status FROM pages WHERE id = $1', [page.id]);
    assert.equal(inReview[0]!.status, 'review');
    await assert.rejects(() => m.handbook.getPage(m.pool, fresh, page.id), /не найдена/i, 'на проверке тоже не виден');

    await m.editor.publishPage(m.pool, scope, page.id);
    const published = await m.handbook.getPage(m.pool, fresh, page.id);
    assert.ok(published.page, 'после публикации страница видна');
    assert.equal(published.page.blocks.length, 2);

    const versions = await q<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id = $1', [page.id]);
    assert.equal(versions[0]!.n, 1, 'публикация сохраняет версию для отката');

    const deadlines = await q<{ title: string }>('SELECT title FROM handbook_deadlines WHERE page_id = $1', [page.id]);
    assert.equal(deadlines.length, 1, 'срок из блока попадает в календарь');

    const found = await m.handbook.search(m.pool, fresh, 'где распечатать');
    assert.ok(found.some((hit) => hit.pageId === page.id), 'опубликованная страница ищется сразу');

    await m.editor.archivePage(m.pool, scope, page.id);
    await assert.rejects(() => m.handbook.getPage(m.pool, fresh, page.id), /не найдена/i, 'архивная страница скрыта');
    const goneDeadlines = await q('SELECT 1 FROM handbook_deadlines WHERE page_id = $1', [page.id]);
    assert.equal(goneDeadlines.length, 0, 'сроки архивной страницы не напоминают');
  });

  it('редактор без прав администратора не публикует', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const editorScope = { handbook, role: 'editor' as const, personId: ids.deanId, userId: user.id };
    const section = (await q<{ id: string }>("SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'ucheba'", [ids.handbookId]))[0]!;
    const page = await m.editor.createPage(m.pool, editorScope, { sectionId: section.id, title: 'Черновик редактора', blocks: [] });
    await assert.rejects(() => m.editor.publishPage(m.pool, editorScope, page.id), /администратор/i);
  });

  it('вопрос дежурному: ответ доходит до читателя и попадает в FAQ', async () => {
    const fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const question = await m.handbook.askQuestion(m.pool, fresh, 'Есть ли у нас военная кафедра?', 'военная кафедра');
    // Тот же вопрос дважды — двойное нажатие, а разные вопросы задавать можно
    await assert.rejects(() => m.handbook.askQuestion(m.pool, fresh, 'Есть ли у нас военная кафедра?', null), /уже отправлен/i);
    const second = await m.handbook.askQuestion(m.pool, fresh, 'А где в корпусе 2 можно распечатать?', null);
    assert.ok(second.id);

    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const scope = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const target = (await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND slug = 'kuda-obratitsya'", [ids.handbookId]))[0]!;

    const answered = await m.editor.answerQuestion(m.pool, scope, question.id, 'Военной кафедры нет, отсрочка оформляется через отдел воинского учёта.', target.id);
    assert.equal(answered.addedToPage, true);
    await assert.rejects(() => m.editor.answerQuestion(m.pool, scope, question.id, 'Второй ответ', null), /уже ответили/i);

    const draft = (await q<{ draft_blocks: Array<{ type: string; items?: unknown[] }> }>('SELECT draft_blocks FROM pages WHERE id = $1', [target.id]))[0]!;
    const faq = draft.draft_blocks.find((block) => block.type === 'faq');
    assert.ok(faq, 'ответ должен лечь в блок «Вопросы и ответы» черновика');

    const notification = (await q<{ kind: string; reader_id: string | null; person_id: string | null; user_id: number }>(
      "SELECT kind, reader_id, person_id, user_id FROM notifications WHERE kind = 'handbook_answer' ORDER BY id DESC LIMIT 1",
    ))[0]!;
    assert.equal(notification.reader_id, fresh.reader.id, 'адресат — читатель справочника');
    assert.equal(notification.person_id, null, 'читатель может не быть в списках деканата');
    assert.equal(notification.user_id, user.id);
  });

  it('объявление уходит только своей аудитории', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const scope = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    await m.handbook.updateProfile(m.pool, ctx.reader, { course: 1, dorm: true });

    const all = await m.editor.announce(m.pool, scope, { title: 'Библиотека работает до 20:00', body: 'С понедельника читальный зал открыт дольше.', notify: true });
    assert.ok(all.notified > 0, 'объявление без аудитории уходит всем читателям');

    const firstOnly = await m.editor.announce(m.pool, scope, {
      title: 'Собрание первого курса',
      body: 'В четверг в 16:00, аудитория 201.',
      audience: { courses: [1] },
      notify: true,
    });
    assert.ok(firstOnly.notified <= all.notified, 'адресное объявление не может уйти большему числу людей');

    const mine = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'handbook_announcement' AND user_id = $1",
      [user.id],
    );
    assert.equal(mine[0]!.n, 2, 'первокурсник получает оба объявления');
  });

  it('объявление: ссылка на страницу, «прочитано» и архив, правка и удаление администратором', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const admin = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const editor = { handbook, role: 'editor' as const, personId: ids.editorIds[0]!, userId: user.id };
    const [page] = await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND slug = 'sessiya-i-brs' AND status = 'published'", [ids.handbookId]);

    const created = await m.editor.announce(m.pool, admin, { title: 'Расписание сессии', body: 'Опубликовано расписание зимней сессии.', pageId: page!.id, notify: true });
    let fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    let home = await m.handbook.home(m.pool, fresh);
    const shown = home.announcements.find((item) => item.id === created.id);
    assert.equal(shown?.pageId, page!.id, 'карточка объявления ведёт на страницу');

    await m.handbook.markAnnouncementRead(m.pool, fresh, created.id, true);
    home = await m.handbook.home(m.pool, fresh);
    assert.ok(!home.announcements.some((item) => item.id === created.id), 'прочитанное уходит с главной');
    const feed = await m.handbook.announcementsFeed(m.pool, fresh);
    assert.ok(feed.archive.some((item) => item.id === created.id && item.readAt), 'и лежит в архиве');
    await m.handbook.markAnnouncementRead(m.pool, fresh, created.id, false);
    home = await m.handbook.home(m.pool, fresh);
    assert.ok(home.announcements.some((item) => item.id === created.id), 'можно вернуть на главную');

    await assert.rejects(() => m.editor.updateAnnouncement(m.pool, editor, created.id, { title: 'Чужая правка', body: 'Текст объявления' }), /администратор/i);
    await assert.rejects(() => m.editor.deleteAnnouncement(m.pool, editor, created.id), /администратор/i);
    await assert.rejects(
      () => m.editor.updateAnnouncement(m.pool, admin, created.id, { title: 'Расписание', body: 'Ссылка на черновик', pageId: '00000000-0000-4000-8000-000000000000' }),
      /не найдена/i,
    );

    await m.editor.updateAnnouncement(m.pool, admin, created.id, { title: 'Расписание сессии обновлено', body: 'Экзамен по матанализу перенесён на 18 января.', pageId: page!.id });
    fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    home = await m.handbook.home(m.pool, fresh);
    assert.equal(home.announcements.find((item) => item.id === created.id)?.title, 'Расписание сессии обновлено');
    const listed = await m.editor.listAnnouncements(m.pool, admin);
    assert.ok(listed.some((item) => item.id === created.id && item.pageTitle === 'Сессия и БРС'), 'редактор видит объявление со ссылкой');

    await m.editor.deleteAnnouncement(m.pool, admin, created.id);
    home = await m.handbook.home(m.pool, fresh);
    assert.ok(!home.announcements.some((item) => item.id === created.id), 'удалённое исчезает у читателя');
    const pending = await q<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE dedupe_key LIKE $1 AND status = 'pending'", [`hb_ann:${created.id}:%`]);
    assert.equal(pending[0]!.n, 0, 'неотправленные уведомления о нём отменены');
  });

  it('демо: роль выбирается и меняется без потери данных, права — по роли', async () => {
    const visitor = await m.identity.upsertUser(m.pool, { id: 868686, first_name: 'Жюри' });
    const asStudent = await m.demo.setDemoRole(visitor, 'student');
    assert.equal(asStudent.role, 'student');
    assert.equal(await m.demo.getDemoRole(m.pool, visitor.id), 'student');
    assert.equal(await m.handbook.memberRole(m.pool, asStudent.handbookId, visitor), null, 'студент — только читатель');

    const studentCtx = (await m.handbook.contextFor(visitor, { handbookId: asStudent.handbookId }))!;
    await m.handbook.askQuestion(m.pool, studentCtx, 'Где взять студенческий билет, если потеряла?', null);

    const asEditor = await m.demo.setDemoRole(visitor, 'editor');
    assert.equal(asEditor.handbookId, asStudent.handbookId, 'песочница та же');
    assert.equal(await m.handbook.memberRole(m.pool, asEditor.handbookId, visitor), 'editor');
    const kept = await q<{ n: number }>('SELECT count(*)::int AS n FROM handbook_questions WHERE user_id = $1', [visitor.id]);
    assert.equal(kept[0]!.n, 1, 'вопрос, заданный студентом, сохранился');

    const app = await m.api.buildApi();
    const headers = { 'x-max-init-data': signed(868686, 'Жюри') };
    const me = await app.inject({ method: 'GET', url: '/api/me', headers });
    assert.equal(me.json().demo.role, 'editor');
    assert.notEqual(me.json().person?.role, 'dean', 'редактор — не деканат');
    const create = await app.inject({ method: 'POST', url: '/api/handbook-editor/handbooks', headers: { ...headers, 'content-type': 'application/json' }, payload: { instituteId: me.json().person.instituteId, title: 'Мой справочник', template: false } });
    assert.equal(create.statusCode, 200, 'редактор создаёт справочник в своей демо-песочнице');
    assert.match(create.json().slug, /-demo-/);

    const switched = await app.inject({ method: 'POST', url: '/api/demo/role', headers: { ...headers, 'content-type': 'application/json' }, payload: { role: 'dean' } });
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(await m.handbook.memberRole(m.pool, asEditor.handbookId, visitor), 'admin', 'деканат — администратор');
    const reset = await app.inject({ method: 'POST', url: '/api/demo', headers: { ...headers, 'content-type': 'application/json' }, payload: {} });
    assert.equal(reset.json().role, 'dean', 'сброс сохраняет роль');
    await app.close();
  });

  it('worker доставляет уведомления читателю без записи в вузе', async () => {
    const sent: Array<{ userId: number; text: string }> = [];
    const bot = {
      api: {
        sendMessageToUser: async (userId: number, text: string) => {
          sent.push({ userId, text });
          return { body: { mid: `mid-${sent.length}` } };
        },
        getMyInfo: async () => ({ username: 'handbook_test_bot', user_id: 900001 }),
      },
    } as unknown as import('@maxhub/max-bot-api').Bot;

    await m.pool.query("UPDATE notifications SET status = 'pending', simulated = false WHERE kind LIKE 'handbook%' AND user_id = $1", [user.id]);
    await m.worker.dispatchDue(bot, async () => undefined);
    const mine = sent.filter((row) => row.userId === user.max_user_id);
    assert.ok(mine.length > 0, 'читателю должно уйти сообщение');
    assert.ok(mine.some((row) => /Собрание первого курса|Библиотека|Ответ на ваш вопрос/.test(row.text)));
  });

  it('worker: сбой MAX переживаем повторами, «бот заблокирован» не повторяем', async () => {
    const { MaxError } = await import('@maxhub/max-bot-api');
    let status = 503;
    const bot = {
      api: {
        sendMessageToUser: async () => {
          throw new MaxError(status, { code: 'error', message: 'fail' } as never);
        },
        getMyInfo: async () => ({ username: 'handbook_test_bot', user_id: 900001 }),
      },
    } as unknown as import('@maxhub/max-bot-api').Bot;
    const probe = async (code: number) => {
      status = code;
      await m.pool.query("UPDATE notifications SET status = 'cancelled' WHERE status = 'pending'");
      const [row] = await q<{ id: number }>(
        "UPDATE notifications SET status = 'pending', simulated = false, attempts = 0, send_after = now() - interval '1 second' WHERE id = (SELECT id FROM notifications WHERE kind = 'handbook_answer' AND user_id = $1 LIMIT 1) RETURNING id",
        [user.id],
      );
      await m.worker.dispatchDue(bot, async () => undefined);
      return (await q<{ status: string; attempts: number }>('SELECT status, attempts FROM notifications WHERE id = $1', [row!.id]))[0]!;
    };
    for (const code of [503, 429, 401]) assert.equal((await probe(code)).status, 'pending', `${code} — повторим позже`);
    assert.equal((await probe(403)).status, 'failed', '403 — повтор бессмыслен');
  });

  it('аналитика показывает пробелы, слабые и устаревшие страницы', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const scope = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const report = await m.editor.analytics(m.pool, scope);
    assert.ok(report.gaps.length > 0, 'запросы без результата — бэклог редактора');
    assert.ok(report.top.length > 0, 'самые читаемые страницы');
    assert.ok(report.questions.length > 0, 'открытые вопросы');

    // Метрики пилота считаются из данных справочника
    const pilot = report.pilot;
    assert.ok(pilot.searches > 0 && pilot.found > 0 && pilot.found <= pilot.searches, 'самообслуживание: найдено ≤ всего запросов');
    assert.ok(pilot.helpful + pilot.notHelpful > 0, 'есть оценки страниц');
    assert.ok(pilot.answered >= 4, 'отвеченные вопросы демо попадают в метрику');
    // В демо ответы за 2, 4, 6 и 19 часов; другие тесты этого набора добавляют мгновенные ответы
    assert.ok(pilot.medianAnswerMinutes !== null && pilot.medianAnswerMinutes >= 0 && pilot.medianAnswerMinutes <= 300, 'медиана времени ответа');
    assert.ok(pilot.fresh <= pilot.published && pilot.published > 0);
    assert.ok(pilot.activeReaders > 0, 'активные читатели за две недели');
  });

  it('конструктор: новый справочник получает готовую структуру', async () => {
    const dean = (await q<{ id: string; university_id: string }>("SELECT id, university_id FROM persons WHERE id = $1", [ids.deanId]))[0]!;
    const institute = (await q<{ id: string }>('SELECT id FROM institutes WHERE university_id = $1', [dean.university_id]))[0]!;
    const created = await m.editor.createHandbook(
      { personId: dean.id, userId: user.id, universityId: dean.university_id, role: 'dean' },
      { instituteId: institute.id, title: 'Справочник ФМФ', subtitle: 'Физико-математический факультет' },
    );
    assert.ok(created.sections >= 8, 'разделы из шаблона');
    assert.ok(created.pages >= 20, 'страницы-заготовки');
    assert.equal(created.inherited, true, 'наследует справочник вуза');

    const drafts = await q<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE handbook_id = $1 AND status <> 'draft'", [
      (await q<{ id: string }>('SELECT id FROM handbooks WHERE slug = $1 AND university_id = $2', [created.slug, dean.university_id]))[0]!.id,
    ]);
    assert.equal(drafts[0]!.n, 0, 'заготовки не публикуются сами');

    await assert.rejects(
      () => m.editor.createHandbook({ personId: dean.id, userId: user.id, universityId: dean.university_id, role: 'student' }, { instituteId: institute.id, title: 'Чужой справочник' }),
      /деканат/i,
    );
    await assert.rejects(
      () => m.editor.createHandbook({ personId: dean.id, userId: user.id, universityId: dean.university_id, role: 'staff', isDemo: false }, { instituteId: institute.id, title: 'Без прав' }),
      /демо-песочницы/i,
      'редактор настоящего вуза не получает право создания',
    );
    await assert.rejects(
      () => m.editor.createHandbook({ personId: dean.id, userId: -1, universityId: dean.university_id, role: 'staff', isDemo: true }, { instituteId: institute.id, title: 'Чужая песочница' }),
      /своей демо-песочнице/i,
      'флаг демо без владения вузом не даёт доступ',
    );
  });

  it('API: справочник открыт читателю без записи в вузе', async () => {
    const app = await m.api.buildApi();
    const guest = signed(737373, 'Гость', `hb_${ids.handbookSlug}`);

    const home = await app.inject({ method: 'GET', url: '/api/handbook', headers: { 'x-max-init-data': guest } });
    assert.equal(home.statusCode, 200, home.body);
    assert.equal(home.json().handbook.slug, ids.handbookSlug);
    assert.equal(home.json().editorRole, null);

    const search = await app.inject({ method: 'GET', url: '/api/handbook/search?q=' + encodeURIComponent('справка'), headers: { 'x-max-init-data': guest } });
    assert.equal(search.statusCode, 200);
    assert.ok(search.json().hits.length > 0);

    // Чтение не требует записи в вузе, а вот приглашения выдаёт только администратор
    const invite = await app.inject({
      method: 'POST',
      url: `/api/handbook-editor/invites?handbookId=${ids.handbookId}`,
      headers: { 'x-max-init-data': guest },
      payload: { fullName: 'Самозванец', kind: 'student', role: 'admin' },
    });
    assert.equal(invite.statusCode, 403);

    // Редактирование — тоже
    const edit = await app.inject({
      method: 'GET',
      url: `/api/handbook-editor/structure?handbookId=${ids.handbookId}`,
      headers: { 'x-max-init-data': guest },
    });
    assert.equal(edit.statusCode, 403);
    await app.close();
  });

  it('профиль берёт имя и безопасный адрес фото из подписанных данных MAX', async () => {
    const app = await m.api.buildApi();
    const auth = (photoUrl: string) => m.initData.signInitData({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 737374, first_name: 'Алина', last_name: 'Иванова', photo_url: photoUrl }),
    }, BOT_TOKEN);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-max-init-data': auth('https://example.com/avatar.jpg') } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.firstName, 'Алина');
    assert.equal(me.json().user.lastName, 'Иванова');
    assert.equal(me.json().user.photoUrl, 'https://example.com/avatar.jpg');
    const unsafe = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-max-init-data': auth('javascript:alert(1)') } });
    assert.equal(unsafe.json().user.photoUrl, null);
    await app.close();
  });

  it('право на справочник привязано к записи того же вуза', async () => {
    // У одного аккаунта MAX есть записи в двух вузах: деканат чужого вуза не редактор здесь
    const other = await m.identity.upsertUser(m.pool, { id: 949494, first_name: 'Вера' });
    const otherIds = await m.demo.createDemoSandbox(other);
    const mine = await m.handbook.membership(m.pool, ids.handbookId, user);
    assert.ok(mine, 'владелец демо — администратор своего справочника');
    const foreign = await m.handbook.membership(m.pool, otherIds.handbookId, user);
    assert.equal(foreign, null, 'в чужом справочнике прав нет');

    const deanPerson = (await q<{ university_id: string }>('SELECT university_id FROM persons WHERE id = $1', [mine!.personId]))[0]!;
    const handbookUni = (await q<{ university_id: string }>('SELECT university_id FROM handbooks WHERE id = $1', [ids.handbookId]))[0]!;
    assert.equal(deanPerson.university_id, handbookUni.university_id, 'подписывает правки запись того же вуза');
  });

  it('API: диплинк на страницу открывает её справочник', async () => {
    const app = await m.api.buildApi();
    const [page] = await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND slug = 'sessiya-i-brs'", [ids.handbookId]);
    const guest = signed(838383, 'Гость2', `hbp_${page!.id}`);
    const home = await app.inject({ method: 'GET', url: '/api/handbook', headers: { 'x-max-init-data': guest } });
    assert.equal(home.statusCode, 200, home.body);
    assert.equal(home.json().handbook.id, ids.handbookId);

    const opened = await app.inject({ method: 'GET', url: `/api/handbook/pages/${page!.id}`, headers: { 'x-max-init-data': guest } });
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().page.title, 'Сессия и БРС');
    await app.close();
  });

  it('напоминание о сроке: ставится в нужный день и один раз', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const scope = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const section = (await q<{ id: string }>("SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'ucheba'", [ids.handbookId]))[0]!;
    const [today] = await q<{ d: string }>("SELECT to_char((now() AT TIME ZONE 'Europe/Moscow')::date + 3, 'YYYY-MM-DD') AS d");
    const page = await m.editor.createPage(m.pool, scope, {
      sectionId: section.id,
      title: 'Запись на курсы по выбору',
      blocks: [{ id: 'd1', type: 'deadline', title: 'Запись на курсы по выбору', startsOn: today!.d, remindDays: [3, 1] }],
    });
    await m.editor.publishPage(m.pool, scope, page.id);
    await m.handbook.updateProfile(m.pool, ctx.reader, { reminders: true, course: 1 });

    const queued = await m.worker.enqueueDeadlineReminders();
    assert.ok(queued > 0, 'срок через 3 дня попадает в очередь');
    const mine = await q<{ id: number; payload: { daysLeft: number } }>(
      "SELECT id, payload FROM notifications WHERE kind = 'handbook_deadline' AND user_id = $1",
      [user.id],
    );
    assert.equal(mine.length, 1, 'читателю — одно напоминание');
    assert.equal(mine[0]!.payload.daysLeft, 3);

    const again = await m.worker.enqueueDeadlineReminders();
    assert.equal(again, 0, 'повторный прогон планировщика не дублирует напоминания');

    const render = await import('../src/notify/render.js');
    const text = await render.renderNotification(
      m.pool,
      { id: mine[0]!.id, kind: 'handbook_deadline', payload: mine[0]!.payload, person_id: null, role: 'reader' },
      { username: 'handbook_test_bot', userId: 900001 } as never,
    );
    assert.match(text!.text, /через 3 дня/);

    // Отписавшемуся напоминания не приходят
    await m.pool.query("DELETE FROM notifications WHERE kind = 'handbook_deadline'");
    await m.handbook.updateProfile(m.pool, ctx.reader, { reminders: false });
    await m.worker.enqueueDeadlineReminders();
    const muted = await q("SELECT 1 FROM notifications WHERE kind = 'handbook_deadline' AND user_id = $1", [user.id]);
    assert.equal(muted.length, 0);
    await m.handbook.updateProfile(m.pool, ctx.reader, { reminders: true });
  });

  it('приглашение редактора: ссылка, привязка и права', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const admin = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const invite = await m.editor.inviteEditor(m.pool, admin, { fullName: 'Лебедева Ольга Игоревна', kind: 'staff', role: 'editor' });
    assert.match(invite.link, /inv_/);

    const before = await m.editor.listMembers(m.pool, admin);
    const pending = before.find((row) => row.personId === invite.personId)!;
    assert.equal(pending.connected, false);
    assert.ok(pending.link, 'пока человек не подключился, ссылка видна администратору');
    assert.ok(before.some((row) => row.you), 'администратор видит себя в списке');

    const olga = await m.identity.upsertUser(m.pool, { id: 404040, first_name: 'Ольга' });
    await m.identity.bindInvite(olga, invite.code, { notify: false });
    const role = await m.handbook.memberRole(m.pool, ids.handbookId, olga);
    assert.equal(role, 'editor', 'после входа по ссылке человек — редактор справочника');

    const after = (await m.editor.listMembers(m.pool, admin)).find((row) => row.personId === invite.personId)!;
    assert.equal(after.connected, true);
    assert.equal(after.link, null);

    const editorScope = { handbook, role: 'editor' as const, personId: invite.personId, userId: olga.id };
    await assert.rejects(
      () => m.editor.inviteEditor(m.pool, editorScope, { fullName: 'Ещё один', kind: 'student', role: 'admin' }),
      /администратор/i,
      'редактор не раздаёт права',
    );
  });

  it('диплинк hb_<слаг> однозначен даже при многих демо-песочницах', async () => {
    const other = await m.identity.upsertUser(m.pool, { id: 575757, first_name: 'Глеб' });
    const otherIds = await m.demo.createDemoSandbox(other);
    assert.notEqual(otherIds.handbookSlug, ids.handbookSlug, 'у каждой песочницы свой слаг');
    const app = await m.api.buildApi();
    const guest = signed(747474, 'Гость3', `hb_${otherIds.handbookSlug}`);
    const home = await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-max-init-data': guest } });
    assert.equal(home.statusCode, 200, home.body);
    assert.equal(home.json().handbook.id, otherIds.handbookId, '/api/me выбирает справочник из диплинка');
    await app.close();
  });

  it('аудит: редактор не видит чужие ссылки-приглашения и не может «набрать» права', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const admin = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const adminInvite = await m.editor.inviteEditor(m.pool, admin, { fullName: 'Будущий Администратор', kind: 'staff', role: 'admin' });
    const editorInvite = await m.editor.inviteEditor(m.pool, admin, { fullName: 'Обычный Редактор', kind: 'student', role: 'editor' });
    const eve = await m.identity.upsertUser(m.pool, { id: 313131, first_name: 'Ева' });
    await m.identity.bindInvite(eve, editorInvite.code, { notify: false });
    const editorScope = { handbook, role: 'editor' as const, personId: editorInvite.personId, userId: eve.id };
    const seen = await m.editor.listMembers(m.pool, editorScope);
    assert.ok(seen.every((row) => row.link === null), 'редактору ссылки не показываются');
    await assert.rejects(() => m.identity.bindInvite(eve, adminInvite.code, { notify: false }), /уже подключён к этому вузу/);
    assert.equal(await m.handbook.memberRole(m.pool, ids.handbookId, eve), 'editor', 'права не выросли');

    // Аудиторию опубликованной страницы редактор без проверки не меняет
    const [page] = await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND slug = 'sessiya-i-brs'", [ids.handbookId]);
    await assert.rejects(() => m.editor.saveDraft(m.pool, editorScope, page!.id, { audience: { courses: [6] } }), /администратор/);
    // …а черновик текста — пожалуйста
    await m.editor.saveDraft(m.pool, editorScope, page!.id, { summary: 'Как считаются баллы и когда сессия' });
  });

  it('аудит: «на проверку» уходит каждому администратору, с комментарием', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const admin = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    await m.editor.addMember(m.pool, admin, ids.editorIds[1]!, 'admin');
    const editorScope = { handbook, role: 'editor' as const, personId: ids.editorIds[0]!, userId: user.id };
    const [page] = await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND slug = 'kuda-obratitsya'", [ids.handbookId]);
    await m.editor.saveDraft(m.pool, editorScope, page!.id, { summary: 'Кабинеты и часы приёма' });
    const result = await m.editor.submitForReview(m.pool, editorScope, page!.id, 'Проверьте часы приёма');
    const rows = await q<{ person_id: string; payload: { note: string | null } }>(
      "SELECT person_id, payload FROM notifications WHERE kind = 'handbook_review' AND payload->>'pageId' = $1",
      [page!.id],
    );
    assert.equal(rows.length, result.notified, 'каждому администратору — своё уведомление');
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((row) => row.payload.note === 'Проверьте часы приёма'));
  });

  it('аудит: ссылка на страницу вуза не уводит из справочника факультета', async () => {
    const [uniPage] = await q<{ id: string }>(
      "SELECT p.id FROM pages p JOIN handbooks h ON h.id = p.handbook_id WHERE h.id = (SELECT parent_id FROM handbooks WHERE id = $1) AND p.slug = 'spravka-v-voenkomat'",
      [ids.handbookId],
    );
    const viaLink = (await m.handbook.contextFor(user, { pageId: uniPage!.id }))!;
    assert.equal(viaLink.handbook.id, ids.handbookId, 'остаёмся в справочнике факультета');
    const opened = await m.handbook.getPage(m.pool, viaLink, uniPage!.id);
    assert.ok(opened.page.inherited, 'страница вуза открывается внутри справочника факультета');

    // Ссылка на страницу вуза, которую факультет переписал, открывает версию факультета
    const [overridden] = await q<{ id: string }>(
      "SELECT p.id FROM pages p WHERE p.handbook_id = (SELECT parent_id FROM handbooks WHERE id = $1) AND p.slug = 'spravka-ob-obuchenii'",
      [ids.handbookId],
    );
    const facultyVersion = await m.handbook.getPage(m.pool, viaLink, overridden!.id);
    assert.equal(facultyVersion.page.inherited, false);
    assert.match(facultyVersion.page.summary ?? '', /ИИТ/);
  });

  it('аудит: поиск не падает на служебных словах и находит опечатки', async () => {
    const fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const weird = await m.handbook.search(m.pool, fresh, 'constructor toString __proto__');
    assert.ok(Array.isArray(weird));
    const typo = await m.handbook.search(m.pool, fresh, 'общижитие');
    assert.ok(typo.some((hit) => hit.title === 'Заселение'), 'опечатка находит страницу общежития');
    assert.equal(typo[0]!.exact, false, 'и честно помечена как неточная');
    const nothing = await m.handbook.search(m.pool, fresh, 'военная кафедра');
    assert.ok(nothing.every((hit) => !hit.exact), 'случайное совпадение одного слова не выдаётся за точный ответ');
  });

  it('аудит: оценка и прогресс только для своих опубликованных страниц', async () => {
    const fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const stranger = await m.identity.upsertUser(m.pool, { id: 424242, first_name: 'Чужой' });
    const strangerSandbox = await m.demo.createDemoSandbox(stranger);
    const [foreign] = await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND status = 'published' LIMIT 1", [strangerSandbox.handbookId]);
    await assert.rejects(() => m.handbook.setFeedback(m.pool, fresh, foreign!.id, false, 'накрутка'), /не найдена/);
    await assert.rejects(() => m.handbook.setProgress(m.pool, fresh, foreign!.id, 'i1', true), /не найдена/);
  });

  it('аудит: вопрос из чата создаётся только когда пришёл текст', async () => {
    const fresh = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const before = (await q<{ n: number }>('SELECT count(*)::int AS n FROM handbook_questions WHERE reader_id = $1', [fresh.reader.id]))[0]!.n;
    await m.handbook.awaitChatQuestion(m.pool, fresh);
    const after = (await q<{ n: number }>('SELECT count(*)::int AS n FROM handbook_questions WHERE reader_id = $1', [fresh.reader.id]))[0]!.n;
    assert.equal(after, before, 'кнопка «Спросить дежурного» не создаёт пустой вопрос');
    const pending = await m.handbook.takeChatQuestion(m.pool, user.id);
    assert.equal(pending?.handbookId, ids.handbookId);
    assert.equal(await m.handbook.takeChatQuestion(m.pool, user.id), null, 'ожидание снимается после первого сообщения');
  });

  it('аудит: недозаполненный блок сохраняется в черновик, но не уходит на проверку', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const scope = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const section = (await q<{ id: string }>("SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'ucheba'", [ids.handbookId]))[0]!;
    const page = await m.editor.createPage(m.pool, scope, { sectionId: section.id, title: 'Черновик со сроком', blocks: [] });

    // Автосохранение с телефона: блок только что добавлен, название срока ещё не вписано
    const saved = await m.editor.saveDraft(m.pool, scope, page.id, {
      blocks: [{ id: 'd1', type: 'deadline', title: '', startsOn: '2027-03-01', remindDays: [3] }],
    });
    assert.ok(saved.issues.length > 0, 'черновик сохранён, а незаполненное перечислено');
    assert.match(saved.issues[0]!, /Срок \(блок 1\)/, 'подсказка называет блок, а не путь в JSON');

    await assert.rejects(() => m.editor.submitForReview(m.pool, scope, page.id, null), /заполните/i);
    await assert.rejects(() => m.editor.publishPage(m.pool, scope, page.id), /заполните|блок/i);
    const status = (await q<{ status: string }>('SELECT status FROM pages WHERE id = $1', [page.id]))[0]!;
    assert.equal(status.status, 'draft', 'страница осталась черновиком');

    const fixed = await m.editor.saveDraft(m.pool, scope, page.id, {
      blocks: [{ id: 'd1', type: 'deadline', title: 'Подать заявление', startsOn: '2027-03-01', remindDays: [3] }],
    });
    assert.deepEqual(fixed.issues, []);
    await m.editor.archivePage(m.pool, scope, page.id);
  });

  it('API: QR страницы (?page=) открывает её справочник, даже если читатель был в другом', async () => {
    const app = await m.api.buildApi();
    const [page] = await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND slug = 'sessiya-i-brs'", [ids.handbookId]);
    const reader = await m.identity.upsertUser(m.pool, { id: 848484, first_name: 'Лев' });
    const otherIds = await m.demo.createDemoSandbox(reader);
    const headers = { 'x-max-init-data': signed(848484, 'Лев') };
    const own = await app.inject({ method: 'GET', url: '/api/handbook', headers });
    assert.equal(own.json().handbook.id, otherIds.handbookId, 'без параметров — последний справочник читателя');

    const scanned = await app.inject({ method: 'GET', url: `/api/handbook?page=${page!.id}`, headers });
    assert.equal(scanned.statusCode, 200, scanned.body);
    assert.equal(scanned.json().handbook.id, ids.handbookId, 'справочник выбран по странице с плаката');

    const bad = await app.inject({ method: 'GET', url: '/api/handbook?page=not-a-uuid', headers });
    assert.equal(bad.statusCode, 400);
    await app.close();
  });
  it('аудит: правки опубликованной страницы на проверке не снимают её с публикации', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const admin = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const editorScope = { handbook, role: 'editor' as const, personId: ids.editorIds[0]!, userId: user.id };
    const section = (await q<{ id: string }>("SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'ucheba'", [ids.handbookId]))[0]!;
    const page = await m.editor.createPage(m.pool, admin, {
      sectionId: section.id,
      title: 'Где найти куратора',
      blocks: [{ id: 't1', type: 'text', text: 'Куратор принимает по вторникам в аудитории 214.' }],
    });
    await m.editor.publishPage(m.pool, admin, page.id);

    await m.editor.saveDraft(m.pool, editorScope, page.id, { blocks: [{ id: 't1', type: 'text', text: 'Куратор принимает по четвергам в аудитории 305.' }] });
    await m.editor.submitForReview(m.pool, editorScope, page.id, 'Поменялись часы приёма');

    const reader = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const live = await m.handbook.getPage(m.pool, reader, page.id);
    assert.match(JSON.stringify(live.page.blocks), /вторникам/, 'студент видит прежнюю версию, пока правки проверяют');
    const found = await m.handbook.search(m.pool, reader, 'куратор');
    assert.ok(found.some((hit) => hit.pageId === page.id), 'и находит её поиском');

    const structure = await m.editor.editorStructure(m.pool, admin);
    const listed = structure.flatMap((item) => item.pages).find((item) => item.id === page.id);
    assert.equal(listed?.status, 'review', 'администратор видит страницу в «Ждут проверки»');
    const render = await import('../src/notify/render.js');
    const [note] = await q<{ id: number; payload: Record<string, unknown>; person_id: string }>(
      "SELECT id, payload, person_id FROM notifications WHERE kind = 'handbook_review' AND payload->>'pageId' = $1 LIMIT 1",
      [page.id],
    );
    const text = await render.renderNotification(m.pool, { id: note!.id, kind: 'handbook_review', payload: note!.payload, person_id: note!.person_id, role: 'dean' }, { username: 'handbook_test_bot', userId: 900001 } as never);
    assert.ok(text, 'уведомление о проверке правок отправляется');

    await m.editor.publishPage(m.pool, admin, page.id);
    const updated = await m.handbook.getPage(m.pool, reader, page.id);
    assert.match(JSON.stringify(updated.page.blocks), /четвергам/, 'после публикации — новая версия');
    const [row] = await q<{ status: string; review_requested_at: Date | null }>('SELECT status, review_requested_at FROM pages WHERE id = $1', [page.id]);
    assert.equal(row!.status, 'published');
    assert.equal(row!.review_requested_at, null);
  });

  it('аудит: правка объявления не стирает сроки и адресность; даты проверяются', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const admin = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const [dates] = await q<{ today: string; later: string; future: string }>(
      `SELECT to_char((now() AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS today,
              to_char((now() AT TIME ZONE 'Europe/Moscow')::date + 10, 'YYYY-MM-DD') AS later,
              to_char((now() AT TIME ZONE 'Europe/Moscow')::date + 5, 'YYYY-MM-DD') AS future`,
    );
    const created = await m.editor.announce(m.pool, admin, {
      title: 'Заселение второкурсников', body: 'Заселение в общежитие № 3 — с понедельника.', audience: { courses: [2], dorm: true },
      startsOn: dates!.today, endsOn: dates!.later, notify: false,
    });
    await m.editor.updateAnnouncement(m.pool, admin, created.id, { title: 'Заселение третьекурсников', body: 'Заселение в общежитие № 3 — со вторника.', audience: { courses: [3] }, pageId: null });
    let [row] = await q<{ audience: Record<string, unknown>; starts_on: string; ends_on: string }>(
      "SELECT audience, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on FROM announcements WHERE id = $1",
      [created.id],
    );
    assert.deepEqual(row!.audience, { courses: [3], dorm: true }, 'курсы заменены, общежитие сохранилось');
    assert.equal(row!.ends_on, dates!.later, 'срок показа не стёрся');
    await m.editor.updateAnnouncement(m.pool, admin, created.id, { title: 'Заселение всех курсов', body: 'Заселение в общежитие № 3 — со вторника.' });
    [row] = await q("SELECT audience, to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM announcements WHERE id = $1", [created.id]);
    assert.deepEqual(row!.audience, { dorm: true }, '«все курсы» убирает только курсы');
    assert.equal(row!.starts_on, dates!.today);

    const bad = m.editor.announcementSchema.safeParse({ title: 'Собрание', body: 'Собрание старост', startsOn: '2026-02-30' });
    assert.ok(!bad.success && /календаре/.test(bad.error.issues[0]!.message), 'несуществующая дата — понятная ошибка');
    await assert.rejects(
      () => m.editor.announce(m.pool, admin, { title: 'Собрание', body: 'Собрание старост в пятницу', startsOn: dates!.later, endsOn: dates!.today }),
      /раньше/,
    );

    const future = await m.editor.announce(m.pool, admin, { title: 'Дни карьеры', body: 'Ярмарка вакансий в главном корпусе.', startsOn: dates!.future, notify: true });
    const [queued] = await q<{ n: number; soonest: Date | null }>(
      "SELECT count(*)::int AS n, min(send_after) AS soonest FROM notifications WHERE dedupe_key LIKE $1",
      [`hb_ann:${future.id}:%`],
    );
    assert.ok(queued!.n > 0);
    assert.ok(queued!.soonest!.getTime() > Date.now() + 3 * 86_400_000, 'объявление с будущей датой приходит в свой день');
    await m.editor.deleteAnnouncement(m.pool, admin, future.id);
    await m.editor.deleteAnnouncement(m.pool, admin, created.id);
  });

  it('аудит: двойное нажатие и одновременное первое открытие не ломают счётчики', async () => {
    const newcomer = await m.identity.upsertUser(m.pool, { id: 919191, first_name: 'Первокурсник' });
    const contexts = await Promise.all(Array.from({ length: 4 }, () => m.handbook.contextFor(newcomer, { handbookId: ids.handbookId })));
    assert.ok(contexts.every(Boolean), 'одновременные первые запросы не падают');
    const readers = await q('SELECT 1 FROM handbook_readers WHERE handbook_id = $1 AND user_id = $2', [ids.handbookId, newcomer.id]);
    assert.equal(readers.length, 1);

    const [page] = await q<{ id: string; helpful: number }>("SELECT id, helpful FROM pages WHERE handbook_id = $1 AND slug = 'sessiya-i-brs'", [ids.handbookId]);
    await Promise.all(Array.from({ length: 4 }, () => m.handbook.setFeedback(m.pool, contexts[0]!, page!.id, true, null)));
    const [after] = await q<{ helpful: number }>('SELECT helpful FROM pages WHERE id = $1', [page!.id]);
    assert.equal(after!.helpful, page!.helpful + 1, '«Помогла» от одного читателя считается один раз');
  });

  it('аудит: неверная дата в блоке «Срок» — подсказка редактору, а не сбой', () => {
    const issues = m.domain.publishIssues([{ id: 'd1', type: 'deadline', title: 'Подать заявление', startsOn: '2026-02-30' }]);
    assert.ok(issues.some((issue) => /календаре/.test(issue)), issues.join('; '));
    const reversed = m.domain.publishIssues([{ id: 'd1', type: 'deadline', title: 'Подать заявление', startsOn: '2026-10-20', endsOn: '2026-10-10' }]);
    assert.ok(reversed.some((issue) => /раньше даты начала/.test(issue)), reversed.join('; '));
  });

  it('напоминание о перенесённом сроке: дата срока входит в ключ', async () => {
    const handbook = (await m.handbook.findHandbook(m.pool, { id: ids.handbookId }))!;
    const scope = { handbook, role: 'admin' as const, personId: ids.deanId, userId: user.id };
    const section = (await q<{ id: string }>("SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'ucheba'", [ids.handbookId]))[0]!;
    const [due] = await q<{ d: string }>("SELECT to_char((now() AT TIME ZONE 'Europe/Moscow')::date + 2, 'YYYY-MM-DD') AS d");
    const page = await m.editor.createPage(m.pool, scope, {
      sectionId: section.id,
      title: 'Продление читательского билета',
      blocks: [{ id: 'r1', type: 'deadline', title: 'Продлить читательский билет', startsOn: due!.d, remindDays: [2] }],
    });
    await m.editor.publishPage(m.pool, scope, page.id);
    await m.handbook.updateProfile(m.pool, ctx.reader, { reminders: true });
    await m.worker.enqueueDeadlineReminders();
    const [row] = await q<{ dedupe_key: string }>(
      "SELECT n.dedupe_key FROM notifications n JOIN handbook_deadlines dl ON dl.id::text = n.payload->>'deadlineId' WHERE dl.page_id = $1 AND n.user_id = $2",
      [page.id, user.id],
    );
    assert.ok(row, 'напоминание поставлено');
    assert.ok(row!.dedupe_key.includes(`:${due!.d}:`), `в ключе дата срока: ${row!.dedupe_key}`);
  });

  it('демо: сроки отсчитываются от текущей даты, поэтому всегда впереди', async () => {
    const seed = await import('../src/services/demo-handbook.js');
    assert.equal(seed.demoDateShift('2026-09-20'), 0);
    assert.equal(seed.demoDateShift('2026-10-29'), 35);
    const [shifted] = seed.shiftDemoBlocks([{ id: 'x', type: 'deadline', title: 'Срок', startsOn: '2026-10-01', endsOn: '2026-10-15' }], 35);
    assert.deepEqual([(shifted as { startsOn: string }).startsOn, (shifted as { endsOn: string }).endsOn], ['2026-11-05', '2026-11-19']);
    const upcoming = await q("SELECT 1 FROM handbook_deadlines WHERE handbook_id = $1 AND COALESCE(ends_on, starts_on) >= current_date", [ids.handbookId]);
    assert.ok(upcoming.length >= 4, 'в свежем демо есть ближайшие сроки');
  });

  it('демо: смена роли и сброс одновременно не ломают песочницу', async () => {
    const visitor = await m.identity.upsertUser(m.pool, { id: 929292, first_name: 'Жюри-2' });
    const results = await Promise.allSettled([
      m.demo.setDemoRole(visitor, 'editor'),
      m.demo.createDemoSandbox(visitor, 'dean'),
      m.demo.setDemoRole(visitor, 'student'),
      m.demo.setDemoRole(visitor, 'dean'),
    ]);
    assert.deepEqual(results.filter((item) => item.status === 'rejected'), [], 'ни один запрос не упал');
    const sandboxes = await q('SELECT 1 FROM universities WHERE is_demo AND demo_owner_user_id = $1', [visitor.id]);
    assert.equal(sandboxes.length, 1, 'песочница одна');
    assert.ok(await m.demo.getDemoRole(m.pool, visitor.id));
  });

  it('API: ошибки проверки и «не найдено» — по-русски и без повторов', async () => {
    const app = await m.api.buildApi();
    const headers = { 'x-max-init-data': signed(515151, 'Анна'), 'content-type': 'application/json' };
    const bad = await app.inject({ method: 'POST', url: `/api/handbook-editor/announcements?handbookId=${ids.handbookId}`, headers, payload: { title: 'Собрание', body: 'Собрание старост', pageId: 'not-a-uuid' } });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.doesNotMatch(bad.json().error.message, /Invalid|Expected/, bad.json().error.message);
    const missing = await app.inject({ method: 'DELETE', url: `/api/handbook-editor/announcements/00000000-0000-4000-8000-000000000000?handbookId=${ids.handbookId}`, headers: { 'x-max-init-data': headers['x-max-init-data'] } });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.message, 'Объявление не найдено');
    const stale = await app.inject({ method: 'GET', url: '/api/handbook-editor/structure?handbookId=00000000-0000-4000-8000-000000000000', headers: { 'x-max-init-data': headers['x-max-init-data'] } });
    assert.equal(stale.statusCode, 404, 'устаревший id справочника не подменяется другим');
    await app.close();
  });

  // ─── Исправления по QA 25.09 ───

  const adminScope = async (handbookId = ids.handbookId, personId = ids.deanId, userId = user.id) => ({
    handbook: (await m.handbook.findHandbook(m.pool, { id: handbookId }))!,
    role: 'admin' as const,
    personId,
    userId,
  });
  const sectionId = async (handbookId = ids.handbookId, slug = 'ucheba') =>
    (await q<{ id: string }>('SELECT id FROM sections WHERE handbook_id = $1 AND slug = $2', [handbookId, slug]))[0]!.id;
  const mskDate = async (days: number) =>
    (await q<{ d: string }>("SELECT to_char((now() AT TIME ZONE 'Europe/Moscow')::date + $1::int, 'YYYY-MM-DD') AS d", [days]))[0]!.d;

  it('API-6: из демо настоящее сообщение получает только владелец песочницы', async () => {
    const owner = await m.identity.upsertUser(m.pool, { id: 606001, first_name: 'Владелец' });
    const sandbox = await m.demo.createDemoSandbox(owner, 'dean');
    const stranger = await m.identity.upsertUser(m.pool, { id: 606002, first_name: 'Посторонний' });
    // Посторонний открыл справочник чужой песочницы по ссылке hb_<слаг>
    const strangerCtx = (await m.handbook.contextFor(stranger, { slug: sandbox.handbookSlug }))!;
    assert.equal(strangerCtx.handbook.id, sandbox.handbookId);
    const admin = await adminScope(sandbox.handbookId, sandbox.deanId, owner.id);

    // Объявление
    const ann = await m.editor.announce(m.pool, admin, { title: 'Срочно: подтвердите стипендию', body: 'Перейдите по ссылке и введите данные карты', notify: true });
    const rows = await q<{ user_id: number; simulated: boolean }>('SELECT user_id, simulated FROM notifications WHERE dedupe_key LIKE $1', [`hb_ann:${ann.id}:%`]);
    assert.deepEqual(rows.filter((row) => !row.simulated).map((row) => row.user_id), [owner.id], 'по-настоящему — только владельцу');
    assert.ok(rows.some((row) => row.user_id === stranger.id && row.simulated), 'постороннему — имитация');

    // Ответ дежурного
    const question = await m.handbook.askQuestion(m.pool, strangerCtx, 'Как подтвердить стипендию?', null);
    await m.editor.answerQuestion(m.pool, admin, question.id, 'Это демо, ничего подтверждать не нужно', null);
    const [answer] = await q<{ simulated: boolean }>('SELECT simulated FROM notifications WHERE dedupe_key = $1', [`hb_answer:${question.id}`]);
    assert.equal(answer!.simulated, true, 'ответ постороннему — имитация');

    // Запрос проверки: администратор, приглашённый из демо чужим аккаунтом, настоящего сообщения не получает
    const invite = await m.editor.inviteEditor(m.pool, admin, { fullName: 'Чужой Администратор', kind: 'staff', role: 'admin' });
    await m.identity.bindInvite(stranger, invite.code, { notify: false });
    const editorScope = { ...admin, role: 'editor' as const, personId: sandbox.editorIds[0]! };
    const page = await m.editor.createPage(m.pool, editorScope, { sectionId: await sectionId(sandbox.handbookId), title: 'Проверка из демо', blocks: [{ id: 't1', type: 'text', text: 'Текст страницы' }] });
    await m.editor.submitForReview(m.pool, editorScope, page.id, null);
    const reviews = await q<{ person_id: string; simulated: boolean; status: string }>(
      "SELECT person_id, simulated, status FROM notifications WHERE kind = 'handbook_review' AND payload->>'pageId' = $1",
      [page.id],
    );
    assert.equal(reviews.find((row) => row.person_id === invite.personId)?.simulated, true, 'приглашённому посторонний аккаунт — имитация');
    assert.equal(reviews.find((row) => row.person_id === sandbox.deanId)?.simulated, false, 'владелец — по-настоящему');

    // Напоминание о сроке
    const deadlinePage = await m.editor.createPage(m.pool, admin, {
      sectionId: await sectionId(sandbox.handbookId),
      title: 'Срок из демо',
      blocks: [{ id: 'd1', type: 'deadline', title: 'Подать заявку из демо', startsOn: await mskDate(3), remindDays: [3] }],
    });
    await m.editor.publishPage(m.pool, admin, deadlinePage.id);
    await m.worker.enqueueDeadlineReminders();
    const reminders = await q<{ user_id: number; simulated: boolean }>(
      "SELECT n.user_id, n.simulated FROM notifications n JOIN handbook_deadlines dl ON dl.id::text = n.payload->>'deadlineId' WHERE dl.page_id = $1",
      [deadlinePage.id],
    );
    assert.ok(reminders.some((row) => row.user_id === owner.id && !row.simulated), 'владельцу напоминание по-настоящему');
    assert.ok(reminders.some((row) => row.user_id === stranger.id && row.simulated), 'постороннему — имитация');
    assert.equal(reminders.filter((row) => !row.simulated).length, 1);
  });

  it('API-19, APP-22: объявление вуза доходит до читателей факультетов, флажок сроков его не глушит', async () => {
    const [uni] = await q<{ id: string }>('SELECT parent_id AS id FROM handbooks WHERE id = $1', [ids.handbookId]);
    const admin = await adminScope(uni!.id);
    await m.handbook.updateProfile(m.pool, ctx.reader, { course: 1, reminders: false });
    const all = await m.editor.announce(m.pool, admin, { title: 'Для всего университета', body: 'Главный корпус закрыт в субботу.', notify: true });
    const mine = await q<{ reader_id: string }>('SELECT reader_id FROM notifications WHERE dedupe_key LIKE $1 AND user_id = $2', [`hb_ann:${all.id}:%`, user.id]);
    assert.equal(mine.length, 1, 'читатель ИИТ получает объявление вуза один раз');
    assert.equal(mine[0]!.reader_id, ctx.reader.id);
    assert.ok(all.notified > 1, `рассылка не пустая: ${all.notified}`);

    const fourth = await m.editor.announce(m.pool, admin, { title: 'Для четвёртого курса', body: 'Собрание выпускников в пятницу.', audience: { courses: [4] }, notify: true });
    const notMine = await q('SELECT 1 FROM notifications WHERE dedupe_key LIKE $1 AND user_id = $2', [`hb_ann:${fourth.id}:%`, user.id]);
    assert.equal(notMine.length, 0, 'аудитория учитывается');
    await m.handbook.updateProfile(m.pool, ctx.reader, { reminders: true });
    await m.editor.deleteAnnouncement(m.pool, admin, all.id);
    await m.editor.deleteAnnouncement(m.pool, admin, fourth.id);
  });

  it('WRK-1: перенос даты начала объявления переносит и рассылку', async () => {
    const admin = await adminScope();
    const later = await mskDate(10);
    const sooner = await mskDate(2);
    const created = await m.editor.announce(m.pool, admin, { title: 'Выдача студенческих', body: 'Студенческие выдают в каб. 121.', startsOn: later, notify: true });
    const sendAfter = async () =>
      (await q<{ soonest: Date; latest: Date }>("SELECT min(send_after) AS soonest, max(send_after) AS latest FROM notifications WHERE dedupe_key LIKE $1 AND status = 'pending'", [`hb_ann:${created.id}:%`]))[0]!;
    const expected = (day: string) => new Date(`${day}T07:00:00Z`).getTime(); // 10:00 по Москве
    assert.equal((await sendAfter()).soonest.getTime(), expected(later));

    await m.editor.updateAnnouncement(m.pool, admin, created.id, { title: 'Выдача студенческих', body: 'Студенческие выдают в каб. 121.', startsOn: sooner });
    let after = await sendAfter();
    assert.equal(after.soonest.getTime(), expected(sooner), 'на раньше — приходит в новый день');
    assert.equal(after.latest.getTime(), expected(sooner));

    await m.editor.updateAnnouncement(m.pool, admin, created.id, { title: 'Выдача студенческих', body: 'Студенческие выдают в каб. 121.', startsOn: null });
    after = await sendAfter();
    assert.ok(after.latest.getTime() <= Date.now() + 1000, 'без даты начала — сразу');
    await m.editor.deleteAnnouncement(m.pool, admin, created.id);
  });

  it('APP-16: лента объявлений ссылается только на опубликованную страницу', async () => {
    const admin = await adminScope();
    const page = await m.editor.createPage(m.pool, admin, { sectionId: await sectionId(), title: 'Страница для объявления', blocks: [{ id: 't1', type: 'text', text: 'Подробности объявления.' }] });
    await m.editor.publishPage(m.pool, admin, page.id);
    const ann = await m.editor.announce(m.pool, admin, { title: 'Объявление со ссылкой', body: 'Подробнее — на странице.', pageId: page.id, notify: false });
    let feed = await m.handbook.announcementsFeed(m.pool, (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!);
    assert.equal(feed.active.find((item) => item.id === ann.id)?.pageId, page.id);
    await m.editor.archivePage(m.pool, admin, page.id);
    feed = await m.handbook.announcementsFeed(m.pool, (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!);
    const item = feed.active.find((row) => row.id === ann.id);
    assert.ok(item, 'объявление осталось');
    assert.equal(item!.pageId, null, 'ссылки на архивную страницу нет');
    await m.editor.deleteAnnouncement(m.pool, admin, ann.id);
  });

  it('BOT-1: сленг в любой словоформе и примеры из приветствия бота находят нужные страницы', async () => {
    await m.handbook.updateProfile(m.pool, ctx.reader, { course: 1, dorm: true });
    const reader = (await m.handbook.contextFor(user, { handbookId: ids.handbookId }))!;
    const synonyms = reader.handbook.settings?.synonyms ?? {};
    // Словоформы сводятся к тому же, что и начальная форма
    const same: Array<[string, string]> = [
      ['что с физрой', 'что с физра'],
      ['как закрыть физру', 'как закрыть физра'],
      ['физры нет, что делать', 'физра нет, что делать'],
      ['общаги', 'общага'],
      ['общагу когда дают', 'общага когда дают'],
      ['как заселиться в общагу', 'как заселиться в общага'],
      ['стипухи', 'стипуха'],
      ['хвостов', 'хвосты'],
      ['пересдачи', 'пересдача'],
    ];
    for (const [form, base] of same) {
      assert.equal(m.domain.normalizeQuery(form, synonyms), m.domain.normalizeQuery(base, synonyms), form);
    }
    // Настоящие слова не принимаются за сленг
    assert.equal(m.domain.normalizeQuery('академия'), 'академия');
    assert.equal(m.domain.normalizeQuery('стипендия'), 'стипендия');

    // Примеры из приветствия справочника и /help (bot/index.ts) и словоформы из находки BOT-1
    const expected: Array<[string, string]> = [
      ['как получить справку', 'spravka-ob-obuchenii'],
      ['когда сессия', 'sessiya-i-brs'],
      ['что с физрой', 'kak-poluchit-zachet'],
      ['где взять справку об обучении', 'spravka-ob-obuchenii'],
      ['физра отработки', 'kak-poluchit-zachet'],
      ['общага оплата', 'oplata-i-pravila'],
      ['как получить справку об обучении', 'spravka-ob-obuchenii'],
      ['как закрыть физру', 'kak-poluchit-zachet'],
      ['физры нет, что делать', 'kak-poluchit-zachet'],
      ['общаги', 'zaselenie'],
      ['общагу когда дают', 'zaselenie'],
      ['как заселиться в общагу', 'zaselenie'],
      ['хвостов', 'akademicheskie-zadolzhennosti'],
    ];
    const misses: string[] = [];
    for (const [query, slug] of expected) {
      const hits = await m.handbook.search(m.pool, reader, query, 3);
      if (!hits.some((hit) => hit.slug === slug)) misses.push(`${query} → ${hits.map((hit) => hit.slug).join(', ') || 'ничего'}`);
    }
    assert.deepEqual(misses, [], 'каждый пример находит свою страницу в первых трёх результатах');
    // Выдача по словоформе та же, что по начальной форме, и не пустая
    for (const [form, base] of same) {
      const [a, b] = await Promise.all([m.handbook.search(m.pool, reader, form), m.handbook.search(m.pool, reader, base)]);
      assert.ok(a.length > 0, `${form}: ничего не нашлось`);
      assert.deepEqual(a.map((hit) => hit.pageId), b.map((hit) => hit.pageId), form);
    }
  });

  it('API-8, APP-5 (C7): в ссылках блоков только https, в «Чате в MAX» — только https://max.ru/', async () => {
    const issues = (block: Record<string, unknown>) => m.domain.publishIssues([{ id: 'b1', ...block }]);
    for (const url of ['javascript:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'intent://scan/#Intent;end', 'http://evil.example', 'https://max.ru@evil.example/', 'example.com']) {
      assert.ok(issues({ type: 'link', title: 'Ссылка', url }).some((issue) => /https:\/\//.test(issue)), `link: ${url}`);
      assert.ok(issues({ type: 'file', title: 'Файл', url }).length > 0, `file: ${url}`);
      assert.ok(issues({ type: 'place', title: 'Корпус', mapLink: url }).length > 0, `place: ${url}`);
      assert.ok(issues({ type: 'contact', name: 'Деканат', maxLink: url }).length > 0, `contact: ${url}`);
      assert.ok(issues({ type: 'chat', title: 'Чат', url }).length > 0, `chat: ${url}`);
    }
    assert.deepEqual(issues({ type: 'link', title: 'Расписание', url: 'https://example.edu/schedule' }), []);
    assert.deepEqual(issues({ type: 'chat', title: 'Чат курса', url: 'https://max.ru/join/abc' }), []);
    assert.match(issues({ type: 'chat', title: 'Чат курса', url: 'https://example.com/join' }).join(), /https:\/\/max\.ru\//, 'чат — только на max.ru');
    assert.deepEqual(issues({ type: 'place', title: 'Корпус', mapLink: '' }), [], 'пустая необязательная ссылка — всё равно что нет');

    // И через публикацию: небезопасная ссылка не доходит до студента
    const admin = await adminScope();
    const page = await m.editor.createPage(m.pool, admin, { sectionId: await sectionId(), title: 'Опасная ссылка', blocks: [{ id: 'l1', type: 'link', title: 'Жми', url: 'javascript:alert(1)' }] });
    await assert.rejects(() => m.editor.publishPage(m.pool, admin, page.id), /https:\/\//);
    await m.editor.archivePage(m.pool, admin, page.id);
  });

  it('APP-4 (C6): пустой заголовок инструкции и чеклиста не мешает публикации, ошибки называют поля как в форме', async () => {
    const steps = { id: 's1', type: 'steps', title: '', items: [{ id: 'a1', text: 'Зайти в деканат' }] };
    const checklist = { id: 'c1', type: 'checklist', title: '  ', items: [{ id: 'a2', text: 'Получить пропуск' }] };
    assert.deepEqual(m.domain.publishIssues([steps, checklist]), [], 'заголовок у этих блоков необязательный');
    const parsed = m.domain.blocksSchema.parse([steps, checklist]) as Array<{ title?: string }>;
    assert.ok(parsed.every((block) => block.title === undefined), 'пустой заголовок считается отсутствующим');

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ type: 'steps', items: [{ id: 'x', text: '' }] }, /Пошаговая инструкция \(блок 1\): Шаг 1: впишите, что сделать/],
      [{ type: 'checklist', items: [{ id: 'x', text: '' }] }, /Чеклист \(блок 1\): Пункт 1: впишите, что нужно сделать/],
      [{ type: 'faq', items: [{ id: 'x', question: '', answer: 'Ответ' }] }, /Вопросы и ответы \(блок 1\): Вопрос 1: заполните вопрос/],
      [{ type: 'faq', items: [{ id: 'x', question: 'Вопрос?', answer: '' }] }, /\(блок 1\): Вопрос 1: заполните ответ/],
      [{ type: 'contact', name: '' }, /Контакт \(блок 1\): Заполните поле «Кто»/],
      [{ type: 'deadline', title: '', startsOn: '2027-01-10' }, /Срок \(блок 1\): Заполните, что нужно успеть/],
      [{ type: 'glossary', items: [{ id: 'x', term: 'БРС', meaning: '' }] }, /\(блок 1\): Термин 1: заполните, что значит термин/],
      [{ type: 'link', title: 'Расписание', url: '' }, /Ссылка \(блок 1\): Вставьте ссылку/],
    ];
    for (const [block, expected] of cases) {
      const found = m.domain.publishIssues([{ id: 'b1', ...block }]);
      assert.ok(found.some((issue) => expected.test(issue)), `${expected}: ${found.join('; ')}`);
      // Конструктор находит блок по «(блок N): …» — формат должен сохраняться
      assert.ok(found.every((issue) => /\(блок \d+\):\s*.+$/.test(issue)), found.join('; '));
      assert.ok(found.every((issue) => !/Заполните название/.test(issue)), `нет «название» там, где его нет в форме: ${found.join('; ')}`);
    }
    // Очищенная дата срока — одна понятная ошибка, а не две про формат
    const emptyDate = m.domain.publishIssues([{ id: 'd1', type: 'deadline', title: 'Подать заявление', startsOn: '' }]);
    assert.deepEqual(emptyDate, ['Срок (блок 1): Укажите дату начала']);
    // Слишком длинное поле — с названием поля
    const long = m.domain.publishIssues([{ id: 'p1', type: 'place', title: 'Корпус', howTo: 'я'.repeat(601) }]);
    assert.match(long.join(), /«Как найти» — не длиннее 600 символов/);
  });

  it('API-14: год вне 1900–2100 — ошибка проверки, а не сбой', async () => {
    for (const value of ['0000-01-01', '0202-09-01', '1899-12-31', '2101-01-01']) {
      const result = m.domain.calendarDate.safeParse(value);
      assert.ok(!result.success && /год/.test(result.error.issues[0]!.message), value);
    }
    assert.ok(m.domain.calendarDate.safeParse('2026-09-01').success);
    const admin = await adminScope();
    assert.throws(() => m.editor.announcementSchema.parse({ title: 'Собрание', body: 'Собрание старост', startsOn: '0000-01-01' }), /год/);
    const page = await m.editor.createPage(m.pool, admin, { sectionId: await sectionId(), title: 'Древний срок', blocks: [{ id: 'd1', type: 'deadline', title: 'Срок', startsOn: '0000-01-01' }] });
    await assert.rejects(() => m.editor.publishPage(m.pool, admin, page.id), (error: Error & { status?: number }) => error.status === 400 && /год/.test(error.message));
    await m.editor.archivePage(m.pool, admin, page.id);
  });

  it('API-15: одинаковые id блоков и пунктов — понятная ошибка проверки', () => {
    const blocks = [
      { id: 'same', type: 'deadline', title: 'Первый срок', startsOn: '2026-11-01' },
      { id: 'same', type: 'deadline', title: 'Второй срок', startsOn: '2026-12-01' },
    ];
    assert.match(m.domain.publishIssues(blocks).join(), /Срок \(блок 2\): Повторяется идентификатор блока «same»/);
    const items = [
      { id: 'c1', type: 'checklist', items: [{ id: 'i1', text: 'Пропуск' }] },
      { id: 's1', type: 'steps', items: [{ id: 'i1', text: 'Студенческий' }] },
    ];
    assert.match(m.domain.publishIssues(items).join(), /Пошаговая инструкция \(блок 2\): Шаг 1: повторяется идентификатор «i1»/);
    const faq = [{ id: 'f1', type: 'faq', items: [{ id: 'q', question: 'Раз?', answer: 'Да' }, { id: 'q', question: 'Два?', answer: 'Да' }] }];
    assert.equal(m.domain.publishIssues(faq).length, 1);
  });

  it('APP-25, APP-19 (C9): пустую страницу и нетронутую заготовку шаблона не опубликовать', async () => {
    const admin = await adminScope();
    const empty = await m.editor.createPage(m.pool, admin, { sectionId: await sectionId(), title: 'Пустая страница QA', blocks: [] });
    const opened = await m.editor.pageForEditor(m.pool, admin, empty.id);
    assert.deepEqual(opened.issues, ['Добавьте хотя бы один блок'], 'редактор сразу видит, почему нельзя опубликовать');
    await assert.rejects(() => m.editor.publishPage(m.pool, admin, empty.id), (error: Error & { status?: number }) => error.status === 400 && /хотя бы один блок/.test(error.message));
    await assert.rejects(() => m.editor.submitForReview(m.pool, admin, empty.id, null), /хотя бы один блок/);
    await m.editor.archivePage(m.pool, admin, empty.id);

    // Новый справочник из шаблона: заготовка «Стипендии» с подсказкой вместо текста
    const [dean] = await q<{ university_id: string }>('SELECT university_id FROM persons WHERE id = $1', [ids.deanId]);
    const [institute] = await q<{ id: string }>('SELECT id FROM institutes WHERE university_id = $1', [dean!.university_id]);
    const created = await m.editor.createHandbook({ personId: ids.deanId, userId: user.id, universityId: dean!.university_id, role: 'dean' }, { instituteId: institute!.id, title: 'QA Справочник ФизМат' });
    const [handbookRow] = await q<{ id: string }>('SELECT id FROM handbooks WHERE slug = $1', [created.slug]);
    const scope = await adminScope(handbookRow!.id);
    const [draft] = await q<{ id: string; draft_blocks: Array<{ id: string; text: string }> }>(
      "SELECT id, draft_blocks FROM pages WHERE handbook_id = $1 AND draft_blocks->0->>'id' = 'hint' ORDER BY position LIMIT 1",
      [handbookRow!.id],
    );
    const editorView = await m.editor.pageForEditor(m.pool, scope, draft!.id);
    assert.match(editorView.issues.join(), /Замените подсказку шаблона/);
    await assert.rejects(() => m.editor.publishPage(m.pool, scope, draft!.id), /Замените подсказку шаблона/);
    // Редактор добавил свой блок, но подсказку оставил — всё ещё нельзя
    const hintBlock = draft!.draft_blocks[0]!;
    await m.editor.saveDraft(m.pool, scope, draft!.id, { blocks: [hintBlock, { id: 't2', type: 'text', text: 'Академическая стипендия — с оценками «хорошо» и «отлично».' }] as never });
    await assert.rejects(() => m.editor.publishPage(m.pool, scope, draft!.id), /Замените подсказку шаблона/);
    // Заменил подсказку своим текстом — можно
    const saved = await m.editor.saveDraft(m.pool, scope, draft!.id, { blocks: [{ id: 'hint', type: 'text', text: 'Стипендии назначает стипендиальная комиссия раз в семестр.' }] });
    assert.deepEqual(saved.issues, []);
    await m.editor.publishPage(m.pool, scope, draft!.id);
    const [version] = await q<{ note: string | null }>('SELECT note FROM page_versions WHERE page_id = $1', [draft!.id]);
    assert.equal(version!.note, null, 'подсказка шаблона не становится комментарием к версии');
  });

  it('API-16 (C1): правка по устаревшей версии страницы — 409, ответ дежурного в FAQ не теряется', async () => {
    const app = await m.api.buildApi();
    const headers = { 'x-max-init-data': signed(515151, 'Анна'), 'content-type': 'application/json' };
    const admin = await adminScope();
    const page = await m.editor.createPage(m.pool, admin, { sectionId: await sectionId(), title: 'Страница для правки вдвоём', blocks: [{ id: 't1', type: 'text', text: 'Первый текст' }] });
    const url = `/api/handbook-editor/pages/${page.id}?handbookId=${ids.handbookId}`;
    const opened = await app.inject({ method: 'GET', url, headers });
    assert.equal(opened.statusCode, 200, opened.body);
    const base = opened.json().updatedAt as string;
    assert.match(base, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/, 'версия — ISO-строка времени последнего изменения');
    assert.equal(opened.json().page.updatedAt, base);

    // С той же версией — сохраняется и отдаёт новую
    const text = (value: string) => [{ id: 't1', type: 'text', text: value }];
    const saved = await app.inject({ method: 'PATCH', url, headers, payload: { blocks: text('Правка редактора'), baseUpdatedAt: base } });
    assert.equal(saved.statusCode, 200, saved.body);
    const next = saved.json().updatedAt as string;
    assert.ok(next && next !== base, 'после сохранения — новая версия');

    // Тем временем дежурный добавил ответ в FAQ этой страницы
    const asker = await m.identity.upsertUser(m.pool, { id: 616001, first_name: 'Вопрос' });
    const askerCtx = (await m.handbook.contextFor(asker, { handbookId: ids.handbookId }))!;
    const question = await m.handbook.askQuestion(m.pool, askerCtx, 'Можно ли распечатать курсовую в библиотеке?', null);
    await m.editor.answerQuestion(m.pool, admin, question.id, 'Да, в читальном зале, по студенческому.', page.id);

    const stale = await app.inject({ method: 'PATCH', url, headers, payload: { blocks: text('Правка поверх чужой'), baseUpdatedAt: next } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual(stale.json().error, { code: 'page_conflict', message: 'Страницу уже изменил другой участник команды. Обновите её, чтобы не потерять правки.' });
    const [draft] = await q<{ draft_blocks: Array<{ type: string }> }>('SELECT draft_blocks FROM pages WHERE id = $1', [page.id]);
    assert.ok(draft!.draft_blocks.some((block) => block.type === 'faq'), 'ответ дежурного остался в черновике');

    // Публикация по устаревшей версии — тоже 409; по свежей — публикуется
    const stalePublish = await app.inject({ method: 'POST', url: `/api/handbook-editor/pages/${page.id}/publish?handbookId=${ids.handbookId}`, headers, payload: { baseUpdatedAt: next } });
    assert.equal(stalePublish.statusCode, 409, stalePublish.body);
    assert.equal(stalePublish.json().error.code, 'page_conflict');
    const fresh = (await app.inject({ method: 'GET', url, headers })).json().updatedAt as string;
    // Время с точностью до миллисекунд (клиент переформатировал через Date) тоже принимается
    const msPrecision = new Date(fresh).toISOString();
    const published = await app.inject({ method: 'POST', url: `/api/handbook-editor/pages/${page.id}/publish?handbookId=${ids.handbookId}`, headers, payload: { baseUpdatedAt: msPrecision } });
    assert.equal(published.statusCode, 200, published.body);
    assert.ok(published.json().updatedAt);

    // Без baseUpdatedAt — как раньше; мусор вместо версии — понятная ошибка проверки
    const legacy = await app.inject({ method: 'PATCH', url, headers, payload: { summary: 'Без версии' } });
    assert.equal(legacy.statusCode, 200, legacy.body);
    const garbage = await app.inject({ method: 'PATCH', url, headers, payload: { summary: 'С мусором', baseUpdatedAt: 'вчера' } });
    assert.equal(garbage.statusCode, 400);
    assert.match(garbage.json().error.message, /Обновите страницу/);
    await app.close();
  });

  it('APP-11 (C2), C3: администратор возвращает страницу на доработку с причиной', async () => {
    const app = await m.api.buildApi();
    const headers = { 'x-max-init-data': signed(515151, 'Анна'), 'content-type': 'application/json' };
    const admin = await adminScope();
    const editorScope = { ...admin, role: 'editor' as const, personId: ids.editorIds[0]! };
    const page = await m.editor.createPage(m.pool, editorScope, { sectionId: await sectionId(), title: 'Страница на доработку', blocks: [{ id: 't1', type: 'text', text: 'Черновой текст' }] });
    const returnUrl = `/api/handbook-editor/pages/${page.id}/return?handbookId=${ids.handbookId}`;
    const pageUrl = `/api/handbook-editor/pages/${page.id}?handbookId=${ids.handbookId}`;

    // Не на проверке — возвращать нечего
    const early = await app.inject({ method: 'POST', url: returnUrl, headers, payload: {} });
    assert.equal(early.statusCode, 409, early.body);
    assert.equal(early.json().error.code, 'not_in_review');

    // C3: комментарий к проверке — поле note
    const review = await app.inject({ method: 'POST', url: `/api/handbook-editor/pages/${page.id}/review?handbookId=${ids.handbookId}`, headers, payload: { note: 'Проверьте, пожалуйста, часы работы' } });
    assert.equal(review.statusCode, 200, review.body);
    assert.equal((await app.inject({ method: 'GET', url: pageUrl, headers })).json().page.note, 'Проверьте, пожалуйста, часы работы');
    await assert.rejects(() => m.editor.returnPage(m.pool, editorScope, page.id, null), (error: Error & { status?: number }) => error.status === 403);
    const tooLong = await app.inject({ method: 'POST', url: returnUrl, headers, payload: { note: 'я'.repeat(501) } });
    assert.equal(tooLong.statusCode, 400);

    // Последним на проверку отправил редактор — сообщение о возврате получает он
    await m.editor.submitForReview(m.pool, editorScope, page.id, null);
    const returned = await app.inject({ method: 'POST', url: returnUrl, headers, payload: { note: 'Добавьте часы работы и кабинет' } });
    assert.equal(returned.statusCode, 200, returned.body);
    assert.equal(returned.json().ok, true);
    const [row] = await q<{ status: string; review_requested_at: Date | null }>('SELECT status, review_requested_at FROM pages WHERE id = $1', [page.id]);
    assert.equal(row!.status, 'draft', 'черновик снова черновик');
    assert.equal(row!.review_requested_at, null);
    const view = (await app.inject({ method: 'GET', url: pageUrl, headers })).json();
    assert.equal(view.returnNote, 'Добавьте часы работы и кабинет');
    assert.equal(view.page.returnNote, 'Добавьте часы работы и кабинет');
    assert.ok(view.returnedAt);
    assert.equal(view.page.status, 'draft');
    const notices = await q<{ person_id: string; payload: { note: string } }>("SELECT person_id, payload FROM notifications WHERE kind = 'handbook_return' AND payload->>'pageId' = $1", [page.id]);
    assert.deepEqual(notices.map((n) => [n.person_id, n.payload.note]), [[ids.editorIds[0], 'Добавьте часы работы и кабинет']]);
    const again = await app.inject({ method: 'POST', url: returnUrl, headers, payload: {} });
    assert.equal(again.statusCode, 409, 'повторный возврат — не на проверке');

    // Правка причину не стирает, новая отправка на проверку — стирает
    await m.editor.saveDraft(m.pool, editorScope, page.id, { blocks: [{ id: 't1', type: 'text', text: 'Кабинет 121, с 10 до 17' }] });
    assert.equal((await m.editor.pageForEditor(m.pool, admin, page.id)).returnNote, 'Добавьте часы работы и кабинет');
    await m.editor.submitForReview(m.pool, editorScope, page.id, null);
    const resubmitted = await m.editor.pageForEditor(m.pool, admin, page.id);
    assert.equal(resubmitted.returnNote, null);
    assert.equal(resubmitted.returnedAt, null);

    // Опубликованная страница с правками на проверке: возврат снимает проверку, студенты видят прежнюю версию
    await m.editor.publishPage(m.pool, admin, page.id);
    await m.editor.saveDraft(m.pool, editorScope, page.id, { blocks: [{ id: 't1', type: 'text', text: 'Новые часы: с 9 до 18' }] });
    await m.editor.submitForReview(m.pool, editorScope, page.id, null);
    assert.equal((await m.editor.pageForEditor(m.pool, admin, page.id)).page.status, 'review');
    await m.editor.returnPage(m.pool, admin, page.id, null);
    const [published] = await q<{ status: string; review_requested_at: Date | null; blocks: Array<{ text: string }>; return_note: string | null }>(
      'SELECT status, review_requested_at, blocks, return_note FROM pages WHERE id = $1',
      [page.id],
    );
    assert.equal(published!.status, 'published', 'опубликованная версия остаётся у студентов');
    assert.equal(published!.review_requested_at, null);
    assert.equal(published!.blocks[0]!.text, 'Кабинет 121, с 10 до 17');
    const afterReturn = await m.editor.pageForEditor(m.pool, admin, page.id);
    assert.equal(afterReturn.page.status, 'published');
    assert.equal(afterReturn.returnNote, null, 'без причины — null');
    assert.ok(afterReturn.returnedAt, 'но видно, что вернули');
    // Публикация стирает отметку о возврате
    await m.editor.publishPage(m.pool, admin, page.id);
    assert.equal((await m.editor.pageForEditor(m.pool, admin, page.id)).returnedAt, null);
    await m.editor.archivePage(m.pool, admin, page.id);
    await app.close();
  });

  it('WRK-2, API-10: сроки видны тем, кому видна страница; смена аудитории страницы сразу меняет календарь и напоминания', async () => {
    const admin = await adminScope();
    const second = await m.identity.upsertUser(m.pool, { id: 626001, first_name: 'Второкурсник' });
    let secondCtx = (await m.handbook.contextFor(second, { handbookId: ids.handbookId }))!;
    await m.handbook.updateProfile(m.pool, secondCtx.reader, { course: 2, dorm: true, reminders: true });
    secondCtx = (await m.handbook.contextFor(second, { handbookId: ids.handbookId }))!;
    const due = await mskDate(3);
    const page = await m.editor.createPage(m.pool, admin, {
      sectionId: await sectionId(),
      title: 'Сроки первого курса',
      audience: { courses: [1] },
      blocks: [
        { id: 'd1', type: 'deadline', title: 'Сдать анкету первокурсника', startsOn: due, remindDays: [3] },
        { id: 'd2', type: 'deadline', title: 'Заселиться в общежитие', startsOn: due, remindDays: [3], audience: { dorm: true } },
      ],
    });
    await m.editor.publishPage(m.pool, admin, page.id);
    const stored = await q<{ block_id: string; audience: unknown }>('SELECT block_id, audience FROM handbook_deadlines WHERE page_id = $1 ORDER BY block_id', [page.id]);
    assert.deepEqual(stored.map((row) => [row.block_id, row.audience]), [['d1', {}], ['d2', { dorm: true }]], 'в сроке — только аудитория блока');
    const titles = async () => (await m.handbook.upcomingDeadlines(m.pool, secondCtx)).filter((d) => d.pageId === page.id).map((d) => d.title).sort();
    assert.deepEqual(await titles(), [], 'второкурснику страница не видна — и сроки тоже');

    // Администратор расширил аудиторию страницы — сразу, без новой публикации
    await m.editor.saveDraft(m.pool, admin, page.id, { audience: {} });
    assert.deepEqual(await titles(), ['Заселиться в общежитие', 'Сдать анкету первокурсника']);
    await m.worker.enqueueDeadlineReminders();
    const reminders = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications n JOIN handbook_deadlines dl ON dl.id::text = n.payload->>'deadlineId' WHERE dl.page_id = $1 AND n.user_id = $2",
      [page.id, second.id],
    );
    assert.equal(reminders[0]!.n, 2, 'напоминания доходят до новой аудитории');

    // Сузил обратно — календарь снова пустой
    await m.editor.saveDraft(m.pool, admin, page.id, { audience: { courses: [4] } });
    assert.deepEqual(await titles(), []);
    await m.editor.archivePage(m.pool, admin, page.id);
  });

  it('WRK-2: миграция 007 оставляет в сроках только аудиторию блока', async () => {
    const admin = await adminScope();
    const page = await m.editor.createPage(m.pool, admin, {
      sectionId: await sectionId(),
      title: 'Сроки для миграции',
      audience: { courses: [2] },
      blocks: [
        { id: 'm1', type: 'deadline', title: 'Срок без своей аудитории', startsOn: await mskDate(20) },
        { id: 'm2', type: 'deadline', title: 'Срок для общежития', startsOn: await mskDate(20), audience: { dorm: true } },
      ],
    });
    await m.editor.publishPage(m.pool, admin, page.id);
    // Как было до исправления: в срок скопирована аудитория страницы
    await m.pool.query("UPDATE handbook_deadlines SET audience = '{\"courses\":[2]}' WHERE page_id = $1 AND block_id = 'm1'", [page.id]);
    const { readFile } = await import('node:fs/promises');
    await m.pool.query(await readFile(new URL('../migrations/007_deadline_block_audience.sql', import.meta.url), 'utf8'));
    const stored = await q<{ block_id: string; audience: unknown }>('SELECT block_id, audience FROM handbook_deadlines WHERE page_id = $1 ORDER BY block_id', [page.id]);
    assert.deepEqual(stored.map((row) => [row.block_id, row.audience]), [['m1', {}], ['m2', { dorm: true }]]);
    await m.editor.archivePage(m.pool, admin, page.id);
  });

  it('APP-7: в списке редактора — заголовок черновика', async () => {
    const admin = await adminScope();
    const page = await m.editor.createPage(m.pool, admin, { sectionId: await sectionId(), title: 'QA тестовая страница', blocks: [{ id: 't1', type: 'text', text: 'Текст' }] });
    await m.editor.saveDraft(m.pool, admin, page.id, { title: 'QA тестовая страница 5' });
    await m.editor.submitForReview(m.pool, admin, page.id, null);
    const listed = async () => (await m.editor.editorStructure(m.pool, admin)).flatMap((section) => section.pages).find((row) => row.id === page.id)!;
    assert.equal((await listed()).title, 'QA тестовая страница 5');
    assert.equal((await listed()).status, 'review');
    await m.editor.publishPage(m.pool, admin, page.id);
    await m.editor.saveDraft(m.pool, admin, page.id, { title: 'QA тестовая страница 6' });
    const edited = await listed();
    assert.equal(edited.title, 'QA тестовая страница 6', 'у опубликованной с черновиком — заголовок черновика');
    assert.equal(edited.published_title, 'QA тестовая страница 5');
    assert.equal(edited.has_draft, true);
    await m.editor.archivePage(m.pool, admin, page.id);
  });

  it('API-7: справочник из демо не занимает человекочитаемый слаг', async () => {
    const [dean] = await q<{ university_id: string }>('SELECT university_id FROM persons WHERE id = $1', [ids.deanId]);
    const [institute] = await q<{ id: string }>('SELECT id FROM institutes WHERE university_id = $1', [dean!.university_id]);
    const demoHandbook = await m.editor.createHandbook(
      { personId: ids.deanId, userId: user.id, universityId: dean!.university_id, role: 'dean' },
      { instituteId: institute!.id, title: 'Справочник ТГУ', template: false },
    );
    assert.match(demoHandbook.slug, /^spravochnik-tgu-demo-[0-9a-f]{8}$/);

    // Настоящий вуз получает «чистый» слаг
    const [uni] = await q<{ id: string }>("INSERT INTO universities(code, name, short_name) VALUES ('qa-tgu', 'Томский университет', 'ТГУ') RETURNING id");
    const [realInstitute] = await q<{ id: string }>("INSERT INTO institutes(university_id, name, short_name) VALUES ($1, 'Факультет информатики', 'ФИ') RETURNING id", [uni!.id]);
    const [realDean] = await q<{ id: string }>("INSERT INTO persons(university_id, institute_id, role, full_name) VALUES ($1, $2, 'dean', 'Деканат ФИ') RETURNING id", [uni!.id, realInstitute!.id]);
    const real = await m.editor.createHandbook(
      { personId: realDean!.id, userId: user.id, universityId: uni!.id, role: 'dean' },
      { instituteId: realInstitute!.id, title: 'Справочник ТГУ', template: false },
    );
    assert.equal(real.slug, 'spravochnik-tgu');
  });

  it('API-9: редактор не выводит страницу из архива', async () => {
    const admin = await adminScope();
    const editorScope = { ...admin, role: 'editor' as const, personId: ids.editorIds[0]! };
    const page = await m.editor.createPage(m.pool, admin, { sectionId: await sectionId(), title: 'Страница в архив', blocks: [{ id: 't1', type: 'text', text: 'Текст' }] });
    await m.editor.archivePage(m.pool, admin, page.id);
    const archived = (error: Error & { code?: string }) => error.code === 'page_archived' && /в архиве/.test(error.message);
    await assert.rejects(() => m.editor.saveDraft(m.pool, editorScope, page.id, { title: 'Возвращаю из архива' }), archived);
    await assert.rejects(() => m.editor.submitForReview(m.pool, editorScope, page.id, null), archived);
    const [row] = await q<{ status: string; draft_title: string | null }>('SELECT status, draft_title FROM pages WHERE id = $1', [page.id]);
    assert.equal(row!.status, 'archived');
    assert.equal(row!.draft_title, 'Страница в архив');

    // Ответ дежурного в архивную страницу не добавляется, вопрос остаётся открытым
    const asker = await m.identity.upsertUser(m.pool, { id: 636001, first_name: 'Архив' });
    const askerCtx = (await m.handbook.contextFor(asker, { handbookId: ids.handbookId }))!;
    const question = await m.handbook.askQuestion(m.pool, askerCtx, 'Где взять архивную справку?', null);
    await assert.rejects(() => m.editor.answerQuestion(m.pool, admin, question.id, 'В архиве вуза', page.id), archived);
    const [open] = await q<{ status: string }>('SELECT status FROM handbook_questions WHERE id = $1', [question.id]);
    assert.equal(open!.status, 'open');

    // Администратор вернуть из архива может
    await m.editor.saveDraft(m.pool, admin, page.id, { title: 'Страница из архива' });
    const [restored] = await q<{ status: string }>('SELECT status FROM pages WHERE id = $1', [page.id]);
    assert.equal(restored!.status, 'draft');
    await m.editor.archivePage(m.pool, admin, page.id);
  });

  it('API-11: одновременные создания с одним названием не падают, двойное приглашение без дубля', async () => {
    const admin = await adminScope();
    const section = await sectionId();
    const pages = await Promise.allSettled([1, 2, 3].map(() => m.editor.createPage(m.pool, admin, { sectionId: section, title: 'Двойное нажатие', blocks: [] })));
    assert.deepEqual(pages.filter((item) => item.status === 'rejected'), [], 'ни одного сбоя');
    const slugs = await q<{ slug: string }>("SELECT slug FROM pages WHERE handbook_id = $1 AND title = 'Двойное нажатие' ORDER BY slug", [ids.handbookId]);
    assert.equal(new Set(slugs.map((row) => row.slug)).size, 3);

    const sections = await Promise.allSettled([1, 2].map(() => m.editor.createSection(m.pool, admin, { title: 'Раздел дважды' })));
    assert.deepEqual(sections.filter((item) => item.status === 'rejected'), []);

    const [dean] = await q<{ university_id: string }>('SELECT university_id FROM persons WHERE id = $1', [ids.deanId]);
    const [institute] = await q<{ id: string }>('SELECT id FROM institutes WHERE university_id = $1', [dean!.university_id]);
    const actor = { personId: ids.deanId, userId: user.id, universityId: dean!.university_id, role: 'dean' };
    const handbooks = await Promise.allSettled([1, 2].map(() => m.editor.createHandbook(actor, { instituteId: institute!.id, title: 'Справочник дважды', template: false })));
    assert.deepEqual(handbooks.filter((item) => item.status === 'rejected'), []);
    const created = handbooks.map((item) => (item as PromiseFulfilledResult<{ slug: string }>).value.slug);
    assert.notEqual(created[0], created[1]);

    const invites = await Promise.all([1, 2].map(() => m.editor.inviteEditor(m.pool, admin, { fullName: 'Двойной Клик', kind: 'student', role: 'editor' })));
    assert.equal(invites[0]!.personId, invites[1]!.personId, 'одна запись');
    assert.equal(invites[0]!.code, invites[1]!.code, 'одна ссылка');
    const members = await q("SELECT 1 FROM handbook_members m JOIN persons p ON p.id = m.person_id WHERE m.handbook_id = $1 AND p.full_name = 'Двойной Клик'", [ids.handbookId]);
    assert.equal(members.length, 1);
  });

  it('API-13: PATCH раздела меняет только переданные поля', async () => {
    const app = await m.api.buildApi();
    const headers = { 'x-max-init-data': signed(515151, 'Анна'), 'content-type': 'application/json' };
    const admin = await adminScope();
    const section = await m.editor.createSection(m.pool, admin, { title: 'Первокурснику QA', summary: 'Важное описание' });
    const url = `/api/handbook-editor/sections/${section.id}?handbookId=${ids.handbookId}`;
    const visible = await app.inject({ method: 'PATCH', url, headers, payload: { visible: false } });
    assert.equal(visible.statusCode, 200, visible.body);
    const renamed = await app.inject({ method: 'PATCH', url, headers, payload: { title: 'Первокурснику!' } });
    assert.equal(renamed.statusCode, 200, renamed.body);
    let [row] = await q<{ title: string; summary: string | null; visible: boolean }>('SELECT title, summary, visible FROM sections WHERE id = $1', [section.id]);
    assert.deepEqual(row, { title: 'Первокурснику!', summary: 'Важное описание', visible: false });
    await app.inject({ method: 'PATCH', url, headers, payload: { summary: null } });
    [row] = await q<{ title: string; summary: string | null; visible: boolean }>('SELECT title, summary, visible FROM sections WHERE id = $1', [section.id]);
    assert.equal(row!.summary, null, 'явный null очищает описание');
    const short = await app.inject({ method: 'PATCH', url, headers, payload: { title: 'Я' } });
    assert.equal(short.statusCode, 400);
    await app.close();
  });

  it('API-18: аудиторию страницы при создании задаёт только администратор', async () => {
    const admin = await adminScope();
    const editorScope = { ...admin, role: 'editor' as const, personId: ids.editorIds[0]! };
    const section = await sectionId();
    await assert.rejects(
      () => m.editor.createPage(m.pool, editorScope, { sectionId: section, title: 'Страница редактора', audience: { courses: [4] } }),
      (error: Error & { status?: number }) => error.status === 403 && /администратор/.test(error.message),
    );
    const plain = await m.editor.createPage(m.pool, editorScope, { sectionId: await sectionId(), title: 'Страница редактора', audience: {} });
    const byAdmin = await m.editor.createPage(m.pool, admin, { sectionId: await sectionId(), title: 'Страница админа', audience: { courses: [4] } });
    const rows = await q<{ id: string; audience: unknown }>('SELECT id, audience FROM pages WHERE id = ANY($1::uuid[]) ORDER BY title', [[plain.id, byAdmin.id]]);
    assert.deepEqual(rows.map((row) => row.audience), [{ courses: [4] }, {}]);
  });

  /** Ловит строки лога ошибок, пока выполняется fn: «Необработанная ошибка API» не должна появляться от входных данных. */
  const captureErrorLog = async (fn: () => Promise<void>, overrides: Record<string, unknown> = {}) => {
    const { config } = await import('../src/config.js');
    const saved = Object.fromEntries(Object.keys({ LOG_LEVEL: 1, ...overrides }).map((key) => [key, (config as Record<string, unknown>)[key]]));
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    Object.assign(config, { LOG_LEVEL: 'error', ...overrides });
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await fn();
    } finally {
      process.stderr.write = original;
      Object.assign(config, saved);
    }
    return lines.filter((line) => /Необработанная ошибка/.test(line));
  };

  it('API-1: превышение лимита частоты — 429 по-русски, без ошибки в логе', async () => {
    const codes: number[] = [];
    let last: { error: { code: string; message: string } } | null = null;
    const errors = await captureErrorLog(async () => {
      const app = await m.api.buildApi();
      const headers = { 'x-max-init-data': signed(515151, 'Анна') };
      for (let i = 0; i < 5; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/api/me', headers });
        codes.push(response.statusCode);
        last = response.json();
      }
      await app.close();
    }, { RATE_LIMIT_PER_MINUTE: 3 });
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.deepEqual(last, { error: { code: 'rate_limited', message: 'Слишком много запросов — подождите минуту' } });
    assert.deepEqual(errors, [], 'лимит — не сбой сервера');
  });

  it('API-2: нулевой байт во входе вырезается, а не роняет запрос', async () => {
    const [handbookRow] = await q<{ slug: string }>('SELECT slug FROM handbooks WHERE id = $1', [ids.handbookId]);
    const errors = await captureErrorLog(async () => {
      const app = await m.api.buildApi();
      const reader = { 'x-max-init-data': signed(646001, 'Нуль'), 'content-type': 'application/json' };
      const admin = { 'x-max-init-data': signed(515151, 'Анна'), 'content-type': 'application/json' };
      const home = await app.inject({ method: 'GET', url: `/api/handbook?handbook=${handbookRow!.slug}%00`, headers: { 'x-max-init-data': reader['x-max-init-data'] } });
      assert.equal(home.statusCode, 200, home.body);
      assert.equal(home.json().handbook.id, ids.handbookId);
      const question = await app.inject({ method: 'POST', url: `/api/handbook/questions?handbookId=${ids.handbookId}`, headers: reader, payload: { text: 'Где деканат\u0000 находится?' } });
      assert.equal(question.statusCode, 200, question.body);
      const [stored] = await q<{ text: string }>('SELECT text FROM handbook_questions WHERE id = $1', [question.json().id]);
      assert.equal(stored!.text, 'Где деканат находится?');
      const profile = await app.inject({ method: 'PATCH', url: `/api/handbook/profile?handbookId=${ids.handbookId}`, headers: reader, payload: { program: 'ПИ\u0000' } });
      assert.equal(profile.statusCode, 200, profile.body);
      assert.equal(profile.json().reader.program, 'ПИ');
      const page = await app.inject({
        method: 'POST',
        url: `/api/handbook-editor/pages?handbookId=${ids.handbookId}`,
        headers: admin,
        payload: { sectionId: await sectionId(), title: 'Стр\u0000аница', blocks: [{ id: 't1', type: 'text', text: 'a\u0000b' }] },
      });
      assert.equal(page.statusCode, 200, page.body);
      const invite = await app.inject({ method: 'POST', url: `/api/handbook-editor/invites?handbookId=${ids.handbookId}`, headers: admin, payload: { fullName: 'Иван\u0000 Петров' } });
      assert.equal(invite.statusCode, 200, invite.body);
      const announcement = await app.inject({ method: 'POST', url: `/api/handbook-editor/announcements?handbookId=${ids.handbookId}`, headers: admin, payload: { title: 'Объяв\u0000ление', body: 'Текст\u0000 объявления', notify: false } });
      assert.equal(announcement.statusCode, 200, announcement.body);
      await app.close();
    });
    assert.deepEqual(errors, []);
    // Из чата вопрос и поиск приходят мимо API
    const nul = await m.identity.upsertUser(m.pool, { id: 646002, first_name: 'Ну\u0000ль' });
    assert.equal(nul.first_name, 'Нуль');
    const nulCtx = (await m.handbook.contextFor(nul, { handbookId: ids.handbookId }))!;
    await m.handbook.askQuestion(m.pool, nulCtx, 'Вопрос\u0000 из чата про стипендию', null);
    await m.handbook.logSearch(m.pool, nulCtx, 'стипе\u0000ндия', 1, 'bot');
    // Если что-то всё же дошло до базы — это 400 про символы, а не 500
    const dbError = await m.pool.query('SELECT $1::text', ['a\u0000b']).then(() => null, (error: unknown) => error);
    const { inputErrorFromDatabase } = await import('../src/lib/errors.js');
    assert.equal(inputErrorFromDatabase(dbError)?.status, 400);
  });

  it('API-3: ошибки разбора запроса — по-русски', async () => {
    const app = await m.api.buildApi();
    const auth = signed(515151, 'Анна');
    const url = `/api/handbook/questions?handbookId=${ids.handbookId}`;
    const cases = [
      { headers: { 'content-type': 'application/json' }, payload: '{не json', status: 400 },
      { headers: { 'content-type': 'application/json' }, payload: '', status: 400 },
      { headers: { 'content-type': 'text/xml' }, payload: '<q/>', status: 415 },
      { headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ text: 'я'.repeat(3.5 * 1024 * 1024) }), status: 413 },
      { headers: { 'content-type': 'application/json' }, payload: '{"__proto__": {"admin": true}, "text": "Вопрос с подвохом"}', status: 400 },
    ];
    for (const item of cases) {
      const response = await app.inject({ method: 'POST', url, headers: { 'x-max-init-data': auth, ...item.headers }, payload: item.payload });
      assert.equal(response.statusCode, item.status, `${item.headers['content-type']}: ${response.body.slice(0, 200)}`);
      const message = response.json().error.message as string;
      assert.match(message, /[а-яё]/i, message);
      assert.doesNotMatch(message, /Body|content-type|Unsupported|too large|prototype|JSON/i, message);
    }
    await app.close();
  });

  it('API-4: null в профиле снимает курс, общежитие и программу', async () => {
    const reader = await m.identity.upsertUser(m.pool, { id: 656001, first_name: 'Профиль' });
    const readerCtx = (await m.handbook.contextFor(reader, { handbookId: ids.handbookId }))!;
    await m.handbook.updateProfile(m.pool, readerCtx.reader, { course: 3, program: 'ПИ', dorm: true });
    const kept = await m.handbook.updateProfile(m.pool, readerCtx.reader, { reminders: false });
    assert.deepEqual([kept.course, kept.program, kept.dorm], [3, 'ПИ', true], 'непереданные поля не меняются');
    const cleared = await m.handbook.updateProfile(m.pool, readerCtx.reader, { course: null, program: null, dorm: null });
    assert.deepEqual([cleared.course, cleared.program, cleared.dorm], [null, null, null]);
  });

  it('API-5, APP-10, APP-2: запросы без букв и повтор того же запроса не портят журнал поиска', async () => {
    const app = await m.api.buildApi();
    const headers = { 'x-max-init-data': signed(666001, 'Поиск') };
    const base = `/api/handbook/search?handbookId=${ids.handbookId}&q=`;
    await app.inject({ method: 'GET', url: `/api/handbook?handbookId=${ids.handbookId}`, headers });
    const [reader] = await q<{ id: string }>(
      'SELECT r.id FROM handbook_readers r JOIN users u ON u.id = r.user_id WHERE u.max_user_id = $1 AND r.handbook_id = $2',
      [666001, ids.handbookId],
    );
    const logged = () => q<{ normalized: string; results: number }>('SELECT normalized, results FROM search_log WHERE reader_id = $1 ORDER BY id', [reader!.id]);

    for (const junk of ['!!!', '??', '😀', '*']) {
      const response = await app.inject({ method: 'GET', url: base + encodeURIComponent(junk), headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().hits, []);
    }
    assert.deepEqual(await logged(), [], 'запросы без букв не журналируются');

    await app.inject({ method: 'GET', url: base + encodeURIComponent('справка'), headers });
    await app.inject({ method: 'GET', url: base + encodeURIComponent('общага оплата'), headers });
    // «Назад» к результатам: тот же запрос ещё раз — это не новый поиск
    await app.inject({ method: 'GET', url: base + encodeURIComponent('общага оплата'), headers });
    await app.inject({ method: 'GET', url: base + encodeURIComponent('Справка'), headers });
    assert.equal((await logged()).length, 2, JSON.stringify(await logged()));

    // Пустые строки, записанные до исправления, в бэклог и метрики не попадают
    await m.pool.query("INSERT INTO search_log(handbook_id, reader_id, query, normalized, results, source) VALUES ($1, $2, '!!!', '', 0, 'app')", [ids.handbookId, reader!.id]);
    const report = await m.editor.analytics(m.pool, await adminScope());
    assert.ok(!report.gaps.some((gap) => gap.query === ''), 'пустой строки в «Искали и не нашли» нет');
    assert.ok(!report.top.some((row) => row.query === ''));
    await app.close();
  });

  it('API-12: явный несуществующий справочник у читателя — 404, а не другой справочник', async () => {
    const app = await m.api.buildApi();
    const headers = { 'x-max-init-data': signed(515151, 'Анна'), 'content-type': 'application/json' };
    const bySlug = await app.inject({ method: 'GET', url: '/api/handbook?handbook=net-takogo-spravochnika', headers: { 'x-max-init-data': headers['x-max-init-data'] } });
    assert.equal(bySlug.statusCode, 404);
    assert.match(bySlug.json().error.message, /Справочник не найден/);
    const before = await q<{ n: number }>('SELECT count(*)::int AS n FROM handbook_questions');
    const byId = await app.inject({ method: 'POST', url: '/api/handbook/questions?handbookId=00000000-0000-4000-8000-000000000000', headers, payload: { text: 'Куда уйдёт этот вопрос?' } });
    assert.equal(byId.statusCode, 404);
    const after = await q<{ n: number }>('SELECT count(*)::int AS n FROM handbook_questions');
    assert.equal(after[0]!.n, before[0]!.n, 'вопрос никуда не записан');
    const fallback = await app.inject({ method: 'GET', url: '/api/handbook', headers: { 'x-max-init-data': headers['x-max-init-data'] } });
    assert.equal(fallback.statusCode, 200, 'без явного справочника — последний открытый, как раньше');
    await app.close();
  });

  it('API-17: одновременная привязка двух приглашений одного вуза — одна запись на аккаунт', async () => {
    const admin = await adminScope();
    for (let round = 0; round < 3; round += 1) {
      const first = await m.editor.inviteEditor(m.pool, admin, { fullName: `Гонка Редактор ${round}`, kind: 'staff', role: 'editor' });
      const second = await m.editor.inviteEditor(m.pool, admin, { fullName: `Гонка Администратор ${round}`, kind: 'staff', role: 'admin' });
      const racer = await m.identity.upsertUser(m.pool, { id: 676001 + round, first_name: 'Гонщик' });
      const results = await Promise.allSettled([m.identity.bindInvite(racer, first.code, { notify: false }), m.identity.bindInvite(racer, second.code, { notify: false })]);
      assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1, `раунд ${round}: привязалась одна ссылка`);
      const rejected = results.find((item) => item.status === 'rejected') as PromiseRejectedResult;
      assert.equal(rejected.reason.code, 'already_in_university');
      const bound = await q('SELECT 1 FROM persons WHERE user_id = $1 AND university_id = $2', [racer.id, admin.handbook.university_id]);
      assert.equal(bound.length, 1);
    }
  });

  it('миграции: применяются с нуля, повторный запуск ничего не меняет', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const dir = new URL('../migrations/', import.meta.url);
    const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
    const applied = async () => (await q<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).map((row) => row.name);
    assert.deepEqual(await applied(), files, 'схема этого прогона собрана с нуля всеми миграциями');
    await m.migrate();
    assert.deepEqual(await applied(), files, 'повторный запуск — без изменений');
    // Новые миграции можно применить и повторно (например, вручную на стенде)
    for (const file of ['006_page_return.sql', '007_deadline_block_audience.sql']) {
      await m.pool.query(await readFile(new URL(file, dir), 'utf8'));
    }
  });

  it('демо: сброс убирает всё своё и не трогает других пользователей и настоящие вузы', async () => {
    const owner = await m.identity.upsertUser(m.pool, { id: 696001, first_name: 'Владелец сброса' });
    const sandbox = await m.demo.createDemoSandbox(owner, 'dean');
    const stranger = await m.identity.upsertUser(m.pool, { id: 696002, first_name: 'Посторонний читатель' });
    // Посторонний читает и основную песочницу, и песочницу владельца
    const strangerHome = (await m.handbook.contextFor(stranger, { handbookId: ids.handbookId }))!;
    await m.handbook.logSearch(m.pool, strangerHome, 'общежитие', 1, 'app');
    const strangerCtx = (await m.handbook.contextFor(stranger, { slug: sandbox.handbookSlug }))!;
    await m.handbook.askQuestion(m.pool, strangerCtx, 'Вопрос постороннего про демо', null);
    await m.handbook.logSearch(m.pool, strangerCtx, 'стипендия', 1, 'app');
    await m.handbook.awaitChatQuestion(m.pool, strangerCtx);
    const admin = await adminScope(sandbox.handbookId, sandbox.deanId, owner.id);
    await m.editor.announce(m.pool, admin, { title: 'Объявление перед сбросом', body: 'Проверяем, что сброс всё уберёт.', notify: true });
    await m.editor.createPage(m.pool, admin, { sectionId: await sectionId(sandbox.handbookId), title: 'Страница перед сбросом', blocks: [] });
    const invite = await m.editor.inviteEditor(m.pool, admin, { fullName: 'Посторонний Редактор', kind: 'staff', role: 'editor' });
    await m.identity.bindInvite(stranger, invite.code, { notify: false });

    const oldHandbooks = (await q<{ id: string }>('SELECT id FROM handbooks WHERE university_id = $1', [sandbox.universityId])).map((row) => row.id);
    const oldReaders = (await q<{ id: string }>('SELECT id FROM handbook_readers WHERE handbook_id = ANY($1::uuid[])', [oldHandbooks])).map((row) => row.id);
    assert.ok(oldReaders.length > 1);
    // Всё, что не относится к песочнице владельца, — до и после сброса одинаково
    const outside = async () =>
      (await q<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM universities WHERE NOT (is_demo AND demo_owner_user_id = $1)) AS universities,
                (SELECT count(*)::int FROM handbooks h JOIN universities u ON u.id = h.university_id WHERE NOT (u.is_demo AND u.demo_owner_user_id = $1)) AS handbooks,
                (SELECT count(*)::int FROM pages p JOIN handbooks h ON h.id = p.handbook_id JOIN universities u ON u.id = h.university_id WHERE NOT (u.is_demo AND u.demo_owner_user_id = $1)) AS pages,
                (SELECT count(*)::int FROM handbook_readers r JOIN handbooks h ON h.id = r.handbook_id JOIN universities u ON u.id = h.university_id WHERE NOT (u.is_demo AND u.demo_owner_user_id = $1)) AS readers,
                (SELECT count(*)::int FROM search_log s JOIN handbooks h ON h.id = s.handbook_id JOIN universities u ON u.id = h.university_id WHERE NOT (u.is_demo AND u.demo_owner_user_id = $1)) AS searches,
                (SELECT count(*)::int FROM persons p JOIN universities u ON u.id = p.university_id WHERE NOT (u.is_demo AND u.demo_owner_user_id = $1)) AS persons,
                (SELECT count(*)::int FROM notifications n JOIN universities u ON u.id = n.university_id WHERE NOT (u.is_demo AND u.demo_owner_user_id = $1)) AS notifications,
                (SELECT count(*)::int FROM users WHERE max_user_id > 0) AS users`,
        [owner.id],
      ))[0];
    const before = await outside();

    const reset = await m.demo.createDemoSandbox(owner, 'dean');
    assert.notEqual(reset.handbookId, sandbox.handbookId);
    assert.deepEqual(await outside(), before, 'чужие данные на месте');

    const leftovers = (await q<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM universities WHERE id = $1) AS universities,
              (SELECT count(*)::int FROM handbooks WHERE id = ANY($2::uuid[])) AS handbooks,
              (SELECT count(*)::int FROM pages WHERE handbook_id = ANY($2::uuid[])) AS pages,
              (SELECT count(*)::int FROM handbook_readers WHERE id = ANY($3::uuid[])) AS readers,
              (SELECT count(*)::int FROM handbook_questions WHERE handbook_id = ANY($2::uuid[])) AS questions,
              (SELECT count(*)::int FROM search_log WHERE handbook_id = ANY($2::uuid[])) AS searches,
              (SELECT count(*)::int FROM announcements WHERE handbook_id = ANY($2::uuid[])) AS announcements,
              (SELECT count(*)::int FROM handbook_deadlines WHERE handbook_id = ANY($2::uuid[])) AS deadlines,
              (SELECT count(*)::int FROM notifications WHERE university_id = $1 OR reader_id = ANY($3::uuid[])) AS notifications,
              (SELECT count(*)::int FROM persons WHERE university_id = $1) AS persons,
              (SELECT count(*)::int FROM audit_log WHERE university_id = $1) AS audit,
              (SELECT count(*)::int FROM kv WHERE key = 'hbq:' || $4::text) AS chat_question`,
      [sandbox.universityId, oldHandbooks, oldReaders, stranger.id],
    ))[0];
    assert.deepEqual(Object.values(leftovers!).filter((n) => n !== 0), [], JSON.stringify(leftovers));
    const models = await q<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE max_user_id < 0 AND username = $1', [`demo-model-${owner.id}`]);
    assert.equal(models[0]!.n, 28, 'модельные аккаунты только новой песочницы');
    const [strangerRow] = await q<{ active_person_id: string | null }>('SELECT active_person_id FROM users WHERE id = $1', [stranger.id]);
    assert.equal(strangerRow!.active_person_id, null, 'запись из удалённой песочницы больше не активна');
    const strangerReaders = await q('SELECT 1 FROM handbook_readers WHERE user_id = $1 AND handbook_id = $2', [stranger.id, ids.handbookId]);
    assert.equal(strangerReaders.length, 1, 'чужая песочница постороннего не задета');
  });
});
