import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '../../db/pool.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { uuidParam } from '../server.js';
import {
  addUniversityAdmin, adminInputSchema, createUniversity, listUniversities, requirePlatform, resendUniversityInvite, universityInputSchema,
} from '../../services/platform.js';

/** Кабинет платформы (команда Курсора): вузы и их администраторы. */
function platformActor(request: FastifyRequest) {
  if (!request.actor) throw new AppError('unauthorized', 'Нужен вход через MAX', 401);
  if (request.actor.viaReviewAuth) throw forbidden('Ключ проверки работает только с модельной демо-песочницей');
  requirePlatform(request.actor.user);
  return request.actor.user;
}

export function registerPlatformRoutes(app: FastifyInstance) {
  app.get('/api/platform', async (request) => {
    platformActor(request);
    return listUniversities(pool);
  });

  app.post('/api/platform/universities', async (request) => {
    const user = platformActor(request);
    return createUniversity(pool, user.id, universityInputSchema.parse(request.body));
  });

  app.post('/api/platform/universities/:id/admins', async (request) => {
    const user = platformActor(request);
    const { id } = uuidParam.parse(request.params);
    return addUniversityAdmin(pool, user.id, id, adminInputSchema.parse(request.body));
  });

  app.post('/api/platform/admins/:id/resend', async (request) => {
    const user = platformActor(request);
    const { id } = uuidParam.parse(request.params);
    return resendUniversityInvite(pool, user.id, id);
  });
}
