/**
 * Черновики ввода, которые не должны пропадать от «Назад» (вопрос дежурному).
 * Хранятся в sessionStorage, а если он недоступен (приватный режим, WebView без хранилища) — в памяти:
 * тогда черновик живёт до закрытия приложения.
 */
const memory = new Map<string, string>();
const PREFIX = 'kursor:draft:';

export function readDraft(key: string): string {
  try {
    const stored = window.sessionStorage.getItem(PREFIX + key);
    if (stored !== null) return stored;
  } catch {
    /* хранилище недоступно */
  }
  return memory.get(key) ?? '';
}

export function writeDraft(key: string, value: string) {
  if (value) memory.set(key, value);
  else memory.delete(key);
  try {
    if (value) window.sessionStorage.setItem(PREFIX + key, value);
    else window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    /* хранилище недоступно — хватит памяти */
  }
}
