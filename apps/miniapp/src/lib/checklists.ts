/**
 * Прогресс чек-листов, который читатель видел на страницах справочника.
 * Главная получает от сервера только незаконченные чек-листы, поэтому выполненный чек-лист
 * «обнулял» плитку раздела. Страница запоминает свой прогресс здесь, и плитка показывает «3 из 3».
 * Хранится в localStorage этого устройства (без него — в памяти до закрытия приложения).
 */
export interface ChecklistProgress {
  total: number;
  completed: number;
}

const PREFIX = 'kursor:checklists:';
const memory = new Map<string, Record<string, ChecklistProgress>>();

function load(handbookId: string): Record<string, ChecklistProgress> {
  const cached = memory.get(handbookId);
  if (cached) return cached;
  let value: Record<string, ChecklistProgress> = {};
  try {
    const raw = window.localStorage.getItem(PREFIX + handbookId);
    if (raw) value = JSON.parse(raw) as Record<string, ChecklistProgress>;
  } catch {
    /* хранилище недоступно или испорчено — начинаем с пустого */
  }
  memory.set(handbookId, value);
  return value;
}

/** Прогресс чек-листов страниц справочника: pageId → сколько пунктов и сколько отмечено. */
export function knownChecklists(handbookId: string): Record<string, ChecklistProgress> {
  return load(handbookId);
}

/** Запомнить прогресс страницы; null — на странице нет начатого чек-листа. */
export function rememberChecklist(handbookId: string, pageId: string, progress: ChecklistProgress | null) {
  const current = load(handbookId);
  const next = { ...current };
  if (progress && progress.total > 0 && progress.completed > 0) next[pageId] = progress;
  else delete next[pageId];
  memory.set(handbookId, next);
  try {
    window.localStorage.setItem(PREFIX + handbookId, JSON.stringify(next));
  } catch {
    /* хватит памяти */
  }
}
