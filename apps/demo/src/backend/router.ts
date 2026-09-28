/**
 * REST API мини-приложения без сервера: те же модули маршрутов, что в Fastify,
 * регистрируются в маленьком маршрутизаторе, а запросы приходят не по сети, а из fetch().
 */
import { AppError, inputErrorFromDatabase } from '../../../server/src/lib/errors';
import { stripNul } from '../../../server/src/lib/sanitize';
import { registerCommonRoutes } from '../../../server/src/api/routes/common';
import { registerHandbookRoutes } from '../../../server/src/api/routes/handbook';
import { registerHandbookEditorRoutes } from '../../../server/src/api/routes/handbook-editor';
import { authenticate, type Actor } from './auth';
import { serial } from './pool';

type Handler = (request: RequestLike) => unknown;

interface RequestLike {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string | undefined>;
  actor?: Actor;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

function add(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((part) => {
      if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(part.slice(1));
      return '([^/]+)';
    })
    .join('/');
  routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
}

// Минимум интерфейса Fastify, которым пользуются модули маршрутов
const app = {
  get: (path: string, handler: Handler) => add('GET', path, handler),
  post: (path: string, handler: Handler) => add('POST', path, handler),
  patch: (path: string, handler: Handler) => add('PATCH', path, handler),
  put: (path: string, handler: Handler) => add('PUT', path, handler),
  delete: (path: string, handler: Handler) => add('DELETE', path, handler),
};

const fastifyLike = app as never;
registerCommonRoutes(fastifyLike);
registerHandbookRoutes(fastifyLike);
registerHandbookEditorRoutes(fastifyLike);

export interface ApiResponse {
  status: number;
  body: unknown;
}

function errorResponse(error: unknown): ApiResponse {
  // Как в api/server.ts: недопустимые символы и значения, которые не приняла база, — 400, а не 500
  const known = error instanceof AppError ? error : inputErrorFromDatabase(error);
  if (known) {
    return {
      status: known.status,
      body: { error: { code: known.code, message: known.message, ...(known.details ? { details: known.details } : {}) } },
    };
  }
  // ZodError проверяем по форме: у серверного кода своя копия zod
  const issues = (error as { issues?: Array<{ message: string }> })?.issues;
  if ((error as Error)?.name === 'ZodError' && Array.isArray(issues)) {
    return { status: 400, body: { error: { code: 'validation_error', message: `Проверьте данные: ${issues.map((i) => i.message).join('; ')}` } } };
  }
  console.error('[api] необработанная ошибка', error);
  return { status: 500, body: { error: { code: 'internal', message: 'Что-то пошло не так. Попробуйте ещё раз' } } };
}

export async function handleApi(method: string, rawUrl: string, headers: Record<string, string | undefined>, bodyText: string | null): Promise<ApiResponse> {
  const url = new URL(rawUrl, 'https://demo.invalid');
  if (url.pathname === '/api/health') return { status: 200, body: { ok: true, time: new Date().toISOString() } };
  if (url.pathname === '/api/config') return { status: 200, body: { demoEnabled: true, devAuth: true } };

  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const match = route.pattern.exec(url.pathname);
    if (!match) continue;
    let body: unknown;
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1]!)]));
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      return errorResponse(new AppError('bad_request', 'Не удалось прочитать данные запроса — обновите приложение и попробуйте ещё раз', 400));
    }
    // Нулевой байт во входе вырезается, как в api/server.ts (API-2)
    const request: RequestLike = {
      method,
      url: url.pathname + url.search,
      params: stripNul(params),
      query: stripNul(Object.fromEntries(url.searchParams)),
      body: stripNul(body),
      headers,
    };
    return serial(async () => {
      try {
        request.actor = await authenticate(request);
        const result = await route.handler(request);
        return { status: 200, body: result ?? null };
      } catch (error) {
        return errorResponse(error);
      }
    });
  }
  return { status: 404, body: { error: { code: 'not_found', message: `Маршрут ${method} ${url.pathname} не найден` } } };
}
