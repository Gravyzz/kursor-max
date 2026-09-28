/**
 * Нулевой байт (\u0000) PostgreSQL не принимает ни в text, ни в jsonb: запрос с ним падал бы с 500 (API-2).
 * Человек его не вводит, поэтому во входе API (тело, query, параметры пути) и в тексте из чата его просто вырезаем.
 */
export function stripNul<T>(value: T): T {
  if (typeof value === 'string') return (value.includes('\u0000') ? value.replace(/\u0000/g, '') : value) as T;
  if (Array.isArray(value)) return value.map((item) => stripNul(item)) as T;
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    // Только обычные объекты из JSON и query (у разобранной строки запроса Node прототип — пустой объект без прототипа);
    // Buffer, Date и прочее не трогаем
    const plain = proto === null || proto === Object.prototype || Object.getPrototypeOf(proto) === null;
    if (!plain) return value;
    const result: Record<string, unknown> = proto === Object.prototype ? {} : Object.create(null);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__') continue;
      result[stripNul(key)] = stripNul(item);
    }
    return result as T;
  }
  return value;
}
