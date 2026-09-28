/** Чистые проверки для входящих сообщений бота — без базы и сети, чтобы их можно было тестировать отдельно. */

/** Код приглашения в команду справочника: H-XXXX-XXXX, можно со ссылочным префиксом inv_. */
export const INVITE_RE = /^(?:inv_)?H-[A-Z2-9]{4}-[A-Z2-9]{4}$/i;

/**
 * Ограничение частоты для свободного текста: каждое сообщение — поиск и запись в журнал поиска,
 * флуд не должен засорять аналитику «что ищут студенты». 20 сообщений в минуту на пользователя.
 * 'ok' — отвечаем; 'warn' — один раз за окно предупреждаем; 'silent' — молчим, чтобы не отвечать спамом на спам.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const recent = new Map<number, number[]>();
const warnedAt = new Map<number, number>();
export function allowMessage(userId: number, now = Date.now()): 'ok' | 'warn' | 'silent' {
  if (recent.size > 5000) {
    recent.clear();
    warnedAt.clear();
  }
  const stamps = (recent.get(userId) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (stamps.length >= RATE_LIMIT) {
    recent.set(userId, stamps);
    const warned = warnedAt.get(userId);
    if (warned !== undefined && now - warned < RATE_WINDOW_MS) return 'silent';
    warnedAt.set(userId, now);
    return 'warn';
  }
  stamps.push(now);
  recent.set(userId, stamps);
  return 'ok';
}
