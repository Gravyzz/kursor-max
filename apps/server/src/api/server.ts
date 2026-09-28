import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ZodError, z } from 'zod';
import { config } from '../config.js';
import { pool, one } from '../db/pool.js';
import { AppError, clientErrorFromRequest, inputErrorFromDatabase } from '../lib/errors.js';
import { stripNul } from '../lib/sanitize.js';
import { createLogger } from '../lib/logger.js';
import { authenticate } from './auth.js';
import { registerCommonRoutes } from './routes/common.js';
import { registerHandbookRoutes } from './routes/handbook.js';
import { registerHandbookEditorRoutes } from './routes/handbook-editor.js';

const log = createLogger('api');

export async function buildApi(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 3 * 1024 * 1024,
    trustProxy: config.TRUST_PROXY,
    genReqId: () => Math.random().toString(36).slice(2, 10),
  });

  // Ограничение частоты по IP. По сессии считать нельзя: заголовок initData подделывается
  // до проверки подписи, и злоумышленник получил бы сколько угодно отдельных лимитов.
  // Студенты за одним NAT оператора делят лимит, поэтому он высокий: экран приложения — 2–3 запроса.
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    // Плагин бросает то, что вернул построитель: AppError превращается в 429 с русским текстом, без записи в лог ошибок (API-1)
    errorResponseBuilder: (_request, context) =>
      new AppError('rate_limited', 'Слишком много запросов — подождите минуту', context.statusCode),
  });

  const sendError = (reply: FastifyReply, error: AppError) =>
    reply.status(error.status).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return sendError(reply, error);
    if (error instanceof ZodError) {
      const message = error.issues.map((issue) => issue.message).join('; ');
      return reply.status(400).send({ error: { code: 'validation_error', message: `Проверьте данные: ${message}` } });
    }
    // Недопустимые символы или значения, которые не приняла база, — ошибка во входных данных, а не сбой
    const inputError = inputErrorFromDatabase(error);
    if (inputError) return sendError(reply, inputError);
    // Ошибки разбора запроса Fastify (битый JSON, пустое тело, формат, размер) — по-русски, без внутренних подробностей
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return sendError(reply, clientErrorFromRequest(status));
    log.error('Необработанная ошибка API', { id: request.id, url: request.url, error: (error as Error).message, stack: (error as Error).stack?.split('\n').slice(0, 3) });
    return reply.status(500).send({ error: { code: 'internal', message: 'Что-то пошло не так на сервере. Попробуйте ещё раз' } });
  });

  app.get('/api/health', async () => {
    await one(pool, 'SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });

  // Нулевой байт во входе вырезается до разбора: иначе PostgreSQL отвечает ошибкой и запрос падает с 500 (API-2)
  app.addHook('preValidation', async (request) => {
    request.body = stripNul(request.body);
    request.query = stripNul(request.query);
    request.params = stripNul(request.params);
  });

  app.addHook('preHandler', async (request) => {
    if (request.url.startsWith('/api/health') || request.url.startsWith('/api/config')) return;
    request.actor = await authenticate(request);
  });

  app.get('/api/config', async () => ({
    demoEnabled: config.DEMO_ENABLED,
    devAuth: config.DEV_AUTH,
    reviewAuth: Boolean(config.REVIEW_API_KEY),
  }));

  registerCommonRoutes(app);
  registerHandbookRoutes(app);
  registerHandbookEditorRoutes(app);

  app.setNotFoundHandler((request, reply) => reply.status(404).send({ error: { code: 'not_found', message: `Маршрут ${request.method} ${request.url} не найден` } }));
  return app;
}

export async function startApi() {
  const app = await buildApi();
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  log.info('API запущено', { port: config.API_PORT });
  return app;
}

export const uuidParam = z.object({ id: z.string().uuid('Некорректный идентификатор') });
