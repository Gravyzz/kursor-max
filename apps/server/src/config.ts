import { createHmac } from 'node:crypto';
import { z } from 'zod';

const boolFromEnv = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((value) => value === 'true' || value === '1');

// В compose пустая переменная приходит как "" — считаем её незаданной
const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),

  BOT_TOKEN: z.string().default(''),
  MAX_API_BASE_URL: z.string().url().default('https://platform-api2.max.ru'),
  BOT_MODE: z.enum(['polling', 'webhook']).default('polling'),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  WEBHOOK_PATH: z.string().startsWith('/').default('/webhook/max'),
  // MAX принимает секрет подписки из 5–256 символов: латиница, цифры, «_» и «-»
  WEBHOOK_SECRET: z.string().regex(/^(?:[A-Za-z0-9_-]{5,256})?$/, 'WEBHOOK_SECRET: 5–256 символов A-Z, a-z, 0-9, _ или -').default(''),
  BOT_PORT: z.coerce.number().int().positive().default(3001),
  BOT_USERNAME: z.string().default(''),
  BOT_USER_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  MINIAPP_BUTTON: z.enum(['open_app', 'link']).default('open_app'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  // Кому верить в X-Forwarded-For. По умолчанию — только соседнему прокси (Caddy в этом же compose):
  // безоговорочное доверие позволило бы подделать IP и обойти ограничение частоты.
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  INITDATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(86_400),
  DEV_AUTH: boolFromEnv.default('false'),
  // Необязательный ключ для автоматической проверки API жюри. Он даёт доступ только к отдельной демо-песочнице.
  REVIEW_API_KEY: z
    .string()
    .refine((value) => value === '' || (value.length >= 32 && value.length <= 256), 'REVIEW_API_KEY: от 32 до 256 символов')
    .default(''),
  REVIEW_USER_ID: z.coerce.number().int().positive().safe().default(9_000_000_001),
  // Корневой секрет сервера: из него выводятся производные ключи (сейчас — для хеширования телефонов)
  APP_SECRET: z.string().default(''),

  // Имя из базы IANA (Europe/Moscow, Asia/Tomsk): сокращения вроде MSK PostgreSQL примет, а Node.js — нет
  APP_TIMEZONE: z
    .string()
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('ru-RU', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, 'APP_TIMEZONE: укажите часовой пояс вида Europe/Moscow или Asia/Tomsk')
    .default('Europe/Moscow'),
  DEMO_ENABLED: boolFromEnv.default('true'),
  NOTIFY_RPS: z.coerce.number().positive().max(30).default(20),
  WORKER_TICK_MS: z.coerce.number().int().positive().default(3000),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Пустые значения (например, `BOT_USER_ID=` в .env) равнозначны отсутствующим: применяются значения по умолчанию
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Некорректные переменные окружения: ${details}`);
  }
  const config = parsed.data;
  if (config.DEV_AUTH && config.NODE_ENV === 'production') {
    throw new Error('DEV_AUTH нельзя включать при NODE_ENV=production');
  }
  // Публичный HTTPS-адрес — это сервер, доступный из интернета: тестовый вход там позволил бы
  // представиться любым пользователем MAX. Локальный стенд работает по http://localhost.
  if (config.DEV_AUTH && config.PUBLIC_URL.startsWith('https://')) {
    throw new Error('DEV_AUTH нельзя включать на сервере с публичным HTTPS-адресом: вход только через подписанные initData MAX');
  }
  if (config.REVIEW_API_KEY && !config.DEMO_ENABLED) {
    throw new Error('REVIEW_API_KEY можно использовать только при DEMO_ENABLED=true');
  }
  if (config.NODE_ENV === 'production' && config.APP_SECRET.length < 16) {
    throw new Error('Задайте APP_SECRET не короче 16 символов (например, openssl rand -hex 32)');
  }
  if (config.BOT_MODE === 'webhook' && !config.PUBLIC_URL.startsWith('https://')) {
    throw new Error('Для BOT_MODE=webhook нужен PUBLIC_URL с https:// — MAX доставляет обновления только по HTTPS');
  }
  // Адрес webhook предсказуем: без секрета любой мог бы прислать поддельное обновление от имени любого пользователя
  if (config.BOT_MODE === 'webhook' && config.NODE_ENV === 'production' && !config.WEBHOOK_SECRET) {
    throw new Error('Для BOT_MODE=webhook задайте WEBHOOK_SECRET (например, openssl rand -hex 32)');
  }
  return config;
}

export const config = loadConfig();

/**
 * Ключ для конкретной задачи, выведенный из APP_SECRET (HMAC-SHA256).
 * Смена APP_SECRET делает недействительными хеши телефонов — телефоны потребуется загрузить заново.
 */
export function derivedSecret(purpose: 'phone'): string {
  const root =
    config.APP_SECRET.length >= 16
      ? config.APP_SECRET
      : // Вне продакшна допускаем запуск без секрета: ключ производный от токена или фиксированный локальный
        `dev-only:${config.BOT_TOKEN || 'handbook-local'}`;
  return createHmac('sha256', root).update(`handbook:${purpose}`).digest('hex');
}
