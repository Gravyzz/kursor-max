import type { Bot, Context } from '@maxhub/max-bot-api';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { getBotIdentity, saveBotIdentity, tlsTrustHint, type BotIdentity } from '../max/bot.js';
import { appButton, callbackButton, keyboard } from '../max/buttons.js';
import { markProcessed, updateKey } from './dedupe.js';
import { allowMessage, INVITE_RE } from './guards.js';
import { md, welcomeMessage } from '../notify/render.js';
import { bindInvite, normalizeInviteCode, upsertUser, type UserRow } from '../services/identity.js';
import { createDemoSandbox, getDemoRole, setDemoRole, type DemoRole } from '../services/demo.js';
import {
  askQuestion, awaitChatQuestion, contextFor, logSearch, memberRole, openQuestionCount, questionLimitReached, search, takeChatQuestion,
  type HandbookContext,
} from '../services/handbook.js';

const log = createLogger('bot');
type Ctx = Context;

async function currentUser(ctx: Ctx): Promise<UserRow | null> {
  const user = ctx.user as { user_id: number; first_name?: string; last_name?: string; username?: string | null; name?: string } | undefined;
  if (!user?.user_id) return null;
  return upsertUser(pool, { id: user.user_id, first_name: user.first_name ?? user.name, last_name: user.last_name, username: user.username });
}

type Rows = Parameters<typeof keyboard>[0];

/**
 * Ответ в тот же чат. Нажатие кнопки под удалённым сообщением приходит без сообщения, и ctx.reply
 * не знает чата — тогда пишем пользователю напрямую, чтобы он не остался без ответа.
 */
async function send(ctx: Ctx, text: string, rows: Rows = []) {
  const extra = { format: 'markdown' as const, attachments: rows.length ? ([keyboard(rows)] as never) : undefined };
  const userId = (ctx.user as { user_id?: number } | undefined)?.user_id;
  const api = (ctx as { api?: Ctx['api'] }).api;
  if (ctx.chatId == null && userId && typeof api?.sendMessageToUser === 'function') return api.sendMessageToUser(userId, text, extra);
  return ctx.reply(text, extra);
}

async function answer(ctx: Ctx, notification: string) {
  try {
    await ctx.answerOnCallback({ notification } as never);
  } catch (error) {
    log.warn('answerOnCallback не удался', error);
  }
}

/** Первый вход без справочника: что это и как попасть в справочник своего факультета. */
async function greetUnknown(ctx: Ctx, identity: BotIdentity) {
  await send(
    ctx,
    [
      'Здравствуйте! Я Курсор — справочник вашего факультета в MAX.',
      '',
      '• отвечу, где взять справку, как закрыть физкультуру и когда подавать на общежитие;',
      '• напомню о сроках, которые касаются именно вас;',
      '• если ответа нет — передам вопрос дежурному, и ответ придёт сюда же.',
      '',
      'Откройте ссылку на справочник своего факультета — её дают в чате курса, у куратора или в деканате.',
      config.DEMO_ENABLED ? 'Хотите посмотреть, как это работает? Нажмите «Попробовать демо» — данные будут модельными.' : null,
    ]
      // Пустые строки — абзацы, их не выбрасываем
      .filter((line): line is string => line !== null)
      .join('\n'),
    [
      ...(config.DEMO_ENABLED ? [[callbackButton('Попробовать демо', 'demo:start')]] : []),
    ],
  );
}

const DEMO_LEAD: Record<DemoRole, string> = {
  student: 'Вы — студент 1 курса: спрашивайте прямо здесь, отмечайте чек-листы, задавайте вопросы дежурному.',
  editor: 'Вы — редактор из студсовета: правите страницы, отправляете их на проверку и отвечаете на вопросы студентов. Публикует деканат.',
  dean: 'Вы — сотрудник деканата: публикуете страницы, делаете объявления, собираете команду и создаёте справочники факультетов.',
};

/**
 * Приветствие справочника: что здесь есть и как спросить. Администратору и редактору — кнопка редактора,
 * в демо — ещё смена роли и сброс.
 */
