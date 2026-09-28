import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api, ApiError } from '../../lib/api';
import { bridge } from '../../lib/bridge';
import { useLoad } from '../../lib/useLoad';
import { dateTime } from '../../lib/format';
import type { Audience, Block, BlockType } from '../../lib/types';
import { BottomBar, ErrorState, Pill, SectionTitle, Sheet, Skeletons } from '../../components/ui';
import { Icon } from '../../components/icons';
import { AddBlockSheet, BLOCK_LABEL, BlockCard, blockProblem, cleanBlock, emptyBlock } from './BlockEditor';
import { Blocks } from './Blocks';
import { QrPosterSheet } from './QrPoster';

type Status = 'draft' | 'review' | 'published' | 'archived';

interface EditorPageData {
  page: {
    id: string;
    sectionId: string;
    title: string;
    summary: string | null;
    audience: Audience;
    status: Status;
    hasDraft: boolean;
    blocks: Block[];
    publishedTitle: string;
    publishedAt: string | null;
    checkedAt: string | null;
    reviewAt: string | null;
    note: string | null;
    /** Время последнего изменения — основа для защиты от затирания чужих правок. */
    updatedAt?: string | null;
    /** Почему администратор вернул страницу на доработку. */
    returnNote?: string | null;
    /** Когда вернули на доработку (причина может быть не указана). */
    returnedAt?: string | null;
  };
  versions: Array<{ id: number; title: string; created_at: string; note: string | null; author: string | null }>;
  role: 'admin' | 'editor';
  issues: string[];
  link: string;
  handbook: { title: string; emoji: string };
  updatedAt?: string | null;
  returnNote?: string | null;
  returnedAt?: string | null;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

const STATUS: Record<Status, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  draft: { label: 'Черновик', tone: 'neutral' },
  review: { label: 'На проверке', tone: 'warn' },
  published: { label: 'Опубликована', tone: 'ok' },
  archived: { label: 'В архиве', tone: 'neutral' },
};

/** Сервер принимает комментарий к проверке до 300 символов, причину возврата — до 500. */
const REVIEW_NOTE_MAX = 300;
const RETURN_NOTE_MAX = 500;

/** «Срок (блок 2): Заполните название» → номер блока для подсветки. */
function issueByBlock(issues: string[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const issue of issues) {
    const match = /\(блок (\d+)\):\s*(.+)$/.exec(issue);
    if (match && !map.has(Number(match[1]) - 1)) map.set(Number(match[1]) - 1, match[2]!);
  }
  return map;
}

interface FormValues {
  title: string;
  summary: string;
  blocks: Block[];
  audience: Audience;
  audienceTouched: boolean;
  isAdmin: boolean;
}

function payloadOf(values: FormValues) {
  const { audience } = values;
  return {
    title: values.title.trim() || undefined,
    summary: values.summary.trim() || null,
    blocks: values.blocks.map(cleanBlock),
    // Аудиторию меняет только администратор, и только если он её трогал
    ...(values.isAdmin && values.audienceTouched
      ? {
          audience: {
            ...(audience.courses?.length ? { courses: audience.courses } : {}),
            ...(audience.dorm !== undefined ? { dorm: audience.dorm } : {}),
            ...(audience.tags?.length ? { tags: audience.tags } : {}),
          },
        }
      : {}),
  };
}

/**
 * Страница в редакторе. Черновик сохраняется сам через секунду после правки — ничего не теряется,
 * даже если закрыть приложение. Сохранения идут строго по очереди: правка, сделанная, пока идёт
 * сохранение, уходит следующим запросом, а «Черновик сохранён» появляется, только когда сохранена
 * последняя правка. Если страницу тем временем изменил другой участник команды, сервер отвечает
 * page_conflict — автосохранение останавливается и предлагает обновить страницу.
 * Недописанный блок сохранить можно, опубликовать — нет: что мешает, видно сразу у самого блока.
 */
