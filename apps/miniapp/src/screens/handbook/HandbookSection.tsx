import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import type { HandbookSection as SectionData } from '../../lib/types';
import { Icon } from '../../components/icons';
import { sectionIcon, sectionTone } from './HandbookContents';
import { plural } from '../../lib/format';
import { EmptyState, ErrorState, Skeletons } from '../../components/ui';

export function HandbookSection({ slug }: { slug: string }) {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad(
    (signal) => api<{ sections: SectionData[] }>(hb.url('/api/handbook/sections'), { signal }),
    [hb.handbookId],
    `sections:${hb.handbookId}`,
  );

  if (loading && !data) return <Skeletons count={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  const section = data?.sections.find((item) => item.slug === slug);
  if (!section) {
    return (
      <EmptyState icon="search" title="Раздел не найден">
        Возможно, он скрыт для вашего курса. Вернитесь на главную справочника.
      </EmptyState>
    );
  }

  return (
    <>
      <div className={`hb-page__head ${sectionTone(section)}`}>
        <h1 className="hb-page__title">
          <span className="hb-reader-round" aria-hidden="true"><Icon name={sectionIcon(section)} size={24} /></span> {section.title}
        </h1>
        <p className="hb-page__summary">{section.pages.length} {plural(section.pages.length, 'страница', 'страницы', 'страниц')} в разделе</p>
      </div>
      <div className="card hb-reader-page-list">
        {section.pages.map((page) => (
          <button key={page.id} type="button" className="hb-reader-listlink" onClick={() => hb.nav.push({ name: 'hb-page', id: page.id })}>
            <span className="stack" style={{ gap: 2, textAlign: 'left', flex: 1 }}>
              <span style={{ fontWeight: 600 }}>{page.title}</span>
              {page.snippet ? <span className="small muted">{page.snippet}</span> : null}
            </span>
            <Icon name="chevron" />
          </button>
        ))}
      </div>
    </>
  );
}
