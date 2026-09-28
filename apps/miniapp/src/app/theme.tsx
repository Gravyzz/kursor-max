import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { MaxUI } from '@maxhub/max-ui';
// Onest (SIL OFL 1.1) — шрифт интерфейса, едет в сборке, от сети не зависит.
import '@fontsource/onest/cyrillic-400.css';
import '@fontsource/onest/cyrillic-500.css';
import '@fontsource/onest/cyrillic-600.css';
import '@fontsource/onest/cyrillic-700.css';
import '@fontsource/onest/latin-400.css';
import '@fontsource/onest/latin-500.css';
import '@fontsource/onest/latin-600.css';
import '@fontsource/onest/latin-700.css';

/**
 * Оформление: системная тема по умолчанию, светлая и тёмная по выбору.
 * Выбор хранится на устройстве; если хранилище недоступно, работает светлая.
 */
export type ThemePref = 'dark' | 'light' | 'system';
export type ColorScheme = 'dark' | 'light';

const KEY = 'handbook:theme';

function readPref(): ThemePref {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'system' || value === 'dark' ? value : 'system';
  } catch {
    return 'light';
  }
}

function systemScheme(): ColorScheme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'light';
  }
}

interface ThemeValue {
  pref: ThemePref;
  scheme: ColorScheme;
  setPref: (pref: ThemePref) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeValue>({ pref: 'system', scheme: 'light', setPref: () => undefined, toggle: () => undefined });

export const useTheme = () => useContext(Ctx);

/** Корень мини-приложения: провайдер MAX UI в выбранной схеме и обёртка с токенами «Справочника». */
export function AppRoot({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [system, setSystem] = useState<ColorScheme>(systemScheme);

  useEffect(() => {
    if (pref !== 'system') return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(prefers-color-scheme: light)');
    } catch {
      return;
    }
    const onChange = () => setSystem(query.matches ? 'light' : 'dark');
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, [pref]);

  const scheme: ColorScheme = pref === 'system' ? system : pref;

  useEffect(() => {
    document.documentElement.dataset.theme = scheme;
    document.documentElement.style.colorScheme = scheme;
  }, [scheme]);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* без хранилища выбор живёт до закрытия */
    }
  }, []);
  const toggle = useCallback(() => setPref(scheme === 'dark' ? 'light' : 'dark'), [scheme, setPref]);

  const value = useMemo(() => ({ pref, scheme, setPref, toggle }), [pref, scheme, setPref, toggle]);
  return (
    <Ctx.Provider value={value}>
      <MaxUI colorScheme={scheme}>
        <div className="pd-app" data-theme={scheme}>
          {children}
        </div>
      </MaxUI>
    </Ctx.Provider>
  );
}
