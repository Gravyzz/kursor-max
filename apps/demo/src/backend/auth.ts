/**
 * Замена api/auth.ts. В MAX вход подтверждается подписью initData; в демо посетитель
 * всегда один и тот же модельный пользователь, поэтому подпись не нужна.
 * Роль выбирается так же, как на сервере: заголовком x-person-id.
 */
import { pool } from './pool';
import { AppError, forbidden } from '../../../server/src/lib/errors';
import { resolvePerson, upsertUser, type PersonSummary, type UserRow } from '../../../server/src/services/identity';
import type { Role } from '../../../server/src/domain/types';

export interface Actor {
  user: UserRow;
  person: PersonSummary | null;
  startParam: string | null;
  viaDevAuth: boolean;
  maxPhotoUrl: string | null;
}

/** Пользователь MAX, от имени которого посетитель проходит демо. */
export const DEMO_MAX_USER = { id: 7_700_001, first_name: 'Гость', last_name: 'Демо' };

let launchParam: string | null = null;
/** Параметр запуска мини-приложения (startapp), как если бы его передала кнопка в чате MAX. */
export function setLaunchParam(value: string | null) {
  launchParam = value;
}

interface RequestLike {
  headers: Record<string, string | undefined>;
}

export async function authenticate(request: RequestLike): Promise<Actor> {
  const user = await upsertUser(pool, DEMO_MAX_USER);
  const person = await resolvePerson(pool, user, request.headers['x-person-id'] ?? null);
  return { user, person, startParam: launchParam, viaDevAuth: true, maxPhotoUrl: null };
}

export function requireRole(actor: Actor | undefined, role: Role): PersonSummary {
  if (!actor) throw new AppError('unauthorized', 'Нужен вход через MAX', 401);
  if (!actor.person) throw new AppError('not_connected', 'Аккаунт ещё не подключён к вузу: используйте приглашение', 403);
  if (actor.person.role !== role) {
    const labels: Record<Role, string> = { student: 'студента', staff: 'сотрудника', dean: 'деканата' };
    throw forbidden(`Этот раздел доступен в роли ${labels[role]}`);
  }
  return actor.person;
}
