import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('переменные окружения', () => {
  let mod: typeof import('../src/config.js');
  const base = { DATABASE_URL: 'postgres://handbook:secret@db:5432/handbook' };

  before(async () => {
    process.env.DATABASE_URL ??= 'postgres://test@localhost:5432/test';
    process.env.NODE_ENV ??= 'test';
    mod = await import('../src/config.js');
  });

  it('пустые значения из .env равнозначны незаданным', () => {
    const cfg = mod.loadConfig({ ...base, NODE_ENV: 'development', BOT_USER_ID: '', LOG_LEVEL: '', DEV_AUTH: '', BOT_MODE: '' });
    assert.equal(cfg.BOT_USER_ID, undefined);
    assert.equal(cfg.LOG_LEVEL, 'info');
    assert.equal(cfg.DEV_AUTH, false);
    assert.equal(cfg.BOT_MODE, 'polling');
  });

  it('в продакшне запрещён тестовый вход и обязателен APP_SECRET', () => {
    const secret = 'x'.repeat(32);
    assert.throws(() => mod.loadConfig({ ...base, NODE_ENV: 'production', DEV_AUTH: 'true', APP_SECRET: secret }), /DEV_AUTH/);
    assert.throws(() => mod.loadConfig({ ...base, NODE_ENV: 'production', APP_SECRET: 'short' }), /APP_SECRET/);
    assert.equal(mod.loadConfig({ ...base, NODE_ENV: 'production', APP_SECRET: secret }).NODE_ENV, 'production');
  });

  it('тестовый вход запрещён на публичном HTTPS-адресе', () => {
    assert.throws(() => mod.loadConfig({ ...base, NODE_ENV: 'development', DEV_AUTH: 'true', PUBLIC_URL: 'https://handbook.example.ru' }), /DEV_AUTH/);
    assert.equal(mod.loadConfig({ ...base, NODE_ENV: 'development', DEV_AUTH: 'true', PUBLIC_URL: 'http://localhost:8080' }).DEV_AUTH, true);
  });

  it('ключ проверки разрешён в продакшне только для демо и должен быть достаточно длинным', () => {
    const prod = { ...base, NODE_ENV: 'production', APP_SECRET: 'x'.repeat(32) };
    assert.throws(() => mod.loadConfig({ ...prod, REVIEW_API_KEY: 'short' }), /REVIEW_API_KEY/);
    assert.throws(() => mod.loadConfig({ ...prod, REVIEW_API_KEY: 'r'.repeat(32), DEMO_ENABLED: 'false' }), /DEMO_ENABLED/);
    assert.equal(mod.loadConfig({ ...prod, REVIEW_API_KEY: 'r'.repeat(32) }).REVIEW_USER_ID, 9_000_000_001);
  });

  it('часовой пояс — только имя IANA; webhook в продакшне — только с секретом', () => {
    assert.throws(() => mod.loadConfig({ ...base, NODE_ENV: 'development', APP_TIMEZONE: 'MSK' }), /APP_TIMEZONE/);
    assert.equal(mod.loadConfig({ ...base, NODE_ENV: 'development', APP_TIMEZONE: 'Asia/Tomsk' }).APP_TIMEZONE, 'Asia/Tomsk');
    const prod = { ...base, NODE_ENV: 'production', APP_SECRET: 'x'.repeat(32), BOT_MODE: 'webhook', PUBLIC_URL: 'https://handbook.example.ru' };
    assert.throws(() => mod.loadConfig(prod), /WEBHOOK_SECRET/);
    assert.equal(mod.loadConfig({ ...prod, WEBHOOK_SECRET: 'abc_DEF-123' }).BOT_MODE, 'webhook');
  });

  it('webhook требует HTTPS-адрес и секрет из допустимых символов', () => {
    const webhook = { ...base, NODE_ENV: 'development', BOT_MODE: 'webhook' };
    assert.throws(() => mod.loadConfig({ ...webhook, PUBLIC_URL: 'http://localhost:8080' }), /https/);
    assert.throws(() => mod.loadConfig({ ...webhook, PUBLIC_URL: 'https://handbook.example.ru', WEBHOOK_SECRET: 'bad secret!' }), /WEBHOOK_SECRET/);
    assert.equal(mod.loadConfig({ ...webhook, PUBLIC_URL: 'https://handbook.example.ru', WEBHOOK_SECRET: 'abc_DEF-123' }).BOT_MODE, 'webhook');
  });

  it('темп рассылки не превышает лимит MAX Bot API (30 запросов в секунду)', () => {
    assert.throws(() => mod.loadConfig({ ...base, NODE_ENV: 'development', NOTIFY_RPS: '31' }), /NOTIFY_RPS/);
  });

  it('ключ для хеширования телефонов выводится из корневого секрета, но не равен ему', () => {
    const phone = mod.derivedSecret('phone');
    assert.match(phone, /^[0-9a-f]{64}$/);
    assert.notEqual(phone, mod.config.APP_SECRET);
  });
});
