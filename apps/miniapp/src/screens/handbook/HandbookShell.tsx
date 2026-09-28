import { useMemo, useState, type ReactNode } from 'react';
import type { ShowToast } from '../../app/context';
import type { DemoRole, Me, Person } from '../../lib/types';
import { DEMO_ROLES, demoRoleName } from '../../lib/demo';
import { ConfirmSheet, Sheet } from '../../components/ui';
import { Icon, type IconName } from '../../components/icons';
import { CrumbsActionProvider, HandbookProvider, useHandbook, type HandbookRoute } from './context';
import { HandbookHome } from './HandbookHome';
import { HandbookSection } from './HandbookSection';
import { HandbookPage } from './HandbookPage';
import { HandbookSearch } from './HandbookSearch';
import { HandbookProfile } from './HandbookProfile';
import { HandbookAsk } from './HandbookAsk';
import { HandbookEditor } from './HandbookEditor';
import { HandbookEditorPage } from './HandbookEditorPage';
import { HandbookAnalytics } from './HandbookAnalytics';
import { HandbookTeam } from './HandbookTeam';
import { HandbookCreate } from './HandbookCreate';
import { HandbookList } from './HandbookList';
import { HandbookAnnouncements } from './HandbookAnnouncements';
import { HandbookContents } from './HandbookContents';
import { HandbookDeadlines } from './HandbookDeadlines';
import { handbookStartRoutes } from './links';


/** Экран текущего маршрута. Ключ по маршруту: соседняя страница — новый экран, без состояния прежнего. */
function Screen() {
  const { nav } = useHandbook();
  return <RouteScreen key={JSON.stringify(nav.route)} route={nav.route} />;
}

function RouteScreen({ route }: { route: HandbookRoute }) {
  switch (route.name) {
    case 'hb-home':
      return <HandbookHome />;
    case 'hb-contents':
      return <HandbookContents />;
    case 'hb-deadlines':
      return <HandbookDeadlines />;
    case 'hb-section':
      return <HandbookSection slug={route.slug} />;
    case 'hb-page':
      return <HandbookPage id={route.id} />;
    case 'hb-search':
      return <HandbookSearch q={route.q} />;
    case 'hb-profile':
      return <HandbookProfile />;
    case 'hb-ask':
      return <HandbookAsk q={route.q} />;
    case 'hb-editor':
      return <HandbookEditor />;
    case 'hb-editor-page':
      return <HandbookEditorPage id={route.id} />;
    case 'hb-analytics':
      return <HandbookAnalytics />;
    case 'hb-team':
      return <HandbookTeam />;
    case 'hb-create':
      return <HandbookCreate />;
    case 'hb-handbooks':
      return <HandbookList />;
    case 'hb-announcements':
      return <HandbookAnnouncements initialTab={route.tab} />;
    default:
      return null;
  }
}

/** Подпись «Назад»: куда вернёт стрелка. */
const BACK_LABEL: Record<HandbookRoute['name'], string> = {
  'hb-home': 'Главная', 'hb-contents': 'Разделы', 'hb-deadlines': 'Сроки', 'hb-section': 'Раздел', 'hb-page': 'Страница',
  'hb-search': 'Поиск', 'hb-profile': 'Профиль', 'hb-ask': 'Вопрос', 'hb-editor': 'Редакция', 'hb-editor-page': 'Страница',
  'hb-analytics': 'Аналитика', 'hb-team': 'Команда', 'hb-create': 'Справочники', 'hb-handbooks': 'Справочники', 'hb-announcements': 'Объявления',
};

/**
 * Основные разделы: доступ команды определяется членством в открытом справочнике.
 * У команды пять вкладок: «Редактор» и «Команда» объединены в «Редакцию» — подписи не сжимаются.
 */
