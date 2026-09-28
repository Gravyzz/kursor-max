/**
 * Конфигурация демо в браузере: те же поля, что у сервера, но без переменных окружения.
 * Секреты здесь не секретны — это модельный университет в браузере посетителя.
 */
import { createHmac } from './crypto';

export const config = {
  NODE_ENV: 'development' as 'development' | 'production' | 'test',
  LOG_LEVEL: 'warn' as 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent',
  DATABASE_URL: 'pglite://memory',
  BOT_TOKEN: 'browser-demo',
  MAX_API_BASE_URL: 'https://platform-api2.max.ru',
  BOT_MODE: 'polling' as 'polling' | 'webhook',
  PUBLIC_URL: 'https://demo.invalid',
  WEBHOOK_PATH: '/webhook/max',
  WEBHOOK_SECRET: '',
  BOT_PORT: 3001,
  BOT_USERNAME: 'spravochnik_bot',
  BOT_USER_ID: 900001 as number | undefined,
  MINIAPP_BUTTON: 'open_app' as 'open_app' | 'link',
  API_HOST: '0.0.0.0',
  API_PORT: 3000,
  TRUST_PROXY: 'loopback',
  RATE_LIMIT_PER_MINUTE: 100000,
  INITDATA_MAX_AGE_SEC: 86400,
  DEV_AUTH: true,
  REVIEW_API_KEY: '',
  REVIEW_USER_ID: 9_000_000_001,
  APP_SECRET: 'browser-demo-secret-not-for-production',
  APP_TIMEZONE: 'Europe/Moscow',
  DEMO_ENABLED: true,
  NOTIFY_RPS: 30,
  WORKER_TICK_MS: 1200,
};

export type AppConfig = typeof config;

export function loadConfig(): AppConfig {
  return config;
}

export function derivedSecret(purpose: 'phone'): string {
  return createHmac('sha256', config.APP_SECRET).update(`derive:${purpose}`).digest('hex');
}
