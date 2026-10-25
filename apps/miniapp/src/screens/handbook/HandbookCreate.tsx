import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { Icon } from '../../components/icons';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { dateOnly, plural } from '../../lib/format';
import type { ShowToast } from '../../app/context';
import type { Person } from '../../lib/types';
import { ConfirmSheet, EmptyState, ErrorState, Pill, SectionTitle, Skeletons } from '../../components/ui';
import { useHandbook } from './context';

interface ManagedHandbook {
  id: string;
  title: string;
  subtitle: string | null;
  institute: string;
  status: 'active' | 'archived';
  inherited: boolean;
  readers: number;
  closedAt: string | null;
  restoreUntil: string | null;
  closedWithFaculty: boolean;
  canClose: boolean;
  canManage: boolean;
}

/**
 * Справочники факультета для деканата: создать новый (с общими страницами университета или без),
 * закрыть ненужный и вернуть закрытый в течение срока хранения. Закрытие — не удаление:
 * студенты сразу теряют доступ, а страницы, команда и история ждут 90 дней.
 */
export function HandbookCreatePanel({
  person,
  toast,
  currentId,
  onOpen,
  onChanged,
}: {
  person: Person;
  toast: ShowToast;
  currentId?: string;
  onOpen: (handbookId: string) => void;
  /** Список справочников изменился (закрыли или вернули) — перечитать доступ. */
  onChanged?: () => void;
}) {
  const { data, error, loading, reload } = useLoad(
    (signal) => api<{ handbooks: ManagedHandbook[]; retentionDays: number; hasBase: boolean }>('/api/handbook-editor/handbooks', { signal }),
    [person.id],
  );
  const [title, setTitle] = useState(person.instituteName ? `Справочник: ${person.instituteName}` : '');
  const [inherit, setInherit] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<ManagedHandbook | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const canCreate = person.role === 'dean' || (person.isDemo && person.role === 'staff');

  if (loading && !data) return <Skeletons count={3} />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const active = (data?.handbooks ?? []).filter((item) => item.status === 'active');
  const closed = (data?.handbooks ?? []).filter((item) => item.status === 'archived');
  // Первый справочник факультета — основной: общие страницы по умолчанию нужны. Тематический (стажировки,
  // олимпиады) — обычно без них, иначе туда попадут «Справка в военкомат» и «Материальная помощь»
  const withBase = inherit ?? active.length === 0;

  const create = async () => {
    if (title.trim().length < 3) {
      toast('Название от 3 символов', 'error');
      return;
    }
    if (!person.instituteId) {
      toast('Ваша запись не привязана к институту — обратитесь к администратору платформы', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ id: string; slug: string; sections: number; pages: number; inherited: boolean }>(
        '/api/handbook-editor/handbooks',
        { method: 'POST', body: { instituteId: person.instituteId, title: title.trim(), inherit: data?.hasBase ? withBase : undefined } },
      );
      toast(`Готово: ${result.sections} ${plural(result.sections, 'раздел', 'раздела', 'разделов')} и ${result.pages} ${plural(result.pages, 'заготовка', 'заготовки', 'заготовок')}${result.inherited ? ', общие страницы университета подключены' : ''}`);
      onOpen(result.id);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const close = async (item: ManagedHandbook) => {
    setActing(item.id);
    try {
      const result = await api<{ restoreUntil: string | null }>(`/api/handbook-editor/handbooks/${item.id}/close`, { method: 'POST', body: {} });
      toast(`Справочник закрыт — вернуть можно до ${result.restoreUntil ? dateOnly(result.restoreUntil.slice(0, 10), true) : 'окончания срока хранения'}`);
      setClosing(null);
      reload();
      onChanged?.();
      // Закрыли тот, что открыт сейчас, — переходим в другой справочник факультета
      if (item.id === currentId) {
        const next = active.find((other) => other.id !== item.id);
        // Других справочников в списке нет — сервер сам выберет открытый справочник по прошлым визитам
        const fallback = next ? null : await api<{ handbook: { id: string } }>('/api/handbook').catch(() => null);
        const target = next?.id ?? fallback?.handbook.id;
        if (target) onOpen(target);
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setActing(null);
    }
  };

  const reopen = async (item: ManagedHandbook) => {
    setActing(item.id);
    try {
      await api(`/api/handbook-editor/handbooks/${item.id}/reopen`, { method: 'POST', body: {} });
      toast('Справочник снова открыт — студенты видят его по прежней ссылке');
      reload();
      onChanged?.();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setActing(null);
    }
  };

  return (
    <>
      <div className="hb-page__head">
        <h1 className="hb-page__title">Справочники факультета</h1>
        <p className="hb-page__summary">
          Живой справочник вместо PDF и чатов. Студенты ищут по нему прямо в чате с ботом, а студсовет и учебный офис ведут его с телефона.
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          {person.fullName} · {person.instituteName ?? person.universityName}
        </p>
      </div>

      {active.length > 0 ? (
        <div className="stack">
          {active.map((item) => (
            <div key={item.id} className="card hb-handbook-manage">
              <button type="button" className="hb-row hb-handbook-card" onClick={() => onOpen(item.id)}>
                <span className="hb-book-logo" aria-hidden="true"><Icon name="book" size={26} /></span>
                <span className="stack" style={{ gap: 5, flex: 1, textAlign: 'left' }}>
                  <span style={{ fontWeight: 600 }}>{item.title}</span>
                  <span className="small muted">{item.inherited ? 'С общими страницами университета' : 'Без общих страниц университета'} · {item.readers} {plural(item.readers, 'читатель', 'читателя', 'читателей')}</span>
                  {item.id === currentId ? <span style={{ marginTop: 4 }}><Pill tone="accent">Сейчас открыт</Pill></span> : null}
                </span>
                <Icon name="chevron" size={20} />
              </button>
              {item.canClose
                ? <button type="button" className="linkbtn small hb-danger-link" disabled={acting !== null} onClick={() => setClosing(item)}>Закрыть справочник</button>
                : item.canManage
                  ? <span className="faint small">Единственный справочник факультета — закрыть его нельзя. Факультет целиком отключает администратор университета.</span>
                  : <span className="faint small">Вы редактор этого справочника — закрыть его может деканат.</span>}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState icon="book" title="Справочника ещё нет">
          Создайте — и факультет получит готовую структуру из восьми разделов и страниц-заготовок с подсказками, что вписать.
          Студенты увидят только то, что вы опубликуете.
        </EmptyState>
      )}

      {canCreate ? <>
        <SectionTitle>{active.length > 0 ? 'Новый справочник' : 'Создать справочник'}</SectionTitle>
        <div className="card hb-block">
          <label className="hb-field">
            <span className="hb-field__label">Название</span>
            <input className="hb-input" value={title} maxLength={120} placeholder="Например: Справочник ИИТ" onChange={(event) => setTitle(event.target.value)} />
          </label>
          {data?.hasBase ? (
            <div className="hb-field">
              <span className="hb-field__label" id="inherit-label">Общие страницы университета</span>
              <div className="hb-choice" role="radiogroup" aria-labelledby="inherit-label">
                <button type="button" role="radio" aria-checked={withBase} className={`hb-choice__item ${withBase ? 'hb-choice__item--on' : ''}`} onClick={() => setInherit(true)}>
                  <strong>Подключить</strong>
                  <span className="small muted">Справки, стипендия, общежитие и другие общие инструкции появятся сами и будут обновляться университетом. Для основного справочника факультета.</span>
                </button>
                <button type="button" role="radio" aria-checked={!withBase} className={`hb-choice__item ${!withBase ? 'hb-choice__item--on' : ''}`} onClick={() => setInherit(false)}>
                  <strong>Без общих страниц</strong>
                  <span className="small muted">Только ваши страницы. Для тематического справочника: стажировки, олимпиады, приёмная кампания.</span>
                </button>
              </div>
            </div>
          ) : null}
          {/* Когда справочник уже есть, второй — редкое действие: не главная кнопка экрана */}
          <Button variant={active.length > 0 ? 'secondary' : 'primary'} size="large" loading={busy} disabled={busy || title.trim().length < 3} onClick={create}>
            {active.length > 0 ? 'Создать ещё один' : 'Создать справочник'}
          </Button>
        </div>
      </> : null}

      {closed.length > 0 ? <>
        <SectionTitle>Закрытые</SectionTitle>
        <div className="stack">
          {closed.map((item) => (
            <div key={item.id} className="card hb-handbook-manage hb-handbook-manage--closed">
              <span className="stack" style={{ gap: 4 }}>
                <span style={{ fontWeight: 600 }}>{item.title}</span>
                <span className="small muted">
                  Студенты не видят{item.restoreUntil ? ` · вернуть можно до ${dateOnly(item.restoreUntil.slice(0, 10), true)}, потом справочник удалится насовсем` : ''}
                </span>
              </span>
              {item.closedWithFaculty
                ? <span className="faint small">Закрыт вместе с факультетом — вернётся, когда администратор университета восстановит факультет.</span>
                : <Button variant="secondary" size="medium" loading={acting === item.id} disabled={acting !== null} onClick={() => void reopen(item)}>Вернуть справочник</Button>}
            </div>
          ))}
        </div>
      </> : null}

      {closing ? (
        <ConfirmSheet
          title={`Закрыть «${closing.title}»?`}
          text={<>Студенты сразу потеряют доступ: по ссылке и QR они увидят «Справочник закрыт», напоминания о сроках прекратятся. Страницы, команда и история сохранятся — вернуть справочник можно в течение {data?.retentionDays ?? 90} дней, потом он удалится насовсем.</>}
          confirmLabel="Закрыть справочник"
          busy={acting === closing.id}
          onConfirm={() => void close(closing)}
          onClose={() => setClosing(null)}
        />
      ) : null}
    </>
  );
}

/** Создание для деканата и редактора личной демо-песочницы. */
export function HandbookCreate() {
  const hb = useHandbook();
  if (!hb.person || (hb.person.role !== 'dean' && hb.editorRole !== 'admin' && !(hb.person.isDemo && hb.person.role === 'staff'))) {
    return (
      <EmptyState icon="lock" title="Только для деканата">
        В настоящем вузе справочники создаёт и закрывает деканат. В демо новый справочник может создать и редактор.
      </EmptyState>
    );
  }
  return (
    <>
      <HandbookCreatePanel person={hb.person} toast={hb.toast} currentId={hb.handbookId} onOpen={hb.openHandbook} onChanged={() => void hb.refresh()} />
      <button type="button" className="card hb-row" onClick={() => hb.nav.push({ name: 'hb-team' })}>
        <span className="stack" style={{ gap: 2, flex: 1, textAlign: 'left' }}>
          <span style={{ fontWeight: 600 }}>Команда открытого справочника</span>
          <span className="small muted">Пригласить студсовет и учебный офис по личной ссылке</span>
        </span>
        <Icon name="chevron" />
      </button>
    </>
  );
}
