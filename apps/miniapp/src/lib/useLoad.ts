import { useCallback, useEffect, useRef, useState } from 'react';

export interface LoadState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
  setData: (updater: (current: T | null) => T | null) => void;
}

/**
 * Последние ответы экранов. При возврате «Назад» экран сразу показывает то, что видел пользователь,
 * и тихо обновляется — без мигания скелетонов и прыжка прокрутки.
 */
const cache = new Map<string, unknown>();

/**
 * Загрузка данных экрана: состояние загрузки, ошибка и повтор без перезапуска приложения.
 * revalidate: false — если ответ уже в кэше, повторно не запрашивать (поиск: возврат «Назад»
 * не должен заново записывать запрос в журнал). «Повторить» (reload) запрашивает всегда.
 */
export function useLoad<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  cacheKey?: string,
  options: { revalidate?: boolean } = {},
): LoadState<T> {
  const [data, setDataState] = useState<T | null>(() => (cacheKey && cache.has(cacheKey) ? (cache.get(cacheKey) as T) : null));
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(() => !(options.revalidate === false && cacheKey && cache.has(cacheKey)));
  const [version, setVersion] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const revalidate = options.revalidate !== false;

  useEffect(() => {
    if (!revalidate && version === 0 && cacheKey && cache.has(cacheKey)) {
      setDataState(cache.get(cacheKey) as T);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loaderRef
      .current(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (cacheKey) cache.set(cacheKey, result);
        setDataState(result);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted && err.name !== 'AbortError') setError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const setData = useCallback(
    (updater: (current: T | null) => T | null) =>
      setDataState((current) => {
        const next = updater(current);
        if (cacheKey) cache.set(cacheKey, next);
        return next;
      }),
    [cacheKey],
  );
  return { data, error, loading, reload, setData };
}

/** Последний ответ экрана из кэша, если он есть (например, профиль читателя с главной). */
export function peekLoadCache<T>(cacheKey: string): T | null {
  return cache.has(cacheKey) ? (cache.get(cacheKey) as T) : null;
}

/** Сбросить кэш экранов: после сброса демо, смены справочника или записи вуза. */
export function clearLoadCache() {
  cache.clear();
}
