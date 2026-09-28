import { useState } from 'react';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { knownChecklists } from '../../lib/checklists';
import { plural } from '../../lib/format';
import type { HandbookHome, HandbookSection } from '../../lib/types';
import { EmptyState, ErrorState, Skeletons } from '../../components/ui';
import { Icon, type IconName } from '../../components/icons';

export const SECTION_ICONS: Array<{ value: string; icon: IconName; label: string }> = [
  { value: '🎒', icon: 'cap', label: 'Первокурснику' },
  { value: '📚', icon: 'book', label: 'Учёба' },
  { value: '📄', icon: 'file', label: 'Документы' },
  { value: '🏃', icon: 'sport', label: 'Спорт' },
  { value: '🏠', icon: 'home', label: 'Общежитие' },
  { value: '💳', icon: 'wallet', label: 'Деньги' },
  { value: '🚀', icon: 'star', label: 'Возможности' },
  { value: '🆘', icon: 'help', label: 'Помощь' },
  { value: '👥', icon: 'team', label: 'Контакты' },
  { value: '📅', icon: 'calendar', label: 'Сроки' },
];
/** Значок хранится в существующем поле раздела; название на него не влияет. */
export function sectionIcon(section: { emoji?: string | null }): IconName {
  return SECTION_ICONS.find((item) => item.value === section.emoji)?.icon ?? 'book';
}
/** Цвет раздела идёт за значком, который выбирают в редакторе. Палитра декоративная, не статусная. */
export const sectionTone = (section: { emoji?: string | null }) => `hb-cat-${Math.max(0, SECTION_ICONS.findIndex((item) => item.value === section.emoji)) % 5}`;
/** Постоянный цвет аватара по имени: у участников команды разные цвета. */
export const avatarTone = (name: string) => `hb-cat-${Array.from(name).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 5}`;

/** Только известный личный прогресс — без придуманных пунктов из прототипа. */
export function sectionProgress(data: HandbookHome, pageIds: string[]) {
  const seen = knownChecklists(data.handbook.id);
  const server = data.checklists.filter((item) => pageIds.includes(item.pageId));
  const completed = pageIds.filter((id) => seen[id] && !server.some((item) => item.pageId === id)).map((id) => seen[id]!);
  const lists = [...server, ...completed];
  const total = lists.reduce((sum, item) => sum + item.total, 0);
  return total ? { total, completed: lists.reduce((sum, item) => sum + item.completed, 0) } : null;
}

export function HandbookContents() {
  const hb = useHandbook();
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, reload } = useLoad((signal) => api<HandbookHome>(hb.url('/api/handbook'), { signal }), [hb.handbookId], `home:${hb.handbookId}`);
  if (loading && !data) return <Skeletons count={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  return <>
    <header className="hb-page__head"><h1 className="hb-page__title">Разделы</h1><p className="hb-page__summary">Всё нужное об учёбе и жизни на факультете.</p></header>
    {data.sections.length ? <div className="stack">{data.sections.map((section) => {
      const expanded = open === section.slug;
      const progress = sectionProgress(data, section.pages.map((page) => page.id));
      return <article className={`card hb-course ${sectionTone(section)}`} key={section.slug}>
        <button type="button" className="hb-course__summary" aria-expanded={expanded} aria-controls={`section-${section.slug}`} onClick={() => setOpen(expanded ? null : section.slug)}>
          <span className="hb-reader-round" aria-hidden="true"><Icon name={sectionIcon(section)} size={24} /></span>
          <span className="hb-course__identity"><strong>{section.title}</strong><small>{section.pages.length} {plural(section.pages.length, 'страница', 'страницы', 'страниц')}{progress && progress.completed > 0 ? ` · ${progress.completed} из ${progress.total} пунктов` : ''}</small>{progress && progress.completed > 0 ? <span className="hb-progress" aria-hidden="true"><span style={{ width: `${Math.round(progress.completed / progress.total * 100)}%` }} /></span> : null}</span>
          <Icon name="chevron-down" />
        </button>
        <div id={`section-${section.slug}`} className="hb-course__details" hidden={!expanded}>
          {section.pages.length ? section.pages.map((page) => <button type="button" className="hb-reader-listlink" key={page.id} onClick={() => hb.nav.push({ name: 'hb-page', id: page.id })}><span className="stack hb-reader-grow"><strong>{page.title}</strong><small className="muted">{page.summary || page.snippet || 'Подробнее'}</small></span><Icon name="chevron" /></button>) : <p className="small muted">Страницы этого раздела ещё готовятся.</p>}
        </div>
      </article>;
    })}</div> : <EmptyState icon="book" title="Разделов пока нет">Они появятся после публикации страниц.</EmptyState>}
  </>;
}
