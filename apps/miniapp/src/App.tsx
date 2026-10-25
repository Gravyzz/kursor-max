import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@maxhub/max-ui';
import { useToastState } from './app/context';
import { api, ApiError, setActivePersonId, setPersonGoneHandler } from './lib/api';
import { clearLoadCache } from './lib/useLoad';
import { bridge } from './lib/bridge';
import type { DemoRole, HandbookHome, HandbookRef, Me } from './lib/types';
import { Onboarding } from './screens/Onboarding';
import { HandbookShell } from './screens/handbook/HandbookShell';
import { HandbookCreatePanel } from './screens/handbook/HandbookCreate';
import { UniversityShell } from './screens/university/UniversityShell';
import { PlatformShell } from './screens/platform/PlatformShell';
import { Icon } from './components/icons';

/**
 * Мини-приложение Курсора: справочник факультета для студентов и конструктор для команды.
 * Читателю не нужна запись в вузе: справочник выбирается по диплинку, прошлому визиту
 * или из витрины. Запись (person) есть у деканата и приглашённых редакторов.
 */
export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [handbook, setHandbook] = useState<HandbookRef | null>(null);
  // Параметр запуска применяем только к первому открытому справочнику
  const [startParam, setStartParam] = useState<string | null>(null);
  const [fatal, setFatal] = useState<ApiError | Error | null>(null);
  // Администратор университета работает в кабинете; справочник факультета открывает для просмотра
  const [space, setSpace] = useState<'platform' | 'university' | 'handbook'>('handbook');
  const toast = useToastState();

  const loadMe = useCallback(async (applyStart: boolean) => {
    const data = await api<Me>('/api/me');
    setActivePersonId(data.person?.id ?? null);
    setMe(data);
    setHandbook(data.handbook);
    const start = applyStart ? bridge.startParam ?? data.startParam : null;
    if (applyStart) setStartParam(start);
    // Кабинет — по ссылке uni или по умолчанию; ссылка на страницу справочника открывает справочник
    // Кабинет платформы — по ссылке platform из бота или если у команды Курсора нет ни вуза, ни справочника
    if (data.platform && (start === 'platform' || (!data.university && !data.handbook))) setSpace('platform');
    else if (data.university) setSpace(start && /^hb/.test(start) ? 'handbook' : 'university');
    else setSpace('handbook');
    return data;
  }, []);

  // Один запуск на загрузку (StrictMode в разработке вызывает эффекты дважды)
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    bridge.ready();
    loadMe(true).catch((error: Error) => setFatal(error));
  }, [loadMe]);

  // Демо пересоздали в другом окне — запись исчезла. Перечитываем себя вместо ошибки.
  useEffect(() => {
    setPersonGoneHandler(() => {
      loadMe(false).catch((error: Error) => setFatal(error));
    });
    return () => setPersonGoneHandler(null);
  }, [loadMe]);

  const refresh = useCallback(async () => {
    clearLoadCache();
    setStartParam(null);
    await loadMe(false);
  }, [loadMe]);

  const openHandbook = useCallback(
    async (handbookId: string, start?: string) => {
      try {
        // Открытие записывает визит: в следующий раз бот и приложение откроют этот справочник
        const home = await api<HandbookHome>(`/api/handbook?handbookId=${encodeURIComponent(handbookId)}`);
        // start — параметр запуска внутри справочника: страница с отсканированного плаката
        setStartParam(start ?? null);
        setHandbook({ id: home.handbook.id, slug: home.handbook.slug, title: home.handbook.title, emoji: home.handbook.emoji });
        setSpace('handbook');
        window.scrollTo({ top: 0 });
      } catch (error) {
        toast.show((error as Error).message, 'error');
      }
    },
    [toast.show],
  );

  // Демо в выбранной роли. Без роли — пересоздать в текущей
  const startDemo = useCallback(
    async (role?: DemoRole) => {
      const sandbox = await api<{ handbookId: string }>('/api/demo', { method: 'POST', body: role ? { role } : {} });
      clearLoadCache();
      setActivePersonId(null);
      const fresh = await loadMe(false);
      setStartParam(null);
      await openHandbook(sandbox.handbookId);
      if (fresh.university) setSpace('university');
    },
    [loadMe, openHandbook],
  );

  const resetDemo = useCallback(async () => {
    try {
      await startDemo();
      toast.show('Демо пересоздано');
    } catch (error) {
      toast.show((error as Error).message, 'error');
    }
  }, [startDemo, toast.show]);

  // Смена роли не пересоздаёт демо: вопросы, отметки и правки сохраняются
  const changeDemoRole = useCallback(
    async (role: DemoRole) => {
      try {
        const sandbox = await api<{ handbookId: string }>('/api/demo/role', { method: 'POST', body: { role } });
        clearLoadCache();
        setActivePersonId(null);
        await loadMe(false);
        setStartParam(null);
        await openHandbook(sandbox.handbookId);
        if (role === 'university') setSpace('university');
        toast.show(`Теперь вы — ${role === 'student' ? 'студент' : role === 'editor' ? 'редактор' : role === 'dean' ? 'деканат' : 'администратор университета'}`);
      } catch (error) {
        toast.show((error as Error).message, 'error');
      }
    },
    [loadMe, openHandbook, toast.show],
  );

  if (fatal) {
    const unauthorized = fatal instanceof ApiError && fatal.status === 401;
    return (
      <main className="screen">
        <section className="card state" role="alert">
          <span className="state__icon" aria-hidden="true">
            <Icon name={unauthorized ? 'lock' : 'warn'} size={40} />
          </span>
          <span className="state__title">{unauthorized ? 'Откройте приложение из MAX' : 'Не удалось запустить'}</span>
          <span className="muted">{fatal.message}</span>
          {!unauthorized ? (
            <Button variant="secondary" size="medium" onClick={() => { setFatal(null); loadMe(true).catch((error: Error) => setFatal(error)); }}>
              Повторить
            </Button>
          ) : null}
        </section>
      </main>
    );
  }

  if (!me) {
    return (
      <main className="screen" style={{ placeItems: 'center', minHeight: '60vh' }} aria-busy="true">
        <Spinner size={28} />
      </main>
    );
  }

  if (me.platform && space === 'platform') {
    return (
      <>
        <main className="screen">
          <PlatformShell toast={toast.show} onClose={me.university || handbook ? () => { setSpace(me.university ? 'university' : 'handbook'); window.scrollTo({ top: 0 }); } : undefined} />
        </main>
        {toast.view}
      </>
    );
  }

  const inDemoUniversity = Boolean(me.demo) && Boolean(me.university) && Boolean(handbook && /-demo-/.test(handbook.slug));
  if (me.university && space === 'university') {
    return (
      <>
        <main className="screen">
          <UniversityShell
            key={me.university.id}
            me={me}
            toast={toast.show}
            openHandbook={openHandbook}
            refresh={refresh}
            demoRole={inDemoUniversity ? me.demo!.role : null}
            onResetDemo={inDemoUniversity ? resetDemo : undefined}
            onChangeDemoRole={inDemoUniversity ? changeDemoRole : undefined}
            startPageId={startParam && /^uni_[0-9a-f-]{36}$/i.test(startParam) ? startParam.slice(4) : null}
          />
        </main>
        {toast.view}
      </>
    );
  }

  if (handbook) {
    // Баннер демо — только в самой песочнице, а не в настоящем справочнике, который открыли по ссылке
    const inDemo = Boolean(me.demo) && /-demo-/.test(handbook.slug);
    return (
      <>
        <main className="screen">
          <HandbookShell
            key={`${handbook.id}:${me.demo?.role ?? ''}`}
            handbookId={handbook.id}
            title={handbook.title}
            emoji={handbook.emoji}
            toast={toast.show}
            person={me.person}
            user={me.user}
            startParam={startParam}
            openHandbook={openHandbook}
            refresh={refresh}
            demoRole={inDemo ? me.demo!.role : null}
            onResetDemo={inDemo ? resetDemo : undefined}
            onChangeDemoRole={inDemo ? changeDemoRole : undefined}
            openUniversity={me.university ? () => { setSpace('university'); window.scrollTo({ top: 0 }); } : undefined}
          />
        </main>
        {toast.view}
      </>
    );
  }

  // Деканат, у которого справочника ещё нет: сразу конструктор
  if (me.person?.role === 'dean') {
    return (
      <>
        <main className="screen">
          <HandbookCreatePanel person={me.person} toast={toast.show} onOpen={openHandbook} />
        </main>
        {toast.view}
      </>
    );
  }

  return (
    <>
      <Onboarding demoEnabled={me.demoEnabled} onConnected={refresh} onOpenHandbook={openHandbook} onStartDemo={startDemo} />
      {toast.view}
    </>
  );
}
