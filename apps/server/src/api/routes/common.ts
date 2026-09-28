import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { validateContact } from '../../auth/initData.js';
import { bindByPhone, bindInvite, personsForUser, setActivePerson } from '../../services/identity.js';
import { createDemoSandbox, getDemoRole, setDemoRole } from '../../services/demo.js';
import { contextFor, startRef } from '../../services/handbook.js';

export function registerCommonRoutes(app: FastifyInstance) {
  const rejectReviewBinding = (viaReviewAuth: boolean) => {
    if (viaReviewAuth) throw forbidden('Ключ проверки работает только с модельной демо-песочницей');
  };

  app.get('/api/me', async (request) => {
    const actor = request.actor!;
    const [persons, handbook, demoRole] = await Promise.all([
      personsForUser(pool, actor.user.id),
      // Справочник доступен и тем, кого нет в списках деканата, — это отдельный вход в платформу
      // Диплинк на справочник или страницу выбирает справочник, иначе — последний открытый
      contextFor(actor.user, startRef(actor.startParam)).catch(() => null),
      config.DEMO_ENABLED ? getDemoRole(pool, actor.user.id) : Promise.resolve(null),
    ]);
    return {
      user: { id: actor.user.max_user_id, firstName: actor.user.first_name, lastName: actor.user.last_name, photoUrl: actor.maxPhotoUrl },
      person: actor.person,
      persons,
      startParam: actor.startParam,
      demoEnabled: config.DEMO_ENABLED,
      /** Роль в демо-песочнице (студент, редактор, деканат) или null, если демо не открывали. */
      demo: demoRole ? { role: demoRole } : null,
      handbook: handbook
        ? { id: handbook.handbook.id, slug: handbook.handbook.slug, title: handbook.handbook.title, emoji: handbook.handbook.emoji }
        : null,
    };
  });

  app.post('/api/me/active-person', async (request) => {
    rejectReviewBinding(request.actor!.viaReviewAuth);
    const body = z.object({ personId: z.string().uuid() }).parse(request.body);
    await setActivePerson(pool, request.actor!.user.id, body.personId);
    return { ok: true };
  });

  app.post('/api/bind/invite', async (request) => {
    rejectReviewBinding(request.actor!.viaReviewAuth);
    const body = z.object({ code: z.string().min(4).max(40) }).parse(request.body);
    const person = await bindInvite(request.actor!.user, body.code);
    return { person };
  });

  app.post('/api/bind/phone', async (request) => {
    rejectReviewBinding(request.actor!.viaReviewAuth);
    const body = z.object({ phone: z.string().min(5), authDate: z.union([z.string(), z.number()]), hash: z.string().min(10) }).parse(request.body);
    const actor = request.actor!;
    if (!actor.viaDevAuth && !validateContact(body, actor.user.max_user_id, config.BOT_TOKEN)) {
      throw new AppError('contact_invalid', 'Не удалось подтвердить номер телефона', 400);
    }
    const persons = await bindByPhone(actor.user, body.phone);
    return { persons };
  });

  const demoRoleSchema = z.object({ role: z.enum(['student', 'editor', 'dean']).optional() });

  // Создать или пересоздать демо. Без роли — та же, что была (по умолчанию деканат)
  app.post('/api/demo', async (request) => {
    if (!config.DEMO_ENABLED) throw new AppError('demo_disabled', 'Демо-режим отключён', 403);
    const body = demoRoleSchema.parse(request.body ?? {});
    const role = body.role ?? (await getDemoRole(pool, request.actor!.user.id)) ?? 'dean';
    return createDemoSandbox(request.actor!.user, role);
  });

  // Сменить роль в демо, не теряя сделанного
  app.post('/api/demo/role', async (request) => {
    if (!config.DEMO_ENABLED) throw new AppError('demo_disabled', 'Демо-режим отключён', 403);
    const body = z.object({ role: demoRoleSchema.shape.role.unwrap() }).parse(request.body ?? {});
    return setDemoRole(request.actor!.user, body.role);
  });
}
