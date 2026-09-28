import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError, forbidden } from '../lib/errors.js';
import { validateInitData } from '../auth/initData.js';
import { validReviewKey } from '../auth/reviewKey.js';
import { resolvePerson, upsertUser, type PersonSummary, type UserRow } from '../services/identity.js';
import type { Role } from '../domain/types.js';

export interface Actor {
  user: UserRow;
  person: PersonSummary | null;
  startParam: string | null;
  viaDevAuth: boolean;
  viaReviewAuth: boolean;
  /** Фото берём только из подписанных данных запуска MAX; в БД его не копируем. */
  maxPhotoUrl: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

const header = (request: FastifyRequest, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export async function authenticate(request: FastifyRequest): Promise<Actor> {
  const initData = header(request, 'x-max-init-data');
  let maxUser: { id: number; first_name?: string; last_name?: string; username?: string; photo_url?: string } | null = null;
  let startParam: string | null = null;
  let viaDevAuth = false;
  let viaReviewAuth = false;

  if (initData) {
    const result = validateInitData(initData, config.BOT_TOKEN, config.INITDATA_MAX_AGE_SEC);
    if (!result.ok) {
      throw new AppError(
        'unauthorized',
        result.reason === 'expired' ? 'Сессия устарела — откройте приложение заново из чата с ботом' : 'Не удалось подтвердить вход через MAX',
        401,
        { reason: result.reason },
      );
    }
    maxUser = result.data.user;
    startParam = result.data.startParam;
  } else if (validReviewKey(header(request, 'x-review-key'), config.REVIEW_API_KEY)) {
    // Служебный вход для проверяющего работает только при явно заданном серверном ключе
    // и ведёт в отдельную модельную учётную запись, не связанную с пользователями MAX.
    maxUser = { id: config.REVIEW_USER_ID, first_name: 'Проверяющий', last_name: 'API' };
    viaReviewAuth = true;
  } else if (config.DEV_AUTH) {
    // Только для локальной разработки без клиента MAX (запрещено при NODE_ENV=production)
    const devUser = Number(header(request, 'x-dev-user'));
    if (Number.isSafeInteger(devUser) && devUser > 0) {
      maxUser = { id: devUser, first_name: decodeURIComponent(header(request, 'x-dev-name') ?? 'Локальный'), last_name: 'Тестов' };
      viaDevAuth = true;
    }
  }
  if (!maxUser) throw new AppError('unauthorized', 'Откройте справочник из чата с ботом в MAX', 401);

  const user = await upsertUser(pool, maxUser);
  const person = await resolvePerson(pool, user, header(request, 'x-person-id') ?? null);
  let maxPhotoUrl: string | null = null;
  if (maxUser.photo_url && maxUser.photo_url.length <= 2048) {
    try {
      const url = new URL(maxUser.photo_url);
      if (url.protocol === 'https:') maxPhotoUrl = url.toString();
    } catch { /* MAX не передал корректный URL фото */ }
  }
  return { user, person, startParam, viaDevAuth, viaReviewAuth, maxPhotoUrl };
}

export function requireRole(actor: Actor | undefined, role: Role): PersonSummary {
  if (!actor) throw new AppError('unauthorized', 'Нужен вход через MAX', 401);
  if (!actor.person) throw new AppError('not_connected', 'Аккаунт ещё не подключён к вузу: откройте ссылку-приглашение', 403);
  if (actor.person.role !== role) {
    const labels: Record<Role, string> = { student: 'студента', staff: 'сотрудника', dean: 'деканата' };
    throw forbidden(`Этот раздел доступен в роли ${labels[role]}`);
  }
  return actor.person;
}
