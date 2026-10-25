import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { dateOnly, dateTime, plural, todayIso } from '../../lib/format';
import type { HandbookMember } from '../../lib/types';
import { Pill, Sheet, Skeletons } from '../../components/ui';
import { Icon } from '../../components/icons';
import { StatusGuide } from './StatusGuide';

export interface Ownership {
  ownerPersonId: string | null;
  ownerName: string | null;
  ownerUnit: string | null;
  backupPersonId: string | null;
  backupName: string | null;
  reviewIntervalDays: number;
  checkedAt: string | null;
  reviewAt: string | null;
}

export interface OverrideInfo {
  basePageId: string;
  baseTitle: string;
  baseVersion: number;
  fromVersion: number;
  behind: boolean;
  baseArchived: boolean;
  baseOwnerUnit: string | null;
  reason: string | null;
}

export interface Impact {
  version: number;
  faculties: Array<{
    handbookId: string;
    title: string;
    shortName: string;
    relation: 'inherit' | 'supplement' | 'override';
    supplementStatus: string | null;
    supplementText: string | null;
    anchorLabel: string | null;
    overridePageId: string | null;
    overrideBehind: boolean;
    overrideReason: string | null;
  }>;
  anchors: string[];
  /** null — для всех факультетов. */
  instituteIds?: string[] | null;
  /** Факультеты, которым страница не показывается. */
  excluded?: Array<{ id: string; shortName: string }>;
}

const facultyWord = (n: number) => `${n} ${plural(n, 'факультет', 'факультета', 'факультетов')}`;
/** «ИИТ», «ИИТ и ЭФ», «ИИТ, ЭФ и ЮИ» — без повторов, если у факультета несколько справочников. */
export const listNames = (names: string[]) => {
  const unique = [...new Set(names)];
  return unique.length <= 1 ? unique.join('') : `${unique.slice(0, -1).join(', ')} и ${unique.at(-1)}`;
};
/** Дата через n дней в формате YYYY-MM-DD — для сравнения со сроком проверки. */
const plusDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * Как факультет показывает общую страницу — одни и те же слова везде: в карточке страницы,
 * в списке общей базы, у факультета и в справке «Как это работает».
 */
export type SharedState = 'inherit' | 'supplement' | 'override' | 'behind' | 'excluded';
export const SHARED_STATE: Record<SharedState, { label: string; tone: 'ok' | 'accent' | 'neutral' | 'warn'; students: string; todo: string }> = {
  inherit: {
    label: 'Как в общей', tone: 'ok',
    students: 'Студенты видят общую страницу без изменений. Правки университета доходят сразу.',
    todo: 'Ничего делать не нужно.',
  },
  supplement: {
    label: 'С уточнением', tone: 'accent',
    students: 'Студенты видят общую страницу и блок факультета «В ИИТ» — кабинет, часы, контакт. Правки университета доходят сразу, уточнение остаётся на месте.',
    todo: 'Ничего делать не нужно. Уточнение ведёт факультет.',
  },
  override: {
    label: 'Своя версия', tone: 'neutral',
    students: 'Студенты видят версию факультета вместо общей: у факультета порядок другой, причину он указал.',
    todo: 'Следите, чтобы причина оставалась в силе. Правки университета до этой версии сами не доходят.',
  },
  behind: {
    label: 'Своя версия · нужно сверить', tone: 'warn',
    students: 'Студенты видят версию факультета, а университет уже изменил общую страницу. Факультет ещё не сверил свою версию с новой.',
    todo: 'Администратор факультета получил сообщение. Он сравнит версии и перенесёт изменения, отметит «учтено» или вернётся к общей.',
  },
  excluded: {
    label: 'Не показывается', tone: 'neutral',
    students: 'Страница не для этого факультета — его студенты её не видят.',
    todo: 'Чтобы показать, отметьте факультет в блоке «Для каких факультетов».',
  },
};
export const sharedState = (f: { relation: Impact['faculties'][number]['relation']; overrideBehind?: boolean }): SharedState =>
  f.relation === 'override' ? (f.overrideBehind ? 'behind' : 'override') : f.relation;

