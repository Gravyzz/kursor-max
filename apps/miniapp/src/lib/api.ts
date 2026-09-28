import { bridge } from './bridge';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let activePersonId: string | null = null;
export const setActivePersonId = (id: string | null) => {
  activePersonId = id;
};

/**
 * Что делать, если выбранная роль исчезла (например, демо пересоздали в другом окне).
 * Приложение перезагружает данные, а не показывает ошибку.
 */
let onPersonGone: (() => void) | null = null;
export const setPersonGoneHandler = (handler: (() => void) | null) => {
  onPersonGone = handler;
};

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (bridge.initData) headers['x-max-init-data'] = bridge.initData;
  else if (bridge.devUser) headers['x-dev-user'] = bridge.devUser;
  if (activePersonId) headers['x-person-id'] = activePersonId;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('network', 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз', 0);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    if (error?.code === 'person_gone') {
      activePersonId = null;
      onPersonGone?.();
    }
    throw new ApiError(
      error?.code ?? 'http_error',
      error?.message ??
        (response.status >= 500
          ? 'Сервер не ответил. Попробуйте ещё раз через минуту'
          : 'Не получилось выполнить действие. Обновите экран и попробуйте ещё раз'),
      response.status,
    );
  }
  return data as T;
}
