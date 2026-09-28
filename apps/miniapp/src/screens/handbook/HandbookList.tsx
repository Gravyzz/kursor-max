import { Button } from '@maxhub/max-ui';
import { Icon } from '../../components/icons';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import type { HandbookListItem } from '../../lib/types';
import { EmptyState, ErrorState, Pill, SectionTitle, Skeletons } from '../../components/ui';
import { useHandbook } from './context';

/** Витрина справочников: всё, что опубликовано вузами на платформе, плюс своё демо. */
export function HandbookPicker({
  currentId,
  onOpen,
  title,
  hideEmpty,
}: {
  currentId?: string;
  onOpen: (id: string) => void;
  /** Заголовок над списком; вместе с hideEmpty пустой список не занимает место. */
  title?: string;
  hideEmpty?: boolean;
}) {
  const { data, error, loading, reload } = useLoad((signal) => api<{ handbooks: HandbookListItem[] }>('/api/handbooks', { signal }), []);

  if (loading && !data) return <Skeletons count={2} />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const items = data?.handbooks ?? [];
  if (items.length === 0) {
    if (hideEmpty) return null;
    return (
      <EmptyState icon="books" title="Справочников пока нет">
        Попросите ссылку у деканата или студсовета своего факультета.
      </EmptyState>
    );
  }
  return (
    <div className="stack">
      {title ? <SectionTitle>{title}</SectionTitle> : null}
      {items.map((item) => (
        <button key={item.id} type="button" className="card hb-row hb-handbook-card" onClick={() => onOpen(item.id)} aria-current={item.id === currentId ? 'true' : undefined}>
          <span className="hb-book-logo" aria-hidden="true"><Icon name="book" size={26} /></span>
          <span className="stack" style={{ gap: 5, flex: 1, textAlign: 'left', minWidth: 0 }}>
            <span style={{ fontWeight: 600 }}>
              {item.title}
            </span>
            <span className="small muted">
              {[item.institute, item.university].filter(Boolean).join(' · ')}
              {item.is_demo ? ' · демо' : ''}
            </span>
            {item.id === currentId ? (
              <span style={{ marginTop: 4 }}>
                <Pill tone="accent">Сейчас открыт</Pill>
              </span>
            ) : null}
          </span>
          <Icon name="chevron" size={20} />
        </button>
      ))}
    </div>
  );
}

export function HandbookList() {
  const hb = useHandbook();
  return (
    <>
      <div className="hb-page__head">
        <h1 className="hb-page__title">Справочники</h1>
        <p className="hb-page__summary">Бот запомнит выбор: в следующий раз откроется последний справочник.</p>
      </div>
      <HandbookPicker currentId={hb.handbookId} onOpen={hb.openHandbook} />
      {hb.person && (hb.person.role === 'dean' || (hb.person.isDemo && hb.person.role === 'staff'))
        ? <Button variant="primary" size="large" onClick={() => hb.nav.push({ name: 'hb-create' })}>Новый справочник</Button>
        : null}
    </>
  );
}
