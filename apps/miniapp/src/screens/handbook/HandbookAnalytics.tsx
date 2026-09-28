import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { num, plural, relativeDateTime } from '../../lib/format';
import { EmptyState, ErrorState, Fact, SectionTitle, Sheet, Skeletons } from '../../components/ui';
import { Icon } from '../../components/icons';

interface Analytics {
  totals: { readers: number; views: number; published: number; drafts: number };
  gaps: Array<{ query: string; n: number; last_at: string }>;
  top: Array<{ query: string; n: number }>;
  stale: Array<{ id: string; title: string; checked_at: string | null; review_at: string | null }>;
  questions: Question[];
  weak: Array<{ id: string; title: string; helpful: number; not_helpful: number }>;
  pilot: PilotMetrics;
}

interface Question {
  id: string;
  text: string;
  created_at: string;
  query: string | null;
  /** Страница, с которой пришёл вопрос, если сервер её знает. */
  pageId?: string | null;
  pageTitle?: string | null;
}

/** Структура справочника из редактора: из неё выбираем страницу для «Вопросов и ответов». */
interface EditorStructure {
  role: 'admin' | 'editor';
  sections: Array<{ id: string; title: string; emoji: string; pages: Array<{ id: string; title: string; status: string }> }>;
}

interface PilotMetrics {
  searches: number;
  found: number;
  helpful: number;
  notHelpful: number;
  answered: number;
  medianAnswerMinutes: number | null;
  published: number;
  fresh: number;
  activeReaders: number;
}

const percent = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : null);

