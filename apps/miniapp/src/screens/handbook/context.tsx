import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { bridge } from '../../lib/bridge';
import { closeTopSheet, sheetCount, subscribeSheets } from '../../lib/sheets';
import type { ShowToast } from '../../app/context';
import type { HandbookHome, Me, Person } from '../../lib/types';
import { api } from '../../lib/api';
import { useLoad, type LoadState } from '../../lib/useLoad';

/**
 * Навигация внутри справочника. Справочник открыт любому пользователю MAX:
 * запись в вузе (person) нужна только деканату и редакторам.
 */
export type HandbookRoute =
  | { name: 'hb-home' }
  | { name: 'hb-contents' }
  | { name: 'hb-deadlines' }
  | { name: 'hb-section'; slug: string }
  | { name: 'hb-page'; id: string }
  | { name: 'hb-search'; q: string }
  | { name: 'hb-profile' }
  | { name: 'hb-ask'; q?: string }
  | { name: 'hb-editor' }
  | { name: 'hb-editor-page'; id: string }
  | { name: 'hb-analytics' }
  | { name: 'hb-team' }
  | { name: 'hb-create' }
  | { name: 'hb-handbooks' }
  | { name: 'hb-announcements'; tab?: 'new' | 'archive' };

export interface HandbookNav {
  route: HandbookRoute;
  /** Экран, на который вернёт «Назад»: его название подписываем рядом со стрелкой. */
  previous: HandbookRoute | null;
  depth: number;
  push: (route: HandbookRoute) => void;
  pop: () => void;
  replace: (route: HandbookRoute) => void;
  reset: () => void;
  /** Переключить основной раздел без накопления истории нажатий на док. */
  tab: (route: HandbookRoute) => void;
}

export interface HandbookContextValue {
  handbookId: string;
  nav: HandbookNav;
  toast: ShowToast;
  /** Добавляет к пути параметр справочника: у пользователя их может быть несколько. */
  url: (path: string) => string;
  /** Активная запись в вузе: есть у деканата и приглашённых редакторов, у читателя — null. */
  person: Person | null;
  user: Me['user'];
  editorRole: HandbookHome['editorRole'];
  home: LoadState<HandbookHome>;
  /** Открыть другой справочник (из списка, после создания или по QR); start — параметр запуска внутри него. */
  openHandbook: (handbookId: string, start?: string) => void;
  /** Перечитать /api/me: после создания справочника, привязки или сброса демо. */
  refresh: () => Promise<void>;
}

const Ctx = createContext<HandbookContextValue | null>(null);

export function useHandbook(): HandbookContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('HandbookContext недоступен');
  return value;
}

export function HandbookProvider({
  handbookId,
  toast,
  person,
  user,
  openHandbook,
  refresh,
  initialRoutes,
  children,
}: {
  handbookId: string;
  toast: ShowToast;
  person: Person | null;
  user: Me['user'];
  openHandbook: (handbookId: string, start?: string) => void;
  refresh: () => Promise<void>;
  initialRoutes?: HandbookRoute[];
  children: ReactNode;
}) {
  const [stack, setStack] = useState<HandbookRoute[]>(() => initialRoutes?.[0]?.name === 'hb-editor' ? initialRoutes : [{ name: 'hb-home' }, ...(initialRoutes ?? [])]);

  // Позиция прокрутки каждого экрана в стеке: «Назад» возвращает туда, где человек остановился
  const scrolls = useRef<number[]>([]);
  const restoreTo = useRef<number | null>(null);
  const push = useCallback((route: HandbookRoute) => {
    bridge.haptic('tap');
    // Запоминаем прокрутку до перехода: функция-обновление выполнится уже после scrollTo(0)
    const y = window.scrollY;
    setStack((current) => {
      scrolls.current[current.length - 1] = y;
      return [...current, route];
    });
    window.scrollTo({ top: 0 });
  }, []);
  const pop = useCallback(
    () =>
      setStack((current) => {
        if (current.length <= 1) return current;
        restoreTo.current = scrolls.current[current.length - 2] ?? 0;
        return current.slice(0, -1);
      }),
    [],
  );
  useLayoutEffect(() => {
    if (restoreTo.current === null) return;
    const top = restoreTo.current;
    restoreTo.current = null;
    window.scrollTo({ top });
    // данные из кэша уже на экране; второй проход — на случай догрузки картинок и шрифтов
    requestAnimationFrame(() => window.scrollTo({ top }));
  }, [stack]);
  // Замена экрана (соседняя страница, уточнённый поиск) открывает новый экран сверху, а не там, где был прежний
  const replace = useCallback((route: HandbookRoute) => {
    setStack((current) => [...current.slice(0, -1), route]);
    window.scrollTo({ top: 0 });
  }, []);
  const tab = useCallback((route: HandbookRoute) => {
    bridge.haptic('tap');
    scrolls.current = [];
    restoreTo.current = 0;
    setStack([route]);
  }, []);
  const reset = useCallback(() => tab({ name: 'hb-home' }), [tab]);

  // Системная кнопка «Назад» клиента MAX: сначала закрывает открытый лист, потом уводит с экрана
  const sheets = useSyncExternalStore(subscribeSheets, sheetCount, sheetCount);
  const back = useCallback(() => {
    if (!closeTopSheet()) pop();
  }, [pop]);
  useEffect(() => bridge.backButton(stack.length > 1 || sheets > 0 ? back : null), [stack.length, sheets, back]);
  // Escape — «Назад» при проверке в браузере (открытый лист закрывается сам)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && stack.length > 1 && sheetCount() === 0 && !event.defaultPrevented) pop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stack.length, pop]);

  const url = useCallback(
    (path: string) => (handbookId ? `${path}${path.includes('?') ? '&' : '?'}handbookId=${encodeURIComponent(handbookId)}` : path),
    [handbookId],
  );
  // Права справочника приходят с сервера: роль в вузе сама по себе не даёт доступ к редактору.
  const access = useLoad((signal) => api<HandbookHome>(url('/api/handbook'), { signal }), [handbookId], `home:${handbookId}`);
  const editorRole = access.data?.editorRole ?? null;
  const routeName = stack[stack.length - 1]!.name;
  const previousRoute = useRef(routeName);
  useEffect(() => {
    if (routeName === 'hb-home' && previousRoute.current !== 'hb-home') access.reload();
    previousRoute.current = routeName;
  }, [routeName, access.reload]);
  const refreshAccess = useCallback(async () => {
    await refresh();
    access.reload();
  }, [refresh, access.reload]);

  const nav = useMemo<HandbookNav>(
    () => ({ route: stack[stack.length - 1]!, previous: stack.length > 1 ? stack[stack.length - 2]! : null, depth: stack.length, push, pop, replace, reset, tab }),
    [stack, push, pop, replace, reset, tab],
  );
  const value = useMemo<HandbookContextValue>(
    () => ({ handbookId, nav, toast, url, person, user, editorRole, home: access, openHandbook, refresh: refreshAccess }),
    [handbookId, nav, toast, url, person, user, editorRole, access, openHandbook, refreshAccess],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Действие справа в верхней панели вложенного экрана (например, «Поделиться» на странице).
 * Экран передаёт кнопку, панель рисует её в одной строке со стрелкой «Назад».
 */
const CrumbsCtx = createContext<(node: ReactNode) => void>(() => undefined);
export const CrumbsActionProvider = CrumbsCtx.Provider;
export function useCrumbsAction(node: ReactNode, deps: unknown[]) {
  const set = useContext(CrumbsCtx);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { set(node); return () => set(null); }, deps);
}
