import { useEffect, useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { dateOnly, num, plural, todayIso } from '../../lib/format';
import { EmptyState, ErrorState, Pill, SectionTitle, Sheet, Skeletons } from '../../components/ui';
import { BrandMark, Icon } from '../../components/icons';
import { SECTION_ICONS, sectionIcon, sectionTone } from './HandbookContents';
import { QuestionsInbox } from './HandbookAnalytics';

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
}

interface Structure {
  handbook: { id: string; slug: string; title: string; emoji: string };
  role: 'admin' | 'editor';
  sections: Array<{ id: string; slug: string; title: string; emoji: string; visible: boolean; pages: EditorPage[] }>;
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

type EditorTab = 'pages' | 'questions' | 'announcements';
type PageFilter = 'attention' | 'all' | 'review' | 'draft' | 'published' | 'archived';
/** Доля «не помогла» среди оценок страницы. */
const notHelpfulShare = (page: EditorPage) => page.not_helpful / Math.max(1, page.helpful + page.not_helpful);
/**
 * Страница требует внимания по оценкам, только если это заметная доля, а не абсолютное число:
 * четверть оценок «не помогла» (от 5 оценок) или много жалоб при доле от 20 %.
 * Иначе метку получает почти каждая популярная страница, и она перестаёт что-то значить.
 */
export const lowRated = (page: Pick<EditorPage, 'helpful' | 'not_helpful'>) => {
  const votes = page.helpful + page.not_helpful;
  const share = page.not_helpful / Math.max(1, votes);
  return votes >= 5 && (share >= 0.25 || (page.not_helpful >= 10 && share >= 0.2));
};
const FILTERS: Array<[PageFilter, string]> = [['all', 'Все'], ['attention', 'Требует внимания'], ['review', 'На проверке'], ['draft', 'В работе'], ['published', 'Опубликованы'], ['archived', 'Архив']];
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
  const stale = (page: EditorPage) => page.status === 'published' && (!page.checked_at || Date.parse(page.checked_at) < Date.now() - 180 * 86_400_000 || Boolean(page.review_at && page.review_at.slice(0, 10) <= today));
  // Отмечаем по доле жалоб, а сортируем по их числу: наверху — страница, которая подвела больше всего студентов
  const attention = (page: EditorPage) => page.status !== 'archived' && (lowRated(page) || stale(page) || page.status === 'review');
  const priority = (page: EditorPage) => page.status === 'archived' ? -1 : lowRated(page) ? 4 + page.not_helpful : page.status === 'review' ? 3 : stale(page) ? 2 : page.status === 'draft' ? 1 : 0;
  const pages = data.sections.flatMap((section) => section.pages);
  const matches = (page: EditorPage) => filter === 'all' || (filter === 'attention' ? attention(page) : filter === 'draft'
    ? page.status !== 'archived' && (page.status === 'draft' || page.status === 'review' || page.has_draft)
    : page.status === filter);
  const sections = data.sections.map((section) => ({ ...section, pages: section.pages.filter(matches).sort((a, b) => priority(b) - priority(a)) }))
    .filter((section) => filter === 'all' || section.pages.length > 0)
    .sort((a, b) => Math.max(0, ...b.pages.map(priority)) - Math.max(0, ...a.pages.map(priority)));
  const tabs: Array<[EditorTab, string]> = [['pages', 'Страницы'], ['questions', 'Вопросы'], ...(data.role === 'admin' ? [['announcements', 'Объявления'] as [EditorTab, string]] : [])];
  // Запомненная вкладка «Объявления» после смены роли на редактора недоступна — показываем страницы
  const shown = tabs.some(([value]) => value === tab) ? tab : 'pages';