function duration(minutes: number) {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

/**
 * Метрика пилота: значение, цель и честная отметка «достигнута / ниже цели».
 * Статус — значком и словами, не только цветом.
 */
function PilotTile({ label, value, met, target, detail, progress }: { label: string; value: string | null; met: boolean | null; target: string; detail: string; progress?: number | null }) {
  // Цвет кольца — статус: достигнута цель или нет. Для времени кольца нет: «5 ч» — не доля от целого
  const status = met === null ? '' : met ? 'hb-metric--ok' : 'hb-metric--warn';
  return (
    <div className={`hb-metric ${status}`}>
      {progress === undefined ? (
        <span className="hb-metric-plain"><span className="hb-metric__value num">{value ?? '—'}</span></span>
      ) : (
        <span className="hb-metric-ring">
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle className="hb-metric-ring__track" cx="50" cy="50" r="43" /><circle className="hb-metric-ring__fill" cx="50" cy="50" r="43" pathLength="100" opacity={progress ? 1 : 0} strokeDasharray={`${Math.min(100, Math.max(0, progress ?? 0))} 100`} /></svg>
          <span className="hb-metric__value num">{value ?? '—'}</span>
        </span>
      )}
      <span className="hb-metric__label">{label}</span>
      <span className={`hb-metric__target ${met === null ? '' : met ? 'hb-metric__target--ok' : 'hb-metric__target--warn'}`}>
        {met === null ? 'нет данных' : met ? `✓ цель ${target}` : `↓ цель ${target}`}
      </span>
      <span className="hb-metric__detail">{detail}</span>
    </div>
  );
}

function PilotMetricsCard({ pilot }: { pilot: PilotMetrics }) {
  const self = percent(pilot.found, pilot.searches);
  const helpful = percent(pilot.helpful, pilot.helpful + pilot.notHelpful);
  const fresh = percent(pilot.fresh, pilot.published);
  const answer = pilot.medianAnswerMinutes;
  return (
    <section className="stack" aria-label="Главные показатели">
      <SectionTitle>Качество справочника</SectionTitle>
      <div className="hb-metrics">
        <PilotTile
          label="Нашли ответ сами"
          progress={self}
          value={self === null ? null : `${self}%`}
          met={self === null ? null : self >= 80}
          target="≥ 80%"
          detail={`${num(pilot.found)} из ${num(pilot.searches)} ${plural(pilot.searches, 'запроса', 'запросов', 'запросов')} за 30 дней`}
        />
        <PilotTile
          label="Страница помогла"
          progress={helpful}
          value={helpful === null ? null : `${helpful}%`}
          met={helpful === null ? null : helpful >= 85}
          target="≥ 85%"
          detail={`${num(pilot.helpful)} из ${num(pilot.helpful + pilot.notHelpful)} ${plural(pilot.helpful + pilot.notHelpful, 'оценки', 'оценок', 'оценок')}`}
        />
        <PilotTile
          label="Ответ дежурного"
          value={answer === null ? null : duration(answer)}
          met={answer === null ? null : answer <= 24 * 60}
          target="≤ 24 ч"
          detail={pilot.answered ? `медиана по ${pilot.answered} ${plural(pilot.answered, 'ответу', 'ответам', 'ответам')} за 30 дней` : 'за 30 дней ответов не было'}
        />
        <PilotTile
          label="Проверено за полгода"
          progress={fresh}
          value={fresh === null ? null : `${fresh}%`}
          met={fresh === null ? null : fresh >= 90}
          target="≥ 90%"
          detail={`${pilot.fresh} из ${pilot.published} ${plural(pilot.published, 'опубликованной страницы', 'опубликованных страниц', 'опубликованных страниц')}`}
        />
      </div>
    </section>
  );
}

/**
 * Бэклог редактора. Главная мысль: справочник не «пишется один раз» —
 * студенты сами показывают, чего в нём не хватает.
 */
export function HandbookAnalytics() {
  const hb = useHandbook();
  // Кэш: «Назад» со страницы возвращает список на то же место, без скелетонов (APP-21)
  const { data, error, loading, reload } = useLoad(
    (signal) => api<Analytics>(hb.url('/api/handbook-editor/analytics'), { signal }),
    [hb.handbookId],
    `analytics:${hb.handbookId}`,
  );
  const [answering, setAnswering] = useState<Question | null>(null);

  if (loading && !data) return <Skeletons count={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <>
      <div className="hb-page__head">
        <h1 className="hb-page__title">Аналитика</h1>
        <p className="hb-page__summary">Что дописать и что пора перепроверить — по запросам и оценкам студентов.</p>
      </div>

      <div className="hb-stats" aria-label="Статистика">
        <Fact label="Читателей" value={num(data.totals.readers)} />
        <Fact label="Просмотров" value={num(data.totals.views)} />
        <Fact label="Опубликовано" value={num(data.totals.published)} />
        <Fact label="В работе" value={num(data.totals.drafts)} />
      </div>

      {data.pilot ? <PilotMetricsCard pilot={data.pilot} /> : null}

      <SectionTitle>Искали и не нашли</SectionTitle>
      {data.gaps.length === 0 ? (
        <EmptyState icon="done" title="Пробелов нет">
          Все запросы за последние три месяца что-то находили.
        </EmptyState>
      ) : (
        <div className="card hb-list">
          {data.gaps.map((gap) => (
            <div key={gap.query} className="hb-list__row hb-list__row--static">
              <span className="stack hb-reader-grow" style={{ gap: 2 }}>
                <span className="hb-list__title">{gap.query}</span>
                <span className="faint small num">
                  {gap.n} {plural(gap.n, 'раз', 'раза', 'раз')} · последний {relativeDateTime(gap.last_at)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {data.questions.length > 0 ? (
        <>
          <SectionTitle>Вопросы без ответа</SectionTitle>
          <div className="card hb-list">
            {data.questions.map((question) => <QuestionRow key={question.id} question={question} onAnswer={() => setAnswering(question)} />)}
          </div>
        </>
      ) : null}

      {data.weak.length > 0 ? (
        <>
          <SectionTitle>Страницы, которые не помогают</SectionTitle>
          <div className="card hb-list">
            {data.weak.map((page) => (
              <button key={page.id} type="button" className="hb-list__row" onClick={() => hb.nav.push({ name: 'hb-editor-page', id: page.id })}>
                <span className="stack hb-reader-grow" style={{ gap: 2 }}>
                  <span className="hb-list__title">{page.title}</span>
                  <span className="faint small num">помогла {page.helpful} из {page.helpful + page.not_helpful}</span>
                </span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </>
      ) : null}

      {data.stale.length > 0 ? (
        <>
          <SectionTitle>Пора перепроверить</SectionTitle>
          <div className="card hb-list">
            {data.stale.map((page) => (
              <button key={page.id} type="button" className="hb-list__row" onClick={() => hb.nav.push({ name: 'hb-editor-page', id: page.id })}>
                <span className="stack hb-reader-grow" style={{ gap: 2 }}>
                  <span className="hb-list__title">{page.title}</span>
                  <span className="faint small">
                    {page.checked_at ? `проверяли ${relativeDateTime(page.checked_at)}` : 'ни разу не проверяли'}
                  </span>
                </span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </>
      ) : null}

      {data.top.length > 0 ? (
        <>
          <SectionTitle>Самые частые запросы</SectionTitle>
          <div className="hb-chips">
            {data.top.map((item) => (
              <span key={item.query} className="hb-chip hb-chip--static">
                {item.query} · {item.n}
              </span>
            ))}
          </div>
        </>
      ) : null}

      {answering ? (
        <AnswerSheet
          question={answering}
          onClose={() => setAnswering(null)}
          onDone={() => {
            setAnswering(null);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Вопрос без ответа — строка списка: текст, свежесть и компактное «Ответить» справа.
 * Раньше у каждого вопроса была кнопка во всю ширину — список превращался в стену кнопок.
 */
function QuestionRow({ question, onAnswer }: { question: Question; onAnswer: () => void }) {
  return (
    <article className="hb-list__row hb-list__row--static hb-question-row">
      <span className="stack hb-reader-grow" style={{ gap: 4 }}>
        <span className="hb-list__title">{question.text}</span>
        <span className="hb-question-row__foot">
          <span className="faint small">{relativeDateTime(question.created_at)}{question.pageTitle ? ` · ${question.pageTitle}` : ''}</span>
          <button type="button" className="linkbtn small" onClick={onAnswer}><Icon name="chat" size={16} />Ответить</button>
        </span>
      </span>
    </article>
  );
}

/**
 * Входящие вопросы используют тот же серверный ответ и форму, что и аналитика.
 * onAnswered — ответ ушёл: у страницы из «Вопросов и ответов» появился черновик, редакции нужно обновить список.
 */
export function QuestionsInbox({ onAnswered }: { onAnswered?: () => void } = {}) {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad(
    (signal) => api<Analytics>(hb.url('/api/handbook-editor/analytics'), { signal }),
    [hb.handbookId], `analytics:${hb.handbookId}`,
  );
  const [answering, setAnswering] = useState<Question | null>(null);
  if (loading && !data) return <Skeletons count={3} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  return <>
    <p className="small muted">Открытые вопросы студентов. Ответ придёт в MAX, а частый вопрос можно добавить в справочник.</p>
    {data?.questions.length === 0 ? <EmptyState icon="done" title="На все вопросы ответили">Новые обращения студентов появятся здесь.</EmptyState> : null}
    {data?.questions.length ? <div className="card hb-list">
      {data.questions.map((question) => <QuestionRow key={question.id} question={question} onAnswer={() => setAnswering(question)} />)}
    </div> : null}
    {answering ? <AnswerSheet question={answering} onClose={() => setAnswering(null)} onDone={() => { setAnswering(null); reload(); onAnswered?.(); }} /> : null}
  </>;
}

/**
 * Ответ дежурного: уходит студенту в чат, а по желанию — пунктом в «Вопросы и ответы» страницы.
 * Пункт попадает в черновик страницы: студенты увидят его после публикации.
 */
function AnswerSheet({ question, onClose, onDone }: { question: Question; onClose: () => void; onDone: () => void }) {
  const hb = useHandbook();
  const structure = useLoad(
    (signal) => api<EditorStructure>(hb.url('/api/handbook-editor/structure'), { signal }),
    [hb.handbookId],
    `editor:${hb.handbookId}`,
  );
  const [answer, setAnswer] = useState('');
  const [toFaq, setToFaq] = useState(Boolean(question.pageId));
  const [pageId, setPageId] = useState(question.pageId ?? '');
  const [busy, setBusy] = useState(false);

  const groups = (structure.data?.sections ?? [])
    // Значки разделов — Lucide; эмодзи в поле emoji — только ключ значка, в подписи ему не место
    .map((section) => ({ title: section.title, pages: section.pages.filter((page) => page.status === 'published') }))
    .filter((group) => group.pages.length > 0);
  const known = groups.some((group) => group.pages.some((page) => page.id === pageId));
  const pageTitle =
    groups.flatMap((group) => group.pages).find((page) => page.id === pageId)?.title ?? (pageId === question.pageId ? question.pageTitle : null);
  const needsPage = toFaq && !pageId;

  const send = async () => {
    if (answer.trim().length < 2 || needsPage) return;
    setBusy(true);
    try {
      const addToPageId = toFaq && pageId ? pageId : null;
      await api(hb.url(`/api/handbook-editor/questions/${question.id}/answer`), {
        method: 'POST',
        body: { answer: answer.trim(), addToPageId },
      });
      if (addToPageId) {
        const next = structure.data?.role === 'admin' ? 'опубликуйте страницу' : 'отправьте страницу на проверку';
        hb.toast(`Ответ отправлен. Вопрос добавлен в черновик «${pageTitle ?? 'страницы'}» — ${next}, и студенты его увидят`);
      } else {
        hb.toast('Ответ отправлен студенту');
      }
      onDone();
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Ответ студенту" onClose={onClose} dirty={answer.trim().length > 0 && !busy}>
      <span className="small muted">{question.text}</span>
      <label className="hb-field">
        <span className="hb-field__label">Ответ</span>
        <textarea
          className="hb-textarea"
          rows={4}
          autoFocus
          value={answer}
          maxLength={1500}
          placeholder="Ответ придёт студенту в чат"
          onChange={(event) => setAnswer(event.target.value)}
        />
      </label>
      <label className="hb-check hb-check--row">
        <input type="checkbox" checked={toFaq} onChange={(event) => setToFaq(event.target.checked)} />
        <span className="hb-check__box" aria-hidden="true" />
        <span className="stack" style={{ gap: 2 }}>
          <span>Добавить в «Вопросы и ответы»</span>
          <span className="small muted">Частый вопрос попадёт на страницу — следующему студенту не придётся спрашивать</span>
        </span>
      </label>
      {toFaq ? (
        <label className="hb-field">
          <span className="hb-field__label">Страница</span>
          <select className="hb-input hb-select" value={pageId} onChange={(event) => setPageId(event.target.value)}>
            <option value="">{structure.loading && !structure.data ? 'Загружаю страницы…' : 'Выберите страницу'}</option>
            {pageId && !known ? <option value={pageId}>{pageTitle ?? 'Страница вопроса'}</option> : null}
            {groups.map((group) => (
              <optgroup key={group.title} label={group.title}>
                {group.pages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {structure.error && !structure.data ? (
            <span className="small hb-error">{structure.error.message}</span>
          ) : (
            <span className="faint small">Вопрос и ответ попадут в черновик страницы — студенты увидят их после публикации</span>
          )}
        </label>
      ) : null}
      <Button variant="primary" size="large" loading={busy} disabled={busy || answer.trim().length < 2 || needsPage} onClick={send}>
        Отправить
      </Button>
    </Sheet>
  );
}
