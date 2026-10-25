import { useEffect, useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { dateOnly, num, plural, todayIso } from '../../lib/format';
import { EmptyState, ErrorState, Pill, SectionTitle, Sheet, Skeletons } from '../../components/ui';
import { BrandMark, Icon } from '../../components/icons';
import { SECTION_ICONS, sectionIcon, sectionTone } from './HandbookContents';
import { SHARED_STATE } from './SharedCards';
import { StatusGuideSheet, notHelpfulPercent, ratingAttention, reviewDue } from './StatusGuide';

interface EditorPage {
  id: string;
  section_id: string;
  title: string;
  status: 'draft' | 'review' | 'published' | 'archived';
  updated_at: string;
  checked_at: string | null;
  review_at: string | null;
  has_draft: boolean;
  views: number;
  helpful: number;
  not_helpful: number;
  /** Оценки после последней публикации — по ним ставится отметка «не помогла». */
  recent_helpful?: number;
  recent_not_helpful?: number;
  owner_unit?: string | null;
  owner_name?: string | null;
  /** Своя версия общей страницы университета. */
  inherited_from?: string | null;
  /** Общую страницу обновили после того, как своя версия сверена с ней. */
  base_behind?: boolean;
  /** Общая страница только для выбранных факультетов. */
  scoped?: boolean;
}

interface SharedRow {
  id: string;
  sectionSlug: string;
  sectionTitle: string;
  sectionEmoji: string;
  sectionPosition: number;
  title: string;
  ownerUnit: string | null;
  reviewAt: string | null;
  overdue: boolean;
  relation: 'inherit' | 'supplement' | 'override';
  supplementDraft: boolean;
  /** Редактор отправил уточнение на публикацию. */
  supplementReview?: boolean;
  overridePageId: string | null;
  overrideStatus: string | null;
  overrideBehind: boolean;
}

interface Structure {
  handbook: { id: string; slug: string; title: string; emoji: string; isBase?: boolean; hasBase?: boolean };
  role: 'admin' | 'editor';
  sections: Array<{ id: string; slug: string; title: string; emoji: string; visible: boolean; pages: EditorPage[] }>;
  /** Общие страницы университета над справочником факультета. */
  shared?: SharedRow[];
  /** Для общей базы: кто показывает страницу. */
  usage?: Record<string, { faculties: number; supplements: number; overrides: number; behind: number }>;
}

export interface EditorAnnouncement {
  id: string;
  title: string;
  body: string;
  courses: number[];
  pageId: string | null;
  pageTitle: string | null;
  startsOn: string | null;
  endsOn: string | null;
  createdAt: string;
  updatedAt: string | null;
  reads: number;
  active: boolean;
}

/** Когда показывается объявление: «1 октября — 5 октября», «с 1 октября», «до 5 октября». */
function period(startsOn: string | null, endsOn: string | null): string {
  if (startsOn && endsOn) return startsOn === endsOn ? dateOnly(startsOn) : `${dateOnly(startsOn)} — ${dateOnly(endsOn)}`;
  if (startsOn) return `с ${dateOnly(startsOn)}`;
  if (endsOn) return `до ${dateOnly(endsOn)}`;
  return '';
}

const STATUS: Record<EditorPage['status'], { label: string; tone: 'ok' | 'warn' | 'accent' | 'neutral' }> = {
  draft: { label: 'Черновик', tone: 'neutral' },
  review: { label: 'На проверке', tone: 'warn' },
  published: { label: 'Опубликована', tone: 'ok' },
  archived: { label: 'В архиве', tone: 'neutral' },
};

type EditorTab = 'pages' | 'announcements';
type PageFilter = 'attention' | 'all' | 'review' | 'draft' | 'published' | 'archived' | 'shared' | 'overrides';
/** Оценки после последней публикации: исправленная и опубликованная страница теряет отметку «не помогла». */
const recent = (page: EditorPage) => ({ helpful: page.recent_helpful ?? page.helpful, notHelpful: page.recent_not_helpful ?? page.not_helpful });
const lowRated = (page: EditorPage) => ratingAttention(recent(page).helpful, recent(page).notHelpful);
const FILTERS: Array<[PageFilter, string]> = [['all', 'Все'], ['attention', 'Требует внимания'], ['review', 'На проверке'], ['draft', 'В работе'], ['published', 'Опубликованы'], ['archived', 'Архив']];
/** Общая база: фильтры по ответственности и тому, как страницу используют факультеты. */
const BASE_FILTERS: Array<[PageFilter, string]> = [['all', 'Все'], ['attention', 'Пора проверить'], ['review', 'На согласовании'], ['draft', 'В работе'], ['overrides', 'Есть свои версии'], ['archived', 'Архив']];
const facultiesWord = (n: number) => `${n} ${plural(n, 'факультет', 'факультета', 'факультетов')}`;
/**
 * Вкладка, фильтр и свёрнутые разделы по справочнику. Экран монтируется заново после «Назад»
 * со страницы или из аналитики — без этого возвращались «Все» и «Страницы», а прокрутка
 * восстанавливалась в чужом списке.
 */
const lastView = new Map<string, { tab: EditorTab; filter: PageFilter; collapsed: Set<string> }>();

export function HandbookEditor() {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad((signal) => api<Structure>(hb.url('/api/handbook-editor/structure'), { signal }), [hb.handbookId], `editor:${hb.handbookId}`);
  const saved = lastView.get(hb.handbookId);
  const [tab, setTab] = useState<EditorTab>(saved?.tab ?? 'pages');
  const [filter, setFilter] = useState<PageFilter>(saved?.filter ?? 'all');
  const [newPage, setNewPage] = useState<{ sectionId: string } | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [newSection, setNewSection] = useState(false);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(saved?.collapsed ?? new Set());
  useEffect(() => { lastView.set(hb.handbookId, { tab, filter, collapsed }); }, [hb.handbookId, tab, filter, collapsed]);
  const [sectionTitle, setSectionTitle] = useState('');
  const [sectionEmoji, setSectionEmoji] = useState('');
  const [sectionSummary, setSectionSummary] = useState('');
  const [sectionBusy, setSectionBusy] = useState(false);
  const [announcing, setAnnouncing] = useState<EditorAnnouncement | 'new' | null>(null);
  const [guide, setGuide] = useState(false);
  const [query, setQuery] = useState('');
  const announcements = useLoad(
    (signal) => data?.role === 'admin'
      ? api<{ announcements: EditorAnnouncement[] }>(hb.url('/api/handbook-editor/announcements'), { signal })
      : Promise.resolve({ announcements: [] as EditorAnnouncement[] }),
    [hb.handbookId, data?.role],
  );

  if (loading && !data) return <Skeletons count={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const create = async () => {
    if (!newPage || title.trim().length < 3) {
      hb.toast('Заголовок от 3 символов', 'error');
      return;
    }
    setBusy(true);
    try {
      const created = await api<{ id: string }>(hb.url('/api/handbook-editor/pages'), {
        method: 'POST', body: { sectionId: newPage.sectionId, title: title.trim(), blocks: [] },
      });
      setNewPage(null);
      setTitle('');
      hb.nav.push({ name: 'hb-editor-page', id: created.id });
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally { setBusy(false); }
  };
  const createNewSection = async () => {
    if (sectionTitle.trim().length < 2) return hb.toast('Название раздела от 2 символов', 'error');
    setSectionBusy(true);
    try {
      await api(hb.url(editingSection ? `/api/handbook-editor/sections/${editingSection}` : '/api/handbook-editor/sections'), {
        method: editingSection ? 'PATCH' : 'POST',
        body: { title: sectionTitle.trim(), emoji: sectionEmoji.trim() || undefined, summary: sectionSummary.trim() || undefined },
      });
      setNewSection(false);
      setSectionTitle('');
      setSectionEmoji('');
      setSectionSummary('');
      setFilter('all');
      reload();
      hb.toast(editingSection ? 'Раздел обновлён' : 'Раздел создан — добавьте в него первую страницу');
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setSectionBusy(false); }
  };
  const today = todayIso();
  const isAdmin = data.role === 'admin';
  const stale = (page: EditorPage) => reviewDue({ status: page.status, checkedAt: page.checked_at, reviewAt: page.review_at });
  // «На проверке» — задача администратора: у редактора это ожидание, а не проблема, которую он должен решить
  const waitsForMe = (page: EditorPage) => page.status === 'review' && isAdmin;
  // Отмечаем по доле жалоб, а сортируем по их числу: наверху — страница, которая подвела больше всего студентов
  // Правки опубликованной страницы, которые никто не опубликовал: студенты видят старую версию — это легко забыть
  const unpublished = (page: EditorPage) => page.status === 'published' && page.has_draft;
  const attention = (page: EditorPage) => page.status !== 'archived' && (lowRated(page) || stale(page) || waitsForMe(page) || unpublished(page));
  const priority = (page: EditorPage) => page.status === 'archived' ? -1 : lowRated(page) ? 4 + recent(page).notHelpful : waitsForMe(page) ? 3 : unpublished(page) || stale(page) ? 2 : page.status === 'draft' || page.status === 'review' ? 1 : 0;
  const reviewSupplements = !data.handbook.isBase ? (data.shared ?? []).filter((row) => row.supplementReview).length : 0;
  const pages = data.sections.flatMap((section) => section.pages);
  const isBase = Boolean(data.handbook.isBase);
  const usage = data.usage ?? {};
  const shared = data.shared ?? [];
  const filters = isBase ? BASE_FILTERS : data.handbook.hasBase ? [FILTERS[0]!, ['shared', 'Из общей базы'] as [PageFilter, string], ...FILTERS.slice(1)] : FILTERS;
  const needle = query.trim().toLowerCase();
  // Поиск по названиям — чтобы найти страницу для правки; читательский поиск — в «Просмотре»
  const activeFilter = needle ? 'all' : filters.some(([value]) => value === filter) ? filter : 'all';
  const found = (title: string) => !needle || title.toLowerCase().includes(needle);
  const inFilter = (page: EditorPage, value: PageFilter) => value === 'all' || (value === 'overrides' ? (usage[page.id]?.overrides ?? 0) > 0 : value === 'attention' ? attention(page) : value === 'draft'
    ? page.status !== 'archived' && (page.status === 'draft' || page.status === 'review' || page.has_draft)
    : page.status === value);
  const matches = (page: EditorPage) => found(page.title) && inFilter(page, activeFilter);
  // Сколько страниц в каждом фильтре — видно, куда смотреть, ещё до нажатия
  const filterCount = (value: PageFilter) => value === 'shared' ? shared.length : pages.filter((page) => inFilter(page, value)).length;
  const sections = activeFilter === 'shared' ? [] : data.sections.map((section) => ({ ...section, pages: section.pages.filter(matches).sort((a, b) => priority(b) - priority(a)) }))
    .filter((section) => (activeFilter === 'all' && !needle) || section.pages.length > 0)
    .sort((a, b) => Math.max(0, ...b.pages.map(priority)) - Math.max(0, ...a.pages.map(priority)));
  // «Вопросы» студентов — отдельная вкладка нижнего меню команды, здесь их не дублируем
  const tabs: Array<[EditorTab, string]> = [['pages', 'Страницы'], ...(data.role === 'admin' ? [['announcements', 'Объявления'] as [EditorTab, string]] : [])];
  // Запомненная вкладка «Объявления» после смены роли на редактора недоступна — показываем страницы
  const shown = tabs.some(([value]) => value === tab) ? tab : 'pages';

  return (
    <>
      <div className="hb-page__head hb-team-heading">
        <h1 className="hb-page__title">{isBase ? 'Общая база' : 'Редакция'}</h1>
        {/* У общей базы нет своих читателей: поиск и вопросы студентов — в справочниках факультетов */}
        {isBase ? null : <button type="button" className="hb-circle" aria-label="Аналитика" onClick={() => hb.nav.push({ name: 'hb-analytics' })}><Icon name="chart" /></button>}
      </div>
      <section className="card hb-editor-identity hb-editor-identity--compact">
        <span className="hb-book-logo" aria-hidden="true">{isBase ? <Icon name="layers" size={24} /> : <BrandMark size={26} />}</span>
        <h2>{isBase ? 'Единые инструкции вуза' : data.handbook.title}</h2>
        <span className="small muted">{isBase
          ? 'Студенты видят их внутри справочника своего факультета'
          : pages.some((page) => page.status === 'published') ? 'Есть опубликованные страницы' : 'Черновик справочника'}</span>
        <div className="hb-editor-actions">
          <button type="button" className="hb-chip" onClick={() => hb.nav.push({ name: 'hb-team' })}><Icon name="team" size={18} />{isBase ? 'Команда базы' : 'Команда'}</button>
          <button type="button" className="hb-chip" onClick={() => hb.nav.push({ name: 'hb-editor-deadlines' })}><Icon name="calendar" size={18} />Сроки для студентов</button>
        </div>
      </section>
      {tabs.length > 1 ? <div className="hb-editor-tabs" role="tablist" aria-label="Редактор">
        {tabs.map(([value, label], index) => (
          <button key={value} id={`editor-tab-${value}`} type="button" role="tab" aria-selected={shown === value}
            aria-controls={`editor-panel-${value}`} tabIndex={shown === value ? 0 : -1} onClick={() => setTab(value)}
            onKeyDown={(event) => {
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              setTab(tabs[next]![0]);
              document.getElementById(`editor-tab-${tabs[next]![0]}`)?.focus();
            }}>{label}</button>
        ))}
      </div> : null}
      <div role="tabpanel" id={`editor-panel-${shown}`} aria-labelledby={`editor-tab-${shown}`} className="stack--lg">
        {shown === 'pages' ? <>
          <label className="hb-editor-search">
            <Icon name="search" size={18} />
            <input className="hb-input" type="search" value={query} placeholder="Найти страницу по названию" aria-label="Найти страницу по названию" onChange={(event) => setQuery(event.target.value)} />
          </label>
          {needle ? null : <div className="hb-chips hb-editor-filters" role="group" aria-label="Статус страниц">
            {filters.map(([value, label]) => <button key={value} type="button" className={`hb-chip ${activeFilter === value ? 'hb-chip--on' : ''} ${value === 'attention' && filterCount(value) ? 'hb-chip--alert' : ''}`} aria-pressed={activeFilter === value} onClick={() => setFilter(value)}>{label}<span className="hb-chip__n">{filterCount(value)}</span></button>)}
          </div>}
          <button type="button" className="linkbtn small hb-guide-link" onClick={() => setGuide(true)}><Icon name="info" size={16} />Что значат статусы и как их снять</button>
          {needle && shared.some((row) => found(row.title)) ? <SharedList rows={shared.filter((row) => found(row.title))} isAdmin={isAdmin} onOpen={(row) => hb.nav.push(row.overridePageId ? { name: 'hb-editor-page', id: row.overridePageId } : { name: 'hb-shared-page', id: row.id })} /> : null}
          {activeFilter === 'shared' ? <SharedList rows={shared} isAdmin={isAdmin} onOpen={(row) => hb.nav.push(row.overridePageId ? { name: 'hb-editor-page', id: row.overridePageId } : { name: 'hb-shared-page', id: row.id })} /> : null}
          {activeFilter === 'all' && shared.length && !needle ? (
            <button type="button" className="card hb-row hb-shared-entry" onClick={() => setFilter('shared')}>
              <span className="hb-reader-round" aria-hidden="true"><Icon name="layers" /></span>
              <span className="stack hb-reader-grow" style={{ gap: 2 }}>
                <strong>Общие страницы университета · {shared.length}</strong>
                <span className="small muted">Студенты уже видят их. Добавьте уточнение, если на факультете что-то иначе{shared.some((row) => row.overrideBehind) ? ' · есть своя версия, которую нужно сверить' : ''}</span>
                {reviewSupplements ? <span className="hb-attention">{isAdmin
                  ? `${reviewSupplements} ${plural(reviewSupplements, 'уточнение ждёт', 'уточнения ждут', 'уточнений ждут')} вашей публикации`
                  : `${reviewSupplements} ${plural(reviewSupplements, 'уточнение ждёт', 'уточнения ждут', 'уточнений ждут')} публикации администратором`}</span> : null}
              </span>
              <Icon name="chevron" size={18} />
            </button>
          ) : null}
          {sections.length === 0 && activeFilter !== 'shared' && !(needle && shared.some((row) => found(row.title))) ? (needle
            ? <EmptyState icon="search" title="Таких страниц нет">Проверьте название или создайте страницу в нужном разделе.</EmptyState>
            : <EmptyState icon="file" title="Страниц с таким статусом нет">Выберите другой фильтр, чтобы увидеть страницы справочника.</EmptyState>) : null}
          {sections.map((section) => <section key={section.id} className={`card hb-editor-section ${sectionTone(section)}`}>
            <div className="hb-editor-section-head">
              <button type="button" className="hb-section-toggle" aria-expanded={!collapsed.has(section.id)} aria-controls={`editor-section-${section.id}`} onClick={() => setCollapsed((current) => { const next = new Set(current); next.has(section.id) ? next.delete(section.id) : next.add(section.id); return next; })}>
                <Icon name={sectionIcon(section)} /><strong>{section.title}</strong><span className="small muted">{section.pages.length}</span><Icon name="chevron-down" size={18} />
              </button>
              {data.role === 'admin' ? <button type="button" className="hb-circle" aria-label={`Настроить раздел «${section.title}»`} onClick={() => { setEditingSection(section.id); setSectionTitle(section.title); setSectionEmoji(section.emoji); setSectionSummary(''); setNewSection(true); }}><Icon name="settings" size={18} /></button> : null}
            </div>
            <div id={`editor-section-${section.id}`} hidden={collapsed.has(section.id)}>
              {section.pages.map((page) => <button key={page.id} type="button" className="hb-editor-page-row hb-row" aria-label={`${page.title} · ${STATUS[page.status].label}${unpublished(page) ? ' · правки не опубликованы' : ''}${attention(page) ? ' · Требует внимания' : ''}`} onClick={() => hb.nav.push({ name: 'hb-editor-page', id: page.id })}>
                <span className="hb-status-dot" data-status={attention(page) ? 'attention' : page.status} aria-hidden="true" />
                <span className="stack hb-reader-grow"><strong>{page.title}</strong>
                  {isBase
                    ? <span className="small muted">{page.owner_unit ?? 'Ответственный не указан'}{page.review_at && page.status === 'published' ? ` · проверка до ${dateOnly(page.review_at.slice(0, 10))}` : ''}</span>
                    : <span className="small muted">{num(page.views)} {plural(page.views, 'просмотр', 'просмотра', 'просмотров')}{page.helpful + page.not_helpful ? ` · помогла ${page.helpful} из ${page.helpful + page.not_helpful}` : ''}</span>}
                  {isBase && usage[page.id] && page.status !== 'archived' ? <span className="hb-tags">
                    <Pill tone="neutral">{page.scoped ? 'Только выбранные · ' : ''}видят {facultiesWord(usage[page.id]!.faculties)}</Pill>
                    {usage[page.id]!.supplements ? <Pill tone={SHARED_STATE.supplement.tone}>{SHARED_STATE.supplement.label}: {usage[page.id]!.supplements}</Pill> : null}
                    {usage[page.id]!.overrides - usage[page.id]!.behind > 0 ? <Pill tone={SHARED_STATE.override.tone}>{SHARED_STATE.override.label}: {usage[page.id]!.overrides - usage[page.id]!.behind}</Pill> : null}
                    {usage[page.id]!.behind ? <Pill tone={SHARED_STATE.behind.tone}>Нужно сверить: {usage[page.id]!.behind}</Pill> : null}
                  </span> : null}
                  {page.inherited_from ? <span className="hb-tags"><Pill tone={page.base_behind ? SHARED_STATE.behind.tone : SHARED_STATE.override.tone}>{page.base_behind ? SHARED_STATE.behind.label : 'Своя версия общей страницы'}</Pill></span> : null}
                  {unpublished(page) ? <span className="hb-unpublished"><Icon name="edit" size={14} />{isAdmin ? 'Правки не опубликованы — студенты видят старую версию' : 'Правки не отправлены — нажмите «На проверку»'}</span> : null}
                  {attention(page) && !(unpublished(page) && !lowRated(page) && !waitsForMe(page) && !stale(page))
                    ? <span className="hb-attention">{lowRated(page) ? `Требует внимания · не помогла ${notHelpfulPercent(recent(page).helpful, recent(page).notHelpful)}%` : waitsForMe(page) ? 'На проверке · ждёт вашей публикации' : isBase ? 'Пора проверить' : 'Пора перепроверить'}</span>
                    : page.status === 'review' ? <span className="small muted">На проверке · ждёт администратора</span>
                      : page.status !== 'published' ? <span className="small muted">{STATUS[page.status].label}</span> : null}
                </span><Icon name="chevron" size={18} />
              </button>)}
              <button type="button" className="hb-add" onClick={() => { setTitle(''); setNewPage({ sectionId: section.id }); }}><Icon name="plus" size={18} />Новая страница</button>
            </div>
          </section>)}
          {data.role === 'admin' ? <Button variant="secondary" size="large" onClick={() => { setEditingSection(null); setSectionTitle(''); setSectionEmoji('📚'); setSectionSummary(''); setNewSection(true); }}><Icon name="plus" /> Новый раздел</Button> : null}
        </> : data.role === 'admin' ? <>
          <Button variant="primary" size="large" onClick={() => setAnnouncing('new')}>Новое объявление</Button>
          {announcements.loading && !announcements.data ? <Skeletons count={2} /> : null}
          {announcements.error ? <ErrorState error={announcements.error} onRetry={announcements.reload} /> : null}
          {announcements.data?.announcements.length === 0 && !announcements.loading ? <EmptyState icon="megaphone" title="Объявлений пока нет">Сообщите студентам о важном событии или сроке.</EmptyState> : null}
          {announcements.data?.announcements.map((item) => {
            const planned = Boolean(item.active && item.startsOn && item.startsOn > today);
            const when = period(item.startsOn, item.endsOn);
            return <button key={item.id} type="button" className="card hb-row hb-editor-page-row" onClick={() => setAnnouncing(item)}>
              <span className="stack" style={{ gap: 6, textAlign: 'left', flex: 1 }}><strong>{item.title}</strong>
                <span className="faint small">{item.courses.length ? `${item.courses.join(', ')} курс` : 'Всем'} · прочитали {item.reads}{when ? ` · ${when}` : ''}{item.pageTitle ? ` · ${item.pageTitle}` : ''}</span>
                <span><Pill tone={item.active && !planned ? 'accent' : 'neutral'}>{planned ? 'Запланировано' : item.active ? 'Действует' : 'Завершено'}</Pill></span>
              </span><Icon name="edit" size={20} />
            </button>;
          })}
        </> : null}
      </div>
      {guide ? <StatusGuideSheet onClose={() => setGuide(false)} isBase={isBase} hasBase={Boolean(data.handbook.hasBase)} isAdmin={isAdmin} /> : null}
      {newPage ? <Sheet title="Новая страница" onClose={() => setNewPage(null)} dirty={title.trim().length > 0 && !busy}>
        <label className="hb-field"><span className="hb-field__label">Название страницы</span>
          <input className="hb-input" value={title} autoFocus maxLength={120} placeholder="Например: Где распечатать документы" onChange={(event) => setTitle(event.target.value)} />
          <span className="faint small">Пишите так, как студент спросил бы об этом.</span>
        </label>
        <Button variant="primary" size="large" loading={busy} disabled={busy || title.trim().length < 3} onClick={create}>Создать черновик</Button>
      </Sheet> : null}
      {newSection ? <Sheet title={editingSection ? 'Настроить раздел' : 'Новый раздел'} onClose={() => setNewSection(false)} dirty={!sectionBusy && (editingSection ? data.sections.some((section) => section.id === editingSection && (section.title !== sectionTitle || section.emoji !== sectionEmoji)) : Boolean(sectionTitle.trim() || sectionSummary.trim() || sectionEmoji !== '📚'))}>
        <label className="hb-field"><span className="hb-field__label">Название раздела</span>
          <input className="hb-input" value={sectionTitle} autoFocus maxLength={80} placeholder="Например: Практика и стажировки" onChange={(event) => setSectionTitle(event.target.value)} />
        </label>
        <div className="hb-field"><span className="hb-field__label" id="section-icon">Значок раздела</span>
          <div className="hb-icon-picker" role="radiogroup" aria-labelledby="section-icon">{SECTION_ICONS.map((item) => <button type="button" role="radio" key={item.value} aria-checked={sectionEmoji === item.value} aria-label={item.label} onClick={() => setSectionEmoji(item.value)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</div>
        </div>
        {!editingSection ? <label className="hb-field"><span className="hb-field__label">Краткое описание (необязательно)</span>
          <input className="hb-input" value={sectionSummary} maxLength={200} placeholder="Что студент найдёт в разделе" onChange={(event) => setSectionSummary(event.target.value)} />
        </label> : null}
        <Button variant="primary" size="large" loading={sectionBusy} disabled={sectionBusy || sectionTitle.trim().length < 2} onClick={createNewSection}>{editingSection ? 'Сохранить раздел' : 'Создать раздел'}</Button>
      </Sheet> : null}
      {announcing ? <AnnounceSheet initial={announcing === 'new' ? null : announcing}
        pages={data.sections.map((section) => ({ title: section.title, pages: section.pages.filter((page) => page.status === 'published').map((page) => ({ id: page.id, title: page.title })) }))}
        onClose={() => setAnnouncing(null)} onSaved={() => announcements.reload()} /> : null}
    </>
  );
}

/**
 * Объявление: появляется на главной справочника и приходит в чат тем, кого касается.
 * Адресность — по курсу; без выбора курса объявление видят все читатели.
 * Можно привязать страницу — карточка на главной и кнопка в чате поведут на неё.
 * Даты необязательны: с датой начала рассылка придёт в этот день в 10:00, после даты «до»
 * объявление уйдёт в архив само. Правка меняет текст у всех; повторно в чат объявление не рассылается.
 */
function AnnounceSheet({
  initial,
  pages,
  onClose,
  onSaved,
}: {
  initial: EditorAnnouncement | null;
  pages: Array<{ title: string; pages: Array<{ id: string; title: string }> }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const hb = useHandbook();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [courses, setCourses] = useState<number[]>(initial?.courses ?? []);
  const [pageId, setPageId] = useState<string>(initial?.pageId ?? '');
  const [startsOn, setStartsOn] = useState(initial?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(initial?.endsOn ?? '');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState<null | 'save' | 'delete'>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editing = initial !== null;
  const linkable = pages.filter((group) => group.pages.length > 0);
  // Страница, на которую ссылается объявление, могла уйти в архив — показываем её в списке, чтобы не потерять выбор
  const missingPage = initial?.pageId && !linkable.some((group) => group.pages.some((page) => page.id === initial.pageId));
  const today = todayIso();
  const datesWrong = Boolean(startsOn && endsOn && endsOn < startsOn);
  const titleLeft = 3 - title.trim().length;
  const bodyLeft = 5 - body.trim().length;
  const missing = [
    ...(titleLeft > 0 ? [title.trim() ? `допишите заголовок — ещё ${titleLeft} ${plural(titleLeft, 'символ', 'символа', 'символов')}` : 'напишите заголовок (от 3 символов)'] : []),
    ...(bodyLeft > 0 ? [body.trim() ? `допишите текст — ещё ${bodyLeft} ${plural(bodyLeft, 'символ', 'символа', 'символов')}` : 'напишите текст объявления (от 5 символов)'] : []),
    ...(datesWrong ? ['исправьте даты: «до» раньше «с»'] : []),
  ];
  // Дата «до» уже прошла: объявление сразу в архиве, а рассылка перед отправкой его пропустит
  const ended = Boolean(endsOn && endsOn < today);
  // Набранное не теряется от случайного касания подложки или системной «Назад»
  const snapshot = JSON.stringify([title.trim(), body.trim(), courses, pageId, startsOn, endsOn]);
  const [initialSnapshot] = useState(snapshot);
  const dirty = busy === null && snapshot !== initialSnapshot;

  const toggleCourse = (course: number) =>
    setCourses((current) => (current.includes(course) ? current.filter((c) => c !== course) : [...current, course].sort()));

  const save = async () => {
    setBusy('save');
    const payload = {
      title: title.trim(),
      body: body.trim(),
      audience: courses.length ? { courses } : undefined,
      pageId: pageId || null,
      startsOn: startsOn || null,
      endsOn: endsOn || null,
    };
    try {
      if (editing) {
        await api(hb.url(`/api/handbook-editor/announcements/${initial.id}`), { method: 'PATCH', body: payload });
        hb.toast('Объявление обновлено');
      } else {
        const result = await api<{ id: string; notified: number }>(hb.url('/api/handbook-editor/announcements'), {
          method: 'POST',
          body: { ...payload, notify },
        });
        const later = notify && startsOn && startsOn > today;
        const sent = result.notified;
        hb.toast(
          ended
            ? 'Объявление сохранено в архиве: дата «до» уже прошла'
            : later
              ? `Объявление запланировано: в чат уйдёт ${dateOnly(startsOn)} в 10:00`
              : notify && sent > 0
                ? `Объявление опубликовано и уйдёт в чат ${sent} ${plural(sent, 'читателю', 'читателям', 'читателям')}`
                : notify
                  ? 'Объявление опубликовано. В чат отправлять пока некому — нет читателей из этой аудитории'
                  : 'Объявление опубликовано',
        );
      }
      onSaved();
      onClose();
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy('delete');
    try {
      const result = await api<{ retracted?: number }>(hb.url(`/api/handbook-editor/announcements/${initial.id}`), { method: 'DELETE' });
      const n = result?.retracted ?? 0;
      hb.toast(n > 0 ? `Объявление удалено. Бот уберёт его и из чата у ${n} ${plural(n, 'читателя', 'читателей', 'читателей')}` : 'Объявление удалено');
      onSaved();
      onClose();
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const datesHint = datesWrong
    ? null
    : ended
      ? editing
        ? 'Дата «до» прошла — объявление в архиве, студенты его не видят.'
        : 'Дата «до» уже прошла — объявление сразу уйдёт в архив, в чат его не пришлют.'
    : startsOn && startsOn > today
      ? editing
        ? `На главной появится ${dateOnly(startsOn)}.`
        : notify
          ? `На главной появится ${dateOnly(startsOn)}, в чат придёт в этот день в 10:00.`
          : `На главной появится ${dateOnly(startsOn)}.`
      : endsOn
        ? `После ${dateOnly(endsOn)} объявление само уйдёт в архив.`
        : 'Без дат объявление висит на главной, пока его не удалят.';

  return (
    <Sheet title={editing ? 'Объявление' : 'Новое объявление'} onClose={onClose} dirty={dirty}>
      <label className="hb-field">
        <span className="hb-field__label">Заголовок</span>
        <input className="hb-input" value={title} autoFocus={!editing} maxLength={120} placeholder="Например: «Собрание первого курса»" onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="hb-field">
        <span className="hb-field__label">Текст объявления</span>
        <textarea className="hb-textarea" value={body} maxLength={1000} rows={4} placeholder="Что, где и когда" onChange={(event) => setBody(event.target.value)} />
      </label>
      <label className="hb-field">
        <span className="hb-field__label">Ссылка на страницу</span>
        <select className="hb-input hb-select" value={pageId} onChange={(event) => setPageId(event.target.value)}>
          <option value="">Без ссылки</option>
          {missingPage ? <option value={initial!.pageId!}>{initial!.pageTitle ?? 'Страница'} (не опубликована)</option> : null}
          {linkable.map((group) => (
            <optgroup key={group.title} label={group.title}>
              {group.pages.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="faint small">Карточка на главной и кнопка «Подробнее» в чате откроют эту страницу</span>
      </label>
      <div className="hb-field" role="group" aria-label="Когда показывать (необязательно)">
        <div className="hb-dates">
          <label className="hb-field">
            <span className="hb-field__label">Показывать с</span>
            <input className="hb-input" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
          </label>
          <label className="hb-field">
            <span className="hb-field__label">до</span>
            <input className="hb-input" type="date" value={endsOn} min={startsOn || undefined} onChange={(event) => setEndsOn(event.target.value)} />
          </label>
        </div>
        {datesWrong ? (
          <span className="small hb-error" role="alert">
            Дата «до» раньше даты «с» — так объявление никто не увидит
          </span>
        ) : (
          <span className="faint small">{datesHint}</span>
        )}
      </div>
      <div className="hb-field">
        <span className="hb-field__label">Кому</span>
        <div className="hb-chips" role="group" aria-label="Курсы">
          {[1, 2, 3, 4, 5, 6].map((course) => (
            <button key={course} type="button" aria-pressed={courses.includes(course)} className={`hb-chip ${courses.includes(course) ? 'hb-chip--on' : ''}`} onClick={() => toggleCourse(course)}>
              {course} курс
            </button>
          ))}
        </div>
        <span className="faint small">{courses.length ? 'Только выбранным курсам' : 'Всем читателям справочника'}</span>
      </div>
      {editing ? (
        <span className="faint small">
          Прочитали: {initial.reads}. Изменения увидят на главной; повторно в чат объявление не уйдёт. Если удалить объявление, бот уберёт его и из чатов.
        </span>
      ) : (
        <label className="hb-check hb-check--row">
          <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
          <span className="hb-check__box" aria-hidden="true" />
          <span>Прислать в чат с ботом</span>
        </label>
      )}
      <Button
        variant="primary"
        size="large"
        loading={busy === 'save'}
        disabled={missing.length > 0 || busy !== null}
        onClick={save}
      >
        {editing ? 'Сохранить' : 'Опубликовать'}
      </Button>
      {/* Серая кнопка без объяснения непонятна: говорим, чего не хватает, — как у публикации страницы */}
      {missing.length ? <span className="small hb-attention" role="status">{editing ? 'Чтобы сохранить' : 'Чтобы опубликовать'}: {missing.join('; ')}</span> : null}
      {editing ? (
        <Button variant={confirmDelete ? 'destructive' : 'secondary'} size="large" loading={busy === 'delete'} disabled={busy !== null} onClick={remove}>
          {confirmDelete ? 'Точно удалить? Нажмите ещё раз' : 'Удалить объявление'}
        </Button>
      ) : null}
    </Sheet>
  );
}

/** Общие страницы университета в разделах факультета: как они показаны студентам этого факультета. */
function SharedList({ rows, isAdmin, onOpen }: { rows: SharedRow[]; isAdmin: boolean; onOpen: (row: SharedRow) => void }) {
  if (!rows.length) return <EmptyState icon="layers" title="Общих страниц пока нет">Когда университет опубликует единые инструкции, они появятся здесь и у студентов.</EmptyState>;
  const groups = new Map<string, { title: string; position: number; rows: SharedRow[] }>();
  for (const row of rows) {
    const group = groups.get(row.sectionSlug) ?? { title: row.sectionTitle, position: row.sectionPosition, rows: [] };
    group.rows.push(row);
    groups.set(row.sectionSlug, group);
  }
  return <>
    <section className="card hb-shared-note" role="note">
      <span className="row" style={{ gap: 12 }}>
        <span className="hb-reader-round" aria-hidden="true"><Icon name="layers" /></span>
        <span className="small">Общие страницы ведёт университет: обновления приходят сами. Факультет может добавить уточнение или создать свою версию.</span>
      </span>
    </section>
    {[...groups.entries()].sort((a, b) => a[1].position - b[1].position).map(([slug, group]) => (
      <section key={slug} className="card hb-editor-section">
        <div className="hb-editor-section-head"><span className="hb-section-toggle" style={{ cursor: 'default' }}><Icon name="layers" /><strong>{group.title}</strong><span className="small muted">{group.rows.length} {plural(group.rows.length, 'общая', 'общие', 'общих')}</span></span></div>
        <div>
          {group.rows.map((row) => (
            <button key={row.id} type="button" className="hb-editor-page-row hb-row" onClick={() => onOpen(row)}
              aria-label={`${row.title} · ${row.relation === 'override' ? 'своя версия' : row.relation === 'supplement' ? 'с уточнением' : 'общая'}`}>
              {/* Красная точка — только то, что факультет может исправить сам: отставшая своя версия и уточнение на публикацию */}
              <span className="hb-status-dot" data-status={row.overrideBehind || (row.supplementReview && isAdmin) ? 'attention' : 'published'} aria-hidden="true" />
              <span className="stack hb-reader-grow"><strong>{row.title}</strong>
                <span className="small muted">Общая страница университета{row.ownerUnit ? ` · ${row.ownerUnit}` : ''}{row.overdue ? ' · университет не подтвердил актуальность' : ''}</span>
                {row.relation !== 'inherit' || row.supplementDraft || row.supplementReview ? <span className="hb-tags">
                  {row.relation === 'supplement' ? <Pill tone={SHARED_STATE.supplement.tone}>{SHARED_STATE.supplement.label}</Pill> : null}
                  {row.supplementReview ? <Pill tone="warn">{isAdmin ? 'Уточнение ждёт вашей публикации' : 'Уточнение ждёт публикации'}</Pill>
                    : row.supplementDraft ? <Pill tone="neutral">{row.relation === 'supplement' ? 'Есть неопубликованные правки' : 'Черновик уточнения'}</Pill> : null}
                  {row.relation === 'override' ? <Pill tone={row.overrideBehind ? SHARED_STATE.behind.tone : SHARED_STATE.override.tone}>{row.overrideBehind ? SHARED_STATE.behind.label : row.overrideStatus === 'draft' ? 'Своя версия · черновик' : SHARED_STATE.override.label}</Pill> : null}
                </span> : null}
              </span><Icon name="chevron" size={18} />
            </button>
          ))}
        </div>
      </section>
    ))}
  </>;
}
