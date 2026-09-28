import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { createLogger } from './lib/logger.js';
import { startApi } from './api/server.js';
import { createMaxBot, tlsTrustHint } from './max/bot.js';
import { startBot } from './bot/index.js';
import { startWorker } from './worker/index.js';
import { runBootstrapCli } from './cli/bootstrap.js';

const log = createLogger('main');
const role = process.argv[2] ?? process.env.APP_ROLE ?? 'all';

async function main() {
  log.info('Запуск «Курсора»', { role, env: config.NODE_ENV, maxApi: config.MAX_API_BASE_URL, botMode: config.BOT_MODE });
  const stops: Array<() => Promise<unknown>> = [];

  if (role === 'migrate') {
    await migrate();
    await pool.end();
    return;
  }
  if (role === 'bootstrap') {
    try {
      await runBootstrapCli(process.argv.slice(3));
    } catch (error) {
      console.error(`Ошибка: ${(error as Error).message}`);
      process.exitCode = 2;
    }
    return;
  }
  if (role === 'check-max') {
    await checkMax();
    await pool.end();
    return;
  }
  if (role === 'all') await migrate();

  if (role === 'api' || role === 'all') {
    const api = await startApi();
    stops.push(() => api.close());
  }
  if (role === 'bot' || role === 'all') {
    const bot = createMaxBot();
    await startBot(bot);
    // Подписку webhook при остановке не снимаем: после перезапуска контейнера MAX продолжит доставку
    stops.push(async () => (config.BOT_MODE === 'polling' ? bot.stopPolling() : undefined));
  }
  if (role === 'worker' || role === 'all') {
    const bot = config.BOT_TOKEN ? createMaxBot() : null;
    const stop = await startWorker(bot);
    stops.push(stop);
  }
  if (!['api', 'bot', 'worker', 'all'].includes(role)) throw new Error(`Неизвестная роль: ${role}`);

  const shutdown = async (signal: string) => {
    log.info('Остановка', { signal });
    await Promise.allSettled(stops.map((stop) => stop()));
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Проверка связи с MAX после развёртывания: docker compose exec bot node dist/index.js check-max
 * Показывает, кем бот представился, куда настроен webhook и открывается ли мини-приложение.
 */
async function checkMax() {
  const print = (ok: boolean, text: string) => console.log(`${ok ? '✅' : '❌'} ${text}`);
  const bot = createMaxBot();
  try {
    const info = await bot.api.getMyInfo();
    print(true, `MAX API отвечает: бот @${info.username ?? '?'} (id ${info.user_id ?? '?'})`);
    if (config.BOT_USERNAME && info.username && config.BOT_USERNAME !== info.username) {
      print(false, `BOT_USERNAME=${config.BOT_USERNAME}, а MAX называет бота @${info.username} — исправьте .env`);
    }
  } catch (error) {
    print(false, `MAX API недоступен: ${(error as Error).message}`);
    const hint = tlsTrustHint(error);
    if (hint) console.log(`   ${hint}`);
    process.exitCode = 1;
    return;
  }
  try {
    const subscriptions = await bot.api.getSubscriptions();
    const urls = subscriptions.map((item) => item.url);
    if (config.BOT_MODE === 'webhook') {
      // так же адрес собирает SDK MAX (Webhook.getWebhookUrl)
      const expected = `https://${new URL(config.PUBLIC_URL).host}${config.WEBHOOK_PATH}`;
      print(urls.includes(expected), `Webhook: ожидается ${expected}; в MAX: ${urls.join(', ') || 'подписок нет'}`);
      if (!urls.includes(expected)) process.exitCode = 1;
    } else {
      print(urls.length === 0, urls.length ? `Режим polling, но в MAX есть webhook ${urls.join(', ')} — обновления уйдут туда` : 'Режим polling, подписок webhook нет');
    }
  } catch (error) {
    print(false, `Не удалось прочитать подписки: ${(error as Error).message}`);
  }
  try {
    const response = await fetch(new URL('/api/health', config.PUBLIC_URL), { signal: AbortSignal.timeout(10_000) });
    print(response.ok, `Мини-приложение ${config.PUBLIC_URL}: /api/health → ${response.status}`);
  } catch (error) {
    print(false, `Мини-приложение ${config.PUBLIC_URL} недоступно: ${(error as Error).message}`);
  }
}

main().catch((error) => {
  log.error('Фатальная ошибка запуска', { message: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
