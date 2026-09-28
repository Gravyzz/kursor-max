/**
 * Чат с ботом в браузере. Обработчики — настоящие, из apps/server/src/bot/index.ts;
 * вместо SDK MAX — маленькая имитация с тем же порядком middleware, command и action.
 * Уведомления отправляет настоящий воркер очереди (worker/index.ts), только «в сеть» здесь — это лента чата.
 */
import { registerHandlers } from '../../../server/src/bot/index';
import { dispatchDue, runScheduledChecks } from '../../../server/src/worker/index';
import { DEMO_MAX_USER } from './auth';
import { serial } from './pool';

export type InlineButton =
  | { type: 'callback'; text: string; payload: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'open_app'; text: string; web_app: string; payload?: string };

export interface ChatMessage {
  id: string;
  from: 'bot' | 'user';
  text: string;
  buttons: InlineButton[][];
  at: number;
}

type Listener = () => void;

class ChatStore {
  messages: ChatMessage[] = [];
  notice: { text: string; at: number } | null = null;
  typing = false;
  private listeners = new Set<Listener>();
  private seq = 0;
  private version = 0;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => this.version;

  private emit() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}${Date.now().toString(36)}${this.seq}`;
  }

  push(message: Omit<ChatMessage, 'id' | 'at'>) {
    this.messages = [...this.messages, { ...message, id: this.nextId('m'), at: Date.now() }];
    this.emit();
  }

  toast(text: string) {
    this.notice = { text, at: Date.now() };
    this.emit();
  }

  setTyping(value: boolean) {
    this.typing = value;
    this.emit();
  }

  clear() {
    this.messages = [];
    this.notice = null;
    this.emit();
  }
}

export const chat = new ChatStore();

function buttonsFrom(attachments: unknown): InlineButton[][] {
  const list = Array.isArray(attachments) ? attachments : [];
  const keyboard = list.find((item) => (item as { type?: string })?.type === 'inline_keyboard') as
    | { payload?: { buttons?: InlineButton[][] } }
    | undefined;
  return keyboard?.payload?.buttons ?? [];
}

type Update = Record<string, unknown> & { update_type: string };
type Ctx = Record<string, unknown> & { update: Update };
type Middleware = (ctx: Ctx, next: () => Promise<void>) => unknown;

/** Имитация Bot из @maxhub/max-bot-api — ровно то, что используют наш бот и воркер. */
class DemoBot {
  private stack: Middleware[] = [];
  private onError: ((error: unknown, ctx: Ctx) => void) | null = null;

  api = {
    sendMessageToUser: async (_userId: number, text: string, extra?: { attachments?: unknown }) => {
      chat.push({ from: 'bot', text, buttons: buttonsFrom(extra?.attachments) });
      return { body: { mid: chat.nextId('mid') } };
    },
    getMyInfo: async () => ({ username: 'spravochnik_bot', user_id: 900001, name: 'Справочник' }),
    setMyCommands: async () => undefined,
  };

  use(middleware: Middleware) {
    this.stack.push(middleware);
  }

  on(event: string, handler: (ctx: Ctx) => unknown) {
    this.stack.push(async (ctx, next) => (ctx.update.update_type === event ? handler(ctx) : next()));
  }

  command(pattern: RegExp, handler: (ctx: Ctx) => unknown) {
    this.stack.push(async (ctx, next) => {
      if (ctx.update.update_type !== 'message_created') return next();
      const text = ((ctx.message as { body?: { text?: string } } | undefined)?.body?.text ?? '').trim();
      if (!text.startsWith('/')) return next();
      const match = pattern.exec(text.slice(1));
      if (!match) return next();
      ctx.match = match;
      return handler(ctx);
    });
  }

  action(trigger: string | RegExp, handler: (ctx: Ctx) => unknown) {
    this.stack.push(async (ctx, next) => {
      if (ctx.update.update_type !== 'message_callback') return next();
      const payload = String((ctx.update.callback as { payload?: string } | undefined)?.payload ?? '');
      if (typeof trigger === 'string') {
        if (payload !== trigger) return next();
      } else {
        const match = trigger.exec(payload);
        if (!match) return next();
        ctx.match = match;
      }
      return handler(ctx);
    });
  }

  catch(handler: (error: unknown, ctx: Ctx) => void) {
    this.onError = handler;
  }

  async handle(update: Update) {
    const ctx: Ctx = {
      update,
      user: { user_id: DEMO_MAX_USER.id, first_name: DEMO_MAX_USER.first_name, last_name: DEMO_MAX_USER.last_name, username: null },
      startPayload: update.payload ?? null,
      message: update.message,
      match: null,
      reply: async (text: string, extra?: { attachments?: unknown }) => {
        chat.push({ from: 'bot', text, buttons: buttonsFrom(extra?.attachments) });
      },
      answerOnCallback: async (options: { notification?: string }) => {
        if (options?.notification) chat.toast(options.notification);
      },
    };
    const run = async (index: number): Promise<void> => {
      const middleware = this.stack[index];
      if (!middleware) return;
      await middleware(ctx, () => run(index + 1));
    };
    try {
      await run(0);
    } catch (error) {
      console.error('[bot] ошибка обработки', error);
      this.onError?.(error, ctx);
      chat.push({ from: 'bot', text: 'Что-то пошло не так. Попробуйте ещё раз.', buttons: [] });
    }
  }
}

const bot = new DemoBot();
registerHandlers(bot as never);

let updateSeq = 0;
const stamp = () => {
  updateSeq += 1;
  return { timestamp: Date.now() + updateSeq };
};

async function deliver(update: Update) {
  chat.setTyping(true);
  try {
    await serial(() => bot.handle(update));
  } finally {
    chat.setTyping(false);
  }
  await flushNotifications();
}

/** Запуск бота по ссылке ?start=<payload> — как первое открытие чата в MAX. */
export async function startBot(payload: string | null, options: { silent?: boolean } = {}) {
  if (!options.silent) chat.push({ from: 'user', text: payload ? `/start ${payload}` : '/start', buttons: [] });
  await deliver({ ...stamp(), update_type: 'bot_started', payload, user: { user_id: DEMO_MAX_USER.id } });
}

export async function sendText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  chat.push({ from: 'user', text: trimmed, buttons: [] });
  await deliver({
    ...stamp(),
    update_type: 'message_created',
    message: { body: { mid: chat.nextId('mid'), text: trimmed }, recipient: { chat_type: 'dialog' } },
  });
}

export async function pressButton(payload: string, label: string) {
  chat.push({ from: 'user', text: label, buttons: [] });
  await deliver({
    ...stamp(),
    update_type: 'message_callback',
    callback: { callback_id: chat.nextId('cb'), payload },
  });
}

/** Воркер уведомлений: отправляет всё, что пора, прямо в ленту чата. */
export async function flushNotifications() {
  for (let i = 0; i < 4; i += 1) {
    const sent = await serial(() => dispatchDue(bot as never, async () => undefined));
    if (sent === 0) break;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastChecks = 0;

export function startWorker() {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      if (Date.now() - lastChecks > 60_000) {
        lastChecks = Date.now();
        await serial(() => runScheduledChecks()).catch((error) => console.warn('[worker]', error));
      }
      await flushNotifications().catch((error) => console.warn('[worker]', error));
    })();
  }, 1500);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
