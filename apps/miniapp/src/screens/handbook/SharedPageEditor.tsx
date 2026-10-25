import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { bridge } from '../../lib/bridge';
import { useLoad } from '../../lib/useLoad';
import { dateOnly, dateTime, todayIso } from '../../lib/format';
import type { Block, BlockType } from '../../lib/types';
import { BottomBar, ErrorState, Pill, SectionTitle, Sheet, Skeletons } from '../../components/ui';
import { Icon } from '../../components/icons';
import { AddBlockSheet, BLOCK_LABEL, BlockCard, blockProblem, cleanBlock, emptyBlock } from './BlockEditor';
import { Blocks } from './Blocks';

interface SharedData {
  role: 'admin' | 'editor';
  base: {
    id: string;
    title: string;
    summary: string | null;
    section: { slug: string; title: string };
    blocks: Block[];
    ownerUnit: string | null;
    ownerName: string | null;
    checkedAt: string | null;
    reviewAt: string | null;
    version: number;
    lastChange: { at: string; note: string | null; author: string | null } | null;
  };
  supplement: {
    id: string;
    status: 'draft' | 'published';
    hasDraft: boolean;
    blocks: Block[];
    publishedBlocks: Block[];
    anchorBlockId: string | null;
    publishedAnchorBlockId: string | null;
    anchorLost: boolean;
    updatedAt: string;
    publishedAt: string | null;
    owner: string | null;
    /** Редактор отправил уточнение администратору факультета на публикацию. */
    review: { at: string; by: string | null; note: string | null } | null;
    issues: string[];
    baseChangedSince: boolean;
  } | null;
  override: { pageId: string; status: string; behind: boolean } | null;
}

/** Подпись блока общей страницы для выбора места уточнения: «Пошаговая инструкция «Как заказать»». */
function blockName(block: Block, index: number): string {
  const label = BLOCK_LABEL[block.type]?.title ?? 'Блок';
  const title = 'title' in block && typeof block.title === 'string' && block.title ? ` «${block.title}»` : '';
  return `${index + 1}. ${label}${title}`;
}

/**
 * Общая страница университета в редакции факультета. Общая часть — только для чтения: её ведёт университет,
 * и обновления приходят сами. Факультет добавляет уточнение (кабинет, часы, контакт, лишний шаг)
 * или, если порядок действительно другой, создаёт свою версию — с объяснением последствий.
 */
