/**
 * Страница демо: слева чат с ботом, справа «телефон» с мини-приложением, на узком экране — вкладки.
 * Весь «сервер» — PostgreSQL, API, бот и воркер — работает здесь же, в браузере.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './host.css';
import { boot, restart, STAGES, type Stage } from './boot';
import { chat, flushNotifications, pressButton, sendText, startBot, type ChatMessage, type InlineButton } from './backend/chat';
import { handleApi } from './backend/router';
import { setLaunchParam } from './backend/auth';
import { renderMarkdown } from './markdown';

const SUGGESTIONS = ['как получить справку', 'физра отработки', 'хвосты', 'когда сессия', 'общага оплата', 'есть ли военная кафедра'];

// ─── мини-приложение во фрейме ─────────────────────────────────────────

let appAssets: { js: string; css: string } | null = null;
function miniappAssets() {
  if (!appAssets) {
    appAssets = {
      js: document.getElementById('app-js')?.textContent ?? '',
      css: document.getElementById('app-css')?.textContent ?? '',
    };
  }
  return appAssets;
}

interface HostBridge {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  openLink: (url: string) => void;
}

declare global {
  interface Window {
    __demoHost?: HostBridge;
  }
}

function lowerHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers || typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  return out;
}

function appDocument(startParam: string | null): string {
  const { js, css } = miniappAssets();
  const webApp = {
    initData: '',
    initDataUnsafe: { start_param: startParam ?? undefined, user: { id: 7700001, first_name: 'Гость' } },
    platform: 'web',
  };
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>${css}</style></head><body><div id="root"></div>
<script>
try{var t=localStorage.getItem('handbook:theme');document.documentElement.dataset.theme=t==='light'||(t==='system'&&matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark'}catch(e){}
window.WebApp = Object.assign(${JSON.stringify(webApp)}, {
  openLink: function (u) { parent.__demoHost.openLink(u); },
  openMaxLink: function (u) { parent.__demoHost.openLink(u); }
});
(function () {
  var original = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url.indexOf('/api/') === 0) return parent.__demoHost.fetch(url, init);
    return original(input, init);
  };
})();
</script>
<script>${js}</script></body></html>`;
}

// ─── чат ────────────────────────────────────────────────────────────────

function useChat() {
  useSyncExternalStore(chat.subscribe, chat.snapshot);
  return chat;
}

function Bubble({ message, onButton }: { message: ChatMessage; onButton: (button: InlineButton) => void }) {
  const html = useMemo(() => renderMarkdown(message.text), [message.text]);
  return (
    <div className={`msg msg--${message.from}`}>
      <div className="msg__bubble" dangerouslySetInnerHTML={{ __html: html }} />
      {message.buttons.length > 0 ? (
        <div className="msg__keyboard">
          {message.buttons.map((row, r) => (
            <div key={r} className="msg__row">
              {row.map((button, b) => (
                <button key={b} type="button" className={`kbtn kbtn--${button.type}`} onClick={() => onButton(button)}>
                  {button.text}
                  {button.type !== 'callback' ? <span className="kbtn__mark" aria-hidden="true">↗</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Chat({ onButton, disabled }: { onButton: (button: InlineButton) => void; disabled: boolean }) {
  const store = useChat();
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [store.messages.length, store.typing]);

  useEffect(() => {
    if (!store.notice) return;
    setNotice(store.notice.text);
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [store.notice]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    setText('');
    void sendText(value);
  };

  return (
    <section className="chat" aria-label="Чат с ботом">
      <header className="chat__head">
        <span className="chat__avatar" aria-hidden="true">К</span>
        <span className="chat__who">
          <strong>Курсор</strong>
          <span>{store.typing ? 'печатает…' : 'бот'}</span>
        </span>
      </header>
      {notice ? (
        <div className="chat__notice" role="status">
          {notice}
        </div>
      ) : null}
      <div className="chat__list" ref={listRef} aria-live="polite">
        {store.messages.map((message) => (
          <Bubble key={message.id} message={message} onButton={onButton} />
        ))}
        {store.typing ? (
          <div className="msg msg--bot">
            <div className="msg__bubble typing" aria-label="Бот печатает">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
      </div>
      <div className="chat__chips" aria-label="Что спросить">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion} type="button" className="chip" disabled={disabled} onClick={() => void sendText(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>
      <form className="chat__input" onSubmit={submit}>
        <input
          id="chat-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Спросите бота: «где взять справку»"
          autoComplete="off"
          enterKeyHint="send"
          disabled={disabled}
        />
        <button type="submit" className="send" aria-label="Отправить" disabled={disabled || !text.trim()}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M4 12l15-7-5 15-3-6z" fill="currentColor" />
          </svg>
        </button>
      </form>
    </section>
  );
}

// ─── загрузка ──────────────────────────────────────────────────────────

function Boot({ stage, error, onRetry }: { stage: Stage; error: string | null; onRetry: () => void }) {
  const current = STAGES.findIndex((item) => item.id === stage);
  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="boot__card">
        <p className="boot__eyebrow">Демо в браузере</p>
        <h1 className="boot__title">Курсор</h1>
        <p className="boot__lead">
          Конструктор справочников для факультетов в MAX: деканат собирает справочник из шаблона, команда ведёт его с телефона, студент спрашивает бота своими словами. Сервер, база данных и
          бот запускаются прямо здесь — тот же код, что в репозитории. Данные модельные.
        </p>
        <ol className="boot__steps">
          {STAGES.map((item, index) => {
            const state = error && index === current ? 'failed' : index < current || stage === 'ready' ? 'done' : index === current ? 'active' : 'wait';
            return (
              <li key={item.id} className={`step step--${state}`}>
                <span className="step__mark" aria-hidden="true" />
                {item.label}
              </li>
            );
          })}
        </ol>
        {error ? (
          <div className="boot__error">
            <p>{error}</p>
            <button type="button" className="btn" onClick={onRetry}>
              Попробовать ещё раз
            </button>
          </div>
        ) : (
          <p className="boot__hint">Первый запуск занимает 5–15 секунд.</p>
        )}
      </div>
    </div>
  );
}

// ─── страница ──────────────────────────────────────────────────────────

function Host() {
  const [stage, setStage] = useState<Stage>('engine');
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<{ param: string | null; n: number }>({ param: 'hb', n: 0 });
  const [tab, setTab] = useState<'chat' | 'app'>('chat');
  const [unread, setUnread] = useState(0);
  const [link, setLink] = useState<string | null>(null);
  const seen = useRef(0);
  const store = useChat();
  const ready = stage === 'ready';

  const start = useCallback(async (again: boolean) => {
    setError(null);
    try {
      await (again ? restart(setStage) : boot(setStage));
      setLaunch((current) => ({ param: 'hb', n: current.n + 1 }));
    } catch (err) {
      console.error(err);
      setError(`Не получилось запустить демо: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void start(false);
  }, [start]);

  // Мост для фрейма мини-приложения: запросы к API и ссылки наружу
  useEffect(() => {
    window.__demoHost = {
      fetch: async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        const body = typeof init?.body === 'string' ? init.body : null;
        const result = await handleApi(method, url, lowerHeaders(init?.headers), body);
        // Изменения (запись, ответ дежурного) порождают уведомления — отправляем их в чат сразу
        if (method !== 'GET') void flushNotifications();
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
      },
      openLink: (url) => setLink(url),
    };
  }, []);

  // Непрочитанные сообщения бота, пока открыто мини-приложение на телефоне
  useEffect(() => {
    const botCount = store.messages.filter((m) => m.from === 'bot').length;
    if (tab === 'chat') {
      seen.current = botCount;
      setUnread(0);
    } else {
      setUnread(Math.max(0, botCount - seen.current));
    }
  }, [store.messages, tab]);

  const openApp = useCallback((param: string | null) => {
    setLaunchParam(param);
    setLaunch((current) => ({ param, n: current.n + 1 }));
    setTab('app');
  }, []);

  const onButton = useCallback(
    (button: InlineButton) => {
      if (button.type === 'callback') {
        // Роль или сброс демо меняют то, что видно в мини-приложении, — перезапускаем его
        void pressButton(button.payload, button.text).then(() => {
          if (/^demo:(as:|reset)/.test(button.payload)) openApp('hb');
        });
        return;
      }
      if (button.type === 'open_app') {
        openApp(button.payload ?? null);
        return;
      }
      try {
        const url = new URL(button.url);
        if (url.searchParams.has('startapp')) return openApp(url.searchParams.get('startapp') || null);
        const startPayload = url.searchParams.get('start');
        if (startPayload) {
          void startBot(startPayload);
          return;
        }
      } catch {
        // не ссылка MAX
      }
      setLink(button.url);
    },
    [openApp],
  );

  const srcDoc = useMemo(() => (ready ? appDocument(launch.param) : ''), [ready, launch]);

  return (
    <div className="host" data-tab={tab}>
      <header className="top">
        <div className="top__brand">
          <span className="top__name">Курсор</span>
          <span className="top__sub">Конструктор справочников для факультетов · демо в браузере · роль меняется в чате · данные модельные</span>
        </div>
        <button type="button" className="btn btn--quiet" disabled={!ready} onClick={() => void start(true)}>
          Начать заново
        </button>
      </header>

      <nav className="tabs" aria-label="Экраны">
        <button type="button" className={`tab ${tab === 'chat' ? 'tab--on' : ''}`} aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>
          Чат с ботом
          {unread > 0 ? <span className="tab__badge">{unread}</span> : null}
        </button>
        <button type="button" className={`tab ${tab === 'app' ? 'tab--on' : ''}`} aria-pressed={tab === 'app'} onClick={() => setTab('app')}>
          Мини-приложение
        </button>
      </nav>

      <main className="stage">
        <div className="pane pane--chat">
          <Chat onButton={onButton} disabled={!ready} />
        </div>
        <div className="pane pane--app">
          <div className="phone">
            <div className="phone__bar">
              <span className="phone__title">Мини-приложение</span>
              <button type="button" className="phone__reload" disabled={!ready} onClick={() => openApp('hb')} title="Открыть главную справочника">
                Справочник
              </button>
              <button type="button" className="phone__reload" disabled={!ready} onClick={() => openApp('hbe')} title="Открыть редактор справочника">
                Редактор
              </button>
            </div>
            <div className="phone__screen">
              {ready ? <iframe key={launch.n} title="Мини-приложение" srcDoc={srcDoc} /> : <div className="phone__placeholder" />}
            </div>
          </div>
        </div>
      </main>

      {link ? (
        <div className="linknote" role="dialog" aria-label="Ссылка">
          <span>
            В MAX откроется: <code>{link}</code>
            <br />
            <span className="muted">В демо ссылки вымышленные.</span>
          </span>
          <button type="button" className="btn btn--quiet" onClick={() => setLink(null)}>
            Понятно
          </button>
        </div>
      ) : null}

      {!ready ? <Boot stage={stage} error={error} onRetry={() => void start(false)} /> : null}
    </div>
  );
}

createRoot(document.getElementById('host')!).render(<Host />);
