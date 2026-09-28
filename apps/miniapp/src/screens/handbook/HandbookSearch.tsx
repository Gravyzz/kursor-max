import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import type { HandbookHit } from '../../lib/types';
import { ErrorState, Skeletons } from '../../components/ui';
import { plural } from '../../lib/format';
import { Icon } from '../../components/icons';
import { bridge } from '../../lib/bridge';
import { handbookStartRoutes, resolveScanned } from './links';

/** Сервер принимает запрос до 120 символов: длиннее — «вопрос своими словами», его лучше задать дежурному. */
export const SEARCH_MAX = 120;

/** Запрос, который есть смысл искать: хотя бы две буквы или цифры, а не только знаки препинания. */
export const searchable = (value: string) => value.trim().length > 1 && /[\p{L}\p{N}]/u.test(value);

/** Счётчик символов появляется, когда до предела осталось немного. */
export function SearchCounter({ value }: { value: string }) {
  if (value.length < SEARCH_MAX - 20) return null;
  return (
    <span className="faint small num hb-search-count" aria-live="polite">
      {value.length}/{SEARCH_MAX}
      {value.length >= SEARCH_MAX ? ' — длиннее не поместится. Подробный вопрос задайте дежурному' : ''}
    </span>
  );
}

/**
 * Поле поиска — одно на главной и на экране «Поиск»: лупа слева, стрелка «Найти» справа.
 * Кнопка всегда активна: пустой запрос не отправляется, а возвращает фокус в поле, —
 * бледная «выключенная» кнопка выглядела сломанной.
 */
export function SearchField({ value, onChange, onSubmit, className = '' }: { value: string; onChange: (value: string) => void; onSubmit: (value: string) => void; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <form className={`hb-search ${className}`} role="search" onSubmit={(event) => {
      event.preventDefault();
      if (searchable(value)) onSubmit(value.trim());
      else input.current?.focus();
    }}>
      <span className="hb-search__icon" aria-hidden="true"><Icon name="search" /></span>
      <input ref={input} type="search" placeholder="Справка, физра, общежитие…" value={value} maxLength={SEARCH_MAX}
        onChange={(event) => onChange(event.target.value)} aria-label="Поиск по справочнику" enterKeyHint="search" />
      <button type="submit" className="hb-search__go" aria-label="Найти"><Icon name="arrow" /></button>
    </form>
  );
}

/**
 * Сканер QR-кода с плаката: камера MAX (на телефоне). Код справочника открывает нужную страницу,
 * в том числе в справочнике другого факультета; чужой код — понятная ошибка.
 */
export function ScanQrRow() {
  const hb = useHandbook();
  if (!bridge.canScan) return null;
  const scan = async () => {
    try {
      const value = await bridge.scanQr();
      if (!value) return;
      const target = await resolveScanned(value);
      if (!target) return hb.toast('Это не QR-код справочника', 'error');
      if (target.kind === 'route') return hb.nav.push(target.route);
      if (target.handbookId !== hb.handbookId) return hb.openHandbook(target.handbookId, target.start ?? undefined);
      const [route] = handbookStartRoutes(target.start);
      if (route) hb.nav.push(route);
    } catch (err) {
      const message = bridge.scanError(err);
      if (message) hb.toast(message, 'error');
    }
  };
  return (
    <section className="card hb-block hb-scan-card">
      <button type="button" className="hb-reader-listlink" onClick={() => void scan()}>
        <Icon name="scan" size={20} />
        <span className="hb-reader-grow">Сканировать QR-код</span>
        <Icon name="chevron" />
      </button>
    </section>
  );
}

/** Подсвечивает слова запроса в тексте результата: сразу видно, почему страница нашлась. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2).map((word) => word.slice(0, Math.max(3, word.length - 2)));
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[\\p{L}\\p{N}]*`, 'giu');
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<mark key={start} className="hb-mark">{match[0]}</mark>);
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/**
 * Поиск по справочнику. Запрос живёт в маршруте: «Назад» со страницы результата возвращает
 * к последнему запросу, а не к первому. Возврат показывает сохранённые результаты
 * и не записывает запрос в журнал поиска повторно.
 */
