import { Bot } from '@maxhub/max-bot-api';
import { config } from '../config.js';
import { pool, one } from '../db/pool.js';
import { createLogger } from '../lib/logger.js';
import { tlsTrustHint } from './tls.js';

export { tlsTrustHint };

const log = createLogger('max');

export function createMaxBot(): Bot {
  if (!config.BOT_TOKEN) throw new Error('BOT_TOKEN не задан: боту нечем авторизоваться в MAX');
  return new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_BASE_URL } });
}

export interface BotIdentity {
  username: string;
  userId: number | null;
  name: string;
}

let cached: BotIdentity | null = null;

/** Имя и id бота нужны для кнопок open_app и диплинков. */
export async function getBotIdentity(bot?: Bot): Promise<BotIdentity> {
  if (cached) return cached;
  if (config.BOT_USERNAME) {
    cached = { username: config.BOT_USERNAME, userId: config.BOT_USER_ID ?? null, name: 'Курсор' };
    return cached;
  }
  const stored = await one<{ value: BotIdentity }>(pool, "SELECT value FROM kv WHERE key = 'bot_identity'");
  if (stored?.value?.username) {
    cached = stored.value;
    return cached;
  }
  if (bot) {
    try {
      const info = await bot.api.getMyInfo();
      const identity: BotIdentity = {
        username: info.username ?? '',
        userId: info.user_id ?? null,
        name: info.name ?? info.first_name ?? 'Курсор',
      };
      await saveBotIdentity(identity);
      cached = identity;
      return identity;
    } catch (error) {
      log.warn('Не удалось получить данные бота из /me', { error: (error as Error).message, hint: tlsTrustHint(error) });
    }
  }
  return { username: '', userId: null, name: 'Курсор' };
}

export async function saveBotIdentity(identity: BotIdentity): Promise<void> {
  cached = identity;
  await pool.query(
    `INSERT INTO kv(key, value, updated_at) VALUES ('bot_identity', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(identity)],
  );
}

export function deepLink(identity: BotIdentity, kind: 'start' | 'startapp', payload?: string): string {
  const base = `https://max.ru/${identity.username || 'bot'}`;
  if (payload === undefined) return kind === 'startapp' ? `${base}?startapp` : base;
  return `${base}?${kind}=${encodeURIComponent(payload)}`;
}
