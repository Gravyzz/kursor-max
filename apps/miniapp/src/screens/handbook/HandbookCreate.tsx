import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { Icon } from '../../components/icons';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { plural } from '../../lib/format';
import type { ShowToast } from '../../app/context';
import type { HandbookListItem, Person } from '../../lib/types';
import { EmptyState, ErrorState, Pill, SectionTitle, Skeletons } from '../../components/ui';
import { useHandbook } from './context';

/**
 * Конструктор для деканата: одна кнопка — и у факультета есть готовая структура
 * разделов со страницами-заготовками, которые остаётся наполнить.
 */
export function HandbookCreatePanel({
  person,
  toast,
  currentId,
  onOpen,
}: {
  person: Person;
  toast: ShowToast;
  currentId?: string;
  onOpen: (handbookId: string) => void;
}) {
  const { data, error, loading, reload } = useLoad(
    (signal) => api<{ handbooks: HandbookListItem[] }>('/api/handbooks?mine=1', { signal }),
    [person.id],
  );
  const [title, setTitle] = useState(person.instituteName ? `Справочник: ${person.instituteName}` : '');
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <Skeletons count={3} />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const mine = data?.handbooks ?? [];

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
        { method: 'POST', body: { instituteId: person.instituteId, title: title.trim() } },
      );
      toast(`Готово: ${result.sections} ${plural(result.sections, 'раздел', 'раздела', 'разделов')} и ${result.pages} ${plural(result.pages, 'заготовка', 'заготовки', 'заготовок')}`);
      onOpen(result.id);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="hb-page__head">
        <h1 className="hb-page__title">Справочники факультетов</h1>
        <p className="hb-page__summary">
          Живой справочник вместо PDF и чатов: учёба, справки, физкультура, общежитие, деньги. Студенты ищут по нему прямо в чате с
          ботом, а студсовет и учебный офис ведут его с телефона.
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          {person.fullName} · {person.instituteName ?? person.universityName}
        </p>
      </div>

      {mine.length > 0 ? (
        <div className="stack">
          {mine.map((item) => (
            <button key={item.id} type="button" className="card hb-row hb-handbook-card" onClick={() => onOpen(item.id)}>
              <span className="hb-book-logo" aria-hidden="true"><Icon name="book" size={26} /></span>
              <span className="stack" style={{ gap: 5, flex: 1, textAlign: 'left' }}>
                <span style={{ fontWeight: 600 }}>
                  {item.title}
                </span>
                <span className="small muted">{item.institute ?? item.subtitle ?? ''}</span>
                {item.id === currentId ? (
                  <span style={{ marginTop: 4 }}>
                    <Pill tone="accent">Сейчас открыт</Pill>
                  </span>
                ) : null}
              </span>
              <Icon name="chevron" size={20} />
            </button>
          ))}
        </div>
      ) : (
        <EmptyState icon="book" title="Справочника ещё нет">
          Создайте — и факультет получит готовую структуру из восьми разделов и страниц-заготовок с подсказками, что вписать.
          Студенты увидят только то, что вы опубликуете.
        </EmptyState>
      )}

      <SectionTitle>{mine.length > 0 ? 'Новый справочник' : 'Создать справочник'}</SectionTitle>
      <div className="card hb-block">
        <label className="hb-field">
          <span className="hb-field__label">Название</span>
          <input className="hb-input" value={title} maxLength={120} placeholder="Справочник ИИТ" onChange={(event) => setTitle(event.target.value)} />
        </label>
        <span className="faint small">
          Справочник наследует общеуниверситетские страницы: что не переписали, берётся из справочника вуза.
        </span>
        {/* Когда справочник уже есть, второй — редкое действие: не главная кнопка экрана */}
        <Button variant={mine.length > 0 ? 'secondary' : 'primary'} size="large" loading={busy} disabled={busy || title.trim().length < 3} onClick={create}>
          {mine.length > 0 ? 'Создать ещё один' : 'Создать справочник'}
        </Button>
      </div>
    </>
  );
}

/** Создание для деканата и редактора личной демо-песочницы. */
export function HandbookCreate() {
  const hb = useHandbook();
  if (!hb.person || (hb.person.role !== 'dean' && !(hb.person.isDemo && hb.person.role === 'staff'))) {
    return (
      <EmptyState icon="lock" title="Только для деканата">
        В настоящем вузе справочники создаёт деканат. В демо новый справочник может создать и редактор.
      </EmptyState>
    );
  }
  return (
    <>
      <HandbookCreatePanel person={hb.person} toast={hb.toast} currentId={hb.handbookId} onOpen={hb.openHandbook} />
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