export function SharedPageEditor({ id }: { id: string }) {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad((signal) => api<SharedData>(hb.url(`/api/handbook-editor/shared/${id}`), { signal }), [id], `shared:${hb.handbookId}:${id}`);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [anchor, setAnchor] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'publish' | 'archive' | 'override' | 'review'>(null);
  const [reviewAsk, setReviewAsk] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [overrideAsk, setOverrideAsk] = useState(false);
  const [reason, setReason] = useState('');
  const [archiveAsk, setArchiveAsk] = useState(false);
  // «Понятно» под сообщением об обновлении общей части запоминаем для этой версии
  const seenKey = data ? `shared-seen:${hb.handbookId}:${id}:${data.base.version}` : '';
  const [changedSeen, setChangedSeen] = useState(false);
  useEffect(() => {
    if (!seenKey) return;
    try { setChangedSeen(localStorage.getItem(seenKey) === '1'); } catch { /* хранилище недоступно — покажем снова */ }
  }, [seenKey]);
  const markSeen = () => {
    setChangedSeen(true);
    try { localStorage.setItem(seenKey, '1'); } catch { /* не страшно */ }
  };
  // Автосохранение черновика, как в конструкторе страниц: правки не теряются при «Назад»
  const [autoFailed, setAutoFailed] = useState(false);
  const editVersion = useRef(0);
  const latest = useRef({ blocks, anchor, dirty });
  latest.current = { blocks, anchor, dirty };

  useEffect(() => {
    if (!data || dirty) return;
    setBlocks(data.supplement?.blocks ?? []);
    setAnchor(data.supplement?.anchorBlockId ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    bridge.closingConfirmation(dirty);
    return () => bridge.closingConfirmation(false);
  }, [dirty]);

  // Уходя с экрана, дописываем черновик
  useEffect(() => () => {
    const { blocks: last, anchor: lastAnchor, dirty: unsaved } = latest.current;
    if (!unsaved) return;
    void api(hb.url(`/api/handbook-editor/shared/${id}/supplement`), {
      method: 'PUT',
      body: { blocks: last.map(cleanBlock), anchorBlockId: lastAnchor || null },
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Через секунду после последней правки — черновик на сервер; после ошибки ждём новой правки
  const saveRef = useRef<() => Promise<boolean>>(async () => true);
  useEffect(() => {
    if (!dirty || busy !== null || autoFailed) return undefined;
    const timer = window.setTimeout(() => { void saveRef.current().then((ok) => { if (ok) reload(); }); }, 1200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, busy, autoFailed, blocks, anchor]);

  const isAdmin = data?.role === 'admin';
  const problems = useMemo(() => blocks.map((block) => blockProblem(block)), [blocks]);
  const firstProblem = problems.find(Boolean) ?? null;

  if (loading && !data) return <Skeletons count={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const { base, supplement, override } = data;
  const today = todayIso();
  const overdue = Boolean(base.reviewAt && base.reviewAt < today);

  const edit = (next: Block[]) => { setBlocks(next); setDirty(true); setAutoFailed(false); editVersion.current += 1; };
  const save = async (): Promise<boolean> => {
    const version = editVersion.current;
    setBusy('save');
    try {
      await api(hb.url(`/api/handbook-editor/shared/${id}/supplement`), {
        method: 'PUT',
        body: { blocks: blocks.map(cleanBlock), anchorBlockId: anchor || null },
      });
      // Правки, сделанные во время сохранения, остаются несохранёнными — их запишет следующий проход
      if (editVersion.current === version) setDirty(false);
      return true;
    } catch (err) {
      hb.toast((err as Error).message, 'error');
      setAutoFailed(true);
      return false;
    } finally { setBusy(null); }
  };
  saveRef.current = save;
  const saveOnly = async () => {
    if (await save()) {
      hb.toast(isAdmin ? 'Черновик уточнения сохранён' : 'Черновик сохранён — опубликует администратор факультета');
      reload();
    }
  };
  const publish = async () => {
    if (dirty && !(await save())) return;
    setBusy('publish');
    try {
      await api(hb.url(`/api/handbook-editor/shared/${id}/supplement/publish`), { method: 'POST', body: {} });
      hb.toast('Уточнение опубликовано — студенты видят общую страницу вместе с ним');
      setDirty(false);
      reload();
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  const archive = async () => {
    editVersion.current += 1;
    setBusy('archive');
    try {
      await api(hb.url(`/api/handbook-editor/shared/${id}/supplement/archive`), { method: 'POST', body: {} });
      hb.toast('Уточнение убрано — студенты видят общую страницу как есть');
      setArchiveAsk(false);
      setDirty(false);
      setBlocks([]);
      reload();
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  /** Редактор не публикует сам: дописываем черновик и отправляем администратору факультета. */
  const submit = async () => {
    if (dirty && !(await save())) return;
    setBusy('review');
    try {
      const note = reviewNote.trim();
      await api(hb.url(`/api/handbook-editor/shared/${id}/supplement/review`), { method: 'POST', body: note ? { note } : {} });
      setReviewAsk(false);
      setReviewNote('');
      hb.toast('Отправлено — администратор факультета получит сообщение и опубликует уточнение');
      reload();
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  const createOverride = async () => {
    setBusy('override');
    try {
      const created = await api<{ pageId: string }>(hb.url(`/api/handbook-editor/shared/${id}/override`), { method: 'POST', body: { reason: reason.trim() } });
      setOverrideAsk(false);
      hb.toast('Своя версия создана черновиком — студенты увидят её после публикации');
      hb.nav.replace({ name: 'hb-editor-page', id: created.pageId });
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setBusy(null); }
  };

  // Общая часть с местом уточнения: студент увидит блоки факультета ровно здесь
  const at = anchor ? base.blocks.findIndex((block) => block.id === anchor) : -1;
  const before = at < 0 ? base.blocks : base.blocks.slice(0, at + 1);
  const after = at < 0 ? [] : base.blocks.slice(at + 1);
  const noToggle = () => undefined;
  const inReview = Boolean(supplement?.review);
  const supplementState = inReview
    ? { label: isAdmin ? 'Ждёт вашей публикации' : 'Ждёт публикации', tone: 'warn' as const }
    : !supplement || supplement.status !== 'published'
      ? (blocks.length ? { label: 'Черновик', tone: 'neutral' as const } : null)
      : supplement.hasDraft || dirty ? { label: 'Опубликовано · правки не опубликованы', tone: 'warn' as const } : { label: 'Опубликовано', tone: 'ok' as const };
  const hasNews = dirty || Boolean(supplement && (supplement.hasDraft || supplement.status !== 'published'));
  // Что значит состояние уточнения и что делать дальше — одной строкой под заголовком
  const supplementHelp = inReview
    ? (isAdmin ? 'Проверьте блоки и нажмите «Опубликовать» — студенты факультета увидят общую страницу вместе с уточнением.' : 'Администратор факультета получил сообщение и опубликует уточнение. Пока ждёте, можно продолжать править.')
    : !blocks.length ? 'Видят только студенты этого справочника. Общая часть продолжит обновляться сама.'
      : supplement?.status === 'published' && !hasNews ? 'Студенты видят общую страницу вместе с этим уточнением.'
        : isAdmin ? 'Студенты пока не видят этих блоков. Нажмите «Опубликовать», когда закончите.'
          : 'Студенты пока не видят этих блоков. Опубликовать может администратор факультета — нажмите «На проверку».';

  return (
    <>
      <header className="hb-page__head hb-editor-pagehead">
        <span className="small muted">Общая страница университета · {base.section.title}</span>
        <h1 className="hb-page__title">{base.title}</h1>
      </header>

      {supplement?.baseChangedSince && !changedSeen && base.lastChange ? (
        <section className="card hb-shared-note" role="note">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span className="hb-reader-round" aria-hidden="true"><Icon name="info" /></span>
            <span className="stack" style={{ gap: 4 }}>
              <strong>Университет обновил общую часть</strong>
              <span className="small muted">{dateTime(base.lastChange.at)}{base.lastChange.note ? `: «${base.lastChange.note}»` : ''}. Ваше уточнение осталось на месте.</span>
            </span>
          </div>
          <button type="button" className="linkbtn small" onClick={markSeen}>Понятно</button>
        </section>
      ) : null}

      {supplement?.review && !override ? (
        <section className="card hb-shared-note hb-shared-note--warn" role="note">
          <strong>{isAdmin ? 'Уточнение ждёт вашей публикации' : 'Отправлено на публикацию'}</strong>
          <span className="small muted">
            {supplement.review.by ? `${supplement.review.by}, ` : ''}{dateTime(supplement.review.at)}{supplement.review.note ? `: «${supplement.review.note}»` : ''}.
            {isAdmin ? ' Всё верно — «Опубликовать» внизу. Не подходит — поправьте блоки сами или удалите черновик.' : ' Сообщение придёт в чат, когда администратор опубликует уточнение.'}
          </span>
        </section>
      ) : null}

      {override ? (
        <section className="card hb-shared-note hb-shared-note--warn">
          <strong>У факультета своя версия этой страницы</strong>
          <span className="small muted">Студенты видят её, а не общую. {override.behind ? 'Общую страницу с тех пор обновили — сравните версии.' : ''}</span>
          <Button variant="primary" size="medium" onClick={() => hb.nav.push({ name: 'hb-editor-page', id: override.pageId })}>Открыть свою версию</Button>
        </section>
      ) : null}

      <section className="card hb-shared-source">
        <div className="row" style={{ gap: 12 }}>
          <span className="hb-reader-round" aria-hidden="true"><Icon name="layers" /></span>
          <span className="stack" style={{ gap: 2, minWidth: 0 }}>
            <strong>Из общей базы университета</strong>
            <span className="small muted">{[base.ownerUnit, base.ownerName].filter(Boolean).join(' · ') || 'Ответственный не назначен'}</span>
          </span>
        </div>
        <dl className="hb-kv">
          <dt>Проверено</dt><dd>{base.checkedAt ? dateOnly(String(base.checkedAt).slice(0, 10)) : 'нет'}</dd>
          <dt>Следующая</dt><dd className={overdue ? 'hb-kv--risk' : ''}>{base.reviewAt ? `${dateOnly(base.reviewAt)}${overdue ? ' · просрочена' : ''}` : 'не задана'}</dd>
          <dt>Версия</dt><dd>{base.version}</dd>
        </dl>
      </section>

      <section className="card hb-shared-ro" aria-label="Общая часть">
        <span className="hb-shared-ro__head"><Icon name="lock" size={16} />Общая часть · ведёт университет</span>
        <Blocks blocks={before} today={today} done={new Set()} onToggle={noToggle} headingLevel={2} />
      </section>

      {!override ? <>
        {at >= 0 || blocks.length ? <span className="hb-anchor" aria-hidden="true"><Icon name="pin" size={14} />{at >= 0 ? `после блока ${at + 1}` : 'в конце страницы'}</span> : null}
        <section className="card hb-local-editor" aria-label="Уточнение факультета">
          <div className="row row--between" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="stack" style={{ gap: 2 }}>
              <strong>Уточнение факультета</strong>
              <span className="small muted">{supplementHelp}</span>
            </span>
            {supplementState ? <Pill tone={supplementState.tone}>{supplementState.label}</Pill> : null}
          </div>
          {supplement?.anchorLost ? <span className="small hb-attention">Блок, после которого стояло уточнение, убрали из общей версии — сейчас оно в конце страницы.</span> : null}
          {blocks.map((block, index) => (
            <BlockCard
              key={block.id}
              block={block}
              index={index}
              total={blocks.length}
              defaultOpen={fresh === block.id}
              problem={problems[index]}
              onChange={(next) => edit(blocks.map((item) => (item.id === block.id ? next : item)))}
              onRemove={() => edit(blocks.filter((item) => item.id !== block.id))}
              onMove={(direction) => {
                const next = [...blocks];
                const target = index + direction;
                if (target < 0 || target >= next.length) return;
                [next[index], next[target]] = [next[target]!, next[index]!];
                edit(next);
              }}
            />
          ))}
          <button type="button" className="hb-add" onClick={() => setAdding(true)}><Icon name="plus" size={18} />{blocks.length ? 'Добавить блок' : 'Добавить уточнение'}</button>
          {blocks.length ? (
            <label className="hb-field">
              <span className="hb-field__label">Где показать уточнение</span>
              <select className="hb-input hb-select" value={anchor} onChange={(event) => { setAnchor(event.target.value); setDirty(true); setAutoFailed(false); editVersion.current += 1; }}>
                <option value="">В конце страницы</option>
                {base.blocks.map((block, index) => <option key={block.id} value={block.id}>После: {blockName(block, index)}</option>)}
              </select>
            </label>
          ) : <span className="faint small">Кабинет, часы приёма, контакт или дополнительный шаг — то, что на вашем факультете отличается.</span>}
          {isAdmin && supplement ? <button type="button" className="linkbtn small hb-danger-link" onClick={() => setArchiveAsk(true)}>{supplement.status === 'published' ? 'Убрать уточнение' : 'Удалить черновик уточнения'}</button> : null}
        </section>
      </> : null}

      {after.length ? (
        <section className="card hb-shared-ro" aria-label="Общая часть, продолжение">
          <Blocks blocks={after} today={today} done={new Set()} onToggle={noToggle} headingLevel={2} />
        </section>
      ) : null}

      {!override && isAdmin ? (
        <section className="card hb-shared-choice">
          <SectionTitle>Если порядок на факультете другой</SectionTitle>
          <span className="small muted">Своя версия — копия страницы для вашего факультета. Обновления общей страницы перестанут приходить сами: когда её изменят, вы получите сообщение и сравните версии.</span>
          <Button variant="secondary" size="medium" onClick={() => setOverrideAsk(true)}><Icon name="fork" size={18} />Создать свою версию</Button>
        </section>
      ) : null}

      {!override ? (
        <BottomBar>
          <div className="hb-savebar">
            <span className="hb-savebar__state" role="status" aria-live="polite">
              {dirty ? (busy === 'save' ? 'Сохраняю черновик…' : autoFailed ? 'Черновик не сохранился' : 'Сохраню через секунду…') : inReview ? (isAdmin ? 'Прислал редактор · студенты пока не видят' : 'На проверке у администратора') : supplement?.status === 'published' ? (supplement.hasDraft ? 'Правки сохранены · студенты видят прежнее' : 'Уточнение опубликовано') : blocks.length ? 'Черновик сохранён · студенты не видят' : 'Студенты видят общую страницу как есть'}
              {firstProblem ? <span className="hb-savebar__hint">{isAdmin ? 'Для публикации' : 'Перед отправкой'}: {firstProblem}</span>
                : !blocks.length ? <span className="hb-savebar__hint">Нажмите «Добавить уточнение», если на факультете что-то иначе</span> : null}
            </span>
            {isAdmin ? (
              <Button variant="primary" size="large" loading={busy === 'publish'}
                disabled={busy !== null || !blocks.length || Boolean(firstProblem) || (!dirty && supplement?.status === 'published' && !supplement.hasDraft)}
                onClick={publish}>Опубликовать</Button>
            ) : (
              <Button variant="primary" size="large" loading={busy === 'review'}
                disabled={busy !== null || !blocks.length || Boolean(firstProblem) || !hasNews || (inReview && !dirty)}
                onClick={() => setReviewAsk(true)}>{inReview && !dirty ? 'На проверке' : 'На проверку'}</Button>
            )}
          </div>
          {isAdmin && dirty ? <button type="button" className="linkbtn small" disabled={busy !== null} onClick={saveOnly}>Сохранить черновик, не публикуя</button> : null}
        </BottomBar>
      ) : null}

      {adding ? (
        <AddBlockSheet
          onClose={() => setAdding(false)}
          onPick={(type: BlockType) => {
            const block = emptyBlock(type);
            setFresh(block.id);
            edit([...blocks, block]);
            setAdding(false);
          }}
        />
      ) : null}

      {overrideAsk ? (
        <Sheet title="Создать свою версию?" onClose={() => setOverrideAsk(false)} dirty={reason.trim().length > 0 && busy === null}>
          <ul className="hb-consequences">
            <li><Icon name="copy" size={18} /><span>Страница скопируется в ваш справочник{blocks.length ? ' вместе с уточнением' : ''}. После публикации студенты будут видеть только её.</span></li>
            <li><Icon name="alert" size={18} /><span>Обновления общей страницы перестанут применяться сами. Когда её изменят, придёт сообщение, и вы сравните версии.</span></li>
            <li><Icon name="undo" size={18} /><span>Вернуться к общей версии можно в любой момент.</span></li>
          </ul>
          <label className="hb-field">
            <span className="hb-field__label">Почему порядок отличается — это увидит университет</span>
            <textarea className="hb-textarea" rows={3} maxLength={300} value={reason} placeholder="Например: справки выдаёт только деканат, заявление согласует декан" onChange={(event) => setReason(event.target.value)} />
          </label>
          <Button variant="primary" size="large" loading={busy === 'override'} disabled={busy !== null || reason.trim().length < 5} onClick={createOverride}>Создать свою версию</Button>
          <Button variant="secondary" size="large" onClick={() => { setOverrideAsk(false); setAdding(true); }}><Icon name="pin" size={18} />Лучше добавить уточнение</Button>
        </Sheet>
      ) : null}

      {reviewAsk ? (
        <Sheet title="Отправить на публикацию" onClose={() => setReviewAsk(false)} dirty={reviewNote.trim().length > 0 && busy !== 'review'}>
          <span className="small muted">Администратор факультета получит сообщение в чате, проверит уточнение и опубликует его. До публикации студенты видят общую страницу как есть.</span>
          <label className="hb-field">
            <span className="hb-field__label">Комментарий для администратора (необязательно)</span>
            <textarea className="hb-textarea" rows={3} maxLength={300} value={reviewNote} placeholder="Например: с сентября приём в каб. 214" onChange={(event) => setReviewNote(event.target.value)} />
          </label>
          <Button variant="primary" size="large" loading={busy === 'review'} disabled={busy !== null} onClick={submit}>Отправить на проверку</Button>
        </Sheet>
      ) : null}

      {archiveAsk ? (
        <Sheet title={supplement?.status === 'published' ? 'Убрать уточнение?' : 'Удалить черновик уточнения?'} onClose={() => setArchiveAsk(false)}>
          <span className="muted">{supplement?.status === 'published' ? 'Студенты факультета снова увидят общую страницу без ваших блоков.' : 'Студенты ничего не заметят: они и так видят общую страницу без этих блоков.'}</span>
          <Button variant="destructive" size="large" loading={busy === 'archive'} onClick={archive}>{supplement?.status === 'published' ? 'Убрать уточнение' : 'Удалить черновик'}</Button>
        </Sheet>
      ) : null}
    </>
  );
}
