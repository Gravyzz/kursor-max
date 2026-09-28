import { useEffect, useMemo, useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useCrumbsAction, useHandbook } from './context';
import { api, ApiError } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { dateOnly } from '../../lib/format';
import { bridge } from '../../lib/bridge';
import { rememberChecklist } from '../../lib/checklists';
import type { HandbookHome, HandbookPageView } from '../../lib/types';
import { EmptyState, ErrorState, SectionTitle, Skeletons } from '../../components/ui';
import { Icon } from '../../components/icons';
import { Blocks } from './Blocks';

export function HandbookPage({ id }: { id: string }) {
  const hb = useHandbook();
  const share = (view: HandbookPageView) => {
    if (bridge.share(`${view.page.title} — справочник факультета`, view.link)) return;
    if (!navigator.clipboard) return hb.toast(view.link);
    navigator.clipboard.writeText(view.link).then(
      () => hb.toast('Ссылка на страницу скопирована'),
      () => hb.toast(view.link),
    );
  };
  const { data, error, loading, reload, setData } = useLoad(
    (signal) => api<HandbookPageView>(hb.url(`/api/handbook/pages/${id}`), { signal }),
    [id, hb.handbookId],
    `page:${hb.handbookId}:${id}`,
  );
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [rating, setRating] = useState(false);

  // «Напомню заранее в чате» — только если напоминания включены в «О себе» (APP-17).
  // Профиль берём из ответа главной: из кэша, а если страницу открыли по ссылке — одним запросом.
  const hasDeadline = data?.page.blocks.some((block) => block.type === 'deadline') ?? false;
  const home = useLoad<HandbookHome | null>(
    (signal) => (hasDeadline ? api<HandbookHome>(hb.url('/api/handbook'), { signal }) : Promise.resolve(null)),
    [hasDeadline, hb.handbookId],
    hasDeadline ? `home:${hb.handbookId}` : undefined,
    { revalidate: false },
  );
  const reminders = data?.reminders ?? home.data?.profile.reminders ?? null;
  // «Поделиться» — в верхней панели рядом с «Назад», а не отдельной кнопкой в строке раздела
  useCrumbsAction(data ? <button type="button" className="hb-circle" onClick={() => share(data)} aria-label="Поделиться страницей"><Icon name="share" /></button> : null, [data?.link]);

  const done = useMemo(() => new Set(data?.progress ?? []), [data?.progress]);

  // Прогресс чек-листов страницы — для плитки раздела на главной, когда чек-лист уже выполнен (APP-24)
  useEffect(() => {
    if (!data) return;
    const items = data.page.blocks.flatMap((block) => (block.type === 'checklist' ? block.items : []));
    rememberChecklist(hb.handbookId, id, items.length ? { total: items.length, completed: items.filter((item) => done.has(item.id)).length } : null);
  }, [data, done, hb.handbookId, id]);

  if (loading && !data) return <Skeletons count={4} />;
  if (error && !data) {
    // Страницу убрали в архив или сняли с публикации — повтор не поможет
    if (error instanceof ApiError && error.status === 404) {
      return (
        <>
          <EmptyState icon="book" title="Страницу сняли с публикации">
            Её убрали в архив или готовят заново. Поищите ответ в справочнике или спросите дежурного.
          </EmptyState>
          <Button variant="secondary" size="large" onClick={() => hb.nav.reset()}>
            На главную справочника
          </Button>
        </>
      );
    }
    return <ErrorState error={error} onRetry={reload} />;
  }
  if (!data) return null;

  const { page } = data;

  const toggle = async (itemId: string, next: boolean) => {
    // Оптимистично: отметка должна ощущаться мгновенно
    setData((current) =>
      current
        ? { ...current, progress: next ? [...current.progress, itemId] : current.progress.filter((value) => value !== itemId) }
        : current,
    );
    try {
      await api(hb.url(`/api/handbook/pages/${id}/progress`), { method: 'PATCH', body: { itemId, done: next } });
    } catch (err) {
      setData((current) =>
        current
          ? { ...current, progress: next ? current.progress.filter((value) => value !== itemId) : [...current.progress, itemId] }
          : current,
      );
      hb.toast((err as Error).message, 'error');
    }
  };

  const rate = async (helpful: boolean) => {
    if (rating) return;
    const previous = data.myFeedback;
    setRating(true);
    setData((current) => (current ? { ...current, myFeedback: helpful } : current));
    setFeedbackSent(true);
    try {
      await api(hb.url(`/api/handbook/pages/${id}/feedback`), { method: 'POST', body: { helpful } });
      hb.toast(helpful ? 'Спасибо! Редакторы увидят оценку' : 'Спасибо, передам редакторам');
    } catch (err) {
      setData((current) => current ? { ...current, myFeedback: previous } : current);
      setFeedbackSent(false);
      hb.toast((err as Error).message, 'error');
    } finally { setRating(false); }
  };

  return (
    <>
      <div className="hb-page__head hb-reader-pagehead">
        <h1 className="hb-page__title">{page.title}</h1>
        {page.summary ? <p className="hb-page__summary">{page.summary}</p> : null}
        <div className="hb-page-meta">
          <button type="button" className="linkbtn small" onClick={() => hb.nav.push({ name: 'hb-section', slug: page.section.slug })}>{page.section.title}</button>
          {hb.editorRole ? <span className="hb-meta-preview" title="Предпросмотр со стороны студента" aria-label="Предпросмотр со стороны студента"><Icon name="book" size={16} /></span> : null}
          <span className="hb-reader-verified small"><Icon name="done" size={16} />Проверено {dateOnly(String(page.checkedAt ?? page.updatedAt).slice(0, 10))}{page.inherited ? ' · университет' : ''}</span>
        </div>
      </div>

      <article className="card hb-reading-sheet">
      <Blocks
        blocks={page.blocks}
        today={data.today}
        done={done}
        onToggle={toggle}
        reminders={reminders}
        onOpenProfile={() => hb.nav.push({ name: 'hb-profile' })}
      />
      </article>

      {/* Оценка и вопрос дежурному — одна карточка обратной связи: после «Не совсем» сразу предлагаем спросить */}
      <section className="card hb-rate" aria-label="Обратная связь">
        <strong>Страница помогла?</strong>
        <div className="hb-feedback-actions">
          <Button variant={data.myFeedback === true ? 'primary' : 'secondary'} size="medium" aria-pressed={data.myFeedback === true} disabled={rating} onClick={() => rate(true)}><Icon name="like" /> Да</Button>
          <Button variant={data.myFeedback === false ? 'primary' : 'secondary'} size="medium" aria-pressed={data.myFeedback === false} disabled={rating} onClick={() => rate(false)}><Icon name="dislike" /> Не совсем</Button>
        </div>
        {data.myFeedback !== null || feedbackSent ? <span className="small muted">{data.myFeedback ? 'Вы отметили страницу полезной.' : 'Вы отметили, что страница не помогла — редакторы это увидят.'}</span> : null}
        {data.myFeedback === false
          ? <Button variant="primary" size="medium" stretched onClick={() => hb.nav.push({ name: 'hb-ask' })}>Спросить дежурного</Button>
          : <div className="hb-rate__ask"><span className="small muted">Остались вопросы?</span><button type="button" className="linkbtn small" onClick={() => hb.nav.push({ name: 'hb-ask' })}>Спросить дежурного <Icon name="chevron" size={16} /></button></div>}
      </section>

      {data.siblings.length > 0 ? (
        <>
          <SectionTitle>Рядом в разделе</SectionTitle>
          <div className="card hb-list">
            {data.siblings.map((item) => (
              <button key={item.id} type="button" className="hb-list__row" onClick={() => hb.nav.replace({ name: 'hb-page', id: item.id })}>
                <span className="hb-list__title hb-reader-grow">{item.title}</span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
