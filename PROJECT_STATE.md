# PROJECT_STATE — текущее состояние проекта

> **Единый источник правды о проекте.** Агенты и разработчики сначала читают этот файл, а не код.
> Код открывается точечно — только файлы, которые нужно менять.
> После любого серьёзного или структурного изменения этот файл обновляется в том же коммите,
> а в [журнал изменений](#журнал-изменений) добавляется запись. Правила — в [`AGENTS.md`](AGENTS.md).

**Последнее обновление:** 2026-09-29 (стеклянный дизайн, кампус на главной, курс шкалой) · **Ветка:** `main` · **Дедлайн хакатона:** 30.09.2026

---

## Оглавление

1. [Что это](#что-это)
2. [Фичи](#фичи)
3. [Архитектура](#архитектура)
4. [Карта кода](#карта-кода)
5. [Модель данных](#модель-данных)
6. [API](#api)
7. [Бот и диплинки](#бот-и-диплинки)
8. [Уведомления](#уведомления)
9. [Права и роли](#права-и-роли)
10. [Демо-песочница](#демо-песочница)
11. [Конвенции](#конвенции)
12. [Запуск и проверка](#запуск-и-проверка)
13. [Тесты](#тесты)
14. [Ограничения, техдолг, бэклог](#ограничения-техдолг-бэклог)
15. [Архив](#архив)
16. [Журнал изменений](#журнал-изменений)

---

## Что это

**Курсор** — конструктор живых справочников для факультетов в мессенджере MAX: чат-бот + мини-приложение. Клиент и плательщик — университет; пилот может начинаться с одного факультета. Деканат управляет справочником факультета, студсовет и сотрудники наполняют его, пользователи — студенты. «Курсор» — имя платформы; справочник каждого факультета называется по-своему («Справочник ИИТ»).
Хакатон MAX 2026, трек «Образовательные решения», команда SQUAD 70.
Прообраз — «хитсовник» ВИТШ ТГУ (hits.super.site): студенческий справочник на Notion.

- Студент читает справочник без регистрации (достаточно аккаунта MAX), ищет своими словами прямо в чате с ботом, отмечает чеклисты, получает напоминания о сроках и адресные объявления.
- Команда справочника (студсовет, тьюторы, учебный офис) ведёт его с телефона: страницы из блоков, черновик → проверка → публикация, бэклог из реальных запросов студентов.
- Деканат создаёт справочник одной кнопкой из шаблона и приглашает команду личными ссылками.

Продуктовая концепция — [`docs/HANDBOOK.md`](docs/HANDBOOK.md), коммерческая модель и целевая иерархия доступов — [`docs/COMMERCIAL_MODEL.md`](docs/COMMERCIAL_MODEL.md), пилот и масштабирование — [`docs/PILOT_AND_SCALING.md`](docs/PILOT_AND_SCALING.md). Инструкция для жюри и запуск — [`README.md`](README.md).

## Фичи

Статусы: ✅ готово и покрыто тестами · 🟡 готово, без автотестов · ⛔ нет (см. бэклог).

### Читатель (студент)

| Фича | Статус | Где |
|---|---|---|
| Открыть справочник по ссылке `hb_<слаг>`, по прошлому визиту или из витрины; без записи в вузе | ✅ | `services/handbook.ts` `contextFor`, `startRef`; `api/routes/common.ts` `/api/me` |
| Главная: объявления, ближайшие сроки, незаконченные чеклисты, разделы, «часто ищут» | 🟡 | `services/handbook.ts` `home`; `miniapp/.../HandbookHome.tsx` |
| Объявления: карточка ведёт на связанную страницу; «Прочитано ✓» убирает в архив, из архива можно вернуть; истёкшие — в архиве | ✅ | `announcementsFeed`, `markAnnouncementRead` (`announcement_reads`); `HandbookAnnouncements.tsx` |
| «Стекло»: синий градиентный фон (ночью — тёмно-фиолетовый), текст на фоне белый, карточки, кнопки, поиск и док — матовое стекло; основные действия — градиент синий → фиолетовый; значки разделов и аватары одним синим; статусные цвета только для статусов; системная тема по умолчанию | 🟡 e2e | `app/theme.tsx`, `design-tokens.css`, `styles.css`, `glass.css`, `styles-v2.css`, `components/icons.tsx` |
| Главная: фото кампуса во весь верх экрана (день/ночь), приветствие и название поверх фото, без знака → поиск (общий `SearchField`) → ближайший срок с датой и цветом срочности → объявления → начатые чеклисты или «С чего начать» → разделы → помощь; тема — только в профиле; док с подписями (у команды пять вкладок: «Команда» внутри «Редакции»), «Назад» подписан экраном возврата | 🟡 e2e | `HandbookHome.tsx`, `HandbookContents.tsx`, `HandbookDeadlines.tsx`, `HandbookShell.tsx` |
| Страница из 12 типов блоков, «Проверено <дата>», соседние страницы | ✅ | `domain/handbook.ts`, `miniapp/.../Blocks.tsx`, `HandbookPage.tsx` |
| Наследование вуз → факультет, переопределение страницы (`inherited_from`) | ✅ | `services/handbook.ts` `applyInheritance` |
| Адресность по курсу, общежитию, тегам (страница, раздел, блок, срок, объявление) | ✅ | SQL `audience_matches` в `002_handbook.sql`; `HandbookProfile.tsx` |
| Поиск: синонимы/сленг, веса заголовка и раздела, OR-фолбэк, опечатки `pg_trgm`, флаг `exact` | ✅ | `services/handbook.ts` `search`; `domain/handbook.ts` `normalizeQuery`, синонимы |
| Поиск в чате с ботом: выдержка + кнопка «Открыть страницу» | 🟡 | `bot/index.ts` `handleHandbookText` |
| Чеклисты с личным прогрессом | ✅ | `reader_progress`; `setProgress` |
| Оценка страницы «Помогла?» с комментарием | ✅ | `page_feedback`; `setFeedback` |
| Вопрос дежурному из приложения и из чата (не больше 5 открытых; из чата — только когда пришёл текст) | ✅ | `askQuestion`, `awaitChatQuestion`/`takeChatQuestion` (kv `hbq:<userId>`, 15 мин); `HandbookAsk.tsx`; callback `hb:q` |
| Напоминания о сроках в чат (по `remindDays` блока «Срок», с учётом аудитории и отписки) | ✅ | `worker/index.ts` `enqueueDeadlineReminders` |
| Переключение между справочниками | 🟡 | `HandbookList.tsx`, `App.tsx` `openHandbook(id, start?)` |
| Профиль: имя и фото из подписанных данных MAX, автосохранение программы, курса (шкала 1–6, сохранение по отпусканию), общежития («Да / Нет») и напоминаний; переключатели — отдельные капсулы; в браузерном демо — модельное имя | ✅ smoke | `api/auth.ts`, `api/routes/common.ts`, `HandbookProfile.tsx` |
| Профили команды: метка роли, аналитика и справочники без дублирования дока; параметры студента раскрываются отдельно для предпросмотра. Читательские экраны команды помечены «Предпросмотр со стороны студента» | 🟡 e2e | `HandbookProfile.tsx`, `HandbookShell.tsx` |
| Первый экран: что умеет справочник, сканер QR (телефон), витрина, демо, код или ссылка-приглашение | 🟡 | `screens/Onboarding.tsx` |
| Сканер QR в приложении (`openCodeReader`): плакат любого факультета открывает свой справочник на нужной странице | ✅ | `links.ts` `resolveScanned`; `GET /api/handbook?page=`; `HandbookSearch.tsx` (`ScanQrRow`, экран «Поиск»), `Onboarding.tsx` |
| «Поделиться» справочником и страницей (`shareMaxContent`, иначе копирование) | 🟡 | `HandbookHome.tsx`, `HandbookPage.tsx` |
| «Назад» возвращает на то же место: кэш ответов экранов и позиция прокрутки | 🟡 | `lib/useLoad.ts` (`cacheKey`), `context.tsx` |
| Ограничение частоты в боте: 20 сообщений и нажатий в минуту, одно предупреждение, дальше тишина; бот отвечает только в личном диалоге | ✅ | `bot/guards.ts` `allowMessage`, middleware в `bot/index.ts` |
| Бот не путает команды с вопросами: неизвестная `/команда` — подсказка, устаревшая ссылка `hb_` — честное сообщение, старая кнопка — ответ вместо зависшего индикатора | ✅ smoke | `bot/index.ts` |

### Команда справочника (редактор / администратор)

| Фича | Статус | Где |
|---|---|---|
| Компактный редактор со сворачиваемыми разделами, фильтрами статусов и «Требует внимания» (≥3 отрицательных оценки, проверка или устаревание); проблемные страницы выше; выбор значка раздела | 🟡 | `editorStructure`; `HandbookEditor.tsx` |
| Конструктор со сворачиваемыми блоками, аудиторией, предпросмотром и прежней очередью автосохранения | 🟡 | `HandbookEditorPage.tsx`, `BlockEditor.tsx` |
| Карточка статуса страницы: отправка на проверку доступна редактору и администратору; администратор публикует, возвращает на доработку, архивирует и восстанавливает черновик | 🟡 e2e | `HandbookEditorPage.tsx`, `styles.css`; существующие API |
| Черновик принимает недозаполненные блоки (`draftBlocksSchema`) и возвращает `issues`; на проверку и в публикацию — только полные | ✅ | `domain/handbook.ts` `publishIssues`; `saveDraft`, `submitForReview` |
| QR-плакат страницы для печати (PNG), яркость экрана на максимум | 🟡 | `QrPoster.tsx` (`qrcode`) |
| Черновик → на проверку (уведомление админам) → публикация (версия в `page_versions`) → архив; правки опубликованной страницы проверяются, а студенты до публикации видят прежнюю версию | ✅ | `saveDraft`, `submitForReview` (`review_requested_at`), `publishPage`, `archivePage` |
| Сроки из блоков «Срок» попадают в календарь `handbook_deadlines` при публикации | ✅ | `syncDeadlines` |
| Аналитика: запросы без результата, топ запросов, открытые вопросы, слабые и устаревшие страницы | ✅ | `analytics`; `HandbookAnalytics.tsx` |
| Метрики пилота с целями: нашли ответ сами (≥80%), страница помогла (≥85%), медиана ответа дежурного (≤24 ч), проверено за полгода (≥90%), активные читатели | ✅ | `pilotMetrics`; `HandbookAnalytics.tsx` `PilotMetricsCard` |
| Ответ на вопрос дежурному (любой участник команды) → уведомление читателю + пункт FAQ в черновике страницы | ✅ | `answerQuestion` |
| Объявления: аудитория по курсам, ссылка на опубликованную страницу (кнопка «Подробнее» в чате), рассылка; список с числом прочитавших, правка без повторной рассылки, удаление с отменой неотправленных уведомлений | ✅ | `announce`, `listAnnouncements`, `updateAnnouncement`, `deleteAnnouncement`; `HandbookEditor.tsx` `AnnounceSheet` |
| Команда: раскрывающиеся карточки, приглашение по личной ссылке, смена роли и удаление; изменение состава и ссылки доступны только админу | ✅ | `inviteEditor`, `listMembers`, `removeMember`; `HandbookTeam.tsx` |
| Разделы: создание администратором из редактора; изменение через API | 🟡 | `createSection`, `updateSection`; `HandbookEditor.tsx` |

### Деканат

| Фича | Статус | Где |
|---|---|---|
| Подключение вуза и сотрудников деканата консольной командой с личными ссылками | 🟡 | `cli/bootstrap.ts` |
| Экран «Справочники факультетов»: список справочников вуза и создание нового — шаблон 8 разделов, ~25 заготовок-черновиков, наследование справочника вуза | ✅ | `createHandbook`, `services/handbook-template.ts`; `HandbookCreate.tsx` |
| Редактор личной демо-песочницы тоже создаёт дополнительный справочник; в настоящем вузе создание остаётся правом деканата | ✅ | `createHandbook`, `HandbookList.tsx`, `HandbookCreate.tsx` |
| Деканат своего института — администратор его справочников по должности | ✅ | `services/handbook.ts` `membership` |

### Платформа

| Фича | Статус | Где |
|---|---|---|
| Вход в мини-приложение по подписи `initData`; тестовый вход `DEV_AUTH` | ✅ | `auth/initData.ts`, `api/auth.ts` |
| Привязка аккаунта MAX к записи вуза по приглашению (`inv_<код>`, код `H-XXXX-XXXX`) | ✅ | `services/identity.ts` `bindInvite` |
| Привязка по телефону (`requestContact`) | 🟡 резерв | `bindByPhone`, `POST /api/bind/phone`; в UI не используется — нет загрузки телефонов |
| Outbox-очередь уведомлений с повторами (~5 часов: 401/429/5xx/сеть — временные, 400/403/404 — окончательные), лимитом частоты, дедупликацией | ✅ | `notify/outbox.ts`, `worker/index.ts` |
| Идемпотентная обработка обновлений MAX | ✅ | `bot/dedupe.ts`, `processed_updates` |
| Демо-песочница на каждый аккаунт MAX: выбор роли в начале (студент / редактор / деканат), смена роли без потери данных, сброс | ✅ | `services/demo.ts` (`setDemoRole`, `getDemoRole`), `services/demo-handbook.ts`; `bot/index.ts` `askDemoRole` |
| Docker Compose: офлайн-стенд с имитацией MAX и продакшн-профиль с HTTPS | 🟡 | `compose.yaml`, `compose.prod.yaml`, `apps/max-mock` |
| Браузерное демо одной страницей: PostgreSQL (PGlite) + настоящие маршруты API, бот и воркер в браузере | ✅ smoke, e2e | `apps/demo/` — см. «Карта кода» |
| Сквозной тест сценария из README в браузере (Playwright): роли, объявления, чек-лист, тема, вопрос → ответ, объявление со ссылкой, QR, закрытый редактор | ✅ | `apps/demo/test/e2e.mjs`; job `demo` в CI |

## Архитектура

```
MAX клиент ──чат──▶ MAX Bot API ──updates──▶ bot ─┐
     │                    ▲                        │
     │                    └──── сообщения ◀── worker (outbox, напоминания)
     └──мини-приложение──▶ web (Caddy: статика, /api → api, /webhook → bot)
                                      api ─────────┤
                                                   ▼
                                           PostgreSQL 16
```

- **Один серверный образ** `apps/server`, роль — аргумент запуска: `migrate | api | bot | worker | all | bootstrap | check-max` (`src/index.ts`; `check-max` — диагностика связи с MAX после развёртывания).
- **TLS к MAX:** `platform-api2.max.ru` подписан УЦ Минцифры; цепочка — `apps/server/certs/russian_trusted_ca.pem`, в образе `NODE_EXTRA_CA_CERTS`. Без неё бот не работает на сервере.
- **Стек:** Node 22, TypeScript (ESM), Fastify 5, Zod 3, `pg`, PostgreSQL 16 (+ `pg_trgm`, если доступно), `@maxhub/max-bot-api` 0.3.1. Мини-приложение: React 19, Vite 7, `@maxhub/max-ui` 0.5.0, MAX Bridge (`st.max.ru/js/max-web-app.js`).
- **Разделение чат ↔ приложение:** чат — поиск, короткие ответы, уведомления, приглашения; приложение — чтение, чеклисты, профиль, редактор, аналитика, команда.

## Карта кода

### `apps/server/src`

| Файл | Что внутри |
|---|---|
| `index.ts` | Точка входа: выбор роли процесса, graceful shutdown, `check-max` (MAX API, webhook, `/api/health`) |
| `config.ts` | Переменные окружения (Zod): `APP_TIMEZONE` — только имя IANA, `WEBHOOK_SECRET` обязателен для webhook в продакшне; `derivedSecret('phone')` |
| `db/pool.ts`, `db/migrate.ts` | Пул `pg`, хелперы `one`/`many`/`tx`; применение `migrations/*.sql` по порядку |
| `domain/types.ts` | `Role = 'student' \| 'staff' \| 'dean'`, подписи ролей |
| `domain/dates.ts` | Даты в часовом поясе вуза: `todayIn`, `daysBetween`, `formatDateRu`, `pluralDays`, `notBefore` (окно отправки 10:00–21:00) |
| `domain/handbook.ts` | Схемы блоков (12 типов): `makeBlockSchema(strict)` → `blockSchema`/`blocksSchema` (публикация) и `draftBlockSchema`/`draftBlocksSchema` (черновик); `publishIssues`, `describeBlockIssue`, `BLOCK_LABEL`, `blockText` (текст для поиска), синонимы и нормализация запроса, слаги |
| `services/common.ts` | `audit()`, информация о вузе |
| `lib/errors.ts`, `lib/zod-ru.ts`, `lib/sanitize.ts` | `AppError`, `notFound(сообщение)`, `forbidden`, `inputErrorFromDatabase` (ошибки данных PostgreSQL → 400), `clientErrorFromRequest` (разбор запроса — по-русски); русские сообщения Zod; `stripNul` — вырезает нулевой байт из входа |
| `services/identity.ts` | Пользователи MAX, записи вуза, приглашения (`ensureInvite`, `bindInvite`), телефон |
| `services/handbook.ts` | Чтение: каталог, `contextFor` (какой справочник открыть), `startRef` (диплинк → справочник), читатели, главная, разделы, страница, поиск, прогресс, оценки, вопросы, `membership`/`memberRole` |
| `services/handbook-editor.ts` | Редактор: структура, разделы, страницы, черновик/проверка/публикация/архив, `syncDeadlines`, аналитика, ответы, объявления, создание справочника, участники и приглашения |
| `services/handbook-template.ts` | Шаблон нового справочника: 8 разделов и страницы-заготовки |
| `services/demo.ts` | `createDemoSandbox(user, role)` → `DemoSandbox { …, handbookId, handbookSlug, role }`; `DEMO_ROLES`, `getDemoRole`, `setDemoRole` — роль посетителя в песочнице |
| `services/demo-handbook.ts` | Контент демо: справочник вуза `mu-demo-<id>` и ИИТ `iit-demo-<id>`, объявление, сроки (сдвигаются от 24.09.2026 к сегодняшнему дню — `demoDateShift`), журнал поиска, вопросы |
| `api/server.ts` | Fastify, rate limit по IP, обработка ошибок, регистрация маршрутов |
| `api/auth.ts` | Актор запроса из `X-Max-Init-Data` / `X-Dev-User`, активная запись вуза (`X-Person-Id`) |
| `api/routes/common.ts` | `/api/me` (с ролью в демо), привязка, демо и смена роли |
| `api/routes/handbook.ts` | API читателя |
| `api/routes/handbook-editor.ts` | API редактора; `scope()` — проверка членства |
| `auth/initData.ts` | Проверка и подпись `initData`, проверка контакта |
| `bot/index.ts` | Обработчики бота: `/start` с параметрами, `/demo` (выбор роли), `/reset`, `/spravka`, `/help`, поиск текстом, callbacks; кнопки справочника зависят от роли в демо |
| `bot/dedupe.ts` | Ключи идемпотентности обновлений |
| `bot/guards.ts` | Чистые проверки входящих: `INVITE_RE` (код `H-XXXX-XXXX`), `allowMessage` (лимит частоты: `ok` / `warn` / `silent`) |
| `max/bot.ts`, `max/buttons.ts` | Клиент Bot API, `getBotIdentity`, `deepLink`; кнопки (`appButton`, `callbackButton`) |
| `max/tls.ts` | `tlsTrustHint` — понятная подсказка, если Node.js не доверяет сертификату MAX API |
| `../certs/` | Цепочка УЦ Минцифры для MAX Bot API и README с отпечатками |
| `notify/outbox.ts` | `enqueue` (по записи вуза), `enqueueToReader` (по читателю), `cancelPending`, `acknowledge` |
| `notify/render.ts` | Тексты уведомлений и `welcomeMessage`; пользовательский текст экранируется так, что ссылки, почта и телефоны остаются рабочими; перед отправкой повторно проверяются адресат, аудитория и даты |
| `worker/index.ts` | `dispatchDue` (отправка, 12 попыток с паузой до часа), `enqueueDeadlineReminders` (с 10:00 до 21:00 по времени вуза — `notBefore`; демо — только первые 14 дней), `runScheduledChecks` (раз в минуту под advisory lock; её сбой не останавливает отправку), `startWorker` |
| `cli/bootstrap.ts` | Подключение реального вуза: вуз, институт, деканат, ссылки-приглашения |

### `apps/demo` — браузерное демо

Одна HTML-страница, где работают **настоящие** модули `apps/server/src` и `apps/miniapp/src`: сборка esbuild подменяет модули, завязанные на Node, браузерными (`esbuild.shared.mjs`, `shimPlugin`).

| Файл | Что внутри |
|---|---|
| `esbuild.shared.mjs` | Карта подмен: `db/pool` → PGlite, `config`, `logger`, `max/bot`, `api/server`, `api/auth`, `node:crypto` → `@noble/hashes`, SDK MAX → заглушка |
| `src/backend/pool.ts` | Интерфейс `pg` поверх PGlite: одно соединение, `serial()` — очередь входов, вложенные транзакции → точки сохранения |
| `src/backend/migrate.ts` | Те же SQL-миграции сервера (импорт как текст) — **новую миграцию добавить и сюда** |
| `src/backend/router.ts` | Мини-маршрутизатор с интерфейсом Fastify: регистрирует `registerCommonRoutes`, `registerHandbookRoutes`, `registerHandbookEditorRoutes` |
| `src/backend/chat.ts` | Имитация `Bot` из SDK MAX: настоящие `registerHandlers` бота и `dispatchDue`/`runScheduledChecks` воркера пишут в ленту чата |
| `src/backend/auth.ts` | Постоянный модельный пользователь MAX (id 7700001), `setLaunchParam` — параметр запуска мини-приложения |
| `src/boot.ts`, `src/host.tsx`, `src/host.css` | Загрузка PGlite из встроенных в страницу файлов; страница: чат слева, «телефон» с мини-приложением (iframe `srcdoc`) справа, вкладки на узком экране |
| `src/app-entry.tsx` | Точка входа мини-приложения для фрейма — `App` из `apps/miniapp` без изменений |
| `build.mjs` | `npm run build` → `dist/demo.html` (~9 МБ, без `<html>/<head>`: страницу оборачивает хостинг артефактов) |
| `test/smoke.ts` | `npm run smoke` — сценарий на PGlite в Node: демо, поиск, чат, вопрос → ответ, публикация, объявление, приглашение, новый справочник, диплинки, выбор и смена роли демо, сброс, команды и устаревшие ссылки |
| `test/e2e.mjs` | `npm run e2e` (после `npm run build`) — сценарий из README в Chromium по собранной `dist/demo.html`; элементы ищет по тексту и доступному имени, скриншоты шагов — `test/e2e-output/` |

Опубликованная версия — артефакт claude.ai с демо (приватный, делится через Share). После изменений в сервере или мини-приложении: `npm run smoke && npm run build` в `apps/demo` и перепубликация `dist/demo.html`.

### `apps/miniapp/src`

| Файл | Что внутри |
|---|---|
| `App.tsx` | Загрузка `/api/me`; есть справочник → `HandbookShell`; деканат без справочника → `HandbookCreatePanel`; иначе `Onboarding`. `openHandbook`, демо в выбранной роли, смена роли, сброс |
| `app/theme.tsx` | `AppRoot`: MAX UI в выбранной схеме и обёртка `.pd-app[data-theme]`; `useTheme()` — `pref` (`dark\|light\|system`, `localStorage` `handbook:theme`), `toggle` |
| `app/context.tsx` | `useToastState` (тосты) |
| `lib/api.ts`, `lib/bridge.ts` | HTTP-клиент с заголовками авторизации; обёртка MAX Bridge (back button, haptic, share, openLink) |
| `lib/types.ts`, `lib/format.ts` | Типы ответов API, форматирование |
| `lib/demo.ts` | Роли демо для интерфейса: подписи, значки, `demoRoleName` |
| `lib/sheets.ts` | Стопка открытых листов: системная «Назад» и Esc закрывают верхний лист, а не экран |
| `lib/drafts.ts`, `lib/checklists.ts` | Черновик вопроса дежурному (sessionStorage); прогресс выполненных чек-листов для плиток главной (localStorage) |
| `lib/useLoad.ts` | Загрузчик данных экрана; `cacheKey` — последний ответ показывается сразу при возврате «Назад»; `clearLoadCache` после сброса демо и смены справочника |
| `screens/Onboarding.tsx` | Первый запуск: что умеет справочник, сканер QR (на телефоне), витрина, демо с выбором роли, код или ссылка-приглашение |
| `screens/handbook/context.tsx` | Навигация `hb-*`, стек и восстановление прокрутки; `nav.tab` без накопления истории дока, права справочника с API и профиль MAX в `useHandbook()` |
| `screens/handbook/HandbookShell.tsx` | Шапка и роутер, баннер демо; нижний док из четырёх разделов читателя и двух разделов команды; скрывается в конструкторе |
| `screens/handbook/links.ts` | Диплинки мини-приложения: `handbookStartRoutes`, `paramFromLink`, `resolveScanned` (QR → справочник и экран) |
| `screens/handbook/QrPoster.tsx` | Лист «QR-плакат»: превью, отправка ссылки, PNG для печати |
| `HandbookHome`, `HandbookContents`, `HandbookDeadlines`, `HandbookSection`, `HandbookPage`, `HandbookSearch`, `HandbookProfile` (+ оформление), `HandbookAsk` | Экраны читателя |
| `screens/handbook/HandbookAnnouncements.tsx` | `AnnouncementCard` (карточка со ссылкой на страницу); экран «Объявления»: новые и архив |
| `HandbookEditor` (+ список объявлений, `AnnounceSheet` — создание и правка, выбор страницы, удаление), `HandbookEditorPage`, `BlockEditor`, `Blocks`, `HandbookAnalytics`, `HandbookTeam` | Экраны команды |
| `HandbookCreate` (`HandbookCreatePanel`), `HandbookList` (`HandbookPicker`) | «Справочники факультетов» (для деканата); витрина справочников |
| `styles.css` | Токены `--pd-*` в двух контекстах — «на фоне» (фото кампуса, светлый текст) и «на поверхности» (стеклянные карточки, тёмный текст); переменные MAX UI; классы `hb-*` |
| `styles-v2.css` | Точка входа стилей и локальные шрифты; импорт `styles.css`, затем `glass.css` |
| `glass.css` | Визуальный слой «стекло»: фон, поверхности, кнопки, док, фото кампуса на главной, переключатели и шкала курса профиля, подсказка ролей команды |
| `design-tokens.css` | Единая палитра, пять размеров текста, три радиуса, темы и адаптер MAX UI |
| `assets/campus/` | Изображения кампуса для шапки главной (`hero-day.webp`, `hero-night.webp`), созданные командой с помощью генеративного ИИ специально для «Курсора». Шрифт Onest подключается из `@fontsource/onest` в `app/theme.tsx` |
| `components/icons.tsx` | `Icon` — типизированный набор Lucide (`lucide-react`), без внешних запросов |

### Прочее

| Путь | Что |
|---|---|
| `apps/server/migrations/001_platform.sql` | Платформа: вузы, пользователи, институты, группы, записи, приглашения, уведомления, аудит, kv, processed_updates |
| `apps/server/migrations/002_handbook.sql` | Справочник: все таблицы ниже, `audience_matches`, поисковые колонки |
| `apps/server/migrations/003_chat_questions.sql` | Удалён `handbook_readers.pending_question_id` (ожидание вопроса из чата — в `kv`), вычищены пустые вопросы «Вопрос из чата» |
| `apps/server/migrations/004_announcements.sql` | `announcements.updated_at`; таблица `announcement_reads` (кто убрал объявление в архив) |
| `apps/server/migrations/005_review_keeps_published.sql` | `pages.review_requested_at` (правки опубликованной страницы на проверке); `audience_matches`: читатель без тегов видит адресное по тегам, как в коде |
| `apps/server/migrations/006_page_return.sql` | `pages.return_note`, `pages.returned_at` — страницу вернули на доработку |
| `apps/server/migrations/007_deadline_block_audience.sql` | В `handbook_deadlines.audience` — только аудитория блока; пересчёт сохранённых сроков |
| `apps/max-mock/server.mjs` | Имитация MAX Bot API + веб-чат `/__mock/` |
| `compose.yaml`, `compose.prod.yaml` | Локальный стенд; продакшн-переопределения (webhook, HTTPS, без mock) |
| `.github/workflows/ci.yml` | CI: typecheck + тесты сервера на PostgreSQL, сборка мини-приложения, smoke, сборка и сквозной тест браузерного демо (скриншоты — артефакт `e2e-screenshots`), проверка обновления PROJECT_STATE.md в PR |
| `docs/DESIGN.md` | Правила внешнего вида мини-приложения: где что лежит, токены, MAX UI, тексты, на которые опирается сквозной тест |
| `.github/scripts/check-project-state.sh` | Проверка «структурные изменения ⇒ обновлён PROJECT_STATE.md» (запускается и локально) |

## Модель данных

Все id — `uuid`, кроме `users.id`/`max_user_id` (bigint) и `notifications.id`.

**Платформа (`001_platform.sql`)**

| Таблица | Ключевые поля | Смысл |
|---|---|---|
| `universities` | `code`, `name`, `short_name`, `timezone`, `is_demo`, `demo_owner_user_id` | Вуз; демо-вуз принадлежит одному пользователю |
| `users` | `max_user_id`, имя, `active_person_id` | Аккаунт MAX |
| `institutes`, `groups` | `university_id`; `institute_id`, `course` | Структура вуза |
| `persons` | `university_id`, `institute_id`, `group_id`, `role` (`student\|staff\|dean`), `full_name`, `user_id`, `external_id`, `phone_hash` | Запись вуза; `user_id` появляется после привязки |
| `invites` | `code`, `person_id`, `expires_at`, `used_at` | Личные приглашения |
| `notifications` | `person_id` или `reader_id`, `user_id`, `kind`, `payload`, `dedupe_key` (unique), `status`, `send_after`, `attempts`, `simulated` | Outbox уведомлений |
| `audit_log`, `kv`, `processed_updates` | — | Аудит, служебные значения (в т. ч. `hbq:<userId>` — ждём вопрос дежурному из чата), идемпотентность |

**Справочник (`002_handbook.sql`)**

| Таблица | Ключевые поля | Смысл |
|---|---|---|
| `handbooks` | `university_id`, `institute_id` (NULL — справочник вуза), `parent_id`, `slug` (**уникален глобально**), `title`, `emoji`, `status`, `settings {synonyms, dutyContact}` | Справочник |
| `handbook_members` | `handbook_id`, `person_id`, `role` (`admin\|editor`) | Команда |
| `sections` | `handbook_id`, `slug`, `title`, `emoji`, `position`, `audience`, `visible` | Разделы |
| `pages` | `section_id`, `handbook_id`, `slug`, `title`, `summary`, `blocks`, `draft_blocks`, `status` (`draft\|review\|published\|archived`), `audience`, `inherited_from`, `owner_person_id`, `checked_at`, `review_at`, `review_requested_at` (005), `return_note`, `returned_at` (006), `views`, `helpful`, `not_helpful`, `search_title`, `search_text`, `search_vector` | Страницы; `blocks` — опубликованное, `draft_blocks` — черновик |
| `page_versions` | `page_id`, `blocks`, автор, комментарий | История публикаций |
| `handbook_readers` | `handbook_id`, `user_id`, `person_id?`, `course`, `dorm`, `tags`, `reminders`, `last_seen_at` | Читатель (любой пользователь MAX) |
| `reader_progress` | `reader_id`, `page_id`, `item_id` | Отметки чеклистов |
| `handbook_deadlines` | `handbook_id`, `page_id`, `block_id`, `starts_on`, `ends_on`, `remind_days`, `audience` (только аудитория блока — 007; аудитория страницы и раздела проверяется при выдаче) | Сроки из блоков «Срок» опубликованных страниц |
| `handbook_questions` | `reader_id`, `text`, `query`, `status` (`open\|answered`), `answer`, `page_id`, `answered_by` | Вопросы дежурному |
| `page_feedback`, `search_log` | оценка + комментарий; запрос, число результатов, источник, открытая страница | Аналитика |
| `announcements` | `handbook_id`, `title`, `body`, `audience`, `page_id`, `starts_on`, `ends_on`, `updated_at` (004) | Объявления |
| `announcement_reads` (004) | `announcement_id`, `reader_id`, `read_at`; PK по паре | Прочитанные объявления — уходят в архив читателя |

## API

Все маршруты, кроме `/api/health` и `/api/config`, требуют `X-Max-Init-Data` (или `X-Dev-User` при `DEV_AUTH=true`). Справочник выбирается параметром `?handbookId=`, `?handbook=<слаг>` или `?page=<pageId>` (отсканированный QR страницы), иначе — по диплинку запуска, иначе — последний открытый. REST — внутренний бэкенд мини-приложения, не публичный API: OpenAPI/`DATA-API.yaml` не поставляются (так и написано в README).

| Метод и путь | Кто | Что |
|---|---|---|
| `GET /api/health`, `GET /api/config` | все | Здоровье; `demoEnabled`, `devAuth` |
| `GET /api/me` | все | Пользователь с именем и HTTPS-фото из подписанных данных MAX, активная запись вуза, все записи, `startParam`, текущий справочник, `demo: {role} \| null` |
| `POST /api/me/active-person` | все | Сменить активную запись вуза |
| `POST /api/bind/invite` `{code}` | все | Привязать аккаунт по коду приглашения |
| `POST /api/bind/phone` | все | Привязка по контакту MAX (резерв) |
| `POST /api/demo` `{role?}` | все | Создать/пересоздать демо в роли (по умолчанию — прежняя или деканат) → `DemoSandbox` |
| `POST /api/demo/role` `{role}` | владелец демо | Сменить роль в песочнице: `student \| editor \| dean`, данные остаются |
| `GET /api/handbooks[?mine=1]` | все | Каталог (демо — только свои); `mine=1` — справочники своего вуза |
| `GET /api/handbook` | читатель | Главная: справочник (`link` — диплинк для «Поделиться»), профиль, объявления (до 5 новых) и `archivedAnnouncements`, сроки, чеклисты, разделы, `today`, `editorRole` |
| `GET /api/handbook/announcements` | читатель | `{active, archive}`: архив — прочитанные и истёкшие за 180 дней |
| `POST/DELETE /api/handbook/announcements/:id/read` | читатель | Убрать в архив / вернуть на главную |
| `GET /api/handbook/sections` | читатель | Разделы со страницами |
| `GET /api/handbook/pages/:id` | читатель | Страница, прогресс, моя оценка, соседи, `link`, `today`; страница вуза, перекрытая факультетом, отдаётся факультетской |
| `GET /api/handbook/search?q=` | читатель | Поиск; пишет `search_log` (запрос без букв и цифр не пишется, тот же запрос за 10 минут обновляет прежнюю запись) |
| `GET /api/handbook/deadlines` | читатель | Ближайшие сроки |
| `PATCH /api/handbook/profile` | читатель | Курс, общежитие, программа, теги, напоминания |
| `PATCH /api/handbook/pages/:id/progress` | читатель | Отметка пункта чеклиста |
| `POST /api/handbook/pages/:id/feedback` | читатель | Оценка страницы |
| `GET/POST /api/handbook/questions` | читатель | Мои вопросы / задать вопрос |
| `POST /api/handbook-editor/handbooks` | деканат; редактор — только своя демо-песочница | Создать справочник из шаблона; сервер проверяет владельца демо-вуза |
| `GET /api/handbook-editor/structure` | команда | Разделы и страницы со статусами, моя роль |
| `POST /api/handbook-editor/sections`, `PATCH .../sections/:id` | админ | Разделы; PATCH — частичный |
| `POST /api/handbook-editor/pages` | команда | Новая страница (черновик) |
| `GET/PATCH /api/handbook-editor/pages/:id` | команда | Страница для редактора (`role`, `issues`, `link`, `handbook`, `updatedAt`, `returnNote`, `returnedAt`) / сохранить черновик `{…, baseUpdatedAt?}` → `{id, status, updatedAt, issues}`; чужие правки после `baseUpdatedAt` → 409 `page_conflict`; архивную страницу правит только админ (409 `page_archived`); `audience` меняет только админ |
| `POST .../pages/:id/review` `{note?}` | команда | На проверку (уведомление каждому админу); повтор текущего запроса не дублирует уведомление, но запоминает последнего отправителя; после доработки начинается новый цикл; 400 для незаполненных блоков |
| `POST .../pages/:id/publish` `{baseUpdatedAt?}`, `.../archive` | админ | Публикация (не публикуется страница без блоков и нетронутая заготовка шаблона; 409 `page_conflict`) / архив |
| `POST .../pages/:id/return` `{note?}` | админ | Вернуть страницу с проверки на доработку → `{ok, updatedAt}`; 409 `not_in_review`; автору — уведомление `handbook_return` |
| `GET /api/handbook-editor/analytics` | команда | Бэклог (`gaps`, `top`, `stale`, `questions`, `weak`), `totals` и `pilot` — метрики пилота за 30 дней |
| `POST .../questions/:id/answer` `{answer, addToPageId?}` | команда | Ответ дежурного |
| `GET /api/handbook-editor/announcements` | админ | Объявления справочника: `pageTitle`, `reads`, `active` |
| `POST /api/handbook-editor/announcements` | админ | Объявление `{title, body, audience?, pageId?, notify}` → `{id, notified}`; `pageId` — только опубликованная страница своего справочника или вуза над ним |
| `PATCH/DELETE /api/handbook-editor/announcements/:id` | админ | Исправить (без повторной рассылки) / удалить (неотправленные уведомления отменяются) |
| `GET /api/handbook-editor/members` | команда | `{members, role}`: участники, подключён ли; ссылку-приглашение видит только админ |
| `POST /api/handbook-editor/members` `{personId, role}` | админ | Добавить существующую запись |
| `POST /api/handbook-editor/invites` `{fullName, kind, role}` | админ | Новый участник по ссылке → `{personId, code, link}` |
| `DELETE /api/handbook-editor/members/:personId` | админ | Убрать из команды |

Ошибки: `{ error: { code, message } }`, сообщения на русском для конечного пользователя; `ZodError` → 400 `validation_error`; превышение лимита — 429 `rate_limited`; битый JSON, неподдерживаемый формат, слишком большой запрос — 400/415/413 по-русски; нулевой байт во входе вырезается. Явно указанный несуществующий справочник у читателя — 404 (без подмены последним открытым).

## Бот и диплинки

**Команды бота:** `/start [параметр]`, `/spravka` (открыть справочник), `/help`, `/demo` (выбор роли), `/reset`.
В приветствии новичка нет кнопки «Найти свой факультет» и предложения ввести код: вход студента — по ссылке факультета или через демо. Персональные приглашения команды по-прежнему работают.
**Свободный текст** в личном диалоге: лимит 20 сообщений в минуту (`bot/guards.ts`); код приглашения → привязка; после `hb:q` (kv `hbq:<userId>`, 15 минут) → вопрос дежурному; иначе — поиск по справочнику.
**Callbacks:** `hb:q` (спросить дежурного), `demo:start` и `demo:role` (выбор роли), `demo:as:<student|editor|dean>` (демо в этой роли: создать или сменить роль), `demo:reset`.

| Параметр | Где | Действие |
|---|---|---|
| `start=demo` | бот | Спросить роль (студент / редактор / деканат), затем создать демо |
| `start=demo_<student\|editor\|dean>` | бот | Демо сразу в этой роли |
| `start=hb` / `hb_<слаг>` | бот и мини-приложение | Открыть справочник (последний / по слагу) |
| `start=inv_<код>` | бот | Привязать запись вуза, ответить приветствием по роли |
| `startapp=hbp_<pageId>` | мини-приложение | Страница справочника (кнопки бота, уведомления, QR-плакат) |
| `startapp=hbe` | мини-приложение | Редактор |
| `startapp=hbe_<pageId>` | мини-приложение | Страница в редакторе |
| `startapp=dean` | мини-приложение | Экран «Справочники факультетов» |

Разбор: сервер — `services/handbook.ts` `startRef`, бот — `bot/index.ts` `handleStart`, приложение — `screens/handbook/links.ts` `handbookStartRoutes` (и `resolveScanned` для QR).

## Уведомления

| `kind` | Когда ставится | Кому | Ключ дедупликации | Кнопка |
|---|---|---|---|---|
| `welcome` | Привязка по приглашению из приложения (из бота отвечает сразу, без очереди) | запись вуза | `welcome:<personId>` | `hbe` / `dean` / `hb` по роли |
| `handbook_review` | Страница отправлена на проверку (с комментарием) | каждый админ справочника | `hb_review:<pageId>:<personId>:<версия нового цикла проверки>` | `hbe_<pageId>` |
| `handbook_answer` | Ответ на вопрос | читатель | `hb_answer:<questionId>` | `hbp_<pageId>` или `hb_<слаг>` |
| `handbook_return` | Админ вернул страницу на доработку | тот, кто отправил на проверку (или автор), если это не сам админ | по `pageId` и времени возврата | `hbe_<pageId>` |
| `handbook_announcement` | Объявление с `notify`; с будущей `startsOn` — в этот день в 10:00 по времени вуза; правка отменяет неотправленное тем, кого аудитория больше не касается | читатели из аудитории | `hb_ann:<annId>:<readerId>` | `hbp_<pageId>` или `hb_<слаг>` |
| `handbook_deadline` | Worker: `дней до конца срока ∈ remind_days`; отправка с 10:00 до 21:00 по времени вуза; при отправке заново проверяются подписка и число дней | читатели из аудитории с `reminders=true`, включая наследующие справочники; один раз на аккаунт MAX | `hb_deadline:<deadlineId>:<дата срока>:u<userId>:<days>` — перенесённый срок напомнит снова | `hbp_<pageId>` |

В демо-вузе настоящее сообщение получает только владелец песочницы; всем остальным (модельным пользователям и посторонним, открывшим ссылку на демо) доставка имитируется (`simulated`). Объявления не зависят от флажка «Напоминать о сроках»; объявление справочника вуза получают и читатели наследующих справочников. Отправка в MAX — с таймаутом; «зависшие» строки возвращаются в очередь через 30 минут.

## Права и роли

- **Читатель** — любой пользователь MAX; запись `handbook_readers` создаётся при первом открытии.
- **Запись вуза (`persons`)** — `dean` (деканат), `staff` (сотрудник), `student` (студент). Нужна только команде справочника и деканату.
- **Член справочника** — `handbook_members.role`: `editor` (черновики, отправка на проверку, ответы на вопросы) или `admin` (плюс публикация, архив, аудитория страницы, объявления, разделы, команда). Членство действует, только если запись из того же вуза, что и справочник.
- **`DEV_AUTH`** (вход `X-Dev-User`) запрещён при `NODE_ENV=production` и при `PUBLIC_URL` на https — `config.ts`.
- **Деканат** своего института — администратор его справочников по должности (без строки в `handbook_members`), может создавать справочники.
- **Редактор личного демо-вуза** может создать дополнительный справочник этого же института и становится его администратором; сотрудник настоящего вуза без роли деканата создавать справочники не может.
- **Роль в демо** выбирает посетитель: `student` — запись вуза не привязана к аккаунту (только читатель: чтение, чеклисты, вопросы; редактор закрыт с 403); `editor` — `staff` + `handbook_members.editor`; `dean` — `dean` + `admin`. В настоящем вузе роль выдаёт деканат личной ссылкой-приглашением.

## Демо-песочница

`createDemoSandbox(user, role)` удаляет прошлую песочницу пользователя и создаёт: «Модельный университет», институт ИИТ, группы; посетитель — запись `D-001` (имя из профиля MAX) в выбранной роли и читатель 1 курса; `setDemoRole` меняет только роль записи и членство, данные песочницы остаются; 40 модельных студентов (28 с модельными аккаунтами MAX), двое — редакторы; справочник вуза `mu-demo-<8 hex>` и справочник ИИТ `iit-demo-<8 hex>` (19 опубликованных страниц, 1 на проверке, переопределённая страница вуза, объявление, сроки, журнал поиска, 3 открытых и 4 отвеченных вопроса). Даты сроков в контенте написаны от 24.09.2026 и при создании сдвигаются на прошедшие дни, поэтому всегда впереди. Настоящие напоминания о демо-сроках приходят только первые 14 дней после создания песочницы и помечены «демо». Создание, сброс и смена роли одного пользователя идут под одной блокировкой.

## Конвенции

- **Язык:** все тексты для пользователя и комментарии в коде — по-русски. Сообщения ошибок пишутся для редактора/студента, не для программиста.
- **Миграции:** только новые файлы `NNN_описание.sql` по порядку; каждую новую миграцию подключить и в `apps/demo/src/backend/migrate.ts`. Уже применённые на стендах миграции не редактируются (исключение было сделано один раз при удалении «Пересдама», до первого деплоя).
- **Сервер:** бизнес-логика — в `services/*`, маршруты тонкие; валидация входа — Zod; многошаговые изменения — в `tx()`; уведомление ставится в той же транзакции, что и операция; права проверяются на сервере в каждом запросе.
- **Блоки страниц:** новый тип блока = схема в `domain/handbook.ts` + `BLOCK_LABEL` + `blockText` + рендер в `Blocks.tsx` + форма в `BlockEditor.tsx` + тип в `miniapp/src/lib/types.ts` + демо/шаблон при необходимости.
- **Диплинки:** новый параметр запуска добавляется во все три разборщика (см. [Бот и диплинки](#бот-и-диплинки)) и в эту таблицу.
- **Мини-приложение:** компоненты MAX UI + классы `hb-*`; цвета только через токены `--pd-*`; кнопки не меньше 40px по высоте; «Назад» — через `bridge.backButton`.
- **Тесты:** интеграционные — в `apps/server/test/handbook.test.ts` на реальной PostgreSQL; запросы к справочнику в тестах ограничивайте `handbook_id` (в базе несколько песочниц).
- **Коммиты:** по-русски, в повелительном наклонении («Добавить…», «Исправить…»).

## Запуск и проверка

```bash
docker compose up --build -d               # офлайн-стенд: http://localhost:9090/__mock/ и http://localhost:8080/?dev_user=100500
cd apps/server && npm ci && npm run typecheck && npm test
TEST_DATABASE_URL=postgres://… npm test     # + интеграционные (очищают схему public!)
cd apps/miniapp && npm ci && npm run build
```

Без Docker: PostgreSQL 16, `DATABASE_URL=… npx tsx src/index.ts migrate`, затем роли `api`, `bot`, `worker` (или `all`); `node apps/max-mock/server.mjs`; в `apps/miniapp` — `VITE_API_PROXY=http://127.0.0.1:3000 npx vite`.

## Тесты

`apps/server/test/`: 111 тестов, включая интеграционные на реальной PostgreSQL; файлы идут последовательно (`--test-concurrency=1`), все зелёные на 2026-09-27. Плюс сценарий `apps/demo/test/smoke.ts` на PGlite и `apps/demo/test/e2e.mjs` в браузере.

| Файл | Что проверяет |
|---|---|
| `certs.test.ts` | Отпечатки и цепочка сертификатов Минцифры, подключение в Dockerfile, подсказка при TLS-ошибке |
| `crypto.test.ts` | Подпись `initData`, подделка, срок, `start_param`, контакт `requestContact` |
| `config.test.ts` | Переменные окружения, запреты для продакшна, webhook, лимит рассылки, производный ключ |
| `dates.test.ts` | Даты в часовом поясе вуза |
| `notify.test.ts` | Экранирование текста уведомлений (ссылки, почта, телефоны); отмена вопроса дежурному; объявление до дня начала; перепроверка адресата напоминания; захват строк worker; уведомление о возврате на доработку; сообщения без текста; подтверждение сброса демо |
| `bot.test.ts` | Ключи идемпотентности обновлений MAX; формат кода приглашения; лимит частоты (`ok` → `warn` → `silent`) |
| `handbook.test.ts` | Схема демо-контента; наследование; адресность; поиск (сленг, опечатки, дубли, чужое и неопубликованное); чеклисты и оценки; цикл публикации и версии; права редактора; вопрос дежурному → FAQ → уведомление; объявления по аудитории; доставка worker; аналитика; конструктор; API для гостя; права по вузу; диплинк на страницу; напоминания о сроках; приглашение редактора; однозначность `hb_<слаг>`; аудит: ссылки-приглашения и права редактора, проверка уходит каждому админу, ссылка на страницу вуза не уводит из справочника факультета, поиск на служебных словах и опечатках, оценка/прогресс только своих страниц, вопрос из чата только с текстом, черновик с недозаполненным блоком, QR страницы (`?page=`); объявления: ссылка на страницу, архив читателя, правка и удаление; роли демо; аудит 25.09: правки опубликованной страницы не снимают её с публикации, правка объявления не стирает сроки и адресность, календарные даты, двойные нажатия и одновременное первое открытие, смена роли во время сброса, повторы уведомлений при сбоях MAX, ключ напоминания с датой срока, русские ошибки проверки |

Мини-приложение проверяется сквозным тестом: `cd apps/demo && npm run build && npm run e2e` (нужен Chromium: `npx playwright install chromium`).

## Ограничения, техдолг, бэклог

**Ограничения MVP:** нет загрузки файлов (блок «Файл» — ссылка); новый раздел создаётся в редакторе, но переименование и удаление доступны только через API; наследование двухуровневое; адресность — курс/общежитие/теги; поиск без языковых моделей; подключение вуза — только CLI.

**Техдолг:**
- Привязка по телефону (`/api/bind/phone`, `bindByPhone`, `persons.phone_hash`) не используется UI — решить: удалить или сделать загрузку телефонов.
- Таблица `groups` и поле `persons.group_id` используются только демо.
- Нет модульных тестов мини-приложения: его покрывает сквозной тест `apps/demo/test/e2e.mjs`; бот покрыт частично (идемпотентность, guards) и smoke-сценарием демо.
- Лимит частоты бота — в памяти процесса: при нескольких экземплярах `bot` считается отдельно.
- Префиксы CSS-токенов `--pd-*` остались от прежнего названия — косметика.

**Бэклог (по приоритету):**
1. Экран управления разделами в мини-приложении.
2. Импорт справочника из Markdown/Notion.
3. Еженедельный дайджест вместо отдельных напоминаний.
4. Подписка на раздел, сравнение версий и откат из интерфейса.

## Архив

Модуль **«Пересдам»** (академические задолженности: долги, слоты пересдач, QR-отметка, «красная зона» деканата, импорт CSV) удалён из `main` 2026-09-23 решением команды. Полная версия — в ветке `archive/peresdam` (коммит `fd00b29`), вместе с её документацией (`docs/CONCEPT.md`, прежний README).

---

## Журнал изменений

### 2026-09-30 — Финальная публичная фиксация
- Документы пилота синхронизированы с презентацией: добавлены методика и результаты опроса, статус целевого пилота и порядок выхода в другие вузы.
- Карта проекта очищена от ссылок на рабочие прототипы и старого названия команды; происхождение изображений кампуса зафиксировано явно.

### 2026-09-29 — Широкий экран
- MAX на компьютере и в браузере (от 900 px): колонка 860 px вместо 640, фото кампуса на главной — карточка со скруглёнными углами по ширине колонки (исходник 780 px: растянутый на всё окно мылился), плитки главной в четыре колонки, «Разделы» — в две, панель действий редактора той же ширины. Структура и нижний док прежние; на телефоне ничего не меняется. Правила — в конце `glass.css`.

### 2026-09-29 — Сканер QR переехал в «Поиск»
- Исправлено: камера не открывалась в MAX на iPhone с ошибкой `this.requestController` — `openCodeReader` вызывался оторванной функцией; теперь как метод `window.WebApp`. Ошибки сканера показываются уведомлением с кодом MAX, отмена — нет.
- Кнопка сканера без подписи убрана из шапки главной (рядом остались «Поделиться» и «Уведомления»). На экране «Поиск» — строка «Сканировать QR-код» (`ScanQrRow` в `HandbookSearch.tsx`), пока поле пустое; только на телефоне, где MAX умеет `openCodeReader`.

### 2026-09-29 — Шрифт Onest, документы для сдачи
- Max Sans (лицензия «All rights reserved») удалён из мини-приложения и прототипа; шрифт интерфейса — Onest (SIL OFL 1.1) из `@fontsource/onest`, в прототипе — локальные WOFF2 с текстом лицензии. `--pd-font: 'Onest', system-ui`.
- Новый `docs/PILOT_AND_SCALING.md`: формулировка проблемы, подтверждение (место под цифры опроса), As Is → To Be, гипотеза и метрики эффекта, MoSCoW, пилот (6 вопросов трека), ядро и переменная часть, порядок тиражирования и риски.
- README: сценарий проверки под док «Редакция» и системную тему по умолчанию, поле направления в профиле пока не влияет на выдачу, строка о несовершеннолетних и 152-ФЗ, лицензии шрифтов.

### 2026-09-29 — Полная проверка стеклянной версии: исправления
- Стекло: список поверхностей в `glass.css` — только простые классы (составной селектор внутри `:is()` поднимал приоритет и тост «роль изменена» становился тёмным на тёмном); варианты чипов возвращают свой цвет — «Удалить блок?» белым на красном, «Удалить» красным.
- Меню блока «⋯»: чипы «Выше / Ниже / Удалить» по ширине текста (раньше сжимались в круги 40 px). Док без всплывающих подсказок `title`.
- Главная: затемнение фото ровное на 62–86 % высоты — приветствие и заголовок держат 4.5:1 на светлом небе. Поля ввода меняют только цвет фона (стрелка `.hb-select` на месте), подсказки полей — приглушённым цветом стекла; значки разделов ночью тоже одним синим.
- Профиль: PATCH отправляет только изменённые поля; программа не затирается при быстрых правках курса и общежития; шкала курса сохраняется только клавишами перемещения и по отпусканию.
- Редакция: вкладка, фильтр и свёрнутые разделы сохраняются при возврате со страницы; ответ на вопрос обновляет счётчики; объявления и создание страниц — склонение в тостах; «Создать» и «Пригласить» неактивны при названии/имени короче 3 символов; кнопка «Убрать из команды» красная; выбор значка в 2 колонки на 320 px.

### 2026-09-29 — Стеклянный дизайн, кампус на главной, курс шкалой
- Новый визуальный слой `glass.css` поверх `styles.css`: синий градиентный фон, белый текст на фоне, матовые стеклянные карточки, кнопки, поиск и док; ночью — тёмно-фиолетовый фон и тёмное стекло. Верх градиента затемнён, чтобы мелкий белый текст держал контраст от 4.5:1.
- Главная: фото кампуса (день/ночь) во весь верх экрана, из-под плашки демо; заголовок поверх фото с затемнением; знак справочника и лента «Часто ищут» под поиском убраны (популярные запросы остались на экране «Поиск»).
- Профиль: заголовки групп «Учёба» и «Жизнь» убраны; курс — шкала 1–6 (`CourseSlider`, сохранение по отпусканию); общежитие — только «Да / Нет»; переключатели — отдельные капсулы; без поясняющих строк под темой.
- Команда: пояснение ролей — подсказка «Кто что делает» по нажатию. Поиск: без подзаголовка. Значки разделов и аватары — одним синим.
- Удалены `cover-day.webp`, `cover-night.webp`; добавлены `hero-day.webp`, `hero-night.webp`. e2e: шкала курса, «Да / Нет», главная без ленты запросов, фото во всю ширину, подсказка ролей.

### 2026-09-28 — Дизайн-ревью: ночная тема, «Редакция», палитра разделов
- Токены поверхностей (`--pd-surface*`, `--pd-on-surface*`, `--pd-link`): ночная тема теперь с тёмными карточками, а не белыми на тёмном фоне; неактивные кнопки — нейтральный серый.
- Разделы и аватары красятся декоративной палитрой `--pd-cat-0…4` (цвет идёт за значком раздела); статусные зелёный, янтарный, красный — только для статусов. «Важное» с предупреждением — янтарное.
- Док команды: пять вкладок, «Редактор» и «Команда» объединены в «Редакцию» (команда — кнопкой в карточке справочника). Кнопка «Назад» подписана экраном возврата; «Поделиться» страницей — в верхней панели (`useCrumbsAction` в `context.tsx`). Демо-плашка и пометка предпросмотра — одна плашка.
- Главная: обложка кампуса, свой знак `BrandMark`, общий `SearchField` (как на экране поиска), лента «Часто ищут» в одну строку, срок с датой и цветом срочности, без переключателя темы и дублей входа в справочники.
- Страница: «Проверено <дата>», оценка и вопрос дежурному в одной карточке. Поиск: подсветка совпадений, «N страниц», популярные запросы под результатами.
- Редакция: «Требует внимания» по доле жалоб (от 25 % при 5+ оценках или 10+ жалоб при 20 %), сортировка по числу жалоб; порядок и удаление блока — за меню «⋯»; видимый заголовок страницы; неактивная кнопка объясняет причину. Аналитика: цвет кольца — статус цели, время ответа — без кольца, относительные даты (`relativeDateTime` в `lib/format.ts`), вопросы — строками списка.
- Профиль: переходы строками списка, курс — переключатель 1–6 в одну строку, статус сохранения внутри карточки.
- e2e обновлён: пять вкладок, `openTeam()`, тема из профиля, проверка тёмных поверхностей, лента с прокруткой не считается выходом за экран.

### 2026-09-28 — Исправить читаемость и структуру интерфейса
- Светлая тема получила светлый фон, вторичные кнопки — белую поверхность и синий текст; система стала темой по умолчанию. Убраны три перекрывающихся CSS-слоя, палитра и размеры вынесены в `design-tokens.css`.
- У корневых вкладок один заголовок без «Назад», док подписан. Главная показывает объявления без дублей, начатые и новые чеклисты раздельно, поиск с популярными запросами и кнопку «Поделиться» в шапке.
- Чтение на плотной поверхности, плоские предупреждения, заметные оценки и кнопка вопроса под текстом. Поиск хранит до пяти недавних запросов на устройстве отдельно для пользователя и справочника.
- Компактный редактор поднимает проблемные страницы, сворачивает разделы и меняет значки через существующий PATCH раздела. Аватары команды различаются по цвету имени.
- Профиль группирует настройки, автоматически сохраняет программу вместе с другими полями, показывает роль меткой. Обновлены браузерные проверки и `docs/DESIGN.md`; схема БД, API и права не менялись.


Новые записи — сверху. Формат: `### ГГГГ-ММ-ДД — заголовок`, затем что изменилось и почему, затронутые файлы/таблицы/API.

### 2026-09-28 — Разделить профили по ролям и открыть управление статусами
- Убрана кнопка «Найти свой факультет» и подсказка про код из приветствия бота; личные приглашения команды сохранены (`bot/index.ts`).
- Удалён лишний текст профиля; направление сохранено. Редактор и деканат видят роль и рабочие действия, параметры читателя вынесены в раскрываемые настройки предпросмотра (`HandbookProfile.tsx`).
- Читательские экраны команды помечены «Предпросмотр со стороны студента» (`HandbookShell.tsx`).
- Статус страницы оформлен на светлой карточке; деканату доступна отправка на проверку, архивную страницу можно явно восстановить в черновик. Перед архивированием завершается сохранение (`HandbookEditorPage.tsx`, `team-v2.css`). API, права и схема БД не менялись.
- Расширены smoke и e2e: приветствие, профили трёх ролей, предпросмотр, проверка → доработка → публикация → архив → черновик.

### 2026-09-28 — Зафиксировать коммерческую модель и иерархию доступов
- Клиент и плательщик определён как университет, а факультет — как единица пилота и ведения справочника. Описаны роли владельца платформы, администратора университета, администратора факультета, редактора и студента.
- Зафиксированы персональные приглашения для сотрудников, общая ссылка без персональных кодов для студентов, B2B-оплата, пилот и годовая лицензия. Отдельно отмечены реализованные возможности MVP и следующий этап.
- Добавлен `docs/COMMERCIAL_MODEL.md`; ссылки и позиционирование обновлены в `README.md`, `docs/HANDBOOK.md` и `PROJECT_STATE.md`. Код, API и схема БД не менялись.

### 2026-09-27 — Профиль MAX и полный путь создания в демо
- `/api/me` передаёт HTTPS-фото из подписанного `initData`; имя по-прежнему синхронизируется с MAX. В профиле и на главной показывается фото либо инициалы. Направление обучения теперь можно сохранить в профиле; браузерное демо явно обозначает модельное имя.
- Редактор может создать и открыть второй справочник в собственной демо-песочнице. Создатель может добавить свой раздел прямо в редакторе. Для реального вуза право создания справочника осталось у деканата; проверка владельца демо выполняется на сервере. Обновлены smoke- и интеграционные сценарии.

### 2026-09-26 — Перенести второй прототип в рабочее приложение
- Подключены круглый док с правами из API, Max Sans, Lucide и новый фон; фото оптимизированы в WebP. `nav.tab` переключает разделы без бесконечного стека; «Назад» сохраняет прежнее поведение вложенных экранов.
- У читателя появились разделы аккордеоном и отдельные сроки; обновлены главная, поиск, профиль, объявления и вопрос дежурному.
- У команды — вкладки редактора и фильтры, сворачиваемый конструктор, плитки аналитики с целями, раскрывающаяся команда и смена роли через существующий API. Очередь автосохранения и контроль конфликтов сохранены.
- Обновлены `docs/DESIGN.md` и сквозной тест: новый док, роли, узкие экраны 320/375/430, поиск, объявления, FAQ, QR и медленное сохранение. Схема БД и диплинки не менялись. В сервере отдельно исправлены очистка описания (явный `summary: null` сохраняется до публикации) и уведомления о новом цикле проверки в тот же день; повтор запроса не дублирует уведомление и запоминает последнего отправителя. Добавлены интеграционные и smoke-регрессии.
- Фото/логотип из браузерного прототипа, изменение имени, передача задач и скрытие запросов не перенесены: серверных API для них нет. Max Sans взят из исходного прототипа; подтверждение разрешения на встраивание остаётся задачей команды.

### 2026-09-26 — Исправления по итогам QA (87 находок шести тестировщиков)
- Сервер: демо не рассылает настоящим людям; сленг в любой словоформе; ссылки только https; версия страницы и 409 `page_conflict`; возврат на доработку (`POST …/pages/:id/return`, миграция 006); аудитория сроков (миграция 007); объявления вуза доходят до факультетов и не зависят от напоминаний; 429, нулевой байт, ошибки разбора по-русски; журнал поиска без пустых и повторных записей.
- Бот и уведомления: рабочие ссылки, почта и телефоны в сообщениях; отмена вопроса дежурному; «Найти свой факультет» для новичка; подтверждение сброса демо; уведомление `handbook_return`; перепроверка напоминаний; таймаут отправки в MAX; сообщения без текста.
- Мини-приложение: очередь автосохранения, ответ дежурного в «Вопросы и ответы», возврат на доработку и комментарий к проверке, даты объявлений, листы с «Закрыть» и системной «Назад», подтверждения внутри экрана, значки вместо эмодзи, единые названия, подписи полей.
- Дизайн: контраст текста, статусов, плейсхолдеров и неактивных кнопок; узкие экраны 320–360 px; видимый фокус (`--pd-focus`, `--pd-control-line`); зоны нажатия ≥ 40 px.
- Документы и CI: одна строка с ботом и коммитом в README и команда подстановки; CI на каждый push, проверка compose и сборка Docker; настройки доходят до контейнеров; имя «Курсор» в конфигурации.
- Тесты: 108 тестов сервера (было 64), smoke — 57 проверок, e2e — 38. Файлы: `lib/sanitize.ts`, `test/notify.test.ts`, `miniapp/src/lib/{sheets,drafts,checklists}.ts`.

### 2026-09-26 — Проверить и дополнить прототип редизайна
- Сверены пользовательские функции с исходными экранами; добавлены вопрос/ответ/FAQ, лента и архив объявлений, конструктор 12 типов блоков, локальная публикация с историей и QR, наследование, шаблон нового справочника и приглашения.
- Объединены стили, закреплён фон относительно телефона, исправлены аватар, кнопка вопроса, контраст, поля и навигация; роли разграничены, профиль всегда последний.
- `model.test.cjs` проверяет состояние прототипа; `AUDIT.md` содержит карту функций и ограничения. Добавлены локальные Lucide и qrcode-generator с лицензиями.
- Изменения только в прототипе и документации; схемы БД, API и рабочее miniapp не менялись. Настоящие MAX-интеграции остаются в основном приложении.

### 2026-09-25 — Название продукта: «Курсор» (ветка `feature/redesign`)
- Продукт называется «Курсор» — конструктор справочников для факультетов в MAX. Клиент — факультет, пользователи — студенты. Справочник каждого факультета сохраняет своё имя («Справочник ИИТ»).
- Переименованы только тексты, где продукт называет себя: приветствие бота, первый экран мини-приложения, `<title>`, шапка и загрузка браузерного демо, README, HANDBOOK, описания пакетов. Команды, диплинки, API и данные не менялись.
- Файлы: `bot/index.ts`, `Onboarding.tsx`, `apps/miniapp/index.html`, `apps/demo/src/host.tsx`, `apps/demo/build.mjs`, `apps/max-mock/server.mjs`.

### 2026-09-25 — Редизайн по прототипу тимейта (ветка `feature/redesign`)
- Визуальный язык перенесён в мини-приложение: фото кампуса под вуалью как фон, светлые стеклянные поверхности, синий MAX `#471AFF`, круглые кнопки и значки, шрифт Onest (OFL) вместо Max Sans.
- Главная: шапка с фото, логотипом-кругом и поиском; плашка ближайшего срока; плитки разделов с прогрессом чек-листов (считается на клиенте из `checklists`).
- Навигация, API и данные не менялись; сквозной тест проходит. Картинки прототипа сжаты с 8,4 МБ до 115 КБ.
- Файлы: `styles.css`, `HandbookHome.tsx`, `app/theme.tsx`, `components/icons.tsx`, `assets/campus/*`, `apps/demo/build.mjs` (загрузчик `.webp`), `docs/DESIGN.md`.

### 2026-09-25 — Аудит сервера и бота, сквозной тест в браузере
- Правки опубликованной страницы уходят на проверку, не снимая её с публикации (`pages.review_requested_at`, миграция `005`); `audience_matches` согласована с кодом для читателей без тегов.
- Объявления: правка не стирает сроки и адресность, отменяет лишние неотправленные уведомления; объявление с будущей датой приходит в свой день; даты проверяются по календарю, конец не раньше начала.
- Надёжность: повторы уведомлений ~5 часов при сбоях MAX, сбой проверок по расписанию не останавливает отправку, двойные нажатия «Помогла» и демо, одновременное первое открытие справочника; напоминания с 10:00 до 21:00, ключ с датой срока.
- Бот: только личный диалог, лимит и для нажатий, подсказка на неизвестную команду, честный ответ на устаревшую ссылку, ответ на старые кнопки, ответ пользователю при сбое; `/reset` без песочницы спрашивает роль.
- Демо-сроки сдвигаются к текущей дате; настоящие напоминания о них — только 14 дней и с пометкой «демо». Сквозной тест `apps/demo/test/e2e.mjs` в CI; `docs/DESIGN.md` для редизайна; `APP_TIMEZONE` и `WEBHOOK_SECRET` проверяются при старте.

### 2026-09-24 — Тёмная тема, роли в демо, архив и правка объявлений
- По отзывам команды: тёмная тема по умолчанию и светлая (☀️/🌙 в шапке главной, «О себе» → «Оформление»; `app/theme.tsx`, палитры в `styles.css`, фирменная шапка справочника и первого экрана).
- Демо начинается с выбора роли: `?start=demo` → «Студент» / «Редактор» / «Деканат»; студенту — только чтение и вопросы, редактору — черновики и ответы, деканату — всё. Смена роли в чате и баннере без потери данных. `services/demo.ts`, `bot/index.ts`, `POST /api/demo/role`, диплинки `demo_<роль>`, callbacks `demo:as:*`.
- Объявления: читатель отмечает «Прочитано» → архив (экран «Объявления», можно вернуть); администратор видит список с числом прочитавших, правит и удаляет; ссылка на страницу выбирается из опубликованных. Миграция `004_announcements.sql` (`announcement_reads`, `announcements.updated_at`); маршруты `/api/handbook/announcements*`, `/api/handbook-editor/announcements/:id`.
- «Деканат · Справочники» переименовано в «Справочники факультетов». Редактор для не-участника — понятный экран «Раздел для команды справочника» без кнопки «Повторить».

### 2026-09-24 — Сертификаты Минцифры для MAX API и проверка check-max

- **Критично для развёртывания:** `platform-api2.max.ru` отвечает сертификатом УЦ Минцифры, которого нет в Node.js — без него любой запрос бота к MAX падал бы с `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Добавлена цепочка `apps/server/certs/russian_trusted_ca.pem` (отпечатки сверены), в Dockerfile — `ENV NODE_EXTRA_CA_CERTS`.
- `docs/DEPLOY.md` — развёртывание на VPS по шагам и таблица типичных ошибок (TLS, webhook, кнопка open_app, Docker Hub).
- Роль `check-max`: `docker compose exec bot node dist/index.js check-max` проверяет MAX API, webhook и `/api/health`; `max/tls.ts` — подсказка при TLS-ошибке в логах бота.
- Тест `test/certs.test.ts`; демо-подмена `max-bot.ts` экспортирует `tlsTrustHint`.

### 2026-09-24 — Метрики пилота в продукте, мелкие правки по сверке с заданием

- Экран «Что ищут студенты»: блок «Метрики пилота» с целями — нашли ответ сами (≥80%), страница помогла (≥85%), медиана ответа дежурного (≤24 ч), проверено за полгода (≥90%), активные читатели. Сервер: `pilotMetrics` в `services/handbook-editor.ts`, поле `pilot` в `GET /api/handbook-editor/analytics`.
- Демо: четыре отвеченных вопроса дежурному, чтобы метрика времени ответа была не пустой.
- Мини-приложение: время событий — по часовому поясу устройства (`LOCAL_TZ` в `lib/format.ts`), сканер QR разрешает выбрать фото из галереи, яркость при показе QR-плаката продлевается (MAX держит её 30 секунд), склонение «раз/раза».
- `docs/HANDBOOK.md`: QR-плакат и метрики — сделано; определение самообслуживания совпадает с тем, что считает продукт.

### 2026-09-23 — Аудит перед сдачей: безопасность, права, UX и QR

- Права: редакторы отвечают на вопросы; аудиторию страницы, архив, публикацию, объявления и команду меняет только админ; редактор не видит чужих ссылок-приглашений; удаление участника отзывает его приглашения; `DEV_AUTH` запрещён при https `PUBLIC_URL`.
- Вопрос из чата: `hb:q` больше не создаёт пустой вопрос — ожидание в kv `hbq:<userId>`, вопрос создаётся из следующего сообщения. Миграция `003_chat_questions.sql` (удалён `handbook_readers.pending_question_id`; подключена в демо).
- Черновик принимает недозаполненные блоки (`draftBlocksSchema`) и возвращает `issues`; на проверку/публикацию — только полные. «На проверку» — уведомление каждому админу с комментарием. Напоминания о сроках — не раньше 10:00 по времени вуза, одно на аккаунт.
- Мини-приложение: новый первый экран, главная со сроками-«листками» и панелью команды, автосохранение в редакторе, QR-плакат страницы, сканер QR (`GET /api/handbook?page=`, `links.ts resolveScanned`), «Поделиться», кэш экранов и возврат прокрутки. Файлы: `Onboarding.tsx`, `HandbookHome.tsx`, `HandbookEditorPage.tsx`, `BlockEditor.tsx`, `QrPoster.tsx`, `links.ts`, `useLoad.ts`, `context.tsx`.
- Бот: `bot/guards.ts` — формат кода приглашения и лимит 20 сообщений/мин (одно предупреждение, дальше тишина). Тесты: 47 (было 36).

### 2026-09-23 — Браузерное демо под справочник

- `apps/demo` добавлен в репозиторий и переведён на справочник: миграции `001_platform`/`002_handbook`, маршруты без «Пересдама», кнопки «Справочник»/«Редактор» в «телефоне».
- `npm run smoke` (35 проверок) и `npm run build` → `dist/demo.html`; оба шага — в CI (job `demo`).
- Сборка: `import.meta.url` → `document.baseURI` (PGlite строит адреса файлов), npm-пакет `buffer` вшивается в бандл.

### 2026-09-23 — Только конструктор справочника; файл состояния и правила агентов

- Удалён модуль «Пересдам» (сервисы, маршруты, экраны, правила ст. 58, QR, CSV-импорт, тесты). Архив — ветка `archive/peresdam`.
- Миграции пересобраны: `001_platform.sql` + `002_handbook.sql` (было `001_init`, `002_processed_updates`, `003_handbook`). Роли записей: `student | staff | dean`. Блок `module` удалён.
- `handbooks.slug` теперь уникален глобально; демо-слаги `mu-demo-<id>`, `iit-demo-<id>` — диплинк `hb_<слаг>` однозначен.
- `/api/me` и API справочника выбирают справочник по диплинку (`startRef`: `hb_`, `hbp_`, `hbe_`).
- Новое: приглашение в команду по ссылке (`POST /api/handbook-editor/invites`, экран «Команда»), напоминания о сроках в worker (`enqueueDeadlineReminders`), объявления из редактора, экран «Деканат», витрина справочников, онбординг без «Пересдама».
- Уведомления ведут на правильные экраны: `hbp_<id>`, `hbe_<id>`, `hb_<слаг>`.
- Код приглашения: префикс `H-` вместо `P-`. Имена пакетов/БД/compose: `spravochnik`.
- Добавлены `PROJECT_STATE.md`, `AGENTS.md`, CI (`.github/workflows/ci.yml`), шаблон PR; README переписан под справочник.
- Тесты: +3 интеграционных (напоминания, приглашения, однозначность слага).

### 2026-09-22 и ранее — история до файла состояния

- Справочник факультета: модель данных, API, поиск в чате, демо-контент; мини-приложение (чтение, поиск, чеклисты, конструктор страниц); конструктор справочника для деканата; поиск с весами заголовка и снятием перекрытых страниц; исправления по аудиту. Подробности — `git log`.
