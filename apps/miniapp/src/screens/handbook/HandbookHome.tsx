import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { bridge } from '../../lib/bridge';
import { plural } from '../../lib/format';
import { EmptyState, ErrorState, SectionTitle, Skeletons } from '../../components/ui';
import { deadlineWhen } from './Blocks';
import { DeadlineDate, capitalize, deadlineDate, deadlineTone } from './HandbookDeadlines';
import heroDay from '../../assets/campus/hero-day.webp';
import heroNight from '../../assets/campus/hero-night.webp';
import { AnnouncementCard } from './HandbookAnnouncements';
import { useTheme } from '../../app/theme';
import { Icon } from '../../components/icons';
import { SearchField } from './HandbookSearch';
import { sectionIcon, sectionProgress, sectionTone } from './HandbookContents';

/** Главная показывает реальные данные читателя; полный список разделов — в отдельном экране. */
export function HandbookHome() {
  const hb = useHandbook();
  const theme = useTheme();
  const { data, error, loading, reload, setData } = hb.home;
  const [query, setQuery] = useState('');
  const [reading, setReading] = useState<string[]>([]);
  if (loading && !data) return <Skeletons count={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const handbook = data.handbook;
  const name = hb.user.firstName || hb.person?.fullName.split(' ')[0];
  const initials = [hb.user.firstName, hb.user.lastName].filter(Boolean).map((part) => part![0]).join('') || hb.person?.fullName.split(' ').slice(0, 2).map((part) => part[0]).join('');
  const nearest = data.deadlines[0];
  const unfinished = data.checklists.filter((item) => item.completed > 0 && item.completed < item.total);
  const starting = data.checklists.filter((item) => item.completed === 0);
  const checklists = unfinished.length ? unfinished : starting.slice(0, 2);
  const share = async () => {
    if (bridge.share(`${handbook.title} — справочник факультета в MAX`, handbook.link)) return;
    try {
      if (!navigator.clipboard) return hb.toast(handbook.link);
      await navigator.clipboard.writeText(handbook.link);
      hb.toast('Ссылка на справочник скопирована');
    } catch { hb.toast(handbook.link); }
  };
  const markRead = async (id: string) => {
    if (reading.includes(id)) return;
    setReading((current) => [...current, id]);
    try {
      await api(hb.url(`/api/handbook/announcements/${id}/read`), { method: 'POST' });
      setData((current) => current ? { ...current, announcements: current.announcements.filter((item) => item.id !== id), archivedAnnouncements: current.archivedAnnouncements + 1 } : current);
      hb.toast('Убрано в архив объявлений');
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setReading((current) => current.filter((item) => item !== id)); }
  };

  return (
    <>
      <header className="hb-hero hb-reader-hero">
        <div className="hb-hero__top">
          <button type="button" className="hb-circle hb-reader-avatar" onClick={() => hb.nav.tab({ name: 'hb-profile' })} aria-label="О себе и настройки">
            {hb.user.photoUrl
              ? <img src={hb.user.photoUrl} alt="" referrerPolicy="no-referrer" />
              : initials || <Icon name="user" size={24} />}
          </button>
          <div className="row">
            <button type="button" className="hb-circle" onClick={() => void share()} aria-label="Поделиться справочником"><Icon name="share" /></button>
            <button type="button" className="hb-circle" onClick={() => hb.nav.push({ name: 'hb-deadlines' })} aria-label="Ближайшие сроки"><Icon name="bell" /></button>
          </div>
        </div>
        <div className="hb-cover" style={{ backgroundImage: `url(${theme.scheme === 'dark' ? heroNight : heroDay})` }} aria-hidden="true" />
        <div className="hb-hero__intro">
          <div className="hb-hero__text">
            {name ? <span className="hb-reader-greeting">Привет, {name}!</span> : null}
            <h1 className="hb-hero__title">{handbook.title}</h1>
            <span className="hb-hero__sub">{handbook.subtitle ?? 'Справочник факультета'}</span>
          </div>
        </div>
        <SearchField className="hb-hero__search" value={query} onChange={setQuery} onSubmit={(next) => hb.nav.push({ name: 'hb-search', q: next })} />
      </header>

      {nearest ? (() => {
        const tone = deadlineTone(nearest, data.today);
        return <button type="button" className={`hb-home-pill hb-reader-event hb-reader-event--${tone}`} onClick={() => hb.nav.push({ name: 'hb-deadlines' })}>
          <DeadlineDate date={deadlineDate(nearest, data.today)} tone={tone} />
          <span className="hb-home-pill__text"><small className={`hb-when hb-when--${tone}`}>{capitalize(deadlineWhen(nearest.startsOn, nearest.endsOn, data.today).text)}</small><strong>{nearest.title}</strong></span><Icon name="chevron" />
        </button>;
      })() : null}

      {data.announcements.length || data.archivedAnnouncements ? <section className="stack" aria-label="Объявления"><SectionTitle>Объявления</SectionTitle>
        {data.announcements.map((item) => <AnnouncementCard key={item.id} item={item} onOpen={item.pageId ? () => hb.nav.push({ name: 'hb-page', id: item.pageId! }) : undefined} actions={<button type="button" className="linkbtn small" disabled={reading.includes(item.id)} onClick={() => void markRead(item.id)}>Прочитано ✓</button>} />)}
        <button type="button" className="linkbtn hb-archive-link" onClick={() => hb.nav.push({ name: 'hb-announcements', tab: data.archivedAnnouncements ? 'archive' : 'new' })}>{data.archivedAnnouncements ? `Архив объявлений · ${data.archivedAnnouncements}` : 'Все объявления'} <Icon name="chevron" size={16} /></button>
      </section> : null}
      {checklists.length ? <section className="stack" aria-label="Незаконченные чек-листы"><SectionTitle>{unfinished.length ? 'Продолжить' : 'С чего начать'}</SectionTitle><div className="card hb-list">
        {checklists.map((item) => <button key={item.pageId} type="button" className="hb-list__row" onClick={() => hb.nav.push({ name: 'hb-page', id: item.pageId })}>
          {item.completed > 0 ? <span className="hb-ring" style={{ ['--p' as string]: String(Math.round(item.completed / item.total * 100)) }} aria-hidden="true"><span className="num">{item.completed}</span></span> : <span className="hb-reader-round" aria-hidden="true"><Icon name="checklist" /></span>}
          <span className="stack hb-reader-grow"><span className="hb-list__title">{item.title}</span><span className="small muted num">{item.completed > 0 ? `сделано ${item.completed} из ${item.total}` : `${item.total} шагов — начните с первого`}</span></span><Icon name="chevron" />
        </button>)}
      </div></section> : null}
      {data.sections.length ? (
        <section className="hb-grid hb-reader-console" aria-label="Разделы справочника">
          {data.sections.slice(0, 4).map((section) => {
            const progress = sectionProgress(data, section.pages.map((page) => page.id));
            return <button key={section.slug} type="button" className={`hb-home-tile ${sectionTone(section)}`} onClick={() => hb.nav.push({ name: 'hb-section', slug: section.slug })}>
              <span className="hb-home-tile__icon" aria-hidden="true"><Icon name={sectionIcon(section)} size={24} /></span>
              <span className="hb-home-tile__title">{section.title}</span>
              <span className="hb-home-tile__meta num">{progress && progress.completed > 0 ? `${progress.completed} из ${progress.total} пунктов` : `${section.pages.length} ${plural(section.pages.length, 'страница', 'страницы', 'страниц')}`}</span>
              {progress && progress.completed > 0 ? <span className="hb-home-tile__bar" aria-hidden="true"><i style={{ width: `${Math.round(progress.completed / progress.total * 100)}%` }} /></span> : null}
            </button>;
          })}
        </section>
      ) : <EmptyState icon="book" title="Справочник ещё наполняется">Редакторы факультета готовят страницы. Пока можно спросить дежурного.</EmptyState>}
      <Button variant="secondary" size="large" stretched onClick={() => hb.nav.tab({ name: 'hb-contents' })}>Все разделы</Button>

      <section className="card hb-reader-question">
        <div><strong>Не нашли ответ?</strong><p>Дежурный поможет разобраться.{data.myOpenQuestions ? ` Ваших вопросов без ответа: ${data.myOpenQuestions}.` : ''}</p></div>
        <Button size="medium" onClick={() => hb.nav.push({ name: 'hb-ask' })}>Задать вопрос</Button>
      </section>


      {!data.profile.filled && !hb.editorRole ? <button type="button" className="card hb-nudge" onClick={() => hb.nav.tab({ name: 'hb-profile' })}>
        <span className="hb-reader-round" aria-hidden="true"><Icon name="target" /></span>
        <span className="stack hb-reader-grow"><strong>Покажу только ваше</strong><span className="small muted">Укажите курс и общежитие — настроим страницы и напоминания.</span></span><Icon name="chevron" />
      </button> : null}
    </>
  );
}
