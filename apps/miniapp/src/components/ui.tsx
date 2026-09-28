import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Spinner } from '@maxhub/max-ui';
import { Icon, type IconName } from './icons';
import { isTopSheet, registerSheet, shieldTaps } from '../lib/sheets';

export function TopBar({ title, subtitle, after }: { title: ReactNode; subtitle?: ReactNode; after?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="topbar__title">
        <h1 className="topbar__h1">{title}</h1>
        {subtitle ? <span className="topbar__sub">{subtitle}</span> : null}
      </div>
      {after}
    </header>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="section-title">{children}</h2>;
}

type Tone = 'ok' | 'warn' | 'risk' | 'accent' | 'neutral';

export function Pill({ tone = 'neutral', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  return <span className={`pill ${tone === 'neutral' ? '' : `pill--${tone}`} ${plain ? 'pill--plain' : ''}`}>{children}</span>;
}

export function Skeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="stack--lg" aria-busy="true" aria-label="Загрузка">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  // Нет прав — не сбой: повтор не поможет, поэтому без кнопки и без «не удалось»
  const denied = (error as { status?: number }).status === 403;
  return (
    <div className="card state" role="alert">
      <span className="state__icon" aria-hidden="true">
        <Icon name={denied ? 'lock' : 'warn'} size={40} />
      </span>
      <span className="state__title">{denied ? 'Раздел для команды справочника' : 'Не удалось загрузить'}</span>
      <span className="muted">{error.message}</span>
      {onRetry && !denied ? (
        <Button variant="secondary" size="medium" onClick={onRetry}>
          Повторить
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="card state">
      <span className="state__icon" aria-hidden="true">
        <Icon name={icon} size={40} />
      </span>
      <span className="state__title">{title}</span>
      {children ? <span className="muted">{children}</span> : null}
    </div>
  );
}

export function BottomBar({ children }: { children: ReactNode }) {
  return (
    <div className="bottombar">
      <div className="bottombar__inner">{children}</div>
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab и Shift+Tab не уходят за лист — к кнопкам страницы под затемнением. */
function trapTab(event: KeyboardEvent, root: HTMLElement) {
  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (!root.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (active === first || active === root)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Лист (шторка) снизу. Закрывается кнопкой «Закрыть», тапом по затемнению, Escape и системной «Назад» MAX.
 * Лист с набранным текстом (dirty) перед закрытием спрашивает, не потерять ли введённое.
 */
export function Sheet({
  title,
  onClose,
  children,
  dirty = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** В листе есть несохранённый ввод: закрытие — только после подтверждения. */
  dirty?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const sheetId = useRef<number | null>(null);

  const requestClose = useCallback(() => {
    if (dirtyRef.current) setConfirming(true);
    else onCloseRef.current();
  }, []);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const openedAt = performance.now();
    const { id, unregister } = registerSheet(requestClose);
    sheetId.current = id;
    // Фокус — в лист, если его ещё не взяло поле с autoFocus
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
    return () => {
      unregister();
      // Повторный запуск эффекта в StrictMode — не закрытие листа
      if (performance.now() - openedAt > 50) shieldTaps();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [requestClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (sheetId.current === null || !isTopSheet(sheetId.current) || !ref.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
      } else if (event.key === 'Tab') {
        trapTab(event, ref.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  useEffect(() => {
    if (!confirming) return;
    ref.current?.scrollTo?.({ top: 0 });
    keepRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [confirming]);

  // Черновик очистили — вопрос о потере больше не нужен
  useEffect(() => {
    if (!dirty) setConfirming(false);
  }, [dirty]);

  return (
    <div className="sheet-backdrop" onClick={requestClose}>
      <div
        ref={ref}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="sheet__grip" aria-hidden="true" />
        <div className="sheet__head">
          <h2 className="sheet__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="sheet__close" aria-label="Закрыть" onClick={requestClose}>
            <Icon name="close" />
          </button>
        </div>
        {confirming ? (
          <div ref={keepRef} className="sheet__confirm" role="alert">
            <span style={{ fontWeight: 600 }}>Закрыть без сохранения?</span>
            <span className="small muted">То, что вы ввели, пропадёт.</span>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="secondary" size="medium" onClick={() => setConfirming(false)}>
                Продолжить
              </Button>
              <Button variant="destructive" size="medium" onClick={() => onCloseRef.current()}>
                Закрыть
              </Button>
            </div>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/**
 * Подтверждение внутри экрана: confirm() в клиенте MAX не работает.
 * Деструктивное действие — отдельной кнопкой, отмена рядом.
 */
export function ConfirmSheet({
  title,
  text,
  confirmLabel,
  busy = false,
  onConfirm,
  onClose,
}: {
  title: string;
  text: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={title} onClose={onClose}>
      <span className="muted">{text}</span>
      <Button variant="destructive" size="large" loading={busy} disabled={busy} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button variant="secondary" size="large" disabled={busy} onClick={onClose}>
        Отмена
      </Button>
    </Sheet>
  );
}

export function InlineSpinner() {
  return <Spinner size={20} />;
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="fact">
      <span className="fact__label">{label}</span>
      <span className="fact__value">{value}</span>
    </div>
  );
}

/** Текст только для экранного диктора: заголовок экрана, у которого нет видимого заголовка. */
export function VisuallyHidden({ as: Tag = 'span', children }: { as?: 'span' | 'h1' | 'h2'; children: ReactNode }) {
  return <Tag className="pd-visually-hidden">{children}</Tag>;
}
