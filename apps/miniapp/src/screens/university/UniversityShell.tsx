import { useEffect, useRef, useState } from 'react';
import { Button } from '@maxhub/max-ui';
import type { ShowToast } from '../../app/context';
import { api } from '../../lib/api';
import { bridge } from '../../lib/bridge';
import { useLoad, type LoadState } from '../../lib/useLoad';
import { dateOnly, plural, relativeDateTime } from '../../lib/format';
import type { DemoRole, Me } from '../../lib/types';
import { EmptyState, ErrorState, Pill, SectionTitle, Sheet, Skeletons } from '../../components/ui';
import { Icon, type IconName } from '../../components/icons';
import { BaseHandbookEmbed, DemoBanner } from '../handbook/HandbookShell';
import { SHARED_STATE, SharedGuideSheet } from '../handbook/SharedCards';
import { useTheme, type ThemePref } from '../../app/theme';

type UniTab = 'overview' | 'base' | 'faculties' | 'profile';

interface Overview {
  university: { id: string; name: string; shortName: string; isDemo: boolean };
  today: string;
  baseHandbookId: string;
  base: { published: number; drafts: number; review: number; overdue: number; soon: number; freshShare: number | null };
  faculties: Array<{ id: string; shortName: string }>;
  foundShare: number | null;
  searches: number;
  attention: {
    due: Array<{ id: string; title: string; reviewAt: string; ownerUnit: string | null; overdue: boolean }>;
    behind: Array<{ pageId: string; title: string; handbook: string; shortName: string; changedAt: string | null }>;
    pendingInvites: Array<{ personId: string; name: string; faculty: string | null; since: string }>;
    /** Полные числа: в списках — не больше пяти строк. */
    totals?: { due: number; behind: number; pendingInvites: number };
  };
  recent: Array<{ action: string; what: string; title: string | null; faculty: string | null; affected: number | null; actor: string | null; at: string }>;
}

interface Faculty {
  id: string;
  name: string;
  shortName: string;
  handbook: { id: string; title: string; slug: string; link: string } | null;
  ownPages: number;
  supplements: number;
  overrides: number;
  behind: number;
  readers: number;
  freshShare: number | null;
  admins: Array<{ personId: string; name: string; connected: boolean; link: string | null }>;
}

const word = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;
const initials = (name: string) => name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();

/**
 * Кабинет администратора университета: обзор, общая база, факультеты, профиль.
 * Отдельная оболочка рядом со справочником: в доке справочника уже пять вкладок.
 */