export function HandbookSearch({ q }: { q: string }) {
  const hb = useHandbook();
  const active = q.slice(0, SEARCH_MAX);
  const [query, setQuery] = useState(active);
  useEffect(() => setQuery(active), [active]);
  const valid = searchable(active);
  const recentKey = `handbook:search:${hb.user.id}:${hb.handbookId}`;
  const [recent, setRecent] = useState<string[]>(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem(recentKey) ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 5) : []; } catch { return []; }
  });
  const { data, error, loading, reload } = useLoad<{ query: string; hits: HandbookHit[] } | null>(
    (signal) => valid ? api<{ query: string; hits: HandbookHit[] }>(hb.url(`/api/handbook/search?q=${encodeURIComponent(active)}`), { signal }) : Promise.resolve(null),
    [active, hb.handbookId],
    valid ? `search:${hb.handbookId}:${active}` : undefined,
    { revalidate: false },
  );

  useEffect(() => {
    if (!valid || !data) return;
    setRecent((current) => {
      const next = [active, ...current.filter((item) => item !== active)].slice(0, 5);
      try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch { /* История работает и без хранилища. */ }
      return next;
    });
  }, [active, valid, data, recentKey]);

  // Новый запрос заменяет прежний в истории: «Назад» с найденной страницы вернёт сюда
  const submit = (next: string) => { if (next !== active) hb.nav.replace({ name: 'hb-search', q: next }); };

  return (
    <>
      <header className="hb-page__head"><h1 className="hb-page__title">Поиск</h1></header>
      <SearchField value={query} onChange={setQuery} onSubmit={submit} />
      <SearchCounter value={query} />
      {!valid ? <ScanQrRow /> : null}

      {!valid && recent.length ? <section className="card hb-block"><div className="row row--between"><h2 className="hb-block__title">Недавние запросы</h2><button type="button" className="linkbtn small" onClick={() => { setRecent([]); try { localStorage.removeItem(recentKey); } catch { /* Хранилище недоступно. */ } }}>Очистить</button></div><div className="hb-chips">{recent.map((item) => <button type="button" className="hb-chip" key={item} onClick={() => hb.nav.replace({ name: 'hb-search', q: item })}>{item}</button>)}</div></section> : null}

      {!valid && hb.home.data?.popular.length ? <section className="card hb-block"><h2 className="hb-block__title">{valid ? 'Ещё часто ищут' : 'Часто ищут'}</h2>{hb.home.data.popular.filter((item) => item !== active).length ? hb.home.data.popular.filter((item) => item !== active).map((item) => <button type="button" className="hb-reader-listlink" key={item} onClick={() => hb.nav.replace({ name: 'hb-search', q: item })}><Icon name="search" size={18} /><span className="hb-reader-grow">{item}</span><Icon name="chevron" /></button>) : <p className="small muted">Напишите хотя бы два символа, например «справка» или «физра».</p>}</section> : null}
      {!valid && hb.home.data?.sections.length ? <section className="card hb-block"><h2 className="hb-block__title">Полезные страницы</h2>{hb.home.data.sections.flatMap((section) => section.pages).slice(0, 4).map((page) => <button type="button" className="hb-reader-listlink" key={page.id} onClick={() => hb.nav.push({ name: 'hb-page', id: page.id })}><Icon name="file" size={18} /><span className="hb-reader-grow">{page.title}</span><Icon name="chevron" /></button>)}</section> : null}
      {valid && loading && !data ? <Skeletons count={3} /> : null}
      {loading && data ? <span className="faint small" role="status">Ищу…</span> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}

      {data && data.hits.length === 0 ? (
        <section className="card state">
          <span className="state__icon" aria-hidden="true">
            <Icon name="search" size={40} />
          </span>
          <span className="state__title">Ничего не нашлось</span>
          <span className="muted">Спросите дежурного — ответ придёт в чат.</span>
          <Button variant="primary" size="medium" onClick={() => hb.nav.push({ name: 'hb-ask', q: active })}>
            Спросить дежурного
          </Button>
        </section>
      ) : null}

      {data && data.hits.length > 0 && !data.hits[0]!.exact ? (
        <div className="hb-alert hb-alert--info" role="note">
          <span className="hb-block__icon" aria-hidden="true">
            <Icon name="info" />
          </span>
          <span>Точного совпадения нет — показываю похожее. Если это не то, спросите дежурного.</span>
        </div>
      ) : null}

      {valid && data && data.hits.length > 0 ? (
        <section className="card hb-reader-results">
          <div className="hb-reader-results__head"><h2 className="hb-results-title">{data.hits[0]?.exact ? 'Найдено' : 'Возможно, подойдёт'}</h2><span className="small muted">«{active}» · {data.hits.length} {plural(data.hits.length, 'страница', 'страницы', 'страниц')}</span></div>
          {data.hits.map((hit) => (
            <button key={hit.pageId} type="button" className="hb-reader-result" onClick={() => hb.nav.push({ name: 'hb-page', id: hit.pageId })}>
              <span className="stack" style={{ gap: 3, textAlign: 'left', flex: 1 }}>
                <span className="faint small">{hit.section}</span>
                <span style={{ fontWeight: 600 }}><Highlight text={hit.title} query={active} /></span>
                {hit.snippet ? <span className="small muted"><Highlight text={hit.snippet} query={active} /></span> : null}
              </span>
              <Icon name="chevron" />
            </button>
          ))}
        </section>
      ) : null}

      {data && data.hits.length > 0 && !data.hits[0]!.exact ? (
        <Button variant="secondary" size="medium" onClick={() => hb.nav.push({ name: 'hb-ask', q: active })}>
          Спросить дежурного
        </Button>
      ) : null}
      {(valid && data && data.hits.length > 0 && !loading) && hb.home.data?.popular.length ? <section className="card hb-block"><h2 className="hb-block__title">{valid ? 'Ещё часто ищут' : 'Часто ищут'}</h2>{hb.home.data.popular.filter((item) => item !== active).length ? hb.home.data.popular.filter((item) => item !== active).map((item) => <button type="button" className="hb-reader-listlink" key={item} onClick={() => hb.nav.replace({ name: 'hb-search', q: item })}><Icon name="search" size={18} /><span className="hb-reader-grow">{item}</span><Icon name="chevron" /></button>) : <p className="small muted">Напишите хотя бы два символа, например «справка» или «физра».</p>}</section> : null}
    </>
  );
}
