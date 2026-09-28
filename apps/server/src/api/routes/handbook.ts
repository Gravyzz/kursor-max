import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, pool } from '../../db/pool.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { uuidParam } from '../server.js';
import {
  announcementsFeed, askQuestion, contextFor, findHandbook, getPage, home, listHandbooks, logSearch, markAnnouncementRead, markSearchOpened, memberRole,
  myQuestions, search, sectionsWithPages, setFeedback, setProgress, startRef, updateProfile, upcomingDeadlines,
  type HandbookContext,
} from '../../services/handbook.js';

/**
 * Справочник открыт любому пользователю MAX: читателю не нужно быть в списках деканата.
 * Контекст определяется по ссылке (?startapp=hb_<slug>), прошлому визиту или институту записи в вузе.
 */
async function ctx(request: FastifyRequest): Promise<HandbookContext> {
  if (!request.actor) throw new AppError('unauthorized', 'Нужен вход через MAX', 401);
  const query = z
    .object({
      handbookId: z.string().uuid().optional(),
      handbook: z.string().trim().max(80).optional(),
      // page — отсканированный QR страницы: справочник выбирается по ней
      page: z.string().uuid().optional(),
    })
    .partial()
    .parse(request.query ?? {});
  // Явно указанный справочник обязан существовать (API-12): после сброса демо, архивации или опечатки
  // вопрос, оценка и отметки не должны молча уйти в другой справочник — последний открытый
  if ((query.handbookId || query.handbook) && !(await findHandbook(pool, { id: query.handbookId ?? null, slug: query.handbook ?? null }))) {
    throw notFound('Справочник не найден — возможно, его убрали или демо сбросили. Откройте справочник заново из чата');
  }
  // Явный выбор в приложении важнее диплинка, с которым его открыли
  const start = startRef(request.actor.startParam);
  const context = await contextFor(request.actor.user, {
    handbookId: query.handbookId ?? null,
    slug: query.handbook ?? start.slug,
    pageId: query.page ?? (query.handbookId || query.handbook ? null : start.pageId),
  });
  if (!context) {
    throw new AppError(
      'no_handbook',
      'Справочник не выбран. Откройте ссылку своего факультета или выберите его в списке',
      404,
    );
  }
  if (request.actor.viaReviewAuth) {
    const owned = await one<{ ok: boolean }>(
      pool,
      'SELECT EXISTS (SELECT 1 FROM universities WHERE id = $1 AND is_demo AND demo_owner_user_id = $2) AS ok',
      [context.handbook.university_id, request.actor.user.id],
    );
    if (!owned?.ok) throw forbidden('Ключ проверки работает только с собственной модельной демо-песочницей');
  }
  return context;
}

export function registerHandbookRoutes(app: FastifyInstance) {
  app.get('/api/handbooks', async (request) => {
    const query = z.object({ mine: z.enum(['1', 'true']).optional() }).partial().parse(request.query ?? {});
    // mine=1 — только справочники своего вуза: это нужно деканату, а не общей витрине
    const universityId = query.mine ? request.actor?.person?.universityId ?? null : null;
    const handbooks = await listHandbooks(pool, request.actor!.user.id, universityId);
    return { handbooks: request.actor!.viaReviewAuth ? handbooks.filter((handbook) => handbook.is_demo) : handbooks };
  });

  app.get('/api/handbook', async (request) => {
    const context = await ctx(request);
    const [base, role] = await Promise.all([home(pool, context), memberRole(pool, context.handbook.id, request.actor!.user)]);
    return {
      ...base,
      linked: Boolean(context.reader.person_id),
      editorRole: role,
    };
  });

  app.get('/api/handbook/sections', async (request) => ({ sections: await sectionsWithPages(pool, await ctx(request)) }));

  app.get('/api/handbook/pages/:id', async (request) => {
    const context = await ctx(request);
    const { id } = uuidParam.parse(request.params);
    const page = await getPage(pool, context, id);
    if (!page) throw notFound('Страница не найдена или ещё не опубликована');
    await markSearchOpened(pool, context, id).catch(() => undefined);
    return page;
  });

  app.get('/api/handbook/search', async (request) => {
    const context = await ctx(request);
    const { q } = z.object({ q: z.string().trim().min(1, 'Введите запрос').max(120) }).parse(request.query);
    const hits = await search(pool, context, q);
    await logSearch(pool, context, q, hits.length, 'app').catch(() => undefined);
    return { query: q, hits };
  });

  app.get('/api/handbook/deadlines', async (request) => ({ deadlines: await upcomingDeadlines(pool, await ctx(request)) }));

  app.patch('/api/handbook/profile', async (request) => {
    const context = await ctx(request);
    const body = z
      .object({
        course: z.number().int().min(1).max(6).nullable().optional(),
        dorm: z.boolean().nullable().optional(),
        program: z.string().trim().max(120).nullable().optional(),
        tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
        reminders: z.boolean().optional(),
      })
      .parse(request.body);
    return { reader: await updateProfile(pool, context.reader, body) };
  });

  app.patch('/api/handbook/pages/:id/progress', async (request) => {
    const context = await ctx(request);
    const { id } = uuidParam.parse(request.params);
    const body = z.object({ itemId: z.string().trim().min(1).max(40), done: z.boolean() }).parse(request.body);
    return setProgress(pool, context, id, body.itemId, body.done);
  });

  app.post('/api/handbook/pages/:id/feedback', async (request) => {
    const context = await ctx(request);
    const { id } = uuidParam.parse(request.params);
    const body = z.object({ helpful: z.boolean(), comment: z.string().trim().max(500).optional().nullable() }).parse(request.body);
    return setFeedback(pool, context, id, body.helpful, body.comment || null);
  });

  app.post('/api/handbook/questions', async (request) => {
    const context = await ctx(request);
    const body = z
      .object({ text: z.string().trim().min(5, 'Опишите вопрос подробнее').max(1000), query: z.string().trim().max(120).optional().nullable() })
      .parse(request.body);
    return askQuestion(pool, context, body.text, body.query || null);
  });

  app.get('/api/handbook/questions', async (request) => ({ questions: await myQuestions(pool, await ctx(request)) }));

  // Объявления: новые и архив (прочитанные или с истёкшим сроком)
  app.get('/api/handbook/announcements', async (request) => announcementsFeed(pool, await ctx(request)));

  app.post('/api/handbook/announcements/:id/read', async (request) => {
    const context = await ctx(request);
    const { id } = uuidParam.parse(request.params);
    return markAnnouncementRead(pool, context, id, true);
  });

  app.delete('/api/handbook/announcements/:id/read', async (request) => {
    const context = await ctx(request);
    const { id } = uuidParam.parse(request.params);
    return markAnnouncementRead(pool, context, id, false);
  });
}