export function UniversityShell({
  me,
  toast,
  openHandbook,
  refresh,
  demoRole,
  onResetDemo,
  onChangeDemoRole,
  startTab,
  startPageId,
}: {
  me: Me;
  toast: ShowToast;
  openHandbook: (handbookId: string, start?: string) => void;
  refresh: () => Promise<void>;
  demoRole: DemoRole | null;
  onResetDemo?: () => Promise<void> | void;
  onChangeDemoRole?: (role: DemoRole) => void;
  startTab?: UniTab;
  /** Диплинк uni_<pageId> из напоминания «пора проверить»: сразу страница общей базы. */
  startPageId?: string | null;
}) {
  const [tab, setTab] = useState<UniTab>(startPageId ? 'base' : startTab ?? 'overview');
  // Страница общей базы, которую открыли с обзора: «Пора проверить» ведёт прямо в неё
  const [basePage, setBasePage] = useState<string | null>(startPageId ?? null);
  const [createAsk, setCreateAsk] = useState(false);
  const overview = useLoad((signal) => api<Overview>('/api/university', { signal }), [me.university?.id], `uni:${me.university?.id}`);
  const go = (next: UniTab) => {
    bridge.haptic('tap');
    if (next !== 'base') setBasePage(null);
    setTab(next);
    window.scrollTo({ top: 0 });
  };
  // Обзор перечитываем, когда возвращаются на него после правок в базе; при первом показе он и так загружается
  const shownTab = useRef(tab);
  useEffect(() => {
    if (tab === 'overview' && shownTab.current !== 'overview') overview.reload();
    shownTab.current = tab;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const dock = <UniDock tab={tab} onTab={go} />;
  const banner = demoRole ? <DemoBanner demoRole={demoRole} onResetDemo={onResetDemo} onChangeDemoRole={onChangeDemoRole} /> : null;

  if (tab === 'base') {
    if (!overview.data) return <>{banner}{overview.error ? <ErrorState error={overview.error} onRetry={overview.reload} /> : <Skeletons count={4} />}{dock}</>;
    return (
      <BaseHandbookEmbed
        key={`${overview.data.baseHandbookId}:${basePage ?? ''}`}
        handbookId={overview.data.baseHandbookId}
        initialPageId={basePage}
        toast={toast}
        person={me.person}
        user={me.user}
        openHandbook={openHandbook}
        refresh={refresh}
        dock={dock}
      />
    );
  }
  return (
    <>
      {banner}
      {tab === 'overview' ? <OverviewScreen state={overview} onTab={go} onOpenBasePage={(id) => { setBasePage(id); setTab('base'); window.scrollTo({ top: 0 }); }} onCreate={() => { setCreateAsk(true); go('faculties'); }} /> : null}
      {tab === 'faculties' ? <FacultiesScreen toast={toast} openHandbook={openHandbook} createAsk={createAsk} setCreateAsk={setCreateAsk} onChanged={overview.reload} /> : null}
      {tab === 'profile' ? <ProfileScreen me={me} /> : null}
      {dock}
    </>
  );
}

function UniDock({ tab, onTab }: { tab: UniTab; onTab: (tab: UniTab) => void }) {
  const items: Array<[UniTab, string, IconName]> = [['overview', 'Обзор', 'home'], ['base', 'База', 'layers'], ['faculties', 'Факультеты', 'building'], ['profile', 'Профиль', 'user']];
  return (
    <nav className="hb-dock uni-dock" aria-label="Навигация кабинета университета">
      {items.map(([value, label, icon]) => (
        <button key={value} type="button" aria-label={label} aria-current={tab === value ? 'page' : undefined} onClick={() => onTab(value)}>
          <Icon name={icon} size={22} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function OverviewScreen({ state, onTab, onOpenBasePage, onCreate }: {
  state: LoadState<Overview>;
  onTab: (tab: UniTab) => void;
  onOpenBasePage: (pageId: string) => void;
  onCreate: () => void;
}) {
  const { data, error, loading, reload } = state;
  if (loading && !data) return <Skeletons count={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const firstRun = data.base.published === 0 && data.faculties.length === 0;
  const totals = data.attention.totals ?? { due: data.attention.due.length, behind: data.attention.behind.length, pendingInvites: data.attention.pendingInvites.length };
  const tasks = totals.due + totals.behind + totals.pendingInvites;
  const due = data.attention.due;
  // Списки ограничены пятью строками: остальное — одной строкой «ещё N»
  const hidden = (totals.behind - data.attention.behind.length) + (totals.pendingInvites - data.attention.pendingInvites.length);
  return (
    <>
      <div className="uni-top">
        <span className="uni-space"><span className="uni-space__mark" aria-hidden="true"><Icon name="uni" size={18} /></span>{data.university.name}</span>
      </div>
      <div className="hb-page__head">
        <span className="small uni-eyebrow">Администратор университета</span>
        <h1 className="hb-page__title">Обзор</h1>
      </div>

      {firstRun ? (
        <section className="card uni-start">
          <strong>С чего начать</strong>
          <ol className="uni-steps">
            <li><button type="button" className="linkbtn" onClick={() => onTab('base')}>Заполните общую базу</button><span className="small muted">Справки, стипендии, общежитие, кампус — то, что одинаково для всех факультетов</span></li>
            <li><span>Назначьте ответственных</span><span className="small muted">У каждой общей страницы — подразделение и срок проверки</span></li>
            <li><button type="button" className="linkbtn" onClick={onCreate}>Подключите первый факультет</button><span className="small muted">Администратор получит личную ссылку в MAX</span></li>
          </ol>
        </section>
      ) : null}

      {tasks ? (
        <section className="card uni-attention" aria-label="Требует внимания">
          <div className="row" style={{ gap: 12 }}>
            <span className="hb-reader-round hb-reader-round--warn" aria-hidden="true"><Icon name="alert" /></span>
            <span className="stack" style={{ gap: 2 }}><strong>Требует внимания</strong><span className="small muted">{word(tasks, 'задача', 'задачи', 'задач')}</span></span>
          </div>
          <div className="uni-rows">
            {due.length ? (
              <button type="button" className="hb-row uni-row" onClick={() => onOpenBasePage(due[0]!.id)}>
                <span className="hb-status-dot" data-status="attention" aria-hidden="true" />
                <span className="stack hb-reader-grow"><strong>{totals.due === 1 ? `«${due[0]!.title}» — пора проверить` : `${word(totals.due, 'общая страница', 'общие страницы', 'общих страниц')} пора проверить`}</strong>
                  <span className="small muted">{due[0]!.overdue ? `«${due[0]!.title}» просрочена с ${dateOnly(due[0]!.reviewAt)}` : `Ближайшая — «${due[0]!.title}» до ${dateOnly(due[0]!.reviewAt)}`}{due[0]!.ownerUnit ? ` · ${due[0]!.ownerUnit}` : ''}</span>
                </span><Icon name="chevron" size={18} />
              </button>
            ) : null}
            {data.attention.behind.map((item) => (
              <button key={item.pageId} type="button" className="hb-row uni-row" onClick={() => onTab('faculties')}>
                <span className="hb-status-dot" data-status="attention" aria-hidden="true" />
                <span className="stack hb-reader-grow"><strong>{item.shortName}: своя версия — нужно сверить</strong>
                  <span className="small muted">«{item.title}»: вы обновили общую{item.changedAt ? ` ${dateOnly(String(item.changedAt).slice(0, 10))}` : ''}, а студенты {item.shortName} видят старую версию факультета. Администратору {item.shortName} пришло сообщение</span>
                </span><Icon name="chevron" size={18} />
              </button>
            ))}
            {data.attention.pendingInvites.map((item) => (
              <button key={item.personId} type="button" className="hb-row uni-row" onClick={() => onTab('faculties')}>
                <span className="hb-status-dot" data-status="review" aria-hidden="true" />
                <span className="stack hb-reader-grow"><strong>Администратор ещё не вошёл</strong>
                  <span className="small muted">{item.name}{item.faculty ? `, ${item.faculty}` : ''} · {relativeDateTime(item.since)}</span>
                </span><Icon name="chevron" size={18} />
              </button>
            ))}
            {hidden > 0 ? <button type="button" className="hb-row uni-row small muted" onClick={() => onTab('faculties')}>Ещё {word(hidden, 'задача', 'задачи', 'задач')} — на вкладке «Факультеты»</button> : null}
          </div>
        </section>
      ) : null}

      <div className="uni-tiles">
        <button type="button" className="card uni-tile" onClick={() => onTab('base')}>
          <span className="uni-tile__icon" aria-hidden="true"><Icon name="layers" /></span>
          <span className="uni-tile__big">{data.base.published}</span>
          <span className="uni-tile__label">{plural(data.base.published, 'общая страница', 'общие страницы', 'общих страниц')}</span>
          <span className={`small ${data.base.overdue + data.base.soon ? 'uni-tile__warn' : 'muted'}`}>{data.base.overdue + data.base.soon ? `${data.base.overdue + data.base.soon} пора проверить` : data.base.drafts ? `${word(data.base.drafts, 'черновик', 'черновика', 'черновиков')}` : 'всё проверено'}</span>
        </button>
        <button type="button" className="card uni-tile" onClick={() => onTab('faculties')}>
          <span className="uni-tile__icon" aria-hidden="true"><Icon name="building" /></span>
          <span className="uni-tile__big">{data.faculties.length}</span>
          <span className="uni-tile__label">{plural(data.faculties.length, 'факультет подключён', 'факультета подключено', 'факультетов подключено')}</span>
          <span className="small muted">{data.faculties.map((f) => f.shortName).join(', ') || 'ещё никого'}</span>
        </button>
        <div className="card uni-tile">
          <span className="uni-ring" style={{ ['--p' as string]: data.base.freshShare ?? 0 }} aria-hidden="true" />
          <span className="uni-tile__label">{data.base.freshShare === null ? 'Нечего проверять' : `${data.base.freshShare}% проверено вовремя`}</span>
          <span className="small muted">общая база · цель 90%</span>
        </div>
        <div className="card uni-tile">
          <span className="uni-tile__icon" aria-hidden="true"><Icon name="search" /></span>
          <span className="uni-tile__big">{data.foundShare === null ? '—' : `${data.foundShare}%`}</span>
          <span className="uni-tile__label">нашли ответ сами</span>
          <span className="small muted">{data.searches ? `${word(data.searches, 'запрос', 'запроса', 'запросов')} за 30 дней` : 'запросов пока нет'}</span>
        </div>
      </div>

      {!firstRun ? (
        <section className="uni-dashed">
          <strong>Подключите следующий факультет</strong>
          <span className="small">Справочник сразу получит {word(data.base.published, 'общую страницу', 'общие страницы', 'общих страниц')}. Факультету останется добавить своё.</span>
          <Button variant="secondary" size="medium" onClick={onCreate}><Icon name="plus" size={18} />Подключить факультет</Button>
        </section>
      ) : null}

      {data.recent.length ? <>
        <SectionTitle>Последние изменения</SectionTitle>
        <section className="card uni-recent">
          {data.recent.map((item, index) => (
            <div key={index} className="uni-recent__row">
              <strong className="small">{item.title ?? item.what}</strong>
              <span className="small muted">{item.what}{item.faculty ? ` · ${item.faculty}` : ''}{item.affected ? ` · затронуло ${word(item.affected, 'факультет', 'факультета', 'факультетов')}` : ''}{item.actor ? ` · ${item.actor}` : ''} · {relativeDateTime(item.at)}</span>
            </div>
          ))}
        </section>
      </> : null}
    </>
  );
}

function FacultiesScreen({ toast, openHandbook, createAsk, setCreateAsk, onChanged }: {
  toast: ShowToast;
  openHandbook: (handbookId: string, start?: string) => void;
  createAsk: boolean;
  setCreateAsk: (value: boolean) => void;
  onChanged: () => void;
}) {
  const { data, error, loading, reload } = useLoad((signal) => api<{
    faculties: Faculty[];
    basePublished: number;
    closed?: Array<{ id: string; name: string; shortName: string; closedAt: string; restoreUntil: string | null }>;
    retentionDays?: number;
  }>('/api/university/faculties', { signal }), [], 'uni:faculties');
  // Отключение факультета — с подтверждением названием: одно нажатие не должно закрыть справочник целого факультета
  const [closing, setClosing] = useState<Faculty | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [acting, setActing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [short, setShort] = useState('');
  const [admin, setAdmin] = useState('');
  const [template, setTemplate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ title: string; text: string; link: string; for: string; note: string } | null>(null);
  const ONE_TIME = 'Одноразовая, действует 30 дней. Отправьте её только адресату: по ней человек станет администратором факультета.';

  const share = async (who: string, value: string) => {
    const text = `${who}, вы назначены администратором справочника факультета в «Курсоре». Откройте личную ссылку в MAX:`;
    if (bridge.share(text, value)) return;
    try {
      await navigator.clipboard.writeText(`${text} ${value}`);
      toast('Ссылка скопирована');
    } catch {
      toast('Скопируйте ссылку вручную', 'error');
    }
  };
  const ready = name.trim().length >= 3 && short.trim().length >= 2 && admin.trim().split(/\s+/).length >= 2;
  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const result = await api<{ link: string; skipped: number; sections: number; inherited: boolean }>('/api/university/faculties', {
        method: 'POST', body: { name: name.trim(), shortName: short.trim(), adminFullName: admin.trim(), template },
      });
      setCreateAsk(false);
      setLink({
        title: `${name.trim()} подключён`,
        text: `Справочник ${short.trim()} наследует ${word(data?.basePublished ?? 0, 'общую страницу', 'общие страницы', 'общих страниц')}${template ? ` и получил ${word(result.sections, 'раздел-заготовку', 'раздела-заготовки', 'разделов-заготовок')}` : ''}.${result.skipped ? ` ${word(result.skipped, 'заготовка не создана', 'заготовки не созданы', 'заготовок не создано')}: они уже есть в общей базе.` : ''}`,
        link: result.link,
        for: admin.trim(),
        note: ONE_TIME,
      });
      setName(''); setShort(''); setAdmin('');
      reload();
      onChanged();
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const closeFaculty = async () => {
    if (!closing) return;
    setActing(closing.id);
    try {
      const result = await api<{ handbooks: number; restoreUntil: string | null }>(`/api/university/faculties/${closing.id}/close`, { method: 'POST', body: { confirm: confirmText.trim() } });
      toast(`${closing.shortName} отключён${result.restoreUntil ? ` — восстановить можно до ${dateOnly(result.restoreUntil.slice(0, 10), true)}` : ''}`);
      setClosing(null);
      setConfirmText('');
      reload();
      onChanged();
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setActing(null); }
  };
  const reopenFaculty = async (id: string, shortName: string) => {
    setActing(id);
    try {
      await api(`/api/university/faculties/${id}/reopen`, { method: 'POST', body: {} });
      toast(`${shortName} снова подключён — справочник и команда на месте`);
      reload();
      onChanged();
    } catch (err) { toast((err as Error).message, 'error'); }
    finally { setActing(null); }
  };
  const confirmOk = closing ? [closing.name, closing.shortName].some((value) => value.trim().toLowerCase() === confirmText.trim().toLowerCase()) : false;
  const resend = async (personId: string, who: string) => {
    try {
      const result = await api<{ link: string; renewed?: boolean; expiresAt?: string | null }>(`/api/university/invites/${personId}/resend`, { method: 'POST', body: {} });
      const until = result.expiresAt ? dateOnly(result.expiresAt) : null;
      setLink(result.renewed
        ? { title: 'Новая ссылка', text: 'Прежняя ссылка истекла — эта действует 30 дней.', link: result.link, for: who, note: ONE_TIME }
        : { title: 'Ссылка ещё действует', text: `Отправьте её ещё раз — она работает${until ? ` до ${until}` : ''}, пока ей не воспользовались.`, link: result.link, for: who, note: 'Отправьте её только адресату: по ней человек станет администратором факультета.' });
    } catch (err) { toast((err as Error).message, 'error'); }
  };

  return (
    <>
      <div className="hb-page__head hb-team-heading">
        <span className="stack" style={{ gap: 2 }}><span className="small uni-eyebrow">Университет</span><h1 className="hb-page__title">Факультеты</h1></span>
        <button type="button" className="hb-circle" aria-label="Подключить факультет" onClick={() => setCreateAsk(true)}><Icon name="plus" /></button>
      </div>
      {loading && !data ? <Skeletons count={3} /> : null}
      {error && !data ? <ErrorState error={error} onRetry={reload} /> : null}
      {data && data.faculties.length === 0 ? <EmptyState icon="building" title="Факультетов пока нет">Подключите первый факультет — его администратор получит личную ссылку.</EmptyState> : null}
      {data?.faculties.map((f) => (
        <section key={f.id} className="card uni-faculty">
          <div className="row uni-faculty__head">
            <span className="uni-badge" aria-hidden="true">{f.shortName}</span>
            <span className="stack" style={{ gap: 2, minWidth: 0 }}>
              <strong>{f.name}</strong>
              <span className="small muted">{f.handbook ? `${f.handbook.title} · ${word(f.ownPages, 'своя страница', 'своих страницы', 'своих страниц')}` : 'Справочника ещё нет'}</span>
            </span>
          </div>
          <span className="hb-tags">
            {f.supplements ? <Pill tone={SHARED_STATE.supplement.tone}>{SHARED_STATE.supplement.label}: {word(f.supplements, 'страница', 'страницы', 'страниц')}</Pill> : null}
            {f.overrides - f.behind > 0 ? <Pill tone={SHARED_STATE.override.tone}>{SHARED_STATE.override.label}: {word(f.overrides - f.behind, 'страница', 'страницы', 'страниц')}</Pill> : null}
            {f.behind ? <Pill tone={SHARED_STATE.behind.tone}>Нужно сверить: {word(f.behind, 'страница', 'страницы', 'страниц')}</Pill> : null}
            {f.freshShare !== null ? <Pill tone={f.freshShare >= 90 ? 'ok' : 'warn'}>{f.freshShare}% своих страниц проверено</Pill> : null}
            <Pill tone="neutral">{word(f.readers, 'читатель', 'читателя', 'читателей')}</Pill>
          </span>
          <div className="uni-admins">
            {f.admins.length === 0 ? <span className="small muted">Администратор не назначен</span> : null}
            {f.admins.map((a) => (
              <div key={a.personId} className="row" style={{ gap: 10 }}>
                <span className={`uni-avatar ${a.connected ? '' : 'uni-avatar--pending'}`} aria-hidden="true">{initials(a.name)}</span>
                <span className="stack hb-reader-grow" style={{ gap: 0 }}>
                  <strong className="small">{a.name}</strong>
                  <span className={`small ${a.connected ? 'muted' : 'uni-pending'}`}>{a.connected ? 'Администратор факультета' : 'Ссылка ещё не открыта'}</span>
                </span>
                {!a.connected ? <button type="button" className="linkbtn small" onClick={() => void resend(a.personId, a.name)}>Ссылка</button> : null}
              </div>
            ))}
          </div>
          {f.handbook ? <Button variant="secondary" size="medium" onClick={() => openHandbook(f.handbook!.id)}><Icon name="eye" size={18} />Открыть как студент</Button> : null}
          <button type="button" className="linkbtn small hb-danger-link" disabled={acting !== null} onClick={() => { setConfirmText(''); setClosing(f); }}>Отключить факультет</button>
        </section>
      ))}
      {data?.closed?.length ? <>
        <SectionTitle>Отключённые</SectionTitle>
        {data.closed.map((f) => (
          <section key={f.id} className="card uni-faculty uni-faculty--closed">
            <div className="row uni-faculty__head">
              <span className="uni-badge" aria-hidden="true">{f.shortName}</span>
              <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong>{f.name}</strong>
                <span className="small muted">Студенты и команда факультета не видят справочники{f.restoreUntil ? ` · восстановить можно до ${dateOnly(f.restoreUntil.slice(0, 10), true)}, потом всё удалится насовсем` : ''}</span>
              </span>
            </div>
            <Button variant="secondary" size="medium" loading={acting === f.id} disabled={acting !== null} onClick={() => void reopenFaculty(f.id, f.shortName)}>Восстановить факультет</Button>
          </section>
        ))}
      </> : null}
      {data ? (
        <section className="uni-dashed">
          <strong>Подключить факультет</strong>
          <span className="small">Создаётся справочник с общей базой и заготовками разделов. Администратор входит по личной ссылке в MAX.</span>
          <Button variant="secondary" size="medium" onClick={() => setCreateAsk(true)}><Icon name="plus" size={18} />Подключить</Button>
        </section>
      ) : null}

      {closing ? (
        <Sheet title={`Отключить ${closing.shortName}?`} onClose={() => setClosing(null)} dirty={Boolean(confirmText.trim()) && acting === null}>
          <ul className="hb-consequences">
            <li><Icon name="lock" size={18} /><span>Студенты факультета сразу потеряют доступ: по ссылке и QR они увидят «Справочник закрыт», напоминания прекратятся.</span></li>
            <li><Icon name="team" size={18} /><span>Администратор и редакторы факультета не смогут открыть справочник.</span></li>
            <li><Icon name="layers" size={18} /><span>Общая база университета и другие факультеты не изменятся.</span></li>
            <li><Icon name="undo" size={18} /><span>Всё сохранится {data?.retentionDays ?? 90} дней: восстановить можно одним нажатием в «Отключённых». Потом справочники удалятся насовсем.</span></li>
          </ul>
          <label className="hb-field"><span className="hb-field__label">Чтобы подтвердить, впишите «{closing.shortName}»</span>
            <input className="hb-input" value={confirmText} autoComplete="off" placeholder={closing.shortName} onChange={(event) => setConfirmText(event.target.value)} />
          </label>
          <Button variant="destructive" size="large" loading={acting === closing.id} disabled={!confirmOk || acting !== null} onClick={() => void closeFaculty()}>Отключить факультет</Button>
          <Button variant="secondary" size="large" disabled={acting !== null} onClick={() => setClosing(null)}>Отмена</Button>
        </Sheet>
      ) : null}

      {createAsk ? (
        <Sheet title="Новый факультет" onClose={() => setCreateAsk(false)} dirty={Boolean(name.trim() || short.trim() || admin.trim()) && !busy}>
          <label className="hb-field"><span className="hb-field__label">Название</span>
            <input className="hb-input" value={name} maxLength={160} autoFocus enterKeyHint="next" placeholder="Например: Юридический институт" onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="hb-field"><span className="hb-field__label">Коротко — для меток и подписи «В …»</span>
            <input className="hb-input" value={short} maxLength={12} enterKeyHint="next" placeholder="Например: ЮИ" onChange={(event) => setShort(event.target.value)} />
          </label>
          <label className="hb-field"><span className="hb-field__label">Администратор факультета — фамилия, имя, отчество</span>
            <input className="hb-input" value={admin} maxLength={120} autoComplete="off" enterKeyHint="done" placeholder="Например: Морозова Елена Сергеевна" onChange={(event) => setAdmin(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void create(); }} />
          </label>
          <label className="uni-switch">
            <span className="stack" style={{ gap: 2 }}><strong className="small">Готовая структура справочника</strong><span className="small muted">Разделы и черновики страниц с подсказками, что написать</span></span>
            <input type="checkbox" checked={template} onChange={(event) => setTemplate(event.target.checked)} />
          </label>
          <span className="faint small">{template
            ? 'Факультет получит разделы «Учёба», «Справки и документы», «Физкультура», «Общежитие» и другие, а в них — черновики страниц с подсказкой, что написать. Студенты черновики не видят, пока факультет их не заполнит и не опубликует. Темы, которые уже есть в общей базе, не повторяются.'
            : 'Справочник факультета начнётся с чистого листа: разделы и страницы администратор факультета создаст сам.'}</span>
          <span className="faint small">Общие страницы университета подключаются в любом случае: студенты факультета увидят их, как только откроют справочник.</span>
          <Button variant="primary" size="large" loading={busy} disabled={!ready || busy} onClick={create}>Создать и получить ссылку</Button>
          {!ready && (name || short || admin) ? <span className="faint small">{name.trim().length < 3 ? 'Название — от 3 символов' : short.trim().length < 2 ? 'Короткое название — от 2 символов' : 'Укажите фамилию и имя администратора'}</span> : null}
        </Sheet>
      ) : null}

      {link ? (
        <Sheet title={link.title} onClose={() => setLink(null)}>
          <span className="small">{link.text}</span>
          <label className="hb-field"><span className="hb-field__label">Личная ссылка для: {link.for}</span>
            <input className="hb-input" readOnly value={link.link} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <span className="faint small">{link.note}</span>
          <Button variant="primary" size="large" onClick={() => void share(link.for, link.link)}><Icon name="send" size={18} />Отправить</Button>
        </Sheet>
      ) : null}
    </>
  );
}

const THEMES: Array<{ value: ThemePref; label: string }> = [{ value: 'dark', label: 'Тёмная' }, { value: 'light', label: 'Светлая' }, { value: 'system', label: 'Системная' }];

function ProfileScreen({ me }: { me: Me }) {
  const theme = useTheme();
  const [guide, setGuide] = useState(false);
  const name = [me.user.firstName, me.user.lastName].filter(Boolean).join(' ') || me.person?.fullName || 'Администратор';
  return (
    <>
      <div className="hb-page__head"><h1 className="hb-page__title">Профиль</h1></div>
      <section className="card uni-profile">
        <span className="uni-avatar uni-avatar--lg" aria-hidden="true">{initials(name)}</span>
        <span className="stack" style={{ gap: 2, minWidth: 0 }}>
          <strong>{name}</strong>
          <span className="small muted">Администратор университета · {me.university?.name}</span>
        </span>
      </section>
      <div className="card hb-list">
        <button type="button" className="hb-list__row" onClick={() => setGuide(true)}>
          <span className="hb-reader-round" aria-hidden="true"><Icon name="info" /></span>
          <span className="stack hb-reader-grow" style={{ gap: 2 }}><span className="hb-list__title">Как работает общая база</span><span className="small muted">Статусы страниц и факультетов, что с ними делать</span></span>
          <Icon name="chevron" />
        </button>
      </div>
      {guide ? <SharedGuideSheet onClose={() => setGuide(false)} /> : null}
      <SectionTitle>Что можно в кабинете</SectionTitle>
      <section className="card uni-recent">
        <div className="uni-recent__row"><strong className="small">Общая база</strong><span className="small muted">Публиковать единые инструкции, назначать ответственных и сроки проверки</span></div>
        <div className="uni-recent__row"><strong className="small">Факультеты</strong><span className="small muted">Подключать факультеты и отправлять личные ссылки их администраторам</span></div>
        <div className="uni-recent__row"><strong className="small">Справочники факультетов</strong><span className="small muted">Смотреть со стороны студента. Править их может администратор факультета</span></div>
      </section>
      <div className="card hb-block">
        <h2 className="hb-block__title">Оформление</h2>
        <div className="hb-segment" role="radiogroup" aria-label="Тема оформления">
          {THEMES.map((option) => (
            <button key={option.value} type="button" role="radio" aria-checked={theme.pref === option.value} onClick={() => theme.setPref(option.value)}>{option.label}</button>
          ))}
        </div>
      </div>

    </>
  );
}
