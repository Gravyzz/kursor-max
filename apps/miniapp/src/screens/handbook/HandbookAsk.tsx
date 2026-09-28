import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { dateTime } from '../../lib/format';
import { readDraft, writeDraft } from '../../lib/drafts';
import type { HandbookQuestion } from '../../lib/types';
import { EmptyState, ErrorState, SectionTitle, Skeletons } from '../../components/ui';

/**
 * Вопрос дежурному. Набранный текст — черновик: «Назад» или свайп его не стирают,
 * при следующем открытии экрана вопрос на месте, пока его не отправят.
 */
export function HandbookAsk({ q }: { q?: string }) {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad(
    (signal) => api<{ questions: HandbookQuestion[] }>(hb.url('/api/handbook/questions'), { signal }),
    [hb.handbookId],
    `questions:${hb.handbookId}`,
  );
  const draftKey = `ask:${hb.handbookId}`;
  const [text, setTextState] = useState(() => readDraft(draftKey) || (q ?? '').slice(0, 1000));
  const [sending, setSending] = useState(false);
  const setText = (value: string) => {
    setTextState(value);
    writeDraft(draftKey, value);
  };

  const openCount = data?.questions.filter((item) => item.status === 'open').length ?? 0;
  const send = async () => {
    if (sending || openCount >= 5) return;
    const value = text.trim();
    if (value.length < 5) {
      hb.toast('Опишите вопрос подробнее', 'error');
      return;
    }
    setSending(true);
    try {
      await api(hb.url('/api/handbook/questions'), { method: 'POST', body: { text: value, query: q ?? null } });
      setText('');
      hb.toast('Отправлено. Ответ придёт в чат с ботом');
      reload();
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="hb-page__head">
        <h1 className="hb-page__title">Вопрос дежурному</h1>
        <p className="hb-page__summary">
          Отвечают редакторы справочника — студсовет и учебный офис. Ответ придёт в чат с ботом, а частые вопросы попадают в справочник.
        </p>
      </div>

      <form className="card hb-block hb-reader-ask" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="field__label" htmlFor="reader-question">Ваш вопрос</label>
        <textarea
          id="reader-question"
          className="hb-textarea"
          rows={4}
          value={text}
          maxLength={1000}
          minLength={5}
          required
          onChange={(event) => setText(event.target.value)}
          placeholder="Например: можно ли перевестись с платного на бюджет и когда подавать заявление?"
          aria-label="Текст вопроса"
        />
        {q ? <span className="faint small">К вопросу приложим ваш поиск «{q}» — дежурному будет понятнее.</span> : null}
        <span className="small muted">Ответ появится здесь и придёт в MAX от бота.</span>
        {openCount >= 5 ? <p className="small hb-error" role="status">У вас уже 5 открытых вопросов. Дождитесь ответа дежурного.</p> : null}
        <div className="row row--between">
          <span className="faint small num">{text.length}/1000</span>
          <Button type="submit" variant="primary" size="medium" loading={sending} disabled={openCount >= 5 || text.trim().length < 5}>
            Отправить
          </Button>
        </div>
      </form>

      {loading && !data ? <Skeletons count={2} /> : null}
      {error && !data ? <ErrorState error={error} onRetry={reload} /> : null}

      {data && data.questions.length > 0 ? (
        <>
          <SectionTitle>Мои вопросы</SectionTitle>
          <div className="stack">
            {data.questions.map((question) => (
              <article key={question.id} className="card hb-block">
                <span className={`hb-reader-status ${question.status === 'answered' ? 'hb-reader-status--done' : ''}`}>{question.status === 'answered' ? 'Есть ответ' : 'Ждёт ответа'}</span>
                <span className="stack" style={{ gap: 4 }}>
                  <span style={{ fontWeight: 600 }}>{question.text}</span>
                  <span className="faint small">{dateTime(question.createdAt)}</span>
                </span>
                {question.status === 'answered' && question.answer ? (
                  <div className="hb-answer">
                    <span className="small" style={{ fontWeight: 600 }}>Ответ</span>
                    <span className="small">{question.answer}</span>
                  </div>
                ) : (
                  <span className="small muted">Ждёт ответа дежурного</span>
                )}
              </article>
            ))}
          </div>
        </>
      ) : null}

      {data && data.questions.length === 0 && !loading ? (
        <EmptyState icon="chat" title="Вопросов пока не было">
          Спрашивайте что угодно про учёбу, документы и быт — это анонимно для других студентов.
        </EmptyState>
      ) : null}
    </>
  );
}
