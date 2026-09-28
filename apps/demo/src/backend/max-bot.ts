/** Данные бота для кнопок и диплинков. В демо бот вымышленный, сеть не нужна. */
import { config } from './config';

export interface BotIdentity {
  username: string;
  userId: number | null;
  name: string;
}

const identity: BotIdentity = { username: config.BOT_USERNAME, userId: config.BOT_USER_ID ?? null, name: 'Справочник' };

// Подсказка про сертификаты Минцифры — та же чистая функция, что на сервере
export { tlsTrustHint } from '../../../server/src/max/tls';

export function createMaxBot(): never {
  throw new Error('В демо нет подключения к MAX');
}

export async function getBotIdentity(): Promise<BotIdentity> {
  return identity;
}

export async function saveBotIdentity(): Promise<void> {
  // В демо данные бота постоянны
}

export function deepLink(bot: BotIdentity, kind: 'start' | 'startapp', payload?: string): string {
  const base = `https://max.ru/${bot.username || 'bot'}`;
  if (payload === undefined) return kind === 'startapp' ? `${base}?startapp` : base;
  return `${base}?${kind}=${encodeURIComponent(payload)}`;
}