async function showHandbook(ctx: Ctx, user: UserRow, handbook: HandbookContext, identity: BotIdentity, lead?: string) {
  const demoRole = handbook.handbook.slug.startsWith('iit-demo-') ? await getDemoRole(pool, handbook.reader.user_id) : null;
  const editorRole = await memberRole(pool, handbook.handbook.id, user);
  return send(
    ctx,
    [
      lead ?? null,
      lead ? '' : null,
      `${handbook.handbook.emoji} **${md(handbook.handbook.title)}**`,
      handbook.handbook.subtitle ? md(handbook.handbook.subtitle) : null,
      '',
      'Здесь собрано всё про учёбу, справки, общежитие и деньги — коротко и по делу.',
      'Спросите прямо в чате: «как получить справку», «когда сессия», «что с физрой» — я найду нужную страницу.',
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
    [
      [appButton(identity, 'Открыть справочник', `hb_${handbook.handbook.slug}`)],
      ...(editorRole ? [[appButton(identity, 'Редактор справочника', 'hbe')]] : []),
      ...(demoRole ? [[callbackButton('Сменить роль', 'demo:role'), callbackButton('Сбросить демо', 'demo:reset')]] : []),
    ],
  );
}

/** Выбор роли в демо: так жюри видит продукт глазами студента, редактора или деканата. */
async function askDemoRole(ctx: Ctx) {
  if (!config.DEMO_ENABLED) return send(ctx, 'Демо в этом боте выключено.');
  return send(
    ctx,
    [
      '🎓 Демо: «Модельный университет», справочник Института информационных технологий. Данные вымышленные.',
      '',
      '**Кем попробуете?**',
      '• Студент — ищет ответы, отмечает чек-листы, задаёт вопросы.',
      '• Редактор (студсовет) — правит страницы, отправляет на проверку, отвечает на вопросы.',
      '• Деканат — публикует, делает объявления, собирает команду.',
      '',
      'Роль можно сменить в любой момент — сделанное сохранится. В настоящем вузе роль выдаёт деканат личной ссылкой.',
    ].join('\n'),
    [
      [callbackButton('Студент', 'demo:as:student'), callbackButton('Редактор', 'demo:as:editor')],
      [callbackButton('Деканат', 'demo:as:dean')],
    ],
  );
}

/**
 * Демо собирается несколько секунд. Повторное нажатие в это время не запускает вторую сборку:
 * иначе придут две карточки, и первая будет вести в уже удалённую песочницу.
 */
const demoInProgress = new Set<number>();

/** «Спросить дежурного» в обработке: двойное нажатие не пришлёт две подсказки. */
const askInProgress = new Set<number>();

/** Открыть демо в выбранной роли: песочницы нет — создаётся, есть — меняется только роль. */
async function startDemo(ctx: Ctx, identity: BotIdentity, role: DemoRole, recreate = false) {
  const user = await currentUser(ctx);
  if (!user) return;
  if (!config.DEMO_ENABLED) return send(ctx, 'Демо в этом боте выключено.');
  if (demoInProgress.has(user.id)) return;
  demoInProgress.add(user.id);
  try {
    const sandbox = recreate ? await createDemoSandbox(user, role) : await setDemoRole(user, role);
    const handbook = await contextFor(user, { handbookId: sandbox.handbookId });
    if (!handbook) return greetUnknown(ctx, identity);
    return await showHandbook(ctx, user, handbook, identity, `🎓 Демо «Модельного университета», данные вымышленные.\n${DEMO_LEAD[role]}`);
  } finally {
    demoInProgress.delete(user.id);
  }
}

/** Пересоздать демо с нуля в той же роли; песочницы ещё нет — сначала спросить роль. */
async function resetDemo(ctx: Ctx) {
  const user = await currentUser(ctx);
  if (!user) return;
  if (!config.DEMO_ENABLED) return send(ctx, 'Демо в этом боте выключено.');
  const role = await getDemoRole(pool, user.id);
  if (!role) return askDemoRole(ctx);
  return startDemo(ctx, await getBotIdentity(), role, true);
}

/** Сброс стирает всё, что человек сделал в песочнице, — поэтому сначала спрашиваем (кнопка рядом со «Сменить роль»). */
async function confirmResetDemo(ctx: Ctx) {
  const user = await currentUser(ctx);
  if (!user) return;
  if (!config.DEMO_ENABLED) return send(ctx, 'Демо в этом боте выключено.');
  // Песочницы ещё нет — терять нечего, сразу выбираем роль
  if (!(await getDemoRole(pool, user.id))) return askDemoRole(ctx);
  return send(
    ctx,
    [
      '**Сбросить демо?**',
      'Демо создастся заново: ваши страницы, ответы, объявления и отметки пропадут. Роль останется прежней.',
      'Чтобы посмотреть продукт другими глазами, сбрасывать не нужно — нажмите «Сменить роль».',
    ].join('\n'),
    // Время в кнопке: подтверждение действует недолго и один раз (см. обработчик demo:reset:yes)
    [[callbackButton('Сбросить', `demo:reset:yes:${Date.now().toString(36)}`), callbackButton('Отмена', 'demo:reset:no')]],
  );
}

/** Сколько действует кнопка «Сбросить» в подтверждении. */
const RESET_CONFIRM_MS = 10 * 60_000;

/** Вложения входящего сообщения: стикер, фото, файл, голосовое, геопозиция, контакт. */
function attachmentsOf(ctx: Ctx): string[] {
  const list = (ctx.message?.body?.attachments ?? []) as Array<{ type?: string } | null>;
  return list.map((item) => item?.type ?? 'unknown').filter((type) => type !== 'inline_keyboard');
}

/**
 * Сообщение без текста — стикер, фото, голосовое, геопозиция. Искать по нему нечего и дежурному передать нечего:
 * просим написать словами. Если бот ждёт вопрос дежурному, ожидание сохраняется.
 */
async function handleWithoutText(ctx: Ctx, user: UserRow, identity: BotIdentity) {
  const pending = await takeChatQuestion(pool, user.id);
  const waiting = pending ? await contextFor(user, { handbookId: pending.handbookId }) : null;
  if (waiting) {
    await awaitChatQuestion(pool, waiting);
    return send(ctx, 'Дежурному я передаю только текст. Напишите вопрос словами одним сообщением.', [[callbackButton('Отмена', 'hb:q:cancel')]]);
  }
  const handbook = await contextFor(user);
  if (!handbook) return greetUnknown(ctx, identity);
  return send(ctx, 'Я понимаю только текст. Напишите, что ищете, — например, «как получить справку об обучении».', [
    [appButton(identity, 'Открыть справочник', `hb_${handbook.handbook.slug}`)],
  ]);
}

/** Команды, которые бот понимает; всё остальное со слешем — не вопрос и не поиск. */
const COMMANDS_HINT = config.DEMO_ENABLED
  ? 'Команды: /spravka — открыть справочник, /help — как пользоваться, /demo — демо с модельными данными, /reset — сбросить демо.'
  : 'Команды: /spravka — открыть справочник, /help — как пользоваться.';

/**
 * Свободный текст в чате — это поиск по справочнику.
 * Студенту не нужно открывать приложение, чтобы узнать, куда идти за справкой.
 */
async function handleHandbookText(ctx: Ctx, user: UserRow, text: string, identity: BotIdentity, withAttachments = false): Promise<boolean> {
  // Незнакомая команда — не вопрос дежурному и не поиск: иначе «/menu» попал бы в пробелы справочника
  if (text.startsWith('/')) {
    await send(ctx, `Такой команды нет. ${COMMANDS_HINT}`);
    return true;
  }
  // После «Спросить дежурного» следующее сообщение — это сам вопрос, а не новый поиск
  const pending = await takeChatQuestion(pool, user.id);
  if (pending) {
    const target = await contextFor(user, { handbookId: pending.handbookId });
    if (target) {
      try {
        await askQuestion(pool, target, text, pending.query);
        const lines = [
          'Передал дежурному ✅ Ответ придёт сюда же — обычно в течение дня.',
          // Подпись к фото уходит как вопрос, а само фото — нет: человек должен это знать
          withAttachments ? 'Фото и файлы дежурный не увидит — только текст вопроса.' : null,
        ];
        await send(ctx, lines.filter(Boolean).join('\n'), [
          [appButton(identity, 'Открыть справочник', `hb_${target.handbook.slug}`)],
        ]);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        // Слишком короткий вопрос — даём переписать, не заставляя снова нажимать кнопку
        if (error.code === 'question_short') await awaitChatQuestion(pool, target);
        await send(ctx, error.message);
      }
      return true;
    }
  }

  const handbook = await contextFor(user);
  if (!handbook) return false;

  const hits = await search(pool, handbook, text, 3);
  await logSearch(pool, handbook, text, hits.length, 'bot').catch(() => undefined);
  if (hits.length === 0) {
    await send(ctx, 'В справочнике такого пока нет. Могу передать вопрос дежурному — ответ придёт сюда же.', [
      [callbackButton('Спросить дежурного', 'hb:q')],
      [appButton(identity, 'Открыть справочник', `hb_${handbook.handbook.slug}`)],
    ]);
    return true;
  }
  const best = hits[0]!;
  const others = hits.slice(1);
  // Если точного совпадения не было, честно говорим об этом: неверный ответ хуже отсутствия ответа
  await send(
    ctx,
    [
      best.exact ? null : 'Точного ответа не нашлось. Возможно, подойдёт это:',
      `**${md(best.title)}**`,
      best.snippet ? md(best.snippet) : null,
      others.length ? `\nТакже по теме: ${others.map((hit) => md(hit.title)).join(' · ')}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
    [
      [appButton(identity, 'Открыть страницу', `hbp_${best.pageId}`)],
      ...(others.length ? [others.map((hit) => appButton(identity, hit.title.slice(0, 40), `hbp_${hit.pageId}`))] : []),
      [callbackButton(best.exact ? 'Это не то, что я искал' : 'Спросить дежурного', 'hb:q')],
    ],
  );
  return true;
}

async function handleStart(ctx: Ctx, payload: string | null) {
  const identity = await getBotIdentity();
  const user = await currentUser(ctx);
  if (!user) return;
  const raw = (payload ?? '').trim();
  // Служебные параметры не зависят от регистра: ссылку могли набрать руками. Код приглашения проверяется как есть.
  const value = /^(demo|hb)(_|$)/i.test(raw) ? raw.toLowerCase() : raw;
  const demoAs = /^demo_(student|editor|dean)$/.exec(value);
  if (demoAs) return startDemo(ctx, identity, demoAs[1] as DemoRole);
  if (value === 'demo' || value.startsWith('demo_')) return askDemoRole(ctx);
  if (value === 'hb' || value.startsWith('hb_')) {
    const slug = value === 'hb' ? null : value.slice(3);
    const handbook = await contextFor(user, { slug });
    // Справочник по ссылке не найден (опечатка, демо сбросили) — говорим об этом, а не молча открываем другой
    if (handbook && slug && handbook.handbook.slug !== slug) {
      return showHandbook(ctx, user, handbook, identity, 'Справочник по этой ссылке не найден — возможно, ссылка устарела. Открываю ваш справочник.');
    }
    if (handbook) return showHandbook(ctx, user, handbook, identity);
    if (slug) return send(ctx, 'Справочник по этой ссылке не найден — возможно, ссылка устарела. Попросите новую в чате курса или у куратора.');
  }
  if (value.startsWith('inv_') || INVITE_RE.test(value)) {
    try {
      // Приглашение редактора: привязываем аккаунт и сразу рассказываем, что теперь можно
      const person = await bindInvite(user, normalizeInviteCode(value), { notify: false });
      const welcome = await welcomeMessage(pool, person.id, person.role, identity);
      if (welcome) return ctx.reply(welcome.text, { format: 'markdown', attachments: welcome.attachments as never });
      return send(ctx, `Готово! Вы подключены: ${md(person.universityShortName)}, ${md(person.fullName)}.`);
    } catch (error) {
      if (error instanceof AppError) return send(ctx, error.message);
      throw error;
    }
  }
  const handbook = await contextFor(user);
  if (handbook) return showHandbook(ctx, user, handbook, identity);
  return greetUnknown(ctx, identity);
}

/** Обновления, после которых бот больше не ждёт вопрос дежурному: запуск, любая команда, кнопки демо. */
export function leavesQuestionMode(update: { update_type?: string; message?: { body?: { text?: string | null } | null } | null; callback?: { payload?: string | null } | null } | null | undefined): boolean {
  switch (update?.update_type) {
    case 'bot_started':
      return true;
    case 'message_created':
      return (update.message?.body?.text ?? '').trim().startsWith('/');
    case 'message_callback':
      return (update.callback?.payload ?? '').startsWith('demo:');
    default:
      return false;
  }
}

export function registerHandlers(bot: Bot) {
  // Стикер, фото или голосовое без подписи MAX присылает с text: null — обработчик команд библиотеки
  // на этом падает (null.startsWith), и человек получал «Что-то пошло не так». Пустая строка безопасна.
  bot.use((ctx, next) => {
    const update = ctx.update as { update_type?: string; message?: { body?: { text?: string | null } | null } | null };
    const body = update.update_type === 'message_created' ? update.message?.body : null;
    if (body && body.text == null) body.text = '';
    return next();
  });

  // Повторно доставленное обновление (ретрай webhook, перезапуск long polling) не обрабатываем второй раз
  bot.use(async (ctx, next) => {
    const key = updateKey(ctx.update as never);
    if (key && !(await markProcessed(pool, key))) {
      log.info('Повторное обновление пропущено', { key });
      return;
    }
    return next();
  });

  // Бот отвечает только в личном диалоге: в чате курса команда /reset или кнопки демо были бы лишним шумом.
  // Там же — ограничение частоты для сообщений, команд и нажатий: 20 в минуту, одно предупреждение, дальше тишина.
  bot.use(async (ctx, next) => {
    const type = (ctx.update as { update_type?: string }).update_type;
    if (type !== 'message_created' && type !== 'message_callback') return next();
    const chatType = (ctx.message?.recipient as { chat_type?: string } | undefined)?.chat_type;
    if (chatType && chatType !== 'dialog') {
      if (type === 'message_callback') await answer(ctx, 'Кнопки работают в личном чате с ботом');
      return;
    }
    const userId = (ctx.user as { user_id?: number } | undefined)?.user_id;
    if (!userId) return next();
    const rate = allowMessage(userId);
    if (rate === 'ok') return next();
    if (type === 'message_callback') return answer(ctx, 'Слишком много нажатий — подождите минуту');
    if (rate === 'warn') await send(ctx, 'Слишком много сообщений подряд — подождите минуту, и я снова отвечу.');
  });

  // Команда, новый запуск или кнопка демо — человек передумал спрашивать дежурного:
  // следующий текст снова поиск, а не вопрос (ожидание само не сбросилось бы 15 минут)
  bot.use(async (ctx, next) => {
    if (leavesQuestionMode(ctx.update as never)) {
      const user = await currentUser(ctx);
      if (user) await takeChatQuestion(pool, user.id);
    }
    return next();
  });

  bot.on('bot_started', (ctx) => handleStart(ctx, (ctx.startPayload as string | null | undefined) ?? null));
  bot.command(/^start(?:\s+(\S+))?$/, (ctx) => handleStart(ctx, (ctx.match as RegExpMatchArray | null)?.[1] ?? null));
  bot.command(/^demo$/, async (ctx) => askDemoRole(ctx));
  bot.command(/^reset$/, async (ctx) => confirmResetDemo(ctx));
  bot.command(/^spravka$/, async (ctx) => handleStart(ctx, 'hb'));
  bot.command(/^help$/, async (ctx) =>
    send(
      ctx,
      [
        '**Как пользоваться справочником**',
        '• Спросите своими словами: «где взять справку об обучении», «физра отработки», «общага оплата».',
        '• Не нашлось — нажмите «Спросить дежурного»: ответ придёт сюда же.',
        '• В приложении укажите курс и общежитие — и справочник покажет только то, что касается вас, и напомнит о сроках.',
        '',
        COMMANDS_HINT,
      ].join('\n'),
    ),
  );

  // «Спросить дежурного»: ждём текст вопроса следующим сообщением
  bot.action('hb:q', async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return answer(ctx, 'Откройте справочник своего факультета');
    // Двойное нажатие: второе обновление приходит параллельно с первым — подсказка должна прийти одна
    if (askInProgress.has(user.id)) return answer(ctx, 'Напишите вопрос сообщением');
    askInProgress.add(user.id);
    try {
      const handbook = await contextFor(user);
      if (!handbook) {
        await answer(ctx, 'Сначала откройте справочник');
        return await greetUnknown(ctx, await getBotIdentity());
      }
      if (questionLimitReached(await openQuestionCount(pool, handbook))) {
        await answer(ctx, 'Уже пять вопросов без ответа');
        return await send(ctx, 'У вас уже пять вопросов без ответа — дождитесь ответа дежурного, он придёт сюда же.');
      }
      // Уже ждём вопрос — просто продлеваем ожидание, второй одинаковой подсказки не шлём
      const waiting = await takeChatQuestion(pool, user.id);
      await awaitChatQuestion(pool, handbook);
      if (waiting) return await answer(ctx, 'Жду ваш вопрос — напишите его сообщением');
      await answer(ctx, 'Напишите вопрос сообщением');
      const duty = handbook.handbook.settings?.dutyContact;
      await send(
        ctx,
        [
          'Напишите вопрос одним сообщением — передам дежурному по справочнику. Ответ придёт сюда же.',
          duty ? `Дежурный: ${md(duty)}.` : null,
          'Передумали — нажмите «Отмена».',
        ]
          .filter(Boolean)
          .join('\n'),
        [[callbackButton('Отмена', 'hb:q:cancel')]],
      );
    } finally {
      askInProgress.delete(user.id);
    }
  });

  bot.action('hb:q:cancel', async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return answer(ctx, 'Отменено');
    const waiting = await takeChatQuestion(pool, user.id);
    await answer(ctx, waiting ? 'Не передаю вопрос' : 'Уже не жду вопрос');
    if (waiting) await send(ctx, 'Хорошо, вопрос дежурному не отправляю. Напишите, что ищете, — поищу в справочнике.');
  });

  bot.action('demo:start', async (ctx) => {
    await answer(ctx, 'Выберите роль');
    await askDemoRole(ctx);
  });

  bot.action('demo:role', async (ctx) => {
    await answer(ctx, 'Выберите роль');
    await askDemoRole(ctx);
  });

  bot.action(/^demo:as:(student|editor|dean)$/, async (ctx) => {
    await answer(ctx, 'Открываю демо…');
    const role = ((ctx.match as RegExpMatchArray | null)?.[1] ?? 'dean') as DemoRole;
    await startDemo(ctx, await getBotIdentity(), role);
  });

  bot.action('demo:reset', async (ctx) => {
    await answer(ctx, 'Сбросить демо?');
    await confirmResetDemo(ctx);
  });

  // Старая кнопка «Сбросить» в истории чата не должна стереть демо ещё раз: подтверждение одноразовое и живёт 10 минут
  bot.action(/^demo:reset:yes(?::([0-9a-z]{1,12}))?$/, async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return;
    const token = (ctx.match as RegExpMatchArray | null)?.[1];
    const age = token ? Date.now() - parseInt(token, 36) : Number.NaN;
    if (!(age >= -60_000 && age < RESET_CONFIRM_MS)) {
      await answer(ctx, 'Кнопка устарела');
      return confirmResetDemo(ctx);
    }
    if (!(await markProcessed(pool, `reset:${user.id}:${token}`))) return answer(ctx, 'Демо уже сброшено');
    await answer(ctx, 'Пересоздаю демо…');
    await resetDemo(ctx);
  });

  bot.action('demo:reset:no', async (ctx) => {
    await answer(ctx, 'Хорошо, демо остаётся как было');
  });

  // Кнопка из старой версии бота или чужая: отвечаем, чтобы в клиенте не крутился индикатор
  bot.on('message_callback', async (ctx) => {
    await answer(ctx, 'Эта кнопка устарела — откройте справочник командой /spravka');
  });

  // Любое сообщение в личном диалоге — поиск по справочнику или код приглашения
  bot.on('message_created', async (ctx) => {
    const text = ctx.message?.body?.text?.trim() ?? '';
    if (INVITE_RE.test(text)) return handleStart(ctx, text);
    const identity = await getBotIdentity();
    const user = await currentUser(ctx);
    if (!user) return;
    const attachments = attachmentsOf(ctx);
    if (!text && attachments.length) return handleWithoutText(ctx, user, identity);
    if (text.length >= 3 && (await handleHandbookText(ctx, user, text, identity, attachments.length > 0))) return;
    const handbook = await contextFor(user);
    if (handbook) return send(ctx, 'Напишите вопрос чуть подробнее — например, «как получить справку об обучении».');
    return greetUnknown(ctx, identity);
  });
}

export async function startBot(bot: Bot): Promise<void> {
  bot.catch(async (error, ctx) => {
    const update = ctx.update as { update_type?: string; callback?: { payload?: string } } | undefined;
    log.error('Ошибка обработки обновления', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 4) : undefined,
      update: update?.update_type,
      userId: (ctx.user as { user_id?: number } | undefined)?.user_id,
      payload: update?.callback?.payload,
    });
    // Человек не должен остаться без ответа после «Открываю демо…»
    try {
      await send(ctx, 'Что-то пошло не так. Попробуйте ещё раз через минуту.');
    } catch {
      /* ответить некуда — достаточно журнала */
    }
  });
  registerHandlers(bot);

  try {
    const info = await bot.api.getMyInfo();
    bot.botInfo = info;
    await saveBotIdentity({
      username: config.BOT_USERNAME || info.username || '',
      userId: config.BOT_USER_ID ?? info.user_id ?? null,
      name: info.first_name ?? info.name ?? 'Курсор',
    });
    await bot.api.setMyCommands([
      { name: 'spravka', description: 'Открыть справочник факультета' },
      { name: 'help', description: 'Как пользоваться' },
      ...(config.DEMO_ENABLED
        ? [
            { name: 'demo', description: 'Демо с модельными данными' },
            { name: 'reset', description: 'Сбросить демо' },
          ]
        : []),
    ]);
  } catch (error) {
    const hint = tlsTrustHint(error);
    if (hint) log.error(hint);
    else log.warn('Не удалось получить /me или установить команды', { error: (error as Error).message });
  }

  if (config.BOT_MODE === 'webhook') {
    log.info('Бот запускается в режиме webhook', { path: config.WEBHOOK_PATH, port: config.BOT_PORT });
    await bot.start({
      mode: 'webhook',
      options: {
        domain: config.PUBLIC_URL,
        port: config.BOT_PORT,
        path: config.WEBHOOK_PATH,
        ...(config.WEBHOOK_SECRET ? { secret: config.WEBHOOK_SECRET } : {}),
        allowedUpdates: ['bot_started', 'message_created', 'message_callback'],
      },
    });
  } else {
    log.info('Бот запускается в режиме long polling');
    // Сбой при запуске (MAX API ещё недоступен) не должен ронять процесс: пробуем снова через 10 секунд
    const startPolling = (): void => {
      bot.start({ mode: 'polling', options: { allowedUpdates: ['bot_started', 'message_created', 'message_callback'] } }).catch((error: unknown) => {
        log.error('Long polling остановился — перезапуск через 10 с', { error: tlsTrustHint(error) ?? (error as Error)?.message });
        setTimeout(startPolling, 10_000);
      });
    };
    startPolling();
  }
}
