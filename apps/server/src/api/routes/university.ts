import type { FastifyInstance, FastifyRequest } from 'fastify';

import { pool } from '../../db/pool.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { uuidParam } from '../server.js';
import { createFaculty, facultyInputSchema, listFaculties, overview, requireUniversity, resendInvite } from '../../services/university.js';
import { closeFaculty, facultyCloseSchema, reopenFaculty } from '../../services/lifecycle.js';

/** Кабинет администратора университета: обзор, факультеты, приглашения. Общая база — через API редактора. */
async function uni(request: FastifyRequest) {
  if (!request.actor) throw new AppError('unauthorized', 'Нужен вход через MAX', 401);
  const scope = await requireUniversity(pool, request.actor.user, request.actor.person?.id ?? null);
  if (request.actor.viaReviewAuth && !scope.isDemo) throw forbidden('Ключ проверки работает только с собственной модельной демо-песочницей');
  return scope;
}

export function registerUniversityRoutes(app: FastifyInstance) {
  app.get('/api/university', async (request) => overview(pool, await uni(request)));

  app.get('/api/university/faculties', async (request) => listFaculties(pool, await uni(request)));

  app.post('/api/university/faculties', async (request) => {
    const scope = await uni(request);
    return createFaculty(pool, scope, facultyInputSchema.parse(request.body));
  });

  // Отключить факультет (подтверждение — название) и вернуть его в течение 90 дней
  app.post('/api/university/faculties/:id/close', async (request) => {
    const scope = await uni(request);
    const { id } = uuidParam.parse(request.params);
    return closeFaculty(pool, scope, id, facultyCloseSchema.parse(request.body ?? {}).confirm);
  });

  app.post('/api/university/faculties/:id/reopen', async (request) => {
    const scope = await uni(request);
    const { id } = uuidParam.parse(request.params);
    return reopenFaculty(pool, scope, id);
  });

  app.post('/api/university/invites/:id/resend', async (request) => {
    const scope = await uni(request);
    const { id } = uuidParam.parse(request.params);
    return resendInvite(pool, scope, id);
  });
}
