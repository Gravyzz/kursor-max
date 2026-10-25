/**
 * Общая база университета: роль администратора университета, уточнения и свои версии факультетов,
 * обновление общей страницы у двух факультетов, изоляция вузов и регрессии D1–D3.
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
    LOG_LEVEL: 'silent',
    APP_TIMEZONE: 'Europe/Moscow',
    BOT_USERNAME: 'handbook_test_bot',
    BOT_USER_ID: '900001',
    PLATFORM_ADMIN_IDS: '717999',
  });
}

describe('общая база университета', { skip: !DB_URL && 'TEST_DATABASE_URL не задан' }, () => {
  let m: {
    pool: typeof import('../src/db/pool.js')['pool'];
    migrate: typeof import('../src/db/migrate.js')['migrate'];
    identity: typeof import('../src/services/identity.js');
    demo: typeof import('../src/services/demo.js');
    handbook: typeof import('../src/services/handbook.js');
    editor: typeof import('../src/services/handbook-editor.js');
    shared: typeof import('../src/services/shared.js');
    university: typeof import('../src/services/university.js');
    api: typeof import('../src/api/server.js');
    initData: typeof import('../src/auth/initData.js');
    bootstrap: typeof import('../src/cli/bootstrap.js');
    worker: typeof import('../src/worker/index.js');
    platform: typeof import('../src/services/platform.js');
    lifecycle: typeof import('../src/services/lifecycle.js');
  };
  type Scope = import('../src/services/handbook-editor.js').EditorScope;
  type UserRow = import('../src/services/identity.js').UserRow;

  let admin: UserRow;
  let sandbox: import('../src/services/demo.js').DemoSandbox;
  let baseId: string;
  let efId: string;
  let iitScope: Scope;
  let baseScope: Scope;

  const q = async <T>(sql: string, values: unknown[] = []) => (await m.pool.query(sql, values)).rows as T[];
  const signed = (id: number, name = 'Админ') =>
    m.initData.signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) }, BOT_TOKEN);
  const pageId = async (handbookId: string, slug: string) =>
    (await q<{ id: string }>('SELECT id FROM pages WHERE handbook_id = $1 AND slug = $2', [handbookId, slug]))[0]!.id;
  /** Студент факультета: отдельный аккаунт MAX, открывший справочник по ссылке. */
  const student = async (id: number, handbookId: string) => {
    const user = await m.identity.upsertUser(m.pool, { id, first_name: 'Студент' });
    return (await m.handbook.contextFor(user, { handbookId }))!;
  };
  const freshCtx = async (ctx: import('../src/services/handbook.js').HandbookContext) =>
    (await m.handbook.contextFor({ id: ctx.reader.user_id } as UserRow, { handbookId: ctx.handbook.id }))!;

  before(async () => {
    m = {
      pool: (await import('../src/db/pool.js')).pool,
      migrate: (await import('../src/db/migrate.js')).migrate,
      identity: await import('../src/services/identity.js'),
      demo: await import('../src/services/demo.js'),
      handbook: await import('../src/services/handbook.js'),
      editor: await import('../src/services/handbook-editor.js'),
      shared: await import('../src/services/shared.js'),
      university: await import('../src/services/university.js'),
      api: await import('../src/api/server.js'),
      initData: await import('../src/auth/initData.js'),
      bootstrap: await import('../src/cli/bootstrap.js'),
      worker: await import('../src/worker/index.js'),
      platform: await import('../src/services/platform.js'),
      lifecycle: await import('../src/services/lifecycle.js'),
    };
    await m.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await m.migrate();
    admin = await m.identity.upsertUser(m.pool, { id: 616161, first_name: 'Марина' });
    sandbox = await m.demo.createDemoSandbox(admin, 'university');
    const iit = (await m.handbook.findHandbook(m.pool, { id: sandbox.handbookId }))!;
    baseId = iit.parent_id!;
    efId = (await q<{ id: string }>("SELECT id FROM handbooks WHERE university_id = $1 AND slug LIKE 'ef-demo-%'", [sandbox.universityId]))[0]!.id;
    const base = (await m.handbook.findHandbook(m.pool, { id: baseId }))!;
    iitScope = { handbook: iit, role: 'admin', personId: sandbox.editorIds[0]!, userId: admin.id };
    baseScope = { handbook: base, role: 'admin', personId: sandbox.deanId, userId: admin.id };
  });

  after(async () => {
    await m?.pool.end();
  });

  it('демо «Университет»: роль — назначение, кабинет открыт, справочник факультета — только просмотр', async () => {
    assert.equal(await m.demo.getDemoRole(m.pool, admin.id), 'university');
    const app = await m.api.buildApi();
    const headers = { 'x-max-init-data': signed(616161) };
    const me = await app.inject({ method: 'GET', url: '/api/me', headers });
    assert.equal(me.json().university?.name, 'Модельный университет');
    assert.equal(me.json().demo.role, 'university');

    const overview = await app.inject({ method: 'GET', url: '/api/university', headers });
    assert.equal(overview.statusCode, 200, overview.body);
    const data = overview.json();
    assert.equal(data.baseHandbookId, baseId);
    assert.equal(data.base.published, 5);
    assert.deepEqual(data.faculties.map((f: { shortName: string }) => f.shortName).sort(), ['ИИТ', 'ЭФ']);
    assert.ok(data.attention.due.some((p: { title: string; overdue: boolean }) => p.title === 'Материальная помощь' && p.overdue), 'просроченная проверка');
    assert.ok(data.attention.behind.some((p: { title: string; shortName: string }) => p.title === 'Академический отпуск' && p.shortName === 'ЭФ'), 'своя версия ЭФ отстала');
    assert.ok(data.attention.pendingInvites.some((p: { name: string }) => /Гусев/.test(p.name)), 'неоткрытое приглашение');

    const baseEditor = await app.inject({ method: 'GET', url: `/api/handbook-editor/structure?handbookId=${baseId}`, headers });
    assert.equal(baseEditor.statusCode, 200, 'администратор университета ведёт общую базу');
    assert.equal(baseEditor.json().handbook.isBase, true);
    const spravka = await pageId(baseId, 'spravka-ob-obuchenii');
    assert.deepEqual(baseEditor.json().usage[spravka], { faculties: 2, supplements: 2, overrides: 0, behind: 0 });

    const facultyEditor = await app.inject({ method: 'GET', url: `/api/handbook-editor/structure?handbookId=${sandbox.handbookId}`, headers });
    assert.equal(facultyEditor.statusCode, 403, 'справочник факультета университет не правит');
    await app.close();
  });

  it('D3: общую базу нельзя открыть как отдельный справочник', async () => {
    const app = await m.api.buildApi();
    const reader = { 'x-max-init-data': signed(717171, 'Читатель') };
    const direct = await app.inject({ method: 'GET', url: `/api/handbook?handbookId=${baseId}`, headers: reader });
    assert.equal(direct.statusCode, 404, direct.body);
    const readers = await q<{ n: number }>('SELECT count(*)::int AS n FROM handbook_readers WHERE handbook_id = $1', [baseId]);
    assert.equal(readers[0]!.n, 0, 'читатель общей базы не создаётся');
    await app.close();
  });

  it('обновление общей страницы доходит до обоих факультетов, уточнения остаются на месте', async () => {
    const iitStudent = await student(810001, sandbox.handbookId);
    const efStudent = await student(810002, efId);
    const spravka = await pageId(baseId, 'spravka-ob-obuchenii');

    const impact = await m.shared.pageImpact(m.pool, baseId, spravka);
    assert.deepEqual(impact.faculties.map((f) => [f.shortName, f.relation]), [['ИИТ', 'supplement'], ['ЭФ', 'supplement']]);
    assert.deepEqual(impact.anchors, ['u2']);

    const editing = await m.editor.pageForEditor(m.pool, baseScope, spravka);
    const blocks = structuredClone(editing.page.blocks) as Array<{ id: string; type: string; items?: Array<{ id: string; text: string }> }>;
    blocks.find((block) => block.id === 'u2')!.items![0]!.text = 'Оставить заявку в личном кабинете: «Сервисы» → «Справки»';
    await m.editor.saveDraft(m.pool, baseScope, spravka, { blocks: blocks as never, note: 'Заявку теперь оставляют в личном кабинете' });
    const published = await m.editor.publishPage(m.pool, baseScope, spravka);
    assert.equal(published.version, 2);
    assert.deepEqual(published.affected, { faculties: 2, overrides: 0, anchorsLost: 0 });

    for (const [ctx, room] of [[iitStudent, 'каб. 214'], [efStudent, 'каб. 305']] as const) {
      const page = (await m.handbook.getPage(m.pool, await freshCtx(ctx), spravka)).page;
      const text = JSON.stringify(page.blocks);
      assert.match(text, /личном кабинете/, 'новая общая часть');
      assert.ok(text.includes(room), `своё уточнение: ${room}`);
      assert.ok(!text.includes(room === 'каб. 214' ? 'каб. 305' : 'каб. 214'), 'чужое уточнение не видно');
    }
  });

  it('D1: страница факультета с адресом общей не создаётся — предлагается уточнение', async () => {
    const [docs] = await q<{ id: string }>("SELECT id FROM sections WHERE handbook_id = $1 AND slug = 'spravki-i-dokumenty'", [sandbox.handbookId]);
    await assert.rejects(
      () => m.editor.createPage(m.pool, iitScope, { sectionId: docs!.id, title: 'Справка в военкомат' }),
      (error: { code?: string }) => error.code === 'shared_page_exists',
    );
  });

  it('своя версия: создание, расхождение с общей, сравнение, «учтено» и возврат к общей', async () => {
    const voenkomat = await pageId(baseId, 'spravka-v-voenkomat');
    const iitStudent = await student(810003, sandbox.handbookId);

    const { pageId: own } = await m.shared.createOverride(m.pool, iitScope, voenkomat, 'Справки формы 4 в ИИТ собирает учебный офис');
    let reader = (await m.handbook.getPage(m.pool, await freshCtx(iitStudent), voenkomat)).page;
    assert.equal(reader.inherited, true, 'пока своя версия черновик, студенты видят общую');
    await assert.rejects(() => m.shared.createOverride(m.pool, iitScope, voenkomat, 'Вторая своя версия'), (error: { code?: string }) => error.code === 'override_exists');

    const draft = await m.editor.pageForEditor(m.pool, iitScope, own);
    const ownBlocks = [...draft.page.blocks, { id: 'iit1', type: 'text', text: 'В ИИТ заявку на справку формы 4 принимает учебный офис, каб. 121.' }];
    await m.editor.saveDraft(m.pool, iitScope, own, { blocks: ownBlocks as never });
    await m.editor.publishPage(m.pool, iitScope, own);

    const ctx = await freshCtx(iitStudent);
    reader = (await m.handbook.getPage(m.pool, ctx, voenkomat)).page;
    assert.equal(reader.inherited, false, 'ссылка на общую страницу ведёт на версию факультета');
    const hits = await m.handbook.search(m.pool, ctx, 'военкомат форма 4 отсрочка');
    const found = hits.filter((hit) => hit.slug === 'spravka-v-voenkomat');
    assert.equal(found.length, 1, 'в поиске одна версия');
    assert.equal(found[0]!.pageId, own, 'и это версия факультета (регресс D1)');
    await m.handbook.getPage(m.pool, ctx, found[0]!.pageId);

    // Университет обновляет общую страницу — у ИИТ своя версия, приходит уведомление, версия отстала
    const base = await m.editor.pageForEditor(m.pool, baseScope, voenkomat);
    const changed = (base.page.blocks as Array<{ id: string; type: string; text?: string }>).map((block) =>
      block.id === 'v1' ? { ...block, text: 'Справку формы 4 оформляет отдел воинского учёта, заказать её можно и в личном кабинете.' } : block);
    await m.editor.saveDraft(m.pool, baseScope, voenkomat, { blocks: changed as never, note: 'Заказ через личный кабинет' });
    const result = await m.editor.publishPage(m.pool, baseScope, voenkomat);
    assert.equal(result.affected.overrides, 1);
    const notes = await q<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE kind = 'handbook_base_changed' AND payload->>'pageId' = $1", [own]);
    assert.ok(notes[0]!.n >= 1, 'администратору ИИТ — сообщение «общая обновилась»');

    const behind = await m.editor.pageForEditor(m.pool, iitScope, own);
    assert.equal(behind.override?.behind, true);
    const diff = await m.shared.compareOverride(m.pool, iitScope, own);
    assert.equal(diff.fromVersion, 1);
    assert.equal(diff.toVersion, 2);
    assert.ok(diff.changes.some((change) => change.kind === 'changed' && /личном кабинете/.test(change.after ?? '')));

    await m.shared.ackOverride(m.pool, iitScope, own);
    assert.equal((await m.editor.pageForEditor(m.pool, iitScope, own)).override?.behind, false, '«учтено» снимает метку');

    await m.shared.revertOverride(m.pool, iitScope, own);
    reader = (await m.handbook.getPage(m.pool, await freshCtx(iitStudent), voenkomat)).page;
    assert.equal(reader.inherited, true, 'после возврата студенты снова видят общую');
  });

  it('уточнение: черновик не виден, срок — только своему факультету; удалённый якорь уводит уточнение в конец', async () => {
    const lgoty = await pageId(baseId, 'lgoty-i-proezd');
    const iitStudent = await student(810004, sandbox.handbookId);
    const efStudent = await student(810005, efId);
    const due = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await m.shared.saveSupplement(m.pool, iitScope, lgoty, {
      anchorBlockId: 'l1',
      blocks: [{ id: 'd1', type: 'deadline', title: 'Сдать фото для транспортной карты в ИИТ', startsOn: due, remindDays: [3, 1] }] as never,
    });
    let page = (await m.handbook.getPage(m.pool, await freshCtx(iitStudent), lgoty)).page;
    assert.ok(!JSON.stringify(page.blocks).includes('транспортной карты в ИИТ'), 'черновик уточнения студенту не виден');

    await assert.rejects(() => m.shared.publishSupplement(m.pool, { ...iitScope, role: 'editor' }, lgoty), /администратор/i, 'публикует администратор факультета');
    await m.shared.publishSupplement(m.pool, iitScope, lgoty);
    page = (await m.handbook.getPage(m.pool, await freshCtx(iitStudent), lgoty)).page;
    assert.equal(page.blocks[1]!.type, 'deadline', 'уточнение стоит после блока-якоря');
    const iitDeadlines = await m.handbook.upcomingDeadlines(m.pool, await freshCtx(iitStudent));
    const efDeadlines = await m.handbook.upcomingDeadlines(m.pool, await freshCtx(efStudent));
    assert.ok(iitDeadlines.some((d) => /ИИТ/.test(d.title)));
    assert.ok(!efDeadlines.some((d) => /ИИТ/.test(d.title)), 'срок уточнения не уходит другому факультету');

    // Университет убирает блок-якорь: уточнение уходит в конец, факультету — сообщение
    const base = await m.editor.pageForEditor(m.pool, baseScope, lgoty);
    const rest = (base.page.blocks as Array<{ id: string }>).filter((block) => block.id !== 'l1');
    await m.editor.saveDraft(m.pool, baseScope, lgoty, { blocks: rest as never });
    const result = await m.editor.publishPage(m.pool, baseScope, lgoty);
    assert.equal(result.affected.anchorsLost, 1);
    page = (await m.handbook.getPage(m.pool, await freshCtx(iitStudent), lgoty)).page;
    assert.equal(page.blocks.at(-1)!.type, 'deadline');
    const stillThere = await m.handbook.upcomingDeadlines(m.pool, await freshCtx(iitStudent));
    assert.ok(stillThere.some((d) => /ИИТ/.test(d.title)), 'публикация общей страницы не стирает сроки уточнений');
  });

  it('подключение факультета: справочник с общей базой без копий общих страниц, ссылка администратору (регресс D2)', async () => {
    const scope = (await m.university.universityRole(m.pool, admin))!;
    const created = await m.university.createFaculty(m.pool, scope, { name: 'Юридический институт', shortName: 'ЮИ', adminFullName: 'Морозова Елена Сергеевна' });
    assert.equal(created.inherited, true);
    assert.ok(created.skipped >= 4, 'заготовки, которые есть в общей базе, не создаются');
    assert.match(created.link, /start=inv_H-/);
    const duplicates = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages p JOIN sections s ON s.id = p.section_id
        WHERE p.handbook_id = $1 AND EXISTS (SELECT 1 FROM pages bp JOIN sections bs ON bs.id = bp.section_id
                                             WHERE bp.handbook_id = $2 AND bp.slug = p.slug AND bs.slug = s.slug)`,
      [created.handbookId, baseId],
    );
    assert.equal(duplicates[0]!.n, 0);
    const role = await q<{ role: string }>('SELECT role FROM org_roles WHERE person_id = $1', [created.adminPersonId]);
    assert.deepEqual(role.map((r) => r.role), ['faculty_admin']);
    await assert.rejects(() => m.university.createFaculty(m.pool, scope, { name: 'Юридический институт', shortName: 'ЮИ2', adminFullName: 'Кто-то Другой' }), /уже подключён/);

    // Администратор открывает ссылку — становится администратором справочника своего факультета
    const lawyer = await m.identity.upsertUser(m.pool, { id: 919191, first_name: 'Елена' });
    await m.identity.bindInvite(lawyer, created.link.split('inv_')[1]!, { notify: false });
    assert.equal(await m.handbook.memberRole(m.pool, created.handbookId, lawyer), 'admin');
    assert.equal(await m.handbook.memberRole(m.pool, baseId, lawyer), null, 'общую базу администратор факультета не правит');
  });

  it('ответственность: подтверждение актуальности без новой публикации, замена ответственного', async () => {
    const help = await pageId(baseId, 'materialnaya-pomoshch');
    const before = await m.editor.pageForEditor(m.pool, baseScope, help);
    assert.equal(before.ownership.ownerUnit, 'Профком студентов');
    const verified = await m.editor.verifyPage(m.pool, baseScope, help);
    assert.ok(verified.reviewAt > new Date().toISOString().slice(0, 10), 'следующая проверка в будущем');
    const versions = await q<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id = $1', [help]);
    assert.equal(versions[0]!.n, 1, 'новой версии не появилось');

    await m.editor.setOwnership(m.pool, baseScope, help, { ownerUnit: 'Управление по работе со студентами', reviewIntervalDays: 90 });
    const after = await m.editor.pageForEditor(m.pool, baseScope, help);
    assert.equal(after.ownership.ownerUnit, 'Управление по работе со студентами');
    assert.equal(after.ownership.reviewIntervalDays, 90);
    await assert.rejects(() => m.editor.setOwnership(m.pool, { ...baseScope, role: 'editor' }, help, { ownerUnit: 'Никто' }), /администратор/i);
  });

  it('изоляция: администратор одного вуза не видит базу и кабинет другого', async () => {
    const other = await m.identity.upsertUser(m.pool, { id: 626262, first_name: 'Чужой' });
    const otherSandbox = await m.demo.createDemoSandbox(other, 'university');
    const otherBase = (await m.handbook.findHandbook(m.pool, { id: otherSandbox.handbookId }))!.parent_id!;
    const app = await m.api.buildApi();
    const headers = { 'x-max-init-data': signed(616161) };
    const foreign = await app.inject({ method: 'GET', url: `/api/handbook-editor/structure?handbookId=${otherBase}`, headers });
    assert.equal(foreign.statusCode, 403, foreign.body);
    const own = await app.inject({ method: 'GET', url: '/api/university', headers });
    assert.equal(own.json().baseHandbookId, baseId);
    const student = { 'x-max-init-data': signed(717172, 'Студент') };
    const denied = await app.inject({ method: 'GET', url: '/api/university', headers: student });
    assert.equal(denied.statusCode, 403);
    await app.close();
  });

  it('смена демо-роли снимает назначение университета', async () => {
    await m.demo.setDemoRole(admin, 'dean');
    assert.equal(await m.university.universityRole(m.pool, admin), null);
    assert.equal(await m.handbook.memberRole(m.pool, sandbox.handbookId, admin), 'admin');
    await m.demo.setDemoRole(admin, 'university');
    assert.ok(await m.university.universityRole(m.pool, admin));
  });

  it('bootstrap: администратор университета по личной ссылке, повтор не дублирует, общая база создаётся при первом входе', async () => {
    const args = ['--university', 'Тестовый университет', '--short', 'ТУ', '--university-admin', 'Орлова Марина Викторовна', '--institute', 'Юридический институт', '--dean', 'Морозова Ирина Олеговна'];
    const log = console.log;
    console.log = () => undefined;
    try {
      const first = (await m.bootstrap.bootstrapUniversity(args))!;
      const again = (await m.bootstrap.bootstrapUniversity(args))!;
      assert.deepEqual(again.people.map((p) => p.personId), first.people.map((p) => p.personId), 'повтор не создаёт новых записей');
      const roles = await q<{ role: string; n: number }>(
        'SELECT role, count(*)::int AS n FROM org_roles WHERE university_id = $1 AND revoked_at IS NULL GROUP BY role ORDER BY role',
        [first.universityId],
      );
      assert.deepEqual(roles.map((r) => [r.role, r.n]), [['faculty_admin', 1], ['university_admin', 1]]);
      await assert.rejects(() => m.bootstrap.bootstrapUniversity(['--university', 'Тестовый университет', '--institute', 'Без деканата']), /university-admin/);

      const uniAdmin = first.people.find((p) => p.role === 'university_admin')!;
      const user = await m.identity.upsertUser(m.pool, { id: 636363, first_name: 'Марина' });
      await m.identity.bindInvite(user, uniAdmin.inviteCode, { notify: false });
      const scope = (await m.university.universityRole(m.pool, user))!;
      assert.equal(scope.universityId, first.universityId);
      const data = await m.university.overview(m.pool, scope);
      assert.ok(data.baseHandbookId, 'пустая общая база создана при первом входе');
      assert.deepEqual(data.faculties.map((f: { shortName: string }) => f.shortName), ['Юридический институт']);
      assert.ok(data.attention.pendingInvites.some((p: { name: string }) => /Морозова/.test(p.name)), 'деканат ещё не открыл ссылку');
    } finally {
      console.log = log;
    }
  });
  it('срок проверки: напоминание ответственному и замене один раз за цикл, после «Проверено» — тишина', async () => {
    const help = await pageId(baseId, 'materialnaya-pomoshch');
    const owners = (await q<{ owner_person_id: string | null; backup_owner_person_id: string | null }>('SELECT owner_person_id, backup_owner_person_id FROM pages WHERE id = $1', [help]))[0]!;
    const expected = [owners.owner_person_id, owners.backup_owner_person_id].filter(Boolean).sort();
    assert.ok(expected.length > 0, 'у просроченной страницы демо есть ответственный');
    // Предыдущий тест уже подтвердил страницу — снова делаем её просроченной
    await m.pool.query('UPDATE pages SET review_at = current_date - 3 WHERE id = $1', [help]);
    await m.worker.enqueueReviewReminders();
    const sent = await q<{ person_id: string }>("SELECT person_id FROM notifications WHERE kind = 'page_review_due' AND payload->>'pageId' = $1 ORDER BY person_id", [help]);
    assert.deepEqual(sent.map((r) => r.person_id), expected, 'напоминание — ответственному и замене, не администраторам');
    await m.worker.enqueueReviewReminders();
    const again = await q<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE kind = 'page_review_due' AND payload->>'pageId' = $1", [help]);
    assert.equal(again[0]!.n, expected.length, 'повторный проход не дублирует');
    await m.editor.verifyPage(m.pool, baseScope, help);
    await m.worker.enqueueReviewReminders();
    const after = await q<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE kind = 'page_review_due' AND payload->>'pageId' = $1", [help]);
    assert.equal(after[0]!.n, expected.length, 'после «Проверено» новый срок ещё не наступил');

    // Без ответственного напоминание уходит администраторам справочника
    const akadem = await pageId(baseId, 'akademicheskiy-otpusk');
    await m.pool.query("UPDATE pages SET owner_person_id = NULL, backup_owner_person_id = NULL, review_at = current_date - 1 WHERE id = $1", [akadem]);
    await m.worker.enqueueReviewReminders();
    const admins = await q<{ person_id: string }>("SELECT person_id FROM notifications WHERE kind = 'page_review_due' AND payload->>'pageId' = $1", [akadem]);
    const uniAdmins = await q<{ person_id: string }>("SELECT person_id FROM org_roles WHERE university_id = $1 AND role = 'university_admin' AND revoked_at IS NULL", [sandbox.universityId]);
    assert.ok(uniAdmins.every((r) => admins.some((a) => a.person_id === r.person_id)), 'администратор университета получает напоминание о странице общей базы');
  });

  it('ответственный и замена — разные люди; повторная ссылка честно говорит, новая она или прежняя', async () => {
    const help = await pageId(baseId, 'materialnaya-pomoshch');
    const someone = (await q<{ id: string }>('SELECT id FROM persons WHERE university_id = $1 LIMIT 1', [sandbox.universityId]))[0]!.id;
    await assert.rejects(() => m.editor.setOwnership(m.pool, baseScope, help, { ownerPersonId: someone, backupPersonId: someone }), /другой человек/);

    const scope = (await m.university.universityRole(m.pool, admin))!;
    const pending = (await q<{ id: string }>("SELECT id FROM persons WHERE university_id = $1 AND full_name LIKE 'Гусев%'", [sandbox.universityId]))[0]!.id;
    const same = await m.university.resendInvite(m.pool, scope, pending);
    assert.equal(same.renewed, false, 'действующая ссылка — та же');
    await m.pool.query('UPDATE invites SET expires_at = now() - interval \'1 day\' WHERE person_id = $1', [pending]);
    const fresh = await m.university.resendInvite(m.pool, scope, pending);
    assert.equal(fresh.renewed, true, 'истёкшая — новая');
    assert.notEqual(fresh.link, same.link);
  });
  it('кабинет платформы: только команде Курсора; вуз с администратором по ссылке, без дублей', async () => {
    const app = await m.api.buildApi();
    const team = { 'x-max-init-data': signed(717999, 'Курсор') };
    const stranger = { 'x-max-init-data': signed(717998, 'Чужой') };
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: team })).json().platform, true);
    assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: stranger })).json().platform, false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/platform', headers: stranger })).statusCode, 403);

    const created = await app.inject({ method: 'POST', url: '/api/platform/universities', headers: team,
      payload: { name: 'Сибирский тестовый университет', shortName: 'СТУ', timezone: 'Asia/Tomsk', adminFullName: 'Петрова Анна Сергеевна' } });
    assert.equal(created.statusCode, 200, created.body);
    assert.match(created.json().link, /inv_/);
    const dupe = await app.inject({ method: 'POST', url: '/api/platform/universities', headers: team,
      payload: { name: 'сибирский тестовый университет', shortName: 'СТУ2', timezone: 'Asia/Tomsk', adminFullName: 'Иванов Иван' } });
    assert.equal(dupe.statusCode, 409);
    const badZone = await app.inject({ method: 'POST', url: '/api/platform/universities', headers: team,
      payload: { name: 'Ещё университет', shortName: 'ЕУ', timezone: 'Mars/Base', adminFullName: 'Иванов Иван' } });
    assert.equal(badZone.statusCode, 400);

    const list = (await app.inject({ method: 'GET', url: '/api/platform', headers: team })).json();
    const sibir = list.universities.find((u: { shortName: string }) => u.shortName === 'СТУ');
    assert.ok(sibir, 'новый вуз в списке');
    assert.ok(list.universities.every((u: { name: string }) => u.name !== 'Модельный университет'), 'демо-песочниц в списке нет');
    assert.deepEqual(sibir.admins.map((a: { connected: boolean }) => a.connected), [false]);

    const code = (await q<{ code: string }>('SELECT code FROM invites WHERE person_id = $1', [sibir.admins[0].personId]))[0]!.code;
    const anna = await m.identity.upsertUser(m.pool, { id: 717997, first_name: 'Анна' });
    await m.identity.bindInvite(anna, code, { notify: false });
    const scope = (await m.university.universityRole(m.pool, anna))!;
    assert.equal(scope.universityId, sibir.id);
    assert.equal((await m.university.overview(m.pool, scope)).faculties.length, 0, 'новый вуз начинает с пустой базы');
    await app.close();
  });

  it('общая страница только для выбранных факультетов: другие её не видят ни в списке, ни в поиске', async () => {
    const spravka = await pageId(baseId, 'spravka-ob-obuchenii');
    const iitInstitute = (await m.handbook.findHandbook(m.pool, { id: sandbox.handbookId }))!.institute_id!;
    await assert.rejects(() => m.editor.setFacultyScope(m.pool, baseScope, spravka, { instituteIds: [] }), /хотя бы один/);
    await assert.rejects(() => m.editor.setFacultyScope(m.pool, { ...baseScope, role: 'editor' }, spravka, { instituteIds: null }), /администратор/i);
    await m.editor.setFacultyScope(m.pool, baseScope, spravka, { instituteIds: [iitInstitute] });

    const ef = await freshCtx(await student(810021, efId));
    const iit = await freshCtx(await student(810022, sandbox.handbookId));
    await assert.rejects(() => m.handbook.getPage(m.pool, ef, spravka), /не найдена/);
    assert.ok(!(await m.handbook.search(m.pool, ef, 'справка об обучении')).some((hit) => hit.pageId === spravka), 'ЭФ не находит страницу поиском');
    assert.ok((await m.handbook.search(m.pool, iit, 'справка об обучении')).some((hit) => hit.pageId === spravka), 'ИИТ находит');

    const impact = await m.shared.pageImpact(m.pool, baseId, spravka);
    assert.deepEqual([...new Set(impact.faculties.map((f) => f.shortName))], ['ИИТ']);
    assert.ok(impact.excluded?.some((f) => f.shortName === 'ЭФ'), 'ЭФ в списке «не показывается»');
    const efHandbook = (await m.handbook.findHandbook(m.pool, { id: efId }))!;
    const efScope = { handbook: efHandbook, role: 'admin' as const, personId: null, userId: admin.id };
    assert.ok(!(await m.shared.sharedForFaculty(m.pool, efScope)).some((row) => row.id === spravka), 'в редакции ЭФ страницы нет');
    await assert.rejects(() => m.shared.sharedPage(m.pool, efScope, spravka), /не для вашего факультета/);

    await m.editor.setFacultyScope(m.pool, baseScope, spravka, { instituteIds: null });
    await m.handbook.getPage(m.pool, ef, spravka);
  });
  it('отметка «не помогла» снимается публикацией исправленной страницы', async () => {
    const page = (await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND status = 'published' AND inherited_from IS NULL ORDER BY title LIMIT 1", [sandbox.handbookId]))[0]!.id;
    await m.pool.query('UPDATE pages SET helpful = 3, not_helpful = 6, helpful_before = 0, not_helpful_before = 0 WHERE id = $1', [page]);
    const row = async () => (await m.editor.editorStructure(m.pool, iitScope)).flatMap((s) => s.pages).find((p) => p.id === page)!;
    assert.equal((await row()).recent_not_helpful, 6, 'до исправления жалобы считаются');
    assert.ok((await m.editor.analytics(m.pool, iitScope)).weak.some((w) => w.id === page), 'страница в списке «не помогла»');
    assert.equal((await m.editor.pageForEditor(m.pool, iitScope, page)).rating.recentNotHelpful, 6);

    await m.editor.publishPage(m.pool, iitScope, page);
    const fixed = await row();
    assert.equal(fixed.not_helpful, 6, 'общая статистика сохраняется');
    assert.equal(fixed.recent_not_helpful, 0, 'после публикации оценки считаются заново');
    assert.ok(!(await m.editor.analytics(m.pool, iitScope)).weak.some((w) => w.id === page), 'исправленная страница уходит из списка');
    await m.pool.query('UPDATE pages SET not_helpful = not_helpful + 2 WHERE id = $1', [page]);
    assert.equal((await row()).recent_not_helpful, 2, 'новые жалобы снова видны');
  });

  it('уточнение от редактора: отправка на публикацию, сообщение администратору, ссылка по id уточнения', async () => {
    const target = (await q<{ id: string }>(
      `SELECT p.id FROM pages p WHERE p.handbook_id = $1 AND p.status = 'published' AND page_for_handbook(p.institute_ids, $2)
          AND NOT EXISTS (SELECT 1 FROM page_supplements s WHERE s.base_page_id = p.id AND s.handbook_id = $2 AND s.status <> 'archived')
          AND NOT EXISTS (SELECT 1 FROM pages ov WHERE ov.inherited_from = p.id AND ov.handbook_id = $2 AND ov.status <> 'archived')
        ORDER BY p.title LIMIT 1`,
      [baseId, sandbox.handbookId],
    ))[0]!.id;
    const editorId = sandbox.editorIds[1] ?? sandbox.editorIds[0]!;
    const editorScope: Scope = { ...iitScope, role: 'editor', personId: editorId };
    await assert.rejects(() => m.shared.submitSupplement(m.pool, editorScope, target, null), /отправлять пока нечего/);
    await m.shared.saveSupplement(m.pool, editorScope, target, { blocks: [{ id: 's1', type: 'text', text: 'В ИИТ — каб. 214' }] as never });
    const sent = await m.shared.submitSupplement(m.pool, editorScope, target, 'с сентября');
    assert.ok(sent.notified > 0, 'администраторы факультета получают сообщение');
    const again = await m.shared.submitSupplement(m.pool, editorScope, target, null);
    assert.equal(again.notified, 0, 'повтор не дублирует сообщения');

    const row = (await m.shared.sharedForFaculty(m.pool, iitScope)).find((r) => r.id === target)!;
    assert.equal(row.supplementReview, true, 'в редакции видно, что уточнение ждёт публикации');
    const view = await m.shared.sharedPage(m.pool, iitScope, target);
    assert.equal(view.supplement?.review?.note, 'с сентября');

    const note = (await q<{ id: string; payload: Record<string, unknown>; person_id: string }>("SELECT id, payload, person_id FROM notifications WHERE kind = 'supplement_review' AND payload->>'basePageId' = $1 LIMIT 1", [target]))[0]!;
    const render = await import('../src/notify/render.js');
    const text = await render.renderNotification(m.pool, { id: note.id, kind: 'supplement_review', payload: note.payload, person_id: note.person_id, role: 'dean' } as never, { username: 'handbook_test_bot', userId: 900001 } as never);
    assert.match(JSON.stringify(text), /Уточнение ждёт публикации/);
    assert.match(JSON.stringify(text), new RegExp(`hbs_${String(note.payload.supplementId)}`));

    // Диплинк hbs_<id уточнения> открывает справочник факультета, API принимает id уточнения вместо общей страницы
    const supplementId = String(note.payload.supplementId);
    assert.equal(m.handbook.startRef(`hbs_${supplementId}`).supplementId, supplementId);
    assert.equal(await m.shared.sharedBaseId(m.pool, iitScope, supplementId), target);

    await m.shared.publishSupplement(m.pool, iitScope, target);
    const done = (await m.shared.sharedForFaculty(m.pool, iitScope)).find((r) => r.id === target)!;
    assert.equal(done.supplementReview, false, 'публикация снимает отметку');
    assert.equal(done.relation, 'supplement');
    assert.equal(await render.renderNotification(m.pool, { id: note.id, kind: 'supplement_review', payload: note.payload, person_id: note.person_id, role: 'dean' } as never, { username: 'handbook_test_bot', userId: 900001 } as never), null, 'опубликованное уточнение — сообщение устарело');
  });
  /** Сотрудник деканата ИИТ с собственным аккаунтом MAX — для проверок прав деканата. */
  const iitDean = async (id: number) => {
    const user = await m.identity.upsertUser(m.pool, { id, first_name: 'Деканат' });
    const institute = (await q<{ institute_id: string }>('SELECT institute_id FROM handbooks WHERE id = $1', [sandbox.handbookId]))[0]!.institute_id;
    const person = (await q<{ id: string }>(
      "INSERT INTO persons(university_id, institute_id, role, full_name, user_id) VALUES ($1, $2, 'dean', 'Деканова Ирина Петровна', $3) RETURNING id",
      [sandbox.universityId, institute, user.id],
    ))[0]!.id;
    return { user, person, institute };
  };

  it('вопросы дежурному задают только студенты: деканат и университет — нет', async () => {
    const dean = await iitDean(830001);
    const deanCtx = (await m.handbook.contextFor(dean.user, { handbookId: sandbox.handbookId }))!;
    await assert.rejects(() => m.handbook.askQuestion(m.pool, deanCtx, 'Можно ли перевестись на бюджет?', null), /задают студенты/);
    const uniCtx = (await m.handbook.contextFor(admin, { handbookId: sandbox.handbookId }))!;
    await assert.rejects(() => m.handbook.askQuestion(m.pool, uniCtx, 'Можно ли перевестись на бюджет?', null), /задают студенты/, 'администратор университета тоже не студент');
    const reader = await student(830002, sandbox.handbookId);
    const asked = await m.handbook.askQuestion(m.pool, reader, 'Можно ли перевестись на бюджет?', null);
    assert.ok(asked, 'студент спрашивает как раньше');
  });

  it('справочник деканата: без общих страниц по выбору; закрыть можно не последний, вернуть — 90 дней, потом удаляется', async () => {
    const dean = await iitDean(830011);
    const actor = { personId: dean.person, userId: dean.user.id, universityId: sandbox.universityId, role: 'dean', instituteId: dean.institute, isDemo: true };
    const extra = await m.editor.createHandbook(actor, { instituteId: dean.institute, title: 'Стажировки ИИТ', inherit: false });
    assert.equal(extra.inherited, false, 'тематический справочник — без общих страниц');
    const parent = (await q<{ parent_id: string | null }>('SELECT parent_id FROM handbooks WHERE id = $1', [extra.id]))[0]!;
    assert.equal(parent.parent_id, null);
    const withBase = await m.editor.createHandbook(actor, { instituteId: dean.institute, title: 'Первокурснику ИИТ' });
    assert.equal(withBase.inherited, true, 'по умолчанию общие страницы подключаются');

    let list = await m.lifecycle.manageableHandbooks(m.pool, dean.user);
    assert.ok(list.some((h) => h.id === extra.id && h.canClose && !h.inherited));
    await assert.rejects(() => m.lifecycle.closeHandbook(m.pool, dean.user, baseId), /Общую базу/);

    const closed = await m.lifecycle.closeHandbook(m.pool, dean.user, extra.id);
    assert.ok(closed.restoreUntil);
    const app = await m.api.buildApi();
    const reader = await app.inject({ method: 'GET', url: `/api/handbook?handbookId=${extra.id}`, headers: { 'x-max-init-data': signed(830012, 'Студент') } });
    assert.equal(reader.statusCode, 410, reader.body);
    assert.match(reader.json().error?.message ?? reader.body, /закрыт/);
    await app.close();

    await m.lifecycle.closeHandbook(m.pool, dean.user, withBase.id);
    await assert.rejects(() => m.lifecycle.closeHandbook(m.pool, dean.user, sandbox.handbookId), /единственный справочник/, 'последний справочник факультета не закрывается');
    list = await m.lifecycle.manageableHandbooks(m.pool, dean.user);
    assert.equal(list.find((h) => h.id === sandbox.handbookId)?.canClose, false);
    assert.equal(list.find((h) => h.id === extra.id)?.status, 'archived', 'закрытый виден в списке для восстановления');

    await m.lifecycle.reopenHandbook(m.pool, dean.user, extra.id);
    assert.equal((await q<{ status: string }>('SELECT status FROM handbooks WHERE id = $1', [extra.id]))[0]!.status, 'active');

    // Через 90 дней закрытый справочник удаляется насовсем
    await m.pool.query("UPDATE handbooks SET closed_at = now() - interval '91 days' WHERE id = $1", [withBase.id]);
    const purged = await m.lifecycle.purgeClosed(m.pool);
    assert.ok(purged.handbooks >= 1);
    assert.equal((await q('SELECT 1 FROM handbooks WHERE id = $1', [withBase.id])).length, 0);
    await m.lifecycle.closeHandbook(m.pool, dean.user, extra.id);
  });

  it('отключение факультета: подтверждение названием, справочники закрыты, база цела, восстановление возвращает всё', async () => {
    const scope = (await m.university.universityRole(m.pool, admin))!;
    const created = await m.university.createFaculty(m.pool, scope, { name: 'Факультет журналистики', shortName: 'ФЖ', adminFullName: 'Соколова Анна Викторовна' });
    await assert.rejects(() => m.lifecycle.closeFaculty(m.pool, scope, created.instituteId, 'ЮИ'), /не совпадает/);
    const closed = await m.lifecycle.closeFaculty(m.pool, scope, created.instituteId, 'фж');
    assert.equal(closed.handbooks, 1);
    const faculties = await m.university.listFaculties(m.pool, scope);
    assert.ok(!faculties.faculties.some((f) => f.id === created.instituteId), 'отключённого нет среди действующих');
    assert.ok(faculties.closed.some((f) => f.id === created.instituteId && f.restoreUntil), 'он в «Отключённых»');
    assert.ok(!(await m.university.overview(m.pool, scope)).faculties.some((f) => f.id === created.instituteId));
    assert.equal((await q<{ status: string }>('SELECT status FROM handbooks WHERE id = $1', [created.handbookId]))[0]!.status, 'archived');
    assert.ok((await q<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE handbook_id = $1 AND status = 'published'", [baseId]))[0]!.n > 0, 'общая база не тронута');
    await assert.rejects(() => m.university.createFaculty(m.pool, scope, { name: 'Факультет журналистики', shortName: 'ФЖ2', adminFullName: 'Иванов Иван' }), /отключён/);

    const reopened = await m.lifecycle.reopenFaculty(m.pool, scope, created.instituteId);
    assert.equal(reopened.handbooks, 1);
    assert.equal((await q<{ status: string }>('SELECT status FROM handbooks WHERE id = $1', [created.handbookId]))[0]!.status, 'active');
    assert.ok((await m.university.listFaculties(m.pool, scope)).faculties.some((f) => f.id === created.instituteId));
  });


  it('команда: управлять можно только младшими; администратора назначает руководство', async () => {
    const leadId = (await q<{ id: string }>(
      "SELECT r.person_id AS id FROM org_roles r JOIN handbooks h ON h.institute_id = r.institute_id WHERE h.id = $1 AND r.role = 'faculty_admin' AND r.revoked_at IS NULL LIMIT 1",
      [sandbox.handbookId],
    ))[0]!.id;
    const leadScope: Scope = { ...iitScope, role: 'admin', personId: leadId };
    const a = await m.editor.inviteEditor(m.pool, leadScope, { fullName: 'Админов Антон', kind: 'staff', role: 'admin' });
    const b = await m.editor.inviteEditor(m.pool, leadScope, { fullName: 'Бориска Борис', kind: 'staff', role: 'admin' });
    const adminScope: Scope = { ...iitScope, role: 'admin', personId: a.personId };

    await assert.rejects(() => m.editor.inviteEditor(m.pool, adminScope, { fullName: 'Ещёадмин Олег', kind: 'staff', role: 'admin' }), /Назначить администратора может руководство/);
    const e = await m.editor.inviteEditor(m.pool, adminScope, { fullName: 'Редакторова Елена', kind: 'student', role: 'editor' });
    await assert.rejects(() => m.editor.addMember(m.pool, adminScope, b.personId, 'editor'), /ниже вашей/, 'администратор не меняет роль другого администратора');
    await assert.rejects(() => m.editor.removeMember(m.pool, adminScope, b.personId), /ниже вашей/, 'и не убирает его');
    await assert.rejects(() => m.editor.removeMember(m.pool, adminScope, leadId), /ниже вашей/, 'руководство тем более');
    await assert.rejects(() => m.editor.addMember(m.pool, adminScope, e.personId, 'admin'), /руководство/, 'повысить до администратора тоже нельзя');

    const seen = await m.editor.listMembers(m.pool, adminScope);
    const lead = seen.find((row) => row.personId === leadId)!;
    assert.equal(lead.title, 'Администратор факультета');
    assert.equal(lead.canManage, false);
    assert.equal(seen.find((row) => row.personId === b.personId)!.canManage, false);
    const editorRow = seen.find((row) => row.personId === e.personId)!;
    assert.equal(editorRow.canManage, true);
    assert.equal(editorRow.kind, 'студсовет');
    assert.deepEqual((await m.editor.teamPowers(m.pool, adminScope)).canInviteAdmin, false);
    assert.deepEqual((await m.editor.teamPowers(m.pool, leadScope)).canInviteAdmin, true);

    await m.editor.removeMember(m.pool, adminScope, e.personId);
    await m.editor.addMember(m.pool, leadScope, a.personId, 'editor');
    await m.editor.removeMember(m.pool, leadScope, b.personId);
    assert.equal((await q<{ role: string }>('SELECT role FROM handbook_members WHERE handbook_id = $1 AND person_id = $2', [sandbox.handbookId, a.personId]))[0]!.role, 'editor');

    // Деканат по должности и администратор факультета — оба руководство: друг другом не управляют
    const dean = await iitDean(840001);
    const deanScope: Scope = { ...iitScope, role: 'admin', personId: dean.person };
    await assert.rejects(() => m.editor.removeMember(m.pool, deanScope, leadId), /ниже вашей/);
    assert.equal((await m.editor.teamPowers(m.pool, deanScope)).myTitle, 'Деканат');
  });

  it('файл в блоке «Файл»: загрузка в приложение, выдача по ссылке, проверка публикации, уборка брошенных', async () => {
    const files = await import('../src/services/files.js');
    const domain = await import('../src/domain/handbook.js');
    const pdf = Buffer.from('%PDF-1.4\n% test\n').toString('base64');
    const saved = await files.uploadFile(m.pool, iitScope, { name: 'C:\\fakepath\\Заявление на матпомощь.pdf', data: pdf });
    assert.equal(saved.name, 'Заявление на матпомощь.pdf', 'путь из имени убран');
    assert.equal(saved.mime, 'application/pdf');
    await assert.rejects(() => files.uploadFile(m.pool, iitScope, { name: 'page.html', data: pdf }), /не подойдёт/, 'HTML не принимаем');
    await assert.rejects(() => files.uploadFile(m.pool, iitScope, { name: 'big.pdf', data: Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString('base64') }), /больше 10 МБ/);

    assert.deepEqual(domain.publishIssues([{ id: 'f1', type: 'file', title: 'Бланк' }]), ['Файл (блок 1): Загрузите файл']);
    assert.deepEqual(domain.publishIssues([{ id: 'f1', type: 'file', title: 'Бланк', fileId: saved.id, fileName: saved.name, fileSize: saved.size }]), []);
    assert.deepEqual(domain.publishIssues([{ id: 'f1', type: 'file', title: 'Старый бланк', url: 'https://example.edu/a.pdf' }]), [], 'старые блоки со ссылкой работают');

    const app = await m.api.buildApi();
    const open = await app.inject({ method: 'GET', url: `/api/files/${saved.id}/${encodeURIComponent(saved.name)}` });
    assert.equal(open.statusCode, 200, 'файл открывается без входа через MAX — во внешнем браузере');
    assert.equal(open.headers['content-type'], 'application/pdf');
    assert.equal(open.headers['x-content-type-options'], 'nosniff');
    assert.match(String(open.headers['content-disposition']), /^inline;.*filename\*=UTF-8''/);
    assert.equal(open.rawPayload.toString(), '%PDF-1.4\n% test\n');
    const missing = await app.inject({ method: 'GET', url: '/api/files/00000000-0000-4000-8000-000000000000' });
    assert.equal(missing.statusCode, 404);
    const upload = await app.inject({
      method: 'POST', url: `/api/handbook-editor/files?handbookId=${baseId}`,
      headers: { 'x-max-init-data': signed(616161), 'content-type': 'application/json' },
      payload: { name: 'Памятка.docx', data: Buffer.alloc(4 * 1024 * 1024, 7).toString('base64') },
    });
    assert.equal(upload.statusCode, 200, `файл в 4 МБ проходит лимит тела запроса: ${upload.body}`);
    const reader = await app.inject({ method: 'POST', url: `/api/handbook-editor/files?handbookId=${sandbox.handbookId}`, headers: { 'x-max-init-data': signed(850001, 'Студент'), 'content-type': 'application/json' }, payload: { name: 'a.pdf', data: pdf } });
    assert.equal(reader.statusCode, 403, 'студент файлы не загружает');
    await app.close();

    // Файл на странице остаётся, брошенный через двое суток удаляется
    const orphan = await files.uploadFile(m.pool, iitScope, { name: 'Черновик.pdf', data: pdf });
    const page = (await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND status = 'published' ORDER BY title LIMIT 1", [sandbox.handbookId]))[0]!.id;
    await m.pool.query('UPDATE pages SET draft_blocks = $2 WHERE id = $1', [page, JSON.stringify([{ id: 'f1', type: 'file', title: 'Бланк', fileId: saved.id }])]);
    await m.pool.query("UPDATE handbook_files SET created_at = now() - interval '3 days' WHERE id = ANY($1::uuid[])", [[saved.id, orphan.id]]);
    await files.purgeOrphanFiles(m.pool);
    const left = (await q<{ id: string }>('SELECT id FROM handbook_files WHERE id = ANY($1::uuid[])', [[saved.id, orphan.id]])).map((r) => r.id);
    assert.deepEqual(left, [saved.id]);
    await m.pool.query('UPDATE pages SET draft_blocks = NULL WHERE id = $1', [page]);
  });

  it('удалённое объявление: бот удаляет уже отправленные сообщения из чатов', async () => {
    const { MaxError } = await import('@maxhub/max-bot-api');
    await student(860001, sandbox.handbookId);
    await student(860002, sandbox.handbookId);
    const created = await m.editor.announce(m.pool, iitScope, { title: 'Собрание первого курса', body: 'В пятницу в 15:00, ауд. 101.', notify: true });
    const rows = await q<{ id: number }>("SELECT id FROM notifications WHERE dedupe_key LIKE $1 ORDER BY id", [`hb_ann:${created.id}:%`]);
    assert.ok(rows.length >= 2, 'объявление ушло читателям');
    // Два сообщения доставлены, одно ещё в очереди
    await m.pool.query("UPDATE notifications SET status = 'sent', max_message_id = 'mid-' || id WHERE id = ANY($1::bigint[])", [rows.slice(0, 2).map((r) => r.id)]);
    const removed = await m.editor.deleteAnnouncement(m.pool, iitScope, created.id);
    assert.equal(removed.retracted, 2);
    const pendingLeft = await q<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE dedupe_key LIKE $1 AND status = 'pending'", [`hb_ann:${created.id}:%`]);
    assert.equal(pendingLeft[0]!.n, 0, 'неотправленные отменены');

    const deleted: string[] = [];
    const bot = { api: { deleteMessage: async (mid: string) => {
      if (mid === `mid-${rows[1]!.id}`) throw new MaxError(404, { code: 'not.found', message: 'message not found' } as never);
      deleted.push(mid);
      return { success: true };
    } } };
    await m.worker.retractDue(bot as never, async () => undefined);
    assert.deepEqual(deleted, [`mid-${rows[0]!.id}`]);
    const state = await q<{ retracted: boolean }>('SELECT retracted_at IS NOT NULL AS retracted FROM notifications WHERE id = ANY($1::bigint[]) ORDER BY id', [rows.slice(0, 2).map((r) => r.id)]);
    assert.deepEqual(state.map((r) => r.retracted), [true, true], 'уже удалённое сообщение (404) тоже считается снятым');
    await m.worker.retractDue(bot as never, async () => undefined);
    assert.equal(deleted.length, 1, 'повторно не удаляем');
  });

  it('сроки для команды: видят студенты и ещё в черновиках', async () => {
    const page = (await q<{ id: string }>("SELECT id FROM pages WHERE handbook_id = $1 AND status = 'published' AND inherited_from IS NULL ORDER BY title LIMIT 1", [sandbox.handbookId]))[0]!.id;
    const editorPage = await m.editor.pageForEditor(m.pool, iitScope, page);
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await m.editor.saveDraft(m.pool, iitScope, page, { blocks: [...editorPage.page.blocks, { id: 'dl-new', type: 'deadline', title: 'Сдать заявление на общежитие', startsOn: soon }] as never });
    let list = await m.editor.editorDeadlines(m.pool, iitScope);
    assert.ok(list.drafts.some((d) => d.blockId === 'dl-new' && d.pageId === page), 'новый срок в черновике — студенты его ещё не видят');
    assert.ok(!list.deadlines.some((d) => d.title === 'Сдать заявление на общежитие'));
    await m.editor.publishPage(m.pool, iitScope, page);
    list = await m.editor.editorDeadlines(m.pool, iitScope);
    assert.ok(list.deadlines.some((d) => d.title === 'Сдать заявление на общежитие' && d.pageId === page && !d.shared), 'после публикации срок у студентов');
    assert.ok(!list.drafts.some((d) => d.blockId === 'dl-new'));
  });
});