export function HandbookEditorPage({ id }: { id: string }) {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad(
    (signal) => api<EditorPageData>(hb.url(`/api/handbook-editor/pages/${id}`), { signal }),
    [id, hb.handbookId],
  );
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [audience, setAudience] = useState<Audience>({});
  const [audienceTouched, setAudienceTouched] = useState(false);
  const [issues, setIssues] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  // Ошибка публикации или отправки на проверку — висит под кнопкой до следующей правки
  const [actionError, setActionError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState(false);
  const [poster, setPoster] = useState(false);
  const [archiveAsk, setArchiveAsk] = useState(false);
  const [reviewAsk, setReviewAsk] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [returnAsk, setReturnAsk] = useState(false);
  const [returnNote, setReturnNote] = useState('');
  const [busy, setBusy] = useState<'review' | 'publish' | 'archive' | 'return' | 'draft' | null>(null);
  const [status, setStatus] = useState<Status>('draft');
  const [hasDraft, setHasDraft] = useState(false);

  // Счётчики правок: сколько правок сделано и до какой сохранено
  const editVersion = useRef(0);
  const savedVersion = useRef(0);
  // Время последнего изменения страницы на сервере, от которого сделаны правки
  const baseUpdatedAt = useRef<string | null>(null);
  const conflict = useRef(false);
  const lastSaveError = useRef<string | null>(null);
  const queue = useRef<Promise<boolean> | null>(null);
  const isAdmin = data?.role === 'admin';
  const latest = useRef<FormValues>({ title, summary, blocks, audience, audienceTouched, isAdmin });
  latest.current = { title, summary, blocks, audience, audienceTouched, isAdmin };

  useEffect(() => {
    if (!data) return;
    setTitle(data.page.title);
    setSummary(data.page.summary ?? '');
    setBlocks(data.page.blocks);
    setAudience(data.page.audience ?? {});
    setAudienceTouched(false);
    setIssues(data.issues ?? []);
    setStatus(data.page.status);
    setHasDraft(data.page.hasDraft);
    baseUpdatedAt.current = data.page.updatedAt ?? data.updatedAt ?? null;
    savedVersion.current = editVersion.current;
    conflict.current = false;
    lastSaveError.current = null;
    setSaveState('saved');
    setSaveError(null);
    setActionError(null);
  }, [data]);

  /** Одно сохранение: отправляет то, что сейчас в форме, и запоминает, до какой правки сохранено. */
  const runSave = useCallback(async (): Promise<boolean> => {
    if (conflict.current) return false;
    const version = editVersion.current;
    if (version === savedVersion.current) {
      setSaveState('saved');
      return true;
    }
    setSaveState('saving');
    try {
      const result = await api<{ status: Status; issues?: string[]; updatedAt?: string | null }>(hb.url(`/api/handbook-editor/pages/${id}`), {
        method: 'PATCH',
        body: { ...payloadOf(latest.current), ...(baseUpdatedAt.current ? { baseUpdatedAt: baseUpdatedAt.current } : {}) },
      });
      if (result.updatedAt) baseUpdatedAt.current = result.updatedAt;
      savedVersion.current = Math.max(savedVersion.current, version);
      lastSaveError.current = null;
      setHasDraft(true);
      setStatus(result.status);
      setIssues(result.issues ?? []);
      setSaveError(null);
      setRetryable(false);
      // Правка во время сохранения ещё не на сервере: оставляем «Есть правки», её отправит следующий запрос
      setSaveState(editVersion.current === version ? 'saved' : 'dirty');
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'page_conflict') {
        conflict.current = true;
        lastSaveError.current = err.message;
        setSaveError(err.message);
        setSaveState('conflict');
        return false;
      }
      const offline = !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
      const message = offline
        ? 'Нет связи с сервером — сохраню, как только связь вернётся'
        : err.message;
      lastSaveError.current = message;
      setSaveError(message);
      setRetryable(offline);
      setSaveState('error');
      return false;
    }
  }, [hb, id]);

  /** Сохранения строго по очереди: следующее начинается, когда закончилось предыдущее. */
  const save = useCallback((): Promise<boolean> => {
    const run = (queue.current ?? Promise.resolve(true)).then(runSave, runSave);
    queue.current = run;
    void run.finally(() => {
      if (queue.current === run) queue.current = null;
    });
    return run;
  }, [runSave]);

  // Автосохранение: через секунду после последней правки; без связи — повтор через 5 секунд
  useEffect(() => {
    if (saveState === 'dirty') {
      const timer = window.setTimeout(() => void save(), 1000);
      return () => window.clearTimeout(timer);
    }
    if (saveState === 'error' && retryable) {
      const timer = window.setTimeout(() => void save(), 5000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [saveState, retryable, save, title, summary, blocks, audience]);

  // Закрыть приложение с несохранёнными правками — только с подтверждением
  useEffect(() => {
    bridge.closingConfirmation(saveState !== 'saved');
    return () => bridge.closingConfirmation(false);
  }, [saveState]);

  // Уходя со страницы, дописываем черновик
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      if (editVersion.current !== savedVersion.current && !conflict.current) void saveRef.current();
    },
    [],
  );

  if (loading && !data) return <Skeletons count={4} />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  // Что мешает опубликовать: сначала проверка на телефоне (теми же словами, что подписи полей),
  // затем ответ сервера по последнему сохранённому черновику
  const localProblems = new Map<number, string>();
  blocks.forEach((block, index) => {
    const problem = blockProblem(block);
    if (problem) localProblems.set(index, problem);
  });
  const serverProblems = saveState === 'saved' ? issueByBlock(issues) : new Map<number, string>();
  const pageProblems: string[] = [];
  if (title.trim().length < 3) pageProblems.push('Заголовок — не короче 3 символов');
  if (blocks.length === 0) pageProblems.push('Добавьте хотя бы один блок');
  for (const [index, problem] of localProblems) pageProblems.push(`${BLOCK_LABEL[blocks[index]!.type].title} (блок ${index + 1}): ${problem}`);
  const serverIssues = saveState === 'saved' ? issues : [];
  const hint = pageProblems[0] ?? serverIssues[0] ?? null;

  const nothingNew = status === 'published' && !hasDraft && saveState === 'saved';
  const canPublish = pageProblems.length === 0 && serverIssues.length === 0 && !nothingNew && saveState !== 'conflict';

  const edit = (next: Partial<{ title: string; summary: string; blocks: Block[]; audience: Audience }>) => {
    if (next.title !== undefined) setTitle(next.title);
    if (next.summary !== undefined) setSummary(next.summary);
    if (next.blocks !== undefined) setBlocks(next.blocks);
    if (next.audience !== undefined) {
      setAudience(next.audience);
      setAudienceTouched(true);
    }
    editVersion.current += 1;
    setActionError(null);
    // При конфликте не сохраняем, пока человек не обновит страницу
    if (!conflict.current) setSaveState('dirty');
  };

  /** Дописать все правки перед публикацией или отправкой на проверку. */
  const flush = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (editVersion.current === savedVersion.current && !queue.current) return !conflict.current;
      if (!(await save())) return false;
    }
    return editVersion.current === savedVersion.current && !conflict.current;
  };

  const failed = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'page_conflict') {
      conflict.current = true;
      setSaveError(err.message);
      setSaveState('conflict');
      return;
    }
    const message = (err as Error).message;
    setActionError(message);
    hb.toast(message, 'error');
  };

  const notSaved = () => {
    hb.toast(lastSaveError.current ?? 'Правки ещё не сохранились — попробуйте через минуту', 'error');
  };

  const sendToReview = async () => {
    setBusy('review');
    try {
      if (!(await flush())) return notSaved();
      const note = reviewNote.trim();
      await api(hb.url(`/api/handbook-editor/pages/${id}/review`), { method: 'POST', body: note ? { note } : {} });
      setReviewAsk(false);
      setReviewNote('');
      hb.toast('Отправлено на проверку — администратор получит сообщение в чате');
      reload();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    setBusy('publish');
    try {
      if (!(await flush())) return notSaved();
      await api(hb.url(`/api/handbook-editor/pages/${id}/publish`), {
        method: 'POST',
        body: baseUpdatedAt.current ? { baseUpdatedAt: baseUpdatedAt.current } : {},
      });
      hb.toast('Опубликовано — студенты уже видят и находят поиском');
      reload();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(null);
    }
  };

  const sendBack = async () => {
    setBusy('return');
    try {
      const note = returnNote.trim();
      await api(hb.url(`/api/handbook-editor/pages/${id}/return`), { method: 'POST', body: note ? { note } : {} });
      setReturnAsk(false);
      setReturnNote('');
      hb.toast('Вернули на доработку — автор увидит причину на странице');
      reload();
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    setBusy('archive');
    try {
      if (!(await flush())) return notSaved();
      await api(hb.url(`/api/handbook-editor/pages/${id}/archive`), { method: 'POST', body: {} });
      hb.toast('Страница убрана в архив');
      setArchiveAsk(false);
      hb.nav.pop();
    } catch (err) {
      hb.toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const refreshAfterConflict = () => {
    conflict.current = false;
    reload();
  };

  const restoreDraft = async () => {
    setBusy('draft');
    try {
      if (!(await flush())) return notSaved();
      await api(hb.url(`/api/handbook-editor/pages/${id}`), {
        method: 'PATCH', body: { ...payloadOf(latest.current), ...(baseUpdatedAt.current ? { baseUpdatedAt: baseUpdatedAt.current } : {}) },
      });
      hb.toast('Черновик сохранён');
      reload();
    } catch (err) { failed(err); }
    finally { setBusy(null); }
  };

  const move = (index: number, direction: -1 | 1) => {
    const next = [...blocks];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    edit({ blocks: next });
  };

  const saveLabel =
    saveState === 'saving'
      ? 'Сохраняю…'
      : saveState === 'dirty'
        ? 'Есть правки'
        : saveState === 'error' || saveState === 'conflict'
          ? 'Не сохранено'
          : nothingNew
            ? 'Опубликовано, правок нет'
            : status === 'published'
              ? 'Правки сохранены · студенты пока видят прежнюю версию'
              : 'Черновик сохранён';

  const pageReturnNote = (data.page.returnNote ?? data.returnNote ?? '').trim();
  const returned = Boolean(pageReturnNote || data.page.returnedAt || data.returnedAt);
  // Заготовка нового справочника: в заметке — подсказка, что вписать, а не комментарий к проверке (APP-19)
  const template = status === 'draft' && !data.page.publishedAt && data.versions.length === 0 && !returned;

  return (
    <>
      <header className="hb-page__head hb-editor-pagehead">
        <span className="small muted">Редактирование страницы</span>
        <h1 className="hb-page__title">{title || data.page.publishedTitle || 'Без заголовка'}</h1>
      </header>
      <div className="card hb-page__head hb-page-status">
        <h2 className="hb-block__title">Статус страницы</h2>
        <div className="row row--between">
          <Pill tone={STATUS[status].tone}>{STATUS[status].label}</Pill>
          <div className="row" style={{ gap: 14 }}>
            {status === 'published' ? (
              <button type="button" className="linkbtn" onClick={() => setPoster(true)}>
                QR-плакат
              </button>
            ) : null}
            <button type="button" className="linkbtn" onClick={() => setPreview(true)}>
              Предпросмотр
            </button>
          </div>
        </div>
        {data.page.publishedAt ? (
          <span className="faint small">Опубликована {dateTime(data.page.publishedAt)}</span>
        ) : null}
        {data.page.note ? (
          <span className="small muted">
            {template ? 'Что вписать' : 'Комментарий к проверке'}: {data.page.note}
          </span>
        ) : null}
        <span className="small muted">{status === 'archived'
          ? 'Страница скрыта от студентов. Администратор может восстановить черновик или опубликовать её.'
          : status === 'review' ? 'Страница ожидает проверки. Публикация доступна администратору.'
            : status === 'published' ? 'Студенты видят опубликованную версию. Новые правки можно отправить на проверку.'
              : 'Черновик виден только команде. Заполните страницу и отправьте на проверку или опубликуйте.'}</span>
        {isAdmin && status !== 'review' && status !== 'archived' ? <>
          <Button variant="secondary" size="medium" disabled={!canPublish || busy !== null} onClick={() => setReviewAsk(true)}>На проверку</Button>
          {/* Неактивная кнопка всегда объясняет почему */}
          {!canPublish ? <span className="small muted hb-disabled-why">{nothingNew ? 'Нет новых правок — отправлять пока нечего.' : saveState === 'conflict' ? 'Сначала обновите страницу: её изменил кто-то ещё.' : hint ? `Сначала: ${hint}` : null}</span> : null}
        </> : null}
        {isAdmin && status === 'archived' ? <Button variant="secondary" size="medium" disabled={busy !== null || saveState === 'conflict'} onClick={restoreDraft}>Восстановить черновик</Button> : null}
      </div>

      {returned && status !== 'review' ? (
        <div className="hb-alert hb-alert--warn" role="note">
          <span className="hb-block__icon" aria-hidden="true">
            <Icon name="warn" />
          </span>
          <span>
            <strong>Вернули на доработку.</strong> {pageReturnNote || 'Причину не указали — уточните у администратора справочника.'}
          </span>
        </div>
      ) : null}

      {isAdmin && status === 'review' ? (
        <div className="card hb-block">
          <h2 className="hb-block__title">Страница ждёт проверки</h2>
          <span className="small muted">Всё в порядке — опубликуйте. Нужно поправить — верните автору и напишите, что именно.</span>
          <Button variant="secondary" size="medium" disabled={busy !== null} onClick={() => setReturnAsk(true)}>
            Вернуть на доработку
          </Button>
        </div>
      ) : null}

      <div className="card hb-block">
        <label className="hb-field" htmlFor="page-title">
          <span className="hb-field__label">Заголовок</span>
          <input id="page-title" className="hb-input" value={title} maxLength={120} onChange={(event) => edit({ title: event.target.value })} />
        </label>
        <label className="hb-field" htmlFor="page-summary">
          <span className="hb-field__label">Коротко о чём</span>
          <input
            id="page-summary"
            className="hb-input"
            value={summary}
            maxLength={300}
            placeholder="Одна строка — её видно в поиске и в списке раздела"
            onChange={(event) => edit({ summary: event.target.value })}
          />
        </label>
      </div>

      <div className="card hb-block">
        <h2 className="hb-block__title">Кому показывать</h2>
        {isAdmin ? (
          <>
            <span className="faint small">Ничего не выбрано — страницу видят все.</span>
            <div className="hb-chips">
              {[1, 2, 3, 4, 5, 6].map((course) => {
                const on = audience.courses?.includes(course) ?? false;
                return (
                  <button
                    key={course}
                    type="button"
                    className={`hb-chip ${on ? 'hb-chip--on' : ''}`}
                    aria-pressed={on}
                    onClick={() => {
                      const current = audience.courses ?? [];
                      edit({ audience: { ...audience, courses: on ? current.filter((value) => value !== course) : [...current, course].sort() } });
                    }}
                  >
                    {course} курс
                  </button>
                );
              })}
              <button
                type="button"
                className={`hb-chip ${audience.dorm === true ? 'hb-chip--on' : ''}`}
                aria-pressed={audience.dorm === true}
                onClick={() => edit({ audience: { ...audience, dorm: audience.dorm === true ? undefined : true } })}
              >
                Живущим в общежитии
              </button>
            </div>
          </>
        ) : (
          <span className="small muted">
            {audienceText(audience)} Менять аудиторию может администратор — напишите об этом в комментарии, когда отправите страницу на проверку.
          </span>
        )}
      </div>

      <SectionTitle>Содержание · {blocks.length} {blocks.length === 1 ? 'блок' : blocks.length >= 2 && blocks.length <= 4 ? 'блока' : 'блоков'}</SectionTitle>
      <div className="stack">
        {blocks.length === 0 ? (
          <div className="card hb-block">
            <span className="small muted">
              Страница пока пустая. Начните с блока «Пошаговая инструкция» или «Текст» — а контакт и срок добавьте ниже.
            </span>
          </div>
        ) : null}
        {blocks.map((block, index) => (
          <BlockCard
            key={block.id}
            block={block}
            index={index}
            total={blocks.length}
            defaultOpen={block.id === fresh}
            problem={localProblems.get(index) ?? serverProblems.get(index) ?? null}
            onChange={(next) => edit({ blocks: blocks.map((value) => (value.id === next.id ? next : value)) })}
            onRemove={() => edit({ blocks: blocks.filter((value) => value.id !== block.id) })}
            onMove={(direction) => move(index, direction)}
          />
        ))}
        <button type="button" className="hb-add" onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} /> Добавить блок
        </button>
      </div>

      {data.versions.length > 0 ? (
        <>
          <SectionTitle>История публикаций</SectionTitle>
          <div className="card hb-versions">
            {data.versions.map((item) => (
              <div key={item.id} className="hb-version">
                <span>{item.title}</span>
                <span className="faint small">
                  {dateTime(item.created_at)}
                  {item.author ? ` · ${item.author}` : ''}
                  {item.note ? ` · «${item.note}»` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {isAdmin && status !== 'archived' ? (
        <button type="button" className="linkbtn hb-danger-link" onClick={() => setArchiveAsk(true)}>
          Убрать страницу в архив
        </button>
      ) : null}

      <BottomBar>
        {(saveState === 'conflict' || saveState === 'error') && saveError ? (
          <div className="hb-savebar__alert" role="alert">
            <span className="small">{saveError}</span>
            {saveState === 'conflict' ? (
              <button type="button" className="linkbtn small" onClick={refreshAfterConflict}>
                Обновить
              </button>
            ) : (
              <button type="button" className="linkbtn small" onClick={() => void save()}>
                Повторить
              </button>
            )}
          </div>
        ) : null}
        <div className="hb-savebar">
          <span
            className={`hb-savebar__state ${saveState === 'error' || saveState === 'conflict' || actionError ? 'hb-savebar__state--error' : ''}`}
            role="status"
            aria-live="polite"
          >
            {saveLabel}
            {saveState === 'conflict' || saveState === 'error' ? null : actionError ? (
              <span className="hb-savebar__hint">{actionError}</span>
            ) : hint ? (
              <span className="hb-savebar__hint">Для публикации: {hint}</span>
            ) : null}
          </span>
          {isAdmin ? (
            <Button variant="primary" size="large" loading={busy === 'publish'} disabled={!canPublish || busy !== null} onClick={publish}>
              {status === 'published' ? 'Опубликовать правки' : 'Опубликовать'}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="large"
              loading={busy === 'review'}
              disabled={!canPublish || busy !== null || status === 'archived' || (status === 'review' && saveState === 'saved')}
              onClick={() => setReviewAsk(true)}
            >
              {status === 'review' ? 'На проверке' : 'На проверку'}
            </Button>
          )}
        </div>
      </BottomBar>

      {adding ? (
        <AddBlockSheet
          onClose={() => setAdding(false)}
          onPick={(type: BlockType) => {
            const block = emptyBlock(type);
            setFresh(block.id);
            edit({ blocks: [...blocks, block] });
            setAdding(false);
          }}
        />
      ) : null}

      {reviewAsk ? (
        <Sheet title="Отправить на проверку" onClose={() => setReviewAsk(false)} dirty={reviewNote.trim().length > 0 && busy !== 'review'}>
          <span className="small muted">Администратор получит сообщение в чате, проверит страницу и опубликует её.</span>
          <label className="hb-field">
            <span className="hb-field__label">Комментарий для администратора (необязательно)</span>
            <textarea
              className="hb-textarea"
              rows={3}
              value={reviewNote}
              maxLength={REVIEW_NOTE_MAX}
              placeholder="Что изменили или кому ещё показать страницу"
              onChange={(event) => setReviewNote(event.target.value)}
            />
            <span className="faint small num">
              {reviewNote.length}/{REVIEW_NOTE_MAX}
            </span>
          </label>
          <Button variant="primary" size="large" loading={busy === 'review'} disabled={busy !== null} onClick={sendToReview}>
            Отправить на проверку
          </Button>
        </Sheet>
      ) : null}

      {returnAsk ? (
        <Sheet title="Вернуть на доработку" onClose={() => setReturnAsk(false)} dirty={returnNote.trim().length > 0 && busy !== 'return'}>
          <span className="small muted">
            Страница снова станет черновиком{status === 'review' && data.page.publishedAt ? ', студенты продолжат видеть опубликованную версию' : ''}. Автор
            увидит причину на странице.
          </span>
          <label className="hb-field">
            <span className="hb-field__label">Что поправить (необязательно)</span>
            <textarea
              className="hb-textarea"
              rows={3}
              value={returnNote}
              maxLength={RETURN_NOTE_MAX}
              placeholder="Например: уточните часы приёма и добавьте ссылку на бланк"
              onChange={(event) => setReturnNote(event.target.value)}
            />
            <span className="faint small num">
              {returnNote.length}/{RETURN_NOTE_MAX}
            </span>
          </label>
          <Button variant="primary" size="large" loading={busy === 'return'} disabled={busy !== null} onClick={sendBack}>
            Вернуть на доработку
          </Button>
        </Sheet>
      ) : null}

      {preview ? (
        <Sheet title="Как увидит студент" onClose={() => setPreview(false)}>
          <div className="stack--lg">
            <h3 className="hb-page__title" style={{ fontSize: 20, margin: 0 }}>
              {title || 'Без заголовка'}
            </h3>
            {summary ? <p className="hb-page__summary">{summary}</p> : null}
            <Blocks blocks={blocks} today={new Date().toISOString().slice(0, 10)} done={new Set()} onToggle={() => undefined} headingLevel={4} />
          </div>
        </Sheet>
      ) : null}

      {poster ? (
        <QrPosterSheet
          title={data.page.publishedTitle}
          eyebrow={`${data.handbook.emoji} ${data.handbook.title}`}
          link={data.link}
          onClose={() => setPoster(false)}
        />
      ) : null}

      {archiveAsk ? (
        <Sheet title="Убрать в архив?" onClose={() => setArchiveAsk(false)}>
          <span className="muted">
            Студенты перестанут видеть страницу, она пропадёт из поиска, напоминания о её сроках отключатся. Черновик и история останутся у
            редакторов.
          </span>
          <Button variant="destructive" size="large" loading={busy === 'archive'} onClick={archive}>
            Убрать в архив
          </Button>
          <Button variant="secondary" size="large" onClick={() => setArchiveAsk(false)}>
            Оставить
          </Button>
        </Sheet>
      ) : null}
    </>
  );
}

function audienceText(audience: Audience): string {
  const parts: string[] = [];
  if (audience.courses?.length) parts.push(`${audience.courses.join(', ')} курс`);
  if (audience.dorm) parts.push('живущим в общежитии');
  if (audience.tags?.length) parts.push(audience.tags.join(', '));
  return parts.length ? `Страницу видят: ${parts.join(' · ')}.` : 'Страницу видят все студенты.';
}
