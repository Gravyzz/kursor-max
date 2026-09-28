import { useState, type ReactNode } from 'react';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { dateTime } from '../../lib/format';
import type { HandbookAnnouncement } from '../../lib/types';
import { EmptyState, ErrorState, Pill, Skeletons } from '../../components/ui';
import { Icon } from '../../components/icons';

/**
 * Карточка объявления. Если к объявлению привязана страница, карточка ведёт на неё;
 * действия («Прочитано», «Вернуть») — отдельной строкой, чтобы не нажать их случайно.
 */
export function AnnouncementCard({ item, onOpen, actions }: { item: HandbookAnnouncement; onOpen?: () => void; actions?: ReactNode }) {
  const content = (
    <>
      <span className="hb-block__icon" aria-hidden="true">
        <Icon name="megaphone" />
      </span>
      <span className="stack" style={{ gap: 4, flex: 1, textAlign: 'left' }}>
        <span style={{ fontWeight: 600 }}>{item.title}</span>
        <span className="small">{item.body}</span>
      </span>
      {onOpen ? <Icon name="chevron" /> : null}
    </>
  );
  return (
    <article className="card hb-announce">
      {onOpen ? (
        <button type="button" className="hb-announce__main" onClick={onOpen} aria-label={`${item.title}: открыть страницу`}>
          {content}
        </button>
      ) : (
        <div className="hb-announce__main">{content}</div>
      )}
      {actions ? <div className="hb-announce__foot">{actions}</div> : null}
    </article>
  );
}

interface Feed {
  active: HandbookAnnouncement[];
  archive: HandbookAnnouncement[];
}

/** Все объявления читателя: новые и архив — прочитанные им или с прошедшим сроком. */
export function HandbookAnnouncements({ initialTab = 'new' }: { initialTab?: 'new' | 'archive' }) {
  const hb = useHandbook();
  const { data, error, loading, reload, setData } = useLoad(
    (signal) => api<Feed>(hb.url('/api/handbook/announcements'), { signal }),
    [hb.handbookId],
    `announcements:${hb.handbookId}`,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState(initialTab);

  if (loading && !data) return <Skeletons count={3} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const setRead = async (item: HandbookAnnouncement, read: boolean) => {
    setBusy(item.id);
    try {
      await api(hb.url(`/api/handbook/announcements/${item.id}/read`), { method: read ? 'POST' : 'DELETE' });
      setData((current) => {
        if (!current) return current;
        const rest = { active: current.active.filter((a) => a.id !== item.id), archive: current.archive.filter((a) => a.id !== item.id) };
        const moved = { ...item, readAt: read ? new Date().toISOString() : null };
        return read || item.expired
          ? { ...rest, archive: [moved, ...rest.archive] }
          : { ...rest, active: [moved, ...rest.active] };
      });
      hb.toast(read ? 'Убрано в архив' : 'Вернули на главную');
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const open = (item: HandbookAnnouncement) => (item.pageId ? () => hb.nav.push({ name: 'hb-page', id: item.pageId! }) : undefined);

  return (
    <>
      <div className="hb-page__head">
        <h1 className="hb-page__title">Объявления</h1>
        <p className="hb-page__summary">Прочитанные уходят с главной сюда — их всегда можно вернуть.</p>
      </div>

      <div className="hb-reader-tabs" role="tablist" aria-label="Объявления" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'new' : event.key === 'End' ? 'archive' : tab === 'new' ? 'archive' : 'new';
        setTab(next);
        document.getElementById(`announcements-${next}`)?.focus();
      }}>
        <button type="button" role="tab" id="announcements-new" aria-selected={tab === 'new'} tabIndex={tab === 'new' ? 0 : -1} aria-controls="announcements-panel" onClick={() => setTab('new')}>Новые · {data.active.length}</button>
        <button type="button" role="tab" id="announcements-archive" aria-selected={tab === 'archive'} tabIndex={tab === 'archive' ? 0 : -1} aria-controls="announcements-panel" onClick={() => setTab('archive')}>Архив · {data.archive.length}</button>
      </div>
      <div id="announcements-panel" role="tabpanel" aria-labelledby={`announcements-${tab}`} className="stack">
        {(tab === 'new' ? data.active : data.archive).map((item) => <AnnouncementCard key={item.id} item={item} onOpen={open(item)} actions={<>
          <span className="faint small hb-reader-grow">{item.createdAt ? dateTime(item.createdAt) : ''}</span>
          {item.expired ? <Pill plain>срок прошёл</Pill> : <button type="button" className="linkbtn small" disabled={busy !== null} onClick={() => void setRead(item, tab === 'new')}>{tab === 'new' ? 'Прочитано ✓' : 'Вернуть на главную'}</button>}
        </>} />)}
        {tab === 'new' && !data.active.length ? <EmptyState icon="done" title="Всё прочитано">Новые объявления появятся на главной и придут в чат с ботом.</EmptyState> : null}
        {tab === 'archive' && !data.archive.length ? <EmptyState icon="megaphone" title="Архив пуст">Здесь будут прочитанные объявления и объявления с прошедшим сроком.</EmptyState> : null}
      </div>
    </>
  );
}