/** Кто видит общую страницу и как: одна строка на факультет, понятным языком. */
export function ImpactCard({ impact }: { impact: Impact | null }) {
  const [help, setHelp] = useState(false);
  if (!impact) return <Skeletons count={1} />;
  const groups = (state: SharedState) => listNames(impact.faculties.filter((f) => sharedState(f) === state).map((f) => f.shortName));
  const total = new Set(impact.faculties.map((f) => f.shortName)).size;
  const summary = [
    groups('inherit') && `${groups('inherit')} — как в общей`,
    groups('supplement') && `${groups('supplement')} — с уточнением`,
    groups('override') && `${groups('override')} — своя версия`,
    groups('behind') && `${groups('behind')} — своя версия, нужно сверить`,
  ].filter(Boolean).join('; ');
  return (
    <section className="card hb-impact" aria-label="Кто видит страницу">
      <div className="row" style={{ gap: 12 }}>
        <span className="hb-reader-round" aria-hidden="true"><Icon name="building" /></span>
        <span className="stack" style={{ gap: 2 }}>
          <strong>{total ? `Страницу видят студенты ${total} ${total % 10 === 1 && total % 100 !== 11 ? 'факультета' : 'факультетов'}` : 'Факультетов пока нет'}</strong>
          <span className="small muted">{total ? summary : 'Подключите факультет в кабинете университета'}</span>
        </span>
      </div>
      {impact.faculties.length ? (
        <ul className="hb-impact__list">
          {impact.faculties.map((f) => {
            const state = sharedState(f);
            const meta = SHARED_STATE[state];
            return (
              <li key={f.handbookId}>
                <span className="hb-impact__badge" aria-hidden="true">{f.shortName}</span>
                <span className="stack" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}><strong className="small">{f.title}</strong><Pill tone={meta.tone}>{meta.label}</Pill></span>
                  <span className="small muted">
                    {state === 'inherit' ? 'Общая страница без изменений'
                      : state === 'supplement' ? `Под ${f.anchorLabel ? `блоком «${f.anchorLabel}»` : 'общим текстом'} — уточнение факультета: «${f.supplementText ?? ''}»`
                        : `Вместо общей — версия факультета${f.overrideReason ? `. Причина: «${f.overrideReason}»` : ''}${state === 'behind' ? '. Ваши последние правки в неё не попали' : ''}`}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {impact.excluded?.length ? <span className="small muted">Не показывается: {listNames(impact.excluded.map((f) => f.shortName))} — страница не для этих факультетов.</span> : null}
      <button type="button" className="linkbtn small" onClick={() => setHelp(true)}>Что значат эти статусы</button>
      {help ? <SharedGuideSheet onClose={() => setHelp(false)} /> : null}
    </section>
  );
}

/** Для каких факультетов общая страница: все или выбранные. Действует сразу, без публикации. */
export function FacultyScopeCard({ pageId, scope, isAdmin, onChanged }: {
  pageId: string;
  scope: { selected: string[] | null; options: Array<{ id: string; name: string; shortName: string }> };
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const hb = useHandbook();
  const [selected, setSelected] = useState<string[] | null>(scope.selected);
  const [busy, setBusy] = useState(false);
  const save = async (next: string[] | null) => {
    if (next && next.length === 0) { hb.toast('Выберите хотя бы один факультет или «Все факультеты»', 'error'); return; }
    const before = selected;
    setSelected(next);
    setBusy(true);
    try {
      await api(hb.url(`/api/handbook-editor/pages/${pageId}/faculties`), { method: 'PATCH', body: { instituteIds: next } });
      const names = next ? listNames(scope.options.filter((o) => next.includes(o.id)).map((o) => o.shortName)) : null;
      hb.toast(names ? `Сохранено: страницу видят только ${names}` : 'Сохранено: страницу видят все факультеты');
      onChanged();
    } catch (err) {
      setSelected(before);
      hb.toast((err as Error).message, 'error');
    } finally { setBusy(false); }
  };
  const toggle = (id: string) => {
    const current = selected ?? scope.options.map((o) => o.id);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    void save(next.length === scope.options.length ? null : next);
  };
  return (
    <section className="card hb-scope" aria-label="Для каких факультетов">
      <div className="stack" style={{ gap: 2 }}>
        <strong>Для каких факультетов</strong>
        <span className="small muted">{selected ? 'Страницу видят только отмеченные факультеты. Остальные её не видят — ни в разделах, ни в поиске.' : 'Страницу видят студенты всех факультетов, в том числе подключённых позже.'}</span>
      </div>
      <div className="hb-chips" role="group" aria-label="Факультеты">
        <button type="button" className={`hb-chip ${selected === null ? 'hb-chip--on' : ''}`} aria-pressed={selected === null} disabled={!isAdmin || busy} onClick={() => void save(null)}>Все факультеты</button>
        {scope.options.map((o) => {
          const on = selected === null || selected.includes(o.id);
          // Отмечены факультеты, которые видят страницу: при «Все факультеты» — все
          return <button key={o.id} type="button" title={o.name} className={`hb-chip ${on ? 'hb-chip--on' : ''}`} aria-pressed={on} disabled={!isAdmin || busy} onClick={() => toggle(o.id)}>{on ? '✓ ' : ''}{o.shortName}</button>;
        })}
      </div>
      {!isAdmin ? <span className="faint small">Выбор меняет администратор общей базы.</span> : <span className="faint small">Отмеченные факультеты видят страницу. Нажмите на факультет, чтобы убрать или вернуть его; «Все факультеты» — показывать всем, в том числе новым. Действует сразу, публиковать не нужно.</span>}
    </section>
  );
}

/** Справка: как работает общая база и что значат статусы — для университета и факультета. */
export function SharedGuideSheet({ onClose, isAdmin = true }: { onClose: () => void; isAdmin?: boolean }) {
  return (
    <Sheet title="Как работает общая база" onClose={onClose}>
      <SharedGuide isAdmin={isAdmin} />
    </Sheet>
  );
}

export function SharedGuide({ isAdmin = true }: { isAdmin?: boolean }) {
  return (
    <div className="hb-guide">
      <section className="hb-guide__part">
        <strong>Главное</strong>
        <span className="small">Университет пишет общую инструкцию один раз — её видят студенты всех факультетов. Факультет может дописать своё (кабинет, часы, контакт) или, если порядок у него действительно другой, завести свою версию с причиной.</span>
      </section>
      <section className="hb-guide__part">
        <strong>Как обновить инструкцию</strong>
        <ol className="hb-guide__steps">
          <li>«База» → откройте страницу → исправьте текст.</li>
          <li>«Опубликовать правки» — вы увидите, у кого что изменится, и можете написать, что поменялось.</li>
          <li>Факультеты «как в общей» и «с уточнением» получают новую версию сразу. Факультетам со своей версией приходит сообщение — они сверяются сами.</li>
        </ol>
      </section>
      <StatusGuide isBase isAdmin={isAdmin} />
    </div>
  );
}

/** Ответственный, замена и срок проверки; «Проверено, всё верно» — подтверждение без новой публикации. */
export function OwnershipCard({ pageId, ownership, isAdmin, published, onChanged }: { pageId: string; ownership: Ownership; isAdmin: boolean; published: boolean; onChanged: () => void }) {
  const hb = useHandbook();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = todayIso();
  const overdue = Boolean(ownership.reviewAt && ownership.reviewAt.slice(0, 10) < today);
  const soon = !overdue && Boolean(ownership.reviewAt && ownership.reviewAt.slice(0, 10) <= plusDays(today, 14));
  // Подтвердить может администратор, ответственный или его замена — так же решает сервер
  const canVerify = isAdmin || (Boolean(hb.person?.id) && (hb.person?.id === ownership.ownerPersonId || hb.person?.id === ownership.backupPersonId));
  const verify = async () => {
    setBusy(true);
    try {
      const result = await api<{ reviewAt: string }>(hb.url(`/api/handbook-editor/pages/${pageId}/verify`), { method: 'POST', body: {} });
      hb.toast(`Актуальность подтверждена — следующая проверка ${dateOnly(result.reviewAt)}`);
      onChanged();
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <section className={`card hb-ownership ${overdue ? 'hb-ownership--overdue' : ''}`} aria-label="Кто отвечает">
      <div className="row row--between" style={{ gap: 8 }}>
        <span className="row" style={{ gap: 12 }}>
          <span className="hb-reader-round" aria-hidden="true"><Icon name="shield" /></span>
          <strong>Кто отвечает</strong>
        </span>
        {isAdmin ? <button type="button" className="linkbtn small" onClick={() => setEditing(true)}>Изменить</button> : null}
      </div>
      <dl className="hb-kv">
        <dt>Подразделение</dt><dd>{ownership.ownerUnit ?? 'не указано'}</dd>
        <dt>Ответственный</dt><dd>{ownership.ownerName ?? 'не назначен'}</dd>
        <dt>Замена</dt><dd>{ownership.backupName ?? 'нет'}</dd>
        <dt>Проверено</dt><dd>{ownership.checkedAt ? dateOnly(String(ownership.checkedAt).slice(0, 10), true) : 'ещё не проверяли'}</dd>
        <dt>Следующая</dt><dd className={overdue ? 'hb-kv--risk' : soon ? 'hb-kv--warn' : ''}>{ownership.reviewAt ? `${dateOnly(ownership.reviewAt.slice(0, 10), true)}${overdue ? ' · просрочена' : soon ? ' · скоро' : ''}` : 'после публикации'} · раз в {ownership.reviewIntervalDays} {plural(ownership.reviewIntervalDays, 'день', 'дня', 'дней')}</dd>
      </dl>
      {published && canVerify ? <Button variant={overdue || soon ? 'primary' : 'secondary'} size="medium" loading={busy} disabled={busy} onClick={verify}><Icon name="badge" size={18} />Проверено, всё верно</Button> : null}
      {published && canVerify ? <span className="faint small">Нажмите, если сверили страницу и ничего не изменилось: срок проверки продлится без новой публикации.</span> : null}
      {editing ? <OwnershipSheet pageId={pageId} ownership={ownership} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} /> : null}
    </section>
  );
}

function OwnershipSheet({ pageId, ownership, onClose, onSaved }: { pageId: string; ownership: Ownership; onClose: () => void; onSaved: () => void }) {
  const hb = useHandbook();
  const members = useLoad((signal) => api<{ members: HandbookMember[] }>(hb.url('/api/handbook-editor/members'), { signal }), [hb.handbookId]);
  const [unit, setUnit] = useState(ownership.ownerUnit ?? '');
  const [owner, setOwner] = useState(ownership.ownerPersonId ?? '');
  const [backup, setBackup] = useState(ownership.backupPersonId ?? '');
  const [interval, setIntervalDays] = useState(ownership.reviewIntervalDays);
  const [busy, setBusy] = useState(false);
  // Текущий ответственный может быть не в команде справочника (например, сотрудник подразделения) — не теряем его в списке
  const people = [...(members.data?.members ?? []).map((m) => ({ id: m.personId, name: m.fullName }))];
  if (ownership.ownerPersonId && !people.some((p) => p.id === ownership.ownerPersonId)) people.unshift({ id: ownership.ownerPersonId, name: ownership.ownerName ?? 'Текущий ответственный' });
  if (ownership.backupPersonId && !people.some((p) => p.id === ownership.backupPersonId)) people.unshift({ id: ownership.backupPersonId, name: ownership.backupName ?? 'Текущая замена' });
  const samePerson = Boolean(owner) && owner === backup;
  // В замене нет того, кто уже отвечает за страницу
  const backupChoices = people.filter((p) => p.id !== owner);
  const save = async () => {
    if (samePerson) return;
    setBusy(true);
    try {
      await api(hb.url(`/api/handbook-editor/pages/${pageId}/ownership`), {
        method: 'PATCH',
        body: { ownerUnit: unit.trim() || null, ownerPersonId: owner || null, backupPersonId: backup || null, reviewIntervalDays: interval },
      });
      hb.toast('Ответственный и срок проверки сохранены');
      onSaved();
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet title="Кто отвечает за страницу" onClose={onClose} dirty={!busy && (unit !== (ownership.ownerUnit ?? '') || owner !== (ownership.ownerPersonId ?? '') || backup !== (ownership.backupPersonId ?? '') || interval !== ownership.reviewIntervalDays)}>
      <label className="hb-field"><span className="hb-field__label">Подразделение</span>
        <input className="hb-input" value={unit} maxLength={120} placeholder="Например: Бухгалтерия" onChange={(event) => setUnit(event.target.value)} />
      </label>
      <label className="hb-field"><span className="hb-field__label">Ответственный</span>
        <select className="hb-input hb-select" value={owner} onChange={(event) => {
          const next = event.target.value;
          setOwner(next);
          // Замена — всегда другой человек: если ответственным выбрали того, кто был заменой, замену снимаем
          if (next && next === backup) setBackup('');
        }}>
          <option value="">Не назначен</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="hb-field"><span className="hb-field__label">Замена на время отпуска</span>
        <select className="hb-input hb-select" value={backup} onChange={(event) => setBackup(event.target.value)}>
          <option value="">Нет</option>
          {backupChoices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {owner && backupChoices.length === 0 ? <span className="faint small">Замену можно выбрать из команды справочника: пригласите коллегу в «Команде».</span> : null}
      </label>
      <label className="hb-field"><span className="hb-field__label">Как часто проверять</span>
        <select className="hb-input hb-select" value={interval} onChange={(event) => setIntervalDays(Number(event.target.value))}>
          {[30, 90, 180, 365].map((n) => <option key={n} value={n}>{n === 30 ? 'Раз в месяц' : n === 90 ? 'Раз в квартал' : n === 180 ? 'Раз в полгода' : 'Раз в год'}</option>)}
        </select>
      </label>
      {samePerson ? <span className="small hb-attention">Замена — другой человек: выберите не того, кто уже отвечает за страницу.</span> : null}
      <span className="faint small">Когда подойдёт срок, ответственному и замене придёт сообщение в MAX; если их нет — администраторам. Просроченные страницы видны на обзоре.</span>
      <Button variant="primary" size="large" loading={busy} disabled={busy || samePerson} onClick={save}>Сохранить</Button>
    </Sheet>
  );
}

interface Compare {
  baseTitle: string;
  fromVersion: number;
  toVersion: number;
  versions: Array<{ version: number; note: string | null; at: string; author: string | null }>;
  changes: Array<{ kind: 'changed' | 'added' | 'removed'; label: string; before: string | null; after: string | null }>;
  fullBase: Array<{ label: string; text: string }> | null;
}

/** Своя версия общей страницы: откуда она, и что делать, если общую обновили. */
export function OverrideCard({ pageId, override, isAdmin, onChanged }: { pageId: string; override: OverrideInfo; isAdmin: boolean; onChanged: () => void }) {
  const hb = useHandbook();
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState<null | 'ack' | 'revert'>(null);
  const [revertAsk, setRevertAsk] = useState(false);
  const ack = async () => {
    setBusy('ack');
    try {
      await api(hb.url(`/api/handbook-editor/pages/${pageId}/override/ack`), { method: 'POST', body: {} });
      hb.toast('Отмечено: своя версия сверена с общей');
      setComparing(false);
      onChanged();
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  const revert = async () => {
    setBusy('revert');
    try {
      await api(hb.url(`/api/handbook-editor/pages/${pageId}/override/revert`), { method: 'POST', body: {} });
      hb.toast('Студенты снова видят общую страницу');
      setRevertAsk(false);
      hb.nav.replace({ name: 'hb-shared-page', id: override.basePageId });
    } catch (err) { hb.toast((err as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  return (
    <>
      {override.behind ? (
        <section className="card hb-shared-note hb-shared-note--warn" role="alert">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <span className="hb-reader-round hb-reader-round--warn" aria-hidden="true"><Icon name="alert" /></span>
            <span className="stack" style={{ gap: 4 }}>
              <strong>Общая страница изменилась</strong>
              <span className="small muted">Вашу версию сделали из версии {override.fromVersion}, общая сейчас — версия {override.baseVersion}. Студенты по-прежнему видят вашу.</span>
            </span>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" size="medium" onClick={() => setComparing(true)}><Icon name="compare" size={18} />Сравнить</Button>
            {isAdmin ? <button type="button" className="linkbtn" onClick={() => setRevertAsk(true)}>Вернуться к общей</button> : null}
          </div>
        </section>
      ) : null}
      <section className="card hb-override-info">
        <div className="row" style={{ gap: 12 }}>
          <span className="hb-reader-round" aria-hidden="true"><Icon name="fork" /></span>
          <span className="stack" style={{ gap: 2, minWidth: 0 }}>
            <strong>Своя версия общей страницы</strong>
            <span className="small muted">«{override.baseTitle}»{override.baseOwnerUnit ? ` · ${override.baseOwnerUnit}` : ''}</span>
          </span>
        </div>
        <dl className="hb-kv">
          <dt>Сверена с</dt><dd>версией {override.fromVersion}{override.behind ? ` · общая уже ${override.baseVersion}` : ' · актуальна'}</dd>
          {override.reason ? <><dt>Причина</dt><dd>{override.reason}</dd></> : null}
          {override.baseArchived ? <><dt>Общая</dt><dd>снята с публикации</dd></> : null}
        </dl>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          {!override.behind ? <button type="button" className="linkbtn small" onClick={() => setComparing(true)}>Что менялось в общей</button> : null}
          {isAdmin && !override.behind ? <button type="button" className="linkbtn small" onClick={() => setRevertAsk(true)}>Вернуться к общей версии</button> : null}
        </div>
      </section>
      {comparing ? <CompareSheet pageId={pageId} behind={override.behind} isAdmin={isAdmin} busy={busy} onAck={ack} onRevert={() => { setComparing(false); setRevertAsk(true); }} onClose={() => setComparing(false)} /> : null}
      {revertAsk ? (
        <Sheet title="Вернуться к общей версии?" onClose={() => setRevertAsk(false)}>
          <span className="muted">Своя версия уйдёт в архив, студенты сразу увидят общую страницу. Если на факультете что-то отличается, добавьте к общей уточнение.</span>
          <Button variant="destructive" size="large" loading={busy === 'revert'} disabled={busy !== null} onClick={revert}>Вернуться к общей</Button>
        </Sheet>
      ) : null}
    </>
  );
}

function CompareSheet({ pageId, behind, isAdmin, busy, onAck, onRevert, onClose }: { pageId: string; behind: boolean; isAdmin: boolean; busy: null | 'ack' | 'revert'; onAck: () => void; onRevert: () => void; onClose: () => void }) {
  const hb = useHandbook();
  const { data, loading } = useLoad((signal) => api<Compare>(hb.url(`/api/handbook-editor/pages/${pageId}/compare`), { signal }), [pageId]);
  return (
    <Sheet title={behind ? 'Что изменилось в общей' : 'История общей страницы'} onClose={onClose}>
      {loading && !data ? <Skeletons count={2} /> : null}
      {data ? <>
        <span className="small muted">Версия {data.fromVersion} → версия {data.toVersion}{data.versions.at(-1) ? ` · ${dateTime(data.versions.at(-1)!.at)}${data.versions.at(-1)!.author ? ` · ${data.versions.at(-1)!.author}` : ''}` : ''}</span>
        {data.versions.filter((v) => v.note).map((v) => <span key={v.version} className="small">«{v.note}»</span>)}
        {data.changes.length === 0 && !data.fullBase ? <span className="muted">Общая страница не менялась с тех пор, как вы сверяли свою версию.</span> : null}
        {data.changes.map((change, index) => (
          <div key={index} className="hb-diff">
            <span className="hb-diff__label">{change.kind === 'added' ? `Новый блок · ${change.label}` : change.kind === 'removed' ? `Убран блок · ${change.label}` : change.label}</span>
            {change.before ? <span className="hb-diff__del">{change.before}</span> : null}
            {change.after ? <span className="hb-diff__add">{change.after}</span> : null}
          </div>
        ))}
        {data.fullBase ? data.fullBase.map((block, index) => <div key={index} className="hb-diff"><span className="hb-diff__label">{block.label}</span><span>{block.text}</span></div>) : null}
        {behind && isAdmin ? <>
          <span className="faint small">Перенесите нужное в свою версию в редакторе ниже и опубликуйте — или отметьте, что изменения учтены.</span>
          <Button variant="primary" size="large" loading={busy === 'ack'} disabled={busy !== null} onClick={onAck}><Icon name="done" size={18} />Учтено, оставить как есть</Button>
          <Button variant="destructive" size="large" disabled={busy !== null} onClick={onRevert}>Вернуться к общей версии</Button>
        </> : null}
      </> : null}
    </Sheet>
  );
}

/** Лист перед публикацией общей страницы: кого коснётся и что останется у факультетов. */
export function PublishBaseSheet({ impact, busy, onPublish, onClose }: { impact: Impact; busy: boolean; onPublish: (note: string) => void; onClose: () => void }) {
  const [note, setNote] = useState('');
  const using = impact.faculties.filter((f) => f.relation !== 'override');
  const own = impact.faculties.filter((f) => f.relation === 'override');
  const usingCount = new Set(using.map((f) => f.shortName)).size;
  return (
    <Sheet title={usingCount ? `Опубликовать для ${facultyWord(usingCount)}?` : 'Опубликовать правки?'} onClose={onClose} dirty={note.trim().length > 0 && !busy}>
      <span className="small muted">{usingCount ? `Студенты ${listNames(using.map((f) => f.shortName))} увидят новую общую часть сразу после публикации.` : 'У всех факультетов своя версия этой страницы — они получат сообщение и сравнят версии.'}</span>
      <ul className="hb-impact__list hb-impact__list--sheet">
        {impact.faculties.map((f) => (
          <li key={f.handbookId}>
            <span className="hb-impact__badge" aria-hidden="true">{f.shortName}</span>
            <span className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
              <strong className="small">{f.title}</strong>
              <span className="small muted">{f.relation === 'supplement' ? 'Студенты сразу увидят новую версию, уточнение факультета останется на месте' : f.relation === 'override' ? 'У факультета своя версия: она не изменится, администратору придёт сообщение сверить' : 'Студенты сразу увидят новую версию'}</span>
            </span>
            <Icon name={f.relation === 'override' ? 'alert' : 'done'} size={18} />
          </li>
        ))}
      </ul>
      <label className="hb-field"><span className="hb-field__label">Что изменилось — увидят администраторы факультетов</span>
        <textarea className="hb-textarea" rows={2} maxLength={300} value={note} placeholder="Например: заявку теперь оставляют в личном кабинете" onChange={(event) => setNote(event.target.value)} />
      </label>
      {own.length ? <span className="faint small">У {listNames(own.map((f) => f.shortName))} своя версия — их администраторы получат сообщение «общая страница обновилась».</span> : null}
      <Button variant="primary" size="large" loading={busy} disabled={busy} onClick={() => onPublish(note.trim())}>Опубликовать</Button>
    </Sheet>
  );
}
