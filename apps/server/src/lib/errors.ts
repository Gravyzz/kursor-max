import './zod-ru.js';
/** Ошибка предметной области с кодом, понятным клиенту. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Сообщение — готовая фраза для человека: «Страница не найдена», а не «Страница: не найдено». */
export const notFound = (message: string) => new AppError('not_found', message, 404);
export const forbidden = (message = 'Недостаточно прав для этого действия') => new AppError('forbidden', message, 403);

/**
 * Ошибки PostgreSQL, вызванные данными из запроса, а не сбоем сервера: недопустимые символы в тексте,
 * дата вне календаря PostgreSQL, неверный формат значения. Это 400 с понятным текстом, а не 500 (API-2).
 */
export function inputErrorFromDatabase(error: unknown): AppError | null {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== 'string' || !/^22[0-9A-Z]{3}$/.test(code)) return null;
  if (code === '22021' || code === '22P05') {
    return new AppError('validation_error', 'В тексте есть недопустимые символы — уберите их и попробуйте ещё раз', 400);
  }
  if (code === '22007' || code === '22008') return new AppError('validation_error', 'Проверьте дату: такой даты нет в календаре', 400);
  return new AppError('validation_error', 'Проверьте данные: одно из значений в неверном формате', 400);
}

/**
 * Ошибки разбора запроса (битый JSON, пустое тело, неподдерживаемый формат, слишком большой запрос)
 * отдаются по-русски и без внутренних подробностей (API-3).
 */
export function clientErrorFromRequest(status: number): AppError {
  if (status === 413) return new AppError('payload_too_large', 'Слишком большой запрос — сократите текст и попробуйте ещё раз', 413);
  if (status === 415) return new AppError('unsupported_media_type', 'Неподдерживаемый формат запроса — обновите приложение', 415);
  if (status === 404) return new AppError('not_found', 'Не найдено', 404);
  if (status === 405) return new AppError('method_not_allowed', 'Такой запрос не поддерживается', 405);
  if (status === 429) return new AppError('rate_limited', 'Слишком много запросов — подождите минуту', 429);
  return new AppError('bad_request', 'Не удалось прочитать данные запроса — обновите приложение и попробуйте ещё раз', status);
}