  return (
    <>
      <div className="hb-page__head hb-team-heading">
        <h1 className="hb-page__title">Редакция</h1>
        <button type="button" className="hb-circle" aria-label="Аналитика" onClick={() => hb.nav.push({ name: 'hb-analytics' })}><Icon name="chart" /></button>
      </div>
      <section className="card hb-editor-identity hb-editor-identity--compact">
        <span className="hb-book-logo" aria-hidden="true"><BrandMark size={26} /></span>
        <h2>{data.handbook.title}</h2>
        <span className="small muted">{pages.some((page) => page.status === 'published') ? 'Есть опубликованные страницы' : 'Черновик справочника'}</span>
        <div className="hb-editor-actions">
          <button type="button" className="hb-chip" onClick={() => hb.nav.push({ name: 'hb-home' })}><Icon name="book" size={18} />Предпросмотр</button>
          <button type="button" className="hb-chip" onClick={() => hb.nav.push({ name: 'hb-team' })}><Icon name="team" size={18} />Команда</button>
          <button type="button" className="hb-chip" onClick={() => hb.nav.push({ name: 'hb-handbooks' })}><Icon name="books" size={18} />Справочники</button>
        </div>
      </section>
      <div className="hb-editor-tabs" role="tablist" aria-label="Редактор">
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
      </div>
      <div role="tabpanel" id={`editor-panel-${shown}`} aria-labelledby={`editor-tab-${shown}`} className="stack--lg">
        {shown === 'pages' ? <>
          <div className="hb-chips hb-editor-filters" role="group" aria-label="Статус страниц">
            {FILTERS.map(([value, label]) => <button key={value} type="button" className={`hb-chip ${filter === value ? 'hb-chip--on' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
          </div>
          {sections.length === 0 ? <EmptyState icon="file" title="Страниц с таким статусом нет">Выберите другой фильтр, чтобы увидеть страницы справочника.</EmptyState> : null}
          {sections.map((section) => <section key={section.id} className={`card hb-editor-section ${sectionTone(section)}`}>
            <div className="hb-editor-section-head">
              <button type="button" className="hb-section-toggle" aria-expanded={!collapsed.has(section.id)} aria-controls={`editor-section-${section.id}`} onClick={() => setCollapsed((current) => { const next = new Set(current); next.has(section.id) ? next.delete(section.id) : next.add(section.id); return next; })}>
                <Icon name={sectionIcon(section)} /><strong>{section.title}</strong><span className="small muted">{section.pages.length}</span><Icon name="chevron-down" size={18} />
              </button>
              {data.role === 'admin' ? <button type="button" className="hb-circle" aria-label={`Настроить раздел «${section.title}»`} onClick={() => { setEditingSection(section.id); setSectionTitle(section.title); setSectionEmoji(section.emoji); setSectionSummary(''); setNewSection(true); }}><Icon name="settings" size={18} /></button> : null}
            </div>
            <div id={`editor-section-${section.id}`} hidden={collapsed.has(section.id)}>
              {section.pages.map((page) => <button key={page.id} type="button" className="hb-editor-page-row hb-row" aria-label={`${page.title} · ${STATUS[page.status].label}${attention(page) ? ' · Требует внимания' : ''}`} onClick={() => hb.nav.push({ name: 'hb-editor-page', id: page.id })}>
                <span className="hb-status-dot" data-status={attention(page) ? 'attention' : page.status} aria-hidden="true" />
                <span className="stack hb-reader-grow"><strong>{page.title}</strong>
                  <span className="small muted">{num(page.views)} {plural(page.views, 'просмотр', 'просмотра', 'просмотров')}{page.has_draft && page.status === 'published' ? ' · есть правки' : ''}{page.helpful + page.not_helpful ? ` · помогла ${page.helpful} из ${page.helpful + page.not_helpful}` : ''}</span>
                  {attention(page) ? <span className="hb-attention">{lowRated(page) ? `Требует внимания · не помогла ${Math.round(notHelpfulShare(page) * 100)}%` : page.status === 'review' ? 'На проверке' : 'Пора перепроверить'}</span> : page.status !== 'published' ? <span className="small muted">{STATUS[page.status].label}</span> : null}
                </span><Icon name="chevron" size={18} />
              </button>)}
              <button type="button" className="hb-add" onClick={() => { setTitle(''); setNewPage({ sectionId: section.id }); }}><Icon name="plus" size={18} />Новая страница</button>
            </div>
          </section>)}
          {data.role === 'admin' ? <Button variant="secondary" size="large" onClick={() => { setEditingSection(null); setSectionTitle(''); setSectionEmoji('📚'); setSectionSummary(''); setNewSection(true); }}><Icon name="plus" /> Новый раздел</Button> : null}
        </> : shown === 'questions' ? <QuestionsInbox onAnswered={reload} /> : data.role === 'admin' ? <>
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
      {newPage ? <Sheet title="Новая страница" onClose={() => setNewPage(null)} dirty={title.trim().length > 0 && !busy}>
        <label className="hb-field"><span className="hb-field__label">Название страницы</span>
          <input className="hb-input" value={title} autoFocus maxLength={120} placeholder="Например: «Где распечатать документы»" onChange={(event) => setTitle(event.target.value)} />
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
      await api(hb.url(`/api/handbook-editor/announcements/${initial.id}`), { method: 'DELETE' });
      hb.toast('Объявление удалено');
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
        <input className="hb-input" value={title} autoFocus={!editing} maxLength={120} placeholder="Заголовок: «Собрание первого курса»" onChange={(event) => setTitle(event.target.value)} />
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
          Прочитали: {initial.reads}. Изменения увидят на главной; повторно в чат объявление не уйдёт.
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
        disabled={title.trim().length < 3 || body.trim().length < 5 || datesWrong || busy !== null}
        onClick={save}
      >
        {editing ? 'Сохранить' : 'Опубликовать'}
      </Button>
      {editing ? (
        <Button variant={confirmDelete ? 'destructive' : 'secondary'} size="large" loading={busy === 'delete'} disabled={busy !== null} onClick={remove}>
          {confirmDelete ? 'Точно удалить? Нажмите ещё раз' : 'Удалить объявление'}
        </Button>
      ) : null}
    </Sheet>
  );
}
