import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { dateOnly, plural } from '../../lib/format';
import { EmptyState, ErrorState, Pill, Sheet, Skeletons } from '../../components/ui';
import { Icon } from '../../components/icons';
import { DeadlineDate, deadlineTone } from './HandbookDeadlines';
import { deadlineWhen } from './Blocks';

interface TeamDeadline {
  id: string;
  pageId: string;
  pageTitle: string;
  title: string;
  startsOn: string;
  endsOn: string | null;
  remindDays: number[];
  shared: boolean;
}

interface DraftDeadline {
  pageId: string;
  pageTitle: string;
  blockId: string;
  title: string;
  startsOn: string | null;
}

interface PagesOnly {
  sections: Array<{ id: string; title: string; pages: Array<{ id: string; title: string; status: string }> }>;
}

const remindText = (days: number[]) => days.length
  ? `напомнит за ${[...days].sort((a, b) => b - a).map((d) => (d === 0 ? 'в день срока' : `${d} ${plural(d, 'день', 'дня', 'дней')}`)).join(' и ')}`
  : 'без напоминаний';

/**
 * Сроки для студентов глазами команды: какие даты студенты видят в «Ближайших сроках»,
 * о чём напомнит бот и какие сроки ещё лежат в черновиках. Срок — блок «Срок» на странице:
 * «Новый срок» выбирает страницу и открывает её с уже добавленным блоком.
 */
export function EditorDeadlines() {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad(
    (signal) => api<{ today: string; deadlines: TeamDeadline[]; drafts: DraftDeadline[] }>(hb.url('/api/handbook-editor/deadlines'), { signal }),
    [hb.handbookId],
  );
  const [picking, setPicking] = useState(false);
  if (loading && !data) return <Skeletons count={3} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  return <>
    <header className="hb-page__head">
      <h1 className="hb-page__title">Сроки для студентов</h1>
      <p className="hb-page__summary">Студенты видят их на главной и в «Ближайших сроках», а бот напоминает в чате. Срок живёт на странице справочника — там, где написано, что сделать.</p>
    </header>
    <Button variant="primary" size="large" onClick={() => setPicking(true)}><Icon name="plus" /> Новый срок</Button>

    {data.drafts.length ? <section className="stack" aria-labelledby="deadlines-drafts">
      <h2 className="section-title" id="deadlines-drafts">Ещё не видят студенты · {data.drafts.length}</h2>
      <span className="faint small">Срок в черновике: появится у студентов после публикации страницы.</span>
      {data.drafts.map((item) => <button key={`${item.pageId}:${item.blockId}`} type="button" className="card hb-reader-deadline" onClick={() => hb.nav.push({ name: 'hb-editor-page', id: item.pageId })}>
        {item.startsOn ? <DeadlineDate date={item.startsOn} tone="neutral" /> : <span className="hb-reader-round" aria-hidden="true"><Icon name="clock" /></span>}
        <span className="stack hb-reader-grow"><strong>{item.title || 'Срок без названия'}</strong>
          <span className="hb-unpublished"><Icon name="edit" size={14} />Не опубликован</span>
          <small className="muted">{item.pageTitle}</small></span><Icon name="chevron" />
      </button>)}
    </section> : null}

    <section className="stack" aria-labelledby="deadlines-live">
      <h2 className="section-title" id="deadlines-live">Видят студенты · {data.deadlines.length}</h2>
      {data.deadlines.length ? data.deadlines.map((item) => {
        const tone = deadlineTone(item, data.today);
        const when = deadlineWhen(item.startsOn, item.endsOn, data.today);
        return <button key={item.id} type="button" className="card hb-reader-deadline" onClick={() => hb.nav.push(item.shared ? { name: 'hb-shared-page', id: item.pageId } : { name: 'hb-editor-page', id: item.pageId })}>
          <DeadlineDate date={item.startsOn <= data.today && item.endsOn ? item.endsOn : item.startsOn} tone={tone} />
          <span className="stack hb-reader-grow"><strong>{item.title}</strong>
            <span className={`small hb-when hb-when--${tone}`}>{item.endsOn && item.endsOn !== item.startsOn ? `${dateOnly(item.startsOn)} — ${dateOnly(item.endsOn)}` : dateOnly(item.startsOn)} · {when.text}</span>
            <small className="muted">{item.pageTitle} · {remindText(item.remindDays)}</small>
            {item.shared ? <span className="hb-tags"><Pill tone="neutral">Общая страница университета</Pill></span> : null}
          </span><Icon name="chevron" />
        </button>;
      }) : <EmptyState icon="calendar" title="Сроков пока нет">Добавьте первый: например, «Заявление на место в общежитии до 30 октября».</EmptyState>}
    </section>

    <section className="card hb-block" role="note">
      <strong>Как это работает</strong>
      <ol className="hb-guide__steps small">
        <li>«Новый срок» → выберите страницу, где описано, что сделать (или создайте её в «Редакции»).</li>
        <li>На странице появится блок «Срок»: напишите, что сделать, поставьте дату и когда напомнить.</li>
        <li>{hb.editorRole === 'admin' ? 'Опубликуйте страницу' : 'Отправьте страницу на проверку — после публикации'} — срок увидят студенты, а бот напомнит тем, кого он касается.</li>
      </ol>
    </section>

    {picking ? <PickPageSheet onClose={() => setPicking(false)} onPick={(pageId) => { setPicking(false); hb.nav.push({ name: 'hb-editor-page', id: pageId, addBlock: 'deadline' }); }} /> : null}
  </>;
}

/** Выбор страницы для нового срока: страницы справочника по разделам, кроме архивных. */
function PickPageSheet({ onClose, onPick }: { onClose: () => void; onPick: (pageId: string) => void }) {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad((signal) => api<PagesOnly>(hb.url('/api/handbook-editor/structure'), { signal }), [hb.handbookId], `editor:${hb.handbookId}`);
  const [pageId, setPageId] = useState('');
  const groups = (data?.sections ?? []).map((section) => ({ ...section, pages: section.pages.filter((page) => page.status !== 'archived') })).filter((section) => section.pages.length);
  return <Sheet title="Новый срок" onClose={onClose}>
    {loading && !data ? <Skeletons count={2} /> : error && !data ? <ErrorState error={error} onRetry={reload} /> : groups.length ? <>
      <label className="hb-field"><span className="hb-field__label">На какой странице</span>
        <select className="hb-input hb-select" value={pageId} onChange={(event) => setPageId(event.target.value)}>
          <option value="">Выберите страницу</option>
          {groups.map((group) => <optgroup key={group.id} label={group.title}>
            {group.pages.map((page) => <option key={page.id} value={page.id}>{page.title}{page.status === 'draft' ? ' (черновик)' : ''}</option>)}
          </optgroup>)}
        </select>
        <span className="faint small">Срок лучше ставить там, где написано, что сделать: студент откроет срок и сразу увидит порядок действий.</span>
      </label>
      <Button variant="primary" size="large" disabled={!pageId} onClick={() => onPick(pageId)}>Добавить срок на страницу</Button>
      {!pageId ? <span className="faint small">Чтобы продолжить, выберите страницу.</span> : null}
    </> : <EmptyState icon="file" title="Страниц пока нет">Создайте страницу в «Редакции» — срок добавляется на страницу.</EmptyState>}
  </Sheet>;
}