function HandbookDock() {
  const { nav, editorRole } = useHandbook();
  if (nav.route.name === 'hb-editor-page') return null;
  const items: Array<{ label: string; icon: IconName; route: HandbookRoute; active: string[] }> = [
    { label: 'Главная', icon: 'home', route: { name: 'hb-home' }, active: ['hb-home', 'hb-announcements', 'hb-deadlines'] },
    { label: 'Разделы', icon: 'list', route: { name: 'hb-contents' }, active: ['hb-contents', 'hb-section', 'hb-page'] },
    { label: 'Поиск', icon: 'search', route: { name: 'hb-search', q: '' }, active: ['hb-search', 'hb-ask'] },
    ...(editorRole ? [
      { label: 'Редакция', icon: 'edit' as const, route: { name: 'hb-editor' as const }, active: ['hb-editor', 'hb-editor-page', 'hb-analytics', 'hb-handbooks', 'hb-create', 'hb-team'] },
    ] : []),
    { label: 'Профиль', icon: 'user', route: { name: 'hb-profile' }, active: ['hb-profile'] },
  ];
  return (
    <nav className="hb-dock" aria-label="Навигация справочника">
      {items.map((item) => (
        <button key={item.label} type="button" aria-label={item.label}
          aria-current={item.active.includes(nav.route.name) ? 'page' : undefined}
          onClick={() => nav.tab(item.route)}>
          <Icon name={item.icon} size={22} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

/**
 * Шапка вложенных экранов. На главной шапку рисует сама главная (название, вход в редактор).
 * В вебе нужна своя кнопка «Назад»: в клиенте MAX её роль играет системная кнопка.
 */
function HandbookChrome({
  demoRole,
  onResetDemo,
  onChangeDemoRole,
}: {
  demoRole: DemoRole | null;
  onResetDemo?: () => Promise<void> | void;
  onChangeDemoRole?: (role: DemoRole) => void;
}) {
  const { nav, editorRole, person } = useHandbook();
  const studentPreview = (Boolean(editorRole) || person?.role === 'dean') && ['hb-home', 'hb-contents', 'hb-section', 'hb-search', 'hb-deadlines', 'hb-announcements', 'hb-ask'].includes(nav.route.name);
  const inner = nav.depth > 1;
  const [picking, setPicking] = useState(false);
  const [crumbAction, setCrumbAction] = useState<ReactNode>(null);
  // «Сбросить» стирает всю песочницу — только после подтверждения (confirm() в MAX не работает)
  const [resetAsk, setResetAsk] = useState(false);
  const [resetting, setResetting] = useState(false);

  return (
    <>
      {demoRole && !inner ? (
        <div className="banner">
          <span className="hb-banner-text">
            <span><strong>Демо</strong> · вы {demoRoleName(demoRole)}{studentPreview ? '' : ' · данные вымышлены'}</span>
            {studentPreview ? <span className="hb-banner-preview">Предпросмотр со стороны студента</span> : null}
          </span>
          <span className="banner__actions">
            {onChangeDemoRole ? (
              <button type="button" onClick={() => setPicking(true)}>
                Роль
              </button>
            ) : null}
            {onResetDemo ? (
              <button type="button" onClick={() => setResetAsk(true)}>
                Сбросить
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      {resetAsk && onResetDemo ? (
        <ConfirmSheet
          title="Сбросить демо?"
          text="Созданные вами страницы, ответы, объявления и отметки пропадут — демо начнётся заново. Сменить роль можно без сброса: кнопка «Роль»."
          confirmLabel="Сбросить демо"
          busy={resetting}
          onClose={() => setResetAsk(false)}
          onConfirm={async () => {
            setResetting(true);
            try {
              await onResetDemo();
            } finally {
              setResetting(false);
              setResetAsk(false);
            }
          }}
        />
      ) : null}
      {picking && demoRole && onChangeDemoRole ? (
        <Sheet title="Кем посмотреть демо" onClose={() => setPicking(false)}>
          <span className="faint small">Всё, что вы сделали, сохранится. В настоящем вузе роль выдаёт деканат личной ссылкой.</span>
          <div className="stack" role="radiogroup" aria-label="Роль в демо">
            {DEMO_ROLES.map((item) => (
              <button
                key={item.role}
                type="button"
                role="radio"
                aria-checked={item.role === demoRole}
                className={`role-card ${item.role === demoRole ? 'role-card--on' : ''}`}
                onClick={() => {
                  setPicking(false);
                  if (item.role !== demoRole) onChangeDemoRole(item.role);
                }}
              >
                <span className="role-card__icon" aria-hidden="true">
                  <Icon name={item.icon} size={24} />
                </span>
                <span className="stack" style={{ gap: 2, flex: 1, textAlign: 'left' }}>
                  <span style={{ fontWeight: 600 }}>{item.title}</span>
                  <span className="small muted">{item.text}</span>
                </span>
                {item.role === demoRole ? <span className="small hb-link__action">сейчас</span> : null}
              </button>
            ))}
          </div>
        </Sheet>
      ) : null}
      {inner ? (
        <div className="hb-crumbs">
          <button type="button" className="hb-back" aria-label={`Назад: ${BACK_LABEL[nav.previous?.name ?? 'hb-home']}`} onClick={nav.pop}>
            <Icon name="back" />
            <span>{BACK_LABEL[nav.previous?.name ?? 'hb-home']}</span>
          </button>
          {crumbAction}
        </div>
      ) : null}
      {/* В демо пометка предпросмотра живёт в той же плашке, что и роль; в MAX — отдельной строкой */}
      {studentPreview && !(demoRole && !inner) ? <div className="banner hb-student-preview" role="note"><Icon name="book" size={20} /><span>Предпросмотр со стороны студента</span></div> : null}
      <CrumbsActionProvider value={setCrumbAction}>
        <Screen />
      </CrumbsActionProvider>
      <HandbookDock />
    </>
  );
}

export function HandbookShell({
  handbookId,
  title,
  emoji,
  toast,
  person,
  user,
  startParam,
  openHandbook,
  refresh,
  demoRole,
  onResetDemo,
  onChangeDemoRole,
}: {
  handbookId: string;
  title: string;
  emoji: string;
  toast: ShowToast;
  person: Person | null;
  user: Me['user'];
  startParam: string | null;
  openHandbook: (handbookId: string, start?: string) => void;
  refresh: () => Promise<void>;
  demoRole: DemoRole | null;
  onResetDemo?: () => Promise<void> | void;
  onChangeDemoRole?: (role: DemoRole) => void;
}) {
  const initialRoutes = useMemo(() => handbookStartRoutes(startParam), [startParam]);
  return (
    <HandbookProvider
      handbookId={handbookId}
      toast={toast}
      person={person}
      user={user}
      openHandbook={openHandbook}
      refresh={refresh}
      initialRoutes={initialRoutes}
    >
      <HandbookChrome demoRole={demoRole} onResetDemo={onResetDemo} onChangeDemoRole={onChangeDemoRole} />
    </HandbookProvider>
  );
}
