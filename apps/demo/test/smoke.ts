/**
 * Проверка демо-бэкенда в Node: те же модули, что уйдут в браузер, поверх PGlite.
 * Запуск: node test/run-smoke.mjs
 */
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { openDatabase, pool } from '../src/backend/pool';
import { migrate } from '../src/backend/migrate';
import { handleApi } from '../src/backend/router';
import { chat, pressButton, sendText, startBot, flushNotifications } from '../src/backend/chat';
import { setLaunchParam } from '../src/backend/auth';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✔' : '✖'} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  if (!ok) failures.push(name);
};

const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await handleApi(method, url, headers, body === undefined ? null : JSON.stringify(body));
  return response as { status: number; body: any };
};

const lastBot = () => [...chat.messages].reverse().find((m) => m.from === 'bot');
const botTexts = () => chat.messages.filter((m) => m.from === 'bot').map((m) => m.text);

const t0 = Date.now();
await openDatabase({ extensions: { pg_trgm } });
await migrate();
console.log(`база и миграции: ${Date.now() - t0} мс`);

const trgm = await pool.query<{ ok: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS ok");
check('pg_trgm подключено', trgm.rows[0]!.ok === true);

// 1. /start demo предлагает роль; студент — только читатель; смена роли сохраняет песочницу
await startBot('');
check('в приветствии нет неработающего поиска факультета', !(lastBot()?.buttons ?? []).flat().some((button) => button.text === 'Найти свой факультет'));
await startBot('demo');
check('бот спрашивает роль', /Кем попробуете/.test(lastBot()?.text ?? ''), lastBot());
const roleButtons = (lastBot()?.buttons ?? []).flat().map((b) => b.text);
check('три роли: студент, редактор, деканат', ['Студент', 'Редактор', 'Деканат'].every((t) => roleButtons.includes(t)), roleButtons);

const t1 = Date.now();
await pressButton('demo:as:student', 'Студент');
console.log(`демо-песочница: ${Date.now() - t1} мс`);
check('студент: приветствие по роли', /Вы — студент/.test(lastBot()?.text ?? ''), lastBot());
const studentButtons = (lastBot()?.buttons ?? []).flat().map((b) => b.text);
check('студенту нет кнопки редактора, есть смена роли', !studentButtons.includes('Редактор справочника') && studentButtons.includes('Сменить роль'), studentButtons);
const meStudent = await api('GET', '/api/me');
check('/api/me: студент без записи вуза', meStudent.body.person === null && meStudent.body.demo?.role === 'student', meStudent.body);
const homeStudent = await api('GET', `/api/handbook?handbookId=${meStudent.body.handbook?.id}`);
check('студент не видит редактор', homeStudent.status === 200 && homeStudent.body.editorRole === null, homeStudent.body.editorRole);

await pressButton('demo:as:dean', 'Деканат');
check('деканат: приветствие по роли', /сотрудник деканата/.test(lastBot()?.text ?? ''), lastBot());
const demoButtons = (lastBot()?.buttons ?? []).flat();
check('кнопки справочника и редактора', demoButtons.some((b) => b.text === 'Открыть справочник') && demoButtons.some((b) => b.text === 'Редактор справочника'), demoButtons);

// 2. /api/me: деканат и справочник песочницы
const me = await api('GET', '/api/me');
check('/api/me: запись деканата', me.status === 200 && me.body.person?.role === 'dean', me.body);
check('/api/me: справочник ИИТ', /^iit-demo-/.test(me.body.handbook?.slug ?? ''), me.body.handbook);
const dean = me.body.person;
const handbookId: string = me.body.handbook.id;
check('смена роли не пересоздаёт песочницу', handbookId === meStudent.body.handbook?.id, { handbookId, before: meStudent.body.handbook?.id });

// 3. Читатель: главная, поиск, страница, чеклист, профиль
const home = await api('GET', `/api/handbook?handbookId=${handbookId}`);
check('главная справочника', home.status === 200 && home.body.sections.length >= 7, home.body.sections?.length);
check('админ видит плашку редактора', home.body.editorRole === 'admin', home.body.editorRole);
const search = await api('GET', `/api/handbook/search?q=${encodeURIComponent('физра отработки')}`);
check('поиск «физра отработки»', search.body.hits?.[0]?.title === 'Как получить зачёт', search.body);
const spravka = await api('GET', `/api/handbook/search?q=${encodeURIComponent('справка')}`);
check('поиск «справка»: первая — справка об обучении', spravka.body.hits?.[0]?.title === 'Справка об обучении', spravka.body.hits?.map((h: any) => h.title));
const pageId = home.body.checklists?.[0]?.pageId;
const page = await api('GET', `/api/handbook/pages/${pageId}`);
check('страница открывается', page.status === 200 && page.body.page.blocks.length > 0, page.body);
const item = page.body.page.blocks.find((b: any) => b.type === 'checklist')?.items?.[0]?.id;
const progress = await api('PATCH', `/api/handbook/pages/${pageId}/progress`, { itemId: item, done: true });
check('отметка в чеклисте', progress.status === 200, progress.body);
const profile = await api('PATCH', '/api/handbook/profile', { course: 1, dorm: true, program: 'Прикладная информатика', reminders: true });
const savedProfile = await api('GET', `/api/handbook?handbookId=${handbookId}`);
check('профиль читателя: направление сохраняется и отображается', profile.status === 200 && savedProfile.body.profile.program === 'Прикладная информатика', savedProfile.body.profile);

// 4. Бот: поиск в чате, «нет ответа» и вопрос дежурному
await sendText('как получить справку');
check('бот нашёл справку', /Справка об обучении/.test(lastBot()?.text ?? ''), lastBot());
await sendText('есть ли военная кафедра');
check('бот честно говорит, что точного ответа нет', /Точного ответа не нашлось|такого пока нет/.test(lastBot()?.text ?? ''), lastBot());
await pressButton('hb:q', 'Спросить дежурного');
check('бот просит сформулировать вопрос', /Напишите вопрос/.test(lastBot()?.text ?? ''), lastBot());
await sendText('Работает ли библиотека по субботам?');
check('вопрос передан дежурному', /Передал дежурному/.test(lastBot()?.text ?? ''), lastBot());

// 5. Редактор: аналитика, ответ на вопрос → уведомление в чат
const analytics = await api('GET', `/api/handbook-editor/analytics?handbookId=${handbookId}`, undefined, { 'x-person-id': dean.id });
check('аналитика редактора', analytics.status === 200 && analytics.body.questions.length > 0, analytics.body);
// В демо уже есть вопросы модельных студентов — ищем свой по тексту
const mine = analytics.body.questions.find((q: any) => /библиотека по субботам/.test(q.text));
check('вопрос виден редактору', Boolean(mine), analytics.body.questions);
if (mine) {
  const answered = await api('POST', `/api/handbook-editor/questions/${mine.id}/answer?handbookId=${handbookId}`, { answer: 'Да, читальный зал открыт по субботам с 10:00 до 16:00.' }, { 'x-person-id': dean.id });
  check('ответ сохранён', answered.status === 200, answered.body);
  await flushNotifications();
  check('ответ дежурного пришёл в чат', botTexts().some((text) => /Ответ на ваш вопрос/.test(text)), botTexts().slice(-3));
}

// 6. Публикация страницы, стоящей на проверке
const structure = await api('GET', `/api/handbook-editor/structure?handbookId=${handbookId}`, undefined, { 'x-person-id': dean.id });
const inReview = structure.body.sections?.flatMap((s: any) => s.pages).find((p: any) => p.status === 'review');
check('есть страница на проверке', Boolean(inReview), structure.body);
if (inReview) {
  const published = await api('POST', `/api/handbook-editor/pages/${inReview.id}/publish?handbookId=${handbookId}`, {}, { 'x-person-id': dean.id });
  check('публикация страницы', published.status === 200, published.body);
  const found = await api('GET', `/api/handbook/search?q=${encodeURIComponent('перевод на другой профиль')}`);
  check('опубликованная страница сразу ищется', found.body.hits?.some((h: any) => h.pageId === inReview.id), found.body);
}

// 6а. Правка вдвоём (C1): устаревшая версия — 409; возврат на доработку с причиной (C2)
const asDean = { 'x-person-id': dean.id };
const section = structure.body.sections?.[0];
const draft = await api('POST', `/api/handbook-editor/pages?handbookId=${handbookId}`, { sectionId: section?.id, title: 'Где распечатать курсовую', blocks: [{ id: 't1', type: 'text', text: 'Принтер — в библиотеке.' }] }, asDean);
check('новая страница', draft.status === 200, draft.body);
const draftUrl = `/api/handbook-editor/pages/${draft.body.id}?handbookId=${handbookId}`;
const opened = await api('GET', draftUrl, undefined, asDean);
check('страница редактора отдаёт updatedAt', typeof opened.body.updatedAt === 'string' && opened.body.page?.updatedAt === opened.body.updatedAt, opened.body.updatedAt);
const firstSave = await api('PATCH', draftUrl, { summary: 'Печать для студентов', baseUpdatedAt: opened.body.updatedAt }, asDean);
check('сохранение по своей версии', firstSave.status === 200 && firstSave.body.updatedAt && firstSave.body.updatedAt !== opened.body.updatedAt, firstSave.body);
const staleSave = await api('PATCH', draftUrl, { summary: 'Затираю чужое', baseUpdatedAt: opened.body.updatedAt }, asDean);
check('устаревшая версия: 409 page_conflict', staleSave.status === 409 && staleSave.body.error?.code === 'page_conflict' && /Обновите её/.test(staleSave.body.error.message), staleSave.body);
const stalePublish = await api('POST', `/api/handbook-editor/pages/${draft.body.id}/publish?handbookId=${handbookId}`, { baseUpdatedAt: opened.body.updatedAt }, asDean);
check('публикация устаревшей версии: 409', stalePublish.status === 409 && stalePublish.body.error?.code === 'page_conflict', stalePublish.body);
const sentToReview = await api('POST', `/api/handbook-editor/pages/${draft.body.id}/review?handbookId=${handbookId}`, { note: 'Проверьте адрес библиотеки' }, asDean);
check('на проверку с комментарием', sentToReview.status === 200, sentToReview.body);
const returned = await api('POST', `/api/handbook-editor/pages/${draft.body.id}/return?handbookId=${handbookId}`, { note: 'Добавьте часы работы' }, asDean);
check('возврат на доработку', returned.status === 200 && returned.body.ok === true, returned.body);
const afterReturn = await api('GET', draftUrl, undefined, asDean);
check('причина возврата в редакторе', afterReturn.body.returnNote === 'Добавьте часы работы' && afterReturn.body.page?.status === 'draft', { returnNote: afterReturn.body.returnNote, status: afterReturn.body.page?.status });
const returnAgain = await api('POST', `/api/handbook-editor/pages/${draft.body.id}/return?handbookId=${handbookId}`, {}, asDean);
check('вернуть можно только страницу на проверке', returnAgain.status === 409, returnAgain.body);

// 6б. Повторная проверка в тот же день и очистка описания (регрессии конструктора).
const reviewCount = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE kind = 'handbook_review' AND payload->>'pageId' = $1", [draft.body.id])).rows[0]!.n;
const beforeRepeat = await reviewCount();
const reviewedAgain = await api('POST', `/api/handbook-editor/pages/${draft.body.id}/review?handbookId=${handbookId}`, { note: 'Часы уточнены' }, asDean);
check('доработка в тот же день создаёт новое уведомление', reviewedAgain.status === 200 && await reviewCount() === beforeRepeat + reviewedAgain.body.notified && reviewedAgain.body.notified > 0, reviewedAgain.body);
const repeatedRequest = await api('POST', `/api/handbook-editor/pages/${draft.body.id}/review?handbookId=${handbookId}`, {}, asDean);
check('повтор запроса проверки не дублирует уведомление', repeatedRequest.body.notified === 0 && repeatedRequest.body.updatedAt === reviewedAgain.body.updatedAt, repeatedRequest.body);
await api('POST', `/api/handbook-editor/pages/${draft.body.id}/publish?handbookId=${handbookId}`, {}, asDean);
const cleared = await api('PATCH', draftUrl, { summary: null }, asDean);
const clearRead = await api('GET', draftUrl, undefined, asDean);
check('описание очищается в черновике', cleared.status === 200 && clearRead.body.page.summary === null, clearRead.body.page);
await api('PATCH', draftUrl, { title: 'Где распечатать курсовую и диплом' }, asDean);
const afterAutosave = await api('GET', draftUrl, undefined, asDean);
check('автосохранение без описания не возвращает старый текст', afterAutosave.body.page.summary === null, afterAutosave.body.page);
const oldPublished = await api('GET', `/api/handbook/pages/${draft.body.id}?handbookId=${handbookId}`);
check('до публикации описание для читателя прежнее', oldPublished.body.page.summary === 'Печать для студентов', oldPublished.body.page);
await api('POST', `/api/handbook-editor/pages/${draft.body.id}/publish?handbookId=${handbookId}`, {}, asDean);
const newPublished = await api('GET', `/api/handbook/pages/${draft.body.id}?handbookId=${handbookId}`);
check('публикация сохраняет очищенное описание', newPublished.body.page.summary === null, newPublished.body.page);

// 7. Объявление первому курсу приходит в чат
const announced = await api('POST', `/api/handbook-editor/announcements?handbookId=${handbookId}`, { title: 'Собрание первого курса', body: 'В четверг в 16:00, аудитория 201.', audience: { courses: [1] }, notify: true }, { 'x-person-id': dean.id });
check('объявление опубликовано', announced.status === 200 && announced.body.notified > 0, announced.body);
await flushNotifications();
check('объявление пришло в чат', botTexts().some((text) => /Собрание первого курса/.test(text)), botTexts().slice(-3));

// 8. Команда: приглашение по ссылке
const invite = await api('POST', `/api/handbook-editor/invites?handbookId=${handbookId}`, { fullName: 'Лебедева Ольга Игоревна', kind: 'staff', role: 'editor' }, { 'x-person-id': dean.id });
check('приглашение в команду', invite.status === 200 && /inv_H-/.test(invite.body.link ?? ''), invite.body);
const members = await api('GET', `/api/handbook-editor/members?handbookId=${handbookId}`, undefined, { 'x-person-id': dean.id });
check('участник ждёт вход по ссылке', members.body.members?.some((m: any) => m.personId === invite.body.personId && !m.connected && m.link), members.body);

// 9. Деканат: список своих справочников и создание нового
const mineList = await api('GET', '/api/handbooks?mine=1', undefined, { 'x-person-id': dean.id });
check('справочники деканата', mineList.status === 200 && mineList.body.handbooks.length >= 1, mineList.body);
const created = await api('POST', '/api/handbook-editor/handbooks', { instituteId: dean.instituteId, title: 'Справочник магистратуры' }, { 'x-person-id': dean.id });
check('новый справочник из шаблона', created.status === 200 && created.body.sections >= 8 && created.body.pages >= 20, created.body);
const asEditor = await api('POST', '/api/demo/role', { role: 'editor' });
const editorMe = await api('GET', '/api/me');
check('роль редактора в той же песочнице', asEditor.status === 200 && editorMe.body.person?.role === 'staff' && editorMe.body.person?.isDemo, editorMe.body.person);
const editorCreated = await api('POST', '/api/handbook-editor/handbooks', { instituteId: editorMe.body.person.instituteId, title: 'Справочник стажировки' });
check('редактор создаёт второй справочник в своей демо-песочнице', editorCreated.status === 200 && editorCreated.body.sections >= 8, editorCreated.body);
const editorMine = await api('GET', '/api/handbooks?mine=1');
check('новый справочник виден редактору', editorMine.body.handbooks.some((item: { id: string }) => item.id === editorCreated.body.id), editorMine.body);
const editorSection = await api('POST', `/api/handbook-editor/sections?handbookId=${editorCreated.body.id}`, { title: 'Практика и стажировки', emoji: '🚀' });
const editorStructure = await api('GET', `/api/handbook-editor/structure?handbookId=${editorCreated.body.id}`);
check('создатель справочника добавляет свой раздел', editorSection.status === 200 && editorStructure.body.sections.some((item: { title: string }) => item.title === 'Практика и стажировки'), editorStructure.body.sections);
await api('POST', '/api/demo/role', { role: 'dean' });

// 10. Диплинки
setLaunchParam(`hbp_${pageId}`);
const deep = await api('GET', '/api/handbook');
check('диплинк на страницу', deep.status === 200 && deep.body.handbook.id === handbookId, deep.body.handbook);
setLaunchParam(`hb_${me.body.handbook.slug}`);
const deepHb = await api('GET', '/api/me');
check('диплинк hb_<слаг>', deepHb.body.handbook?.id === handbookId, deepHb.body.handbook);
setLaunchParam(null);

// 11. Ошибки как на сервере
const badPage = await api('GET', '/api/handbook/pages/не-uuid');
check('невалидный id: 400 по-русски', badPage.status === 400 && /Некорректный идентификатор/.test(badPage.body.error.message), badPage.body);
const shortQuestion = await api('POST', '/api/handbook/questions', { text: 'а?' });
check('короткий вопрос: 400', shortQuestion.status === 400, shortQuestion.body);
const nulQuestion = await api('POST', '/api/handbook/questions', { text: 'Где деканат\u0000 находится?' });
check('нулевой байт во входе вырезается', nulQuestion.status === 200, nulQuestion.body);
const brokenJson = await handleApi('POST', '/api/handbook/questions', {}, '{не json');
check('битый JSON: 400 по-русски', brokenJson.status === 400 && /Не удалось прочитать/.test((brokenJson.body as any).error.message), brokenJson.body);

// 12. Сброс демо из мини-приложения
const reset = await api('POST', '/api/demo', {});
check('пересоздание демо', reset.status === 200 && reset.body.handbookId !== handbookId, reset.body);
const gone = await api('GET', `/api/handbook-editor/structure?handbookId=${reset.body.handbookId}`, undefined, { 'x-person-id': dean.id });
check('старая запись после сброса: person_gone', gone.status === 409 && gone.body.error.code === 'person_gone', gone.body);

// 13. Бот не путает команды с вопросами и честно говорит об устаревшей ссылке
await sendText('/menu');
check('незнакомая команда — подсказка, а не поиск', /Такой команды нет/.test(lastBot()?.text ?? ''), lastBot());
await startBot('hb_net-takogo-spravochnika');
check('устаревшая ссылка hb_ — честное сообщение', /не найден/.test(lastBot()?.text ?? ''), lastBot());
await startBot('DEMO');
check('параметр запуска без учёта регистра', /Кем попробуете/.test(lastBot()?.text ?? ''), lastBot());
await pressButton('old:button', 'Старая кнопка');
check('старая кнопка не ломает бота', !/Что-то пошло не так/.test(lastBot()?.text ?? ''), lastBot());

console.log(`\nсообщений в чате: ${chat.messages.length}`);
console.log(failures.length ? `\nПРОВАЛЕНО: ${failures.length}\n- ${failures.join('\n- ')}` : '\nВСЁ ЗЕЛЁНОЕ');
process.exit(failures.length ? 1 : 0);
