import { timingSafeEqual } from 'node:crypto';

/**
 * Сравнение ключа проверки без раннего выхода по первому отличающемуся символу.
 * Пустой настроенный ключ означает, что служебный вход полностью выключен.
 */
export function validReviewKey(received: string | undefined, configured: string): boolean {
  if (!received || !configured) return false;
  const actual = Buffer.from(received, 'utf8');
  const expected = Buffer.from(configured, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
