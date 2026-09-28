import { useEffect, useRef, useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import type { HandbookHome, HandbookProfile as Profile } from '../../lib/types';
import { ErrorState, Skeletons } from '../../components/ui';
import { Icon, type IconName } from '../../components/icons';
import { useTheme, type ThemePref } from '../../app/theme';

const THEMES: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: 'dark', label: 'Тёмная', icon: 'moon' },
  { value: 'light', label: 'Светлая', icon: 'sun' },
  { value: 'system', label: 'Системная', icon: 'auto' },
];

type Choice = Pick<Profile, 'course' | 'dorm' | 'program' | 'reminders'>;

/**
 * Профиль по роли: настройки читателя либо рабочие действия команды.
 * Команда раскрывает параметры читателя отдельно для предпросмотра.
 * Выбор сохраняется сразу по нажатию, как тема: «Назад» ничего не теряет.
 */
export function HandbookProfile() {
  const hb = useHandbook();
  const theme = useTheme();
  // Тот же ответ, что у главной: после «Назад» главная сразу покажет новый курс
  const { data, error, loading, reload, setData } = useLoad(
    (signal) => api<HandbookHome>(hb.url('/api/handbook'), { signal }),
    [hb.handbookId],
    `home:${hb.handbookId}`,
  );
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [failedChoice, setFailedChoice] = useState<Choice | null>(null);
  // Сохранения по очереди: быстрые нажатия не перегоняют друг друга
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const desired = useRef<Choice | null>(null);
  const confirmed = useRef<Choice | null>(null);
  // Поля, которые человек менял на этом экране: остальные не отправляем, чтобы устаревший кэш не затёр свежие данные
  const touched = useRef(new Set<keyof Choice>());

  const [previewSettings, setPreviewSettings] = useState(false);

  if (loading && !data) return <Skeletons count={3} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const isTeam = Boolean(hb.editorRole) || hb.person?.role === 'dean';
  const roleName = hb.person?.role === 'dean' ? 'Деканат' : hb.editorRole === 'admin' ? 'Администратор справочника' : isTeam ? 'Редактор' : 'Студент';

  const value: Choice = { course: data.profile.course, dorm: data.profile.dorm, program: data.profile.program, reminders: data.profile.reminders };
  // Пока ничего не сохраняется, опираемся на последний ответ сервера, а не на кэш, с которым экран открылся
  if (!desired.current || pending.current === 0) desired.current = value;
  if (!confirmed.current || pending.current === 0) confirmed.current = value;

  const set = (patch: Partial<Choice>) => {
    const next = { ...desired.current!, ...patch };
    desired.current = next;
    for (const key of Object.keys(patch) as Array<keyof Choice>) touched.current.add(key);
    const body = Object.fromEntries([...touched.current].map((key) => [key, next[key]]));
    setData((current) => (current ? { ...current, profile: { ...current.profile, ...next, filled: next.course !== null } } : current));
    setSaveState('saving');
    pending.current += 1;
    queue.current = queue.current
      .then(() => api(hb.url('/api/handbook/profile'), { method: 'PATCH', body }))
      .then(
        () => {
          confirmed.current = next;
          pending.current -= 1;
          if (pending.current > 0) return;
          // Последний выбор сохранён: он главнее ответа загрузки, который мог прийти позже нажатия
          setData((current) => (current ? { ...current, profile: { ...current.profile, ...next, filled: next.course !== null } } : current));
          setSaveState('saved');
          setFailedChoice(null);
        },
        (err: Error) => {
          pending.current -= 1;
          if (pending.current > 0) return;
          const previous = confirmed.current!;
          setData((current) => (current ? { ...current, profile: { ...current.profile, ...previous, filled: previous.course !== null } } : current));
          setSaveState('error');
          setFailedChoice(next);
          hb.toast(err.message, 'error');
        },
      );
  };

  return (
    <>
      <div className="hb-page__head">
        <h1 className="hb-page__title">Профиль и настройки</h1>
      </div>

      <section className="card hb-profile-identity">
        <span className="hb-reader-avatar hb-reader-avatar--large" aria-hidden="true">
          {hb.user.photoUrl
            ? <img src={hb.user.photoUrl} alt="" referrerPolicy="no-referrer" />
            : [hb.user.firstName, hb.user.lastName].filter(Boolean).map((part) => part![0]).join('') || <Icon name="user" size={32} />}
        </span>
        <strong>{[hb.user.firstName, hb.user.lastName].filter(Boolean).join(' ') || hb.person?.fullName || 'Читатель справочника'}</strong>
        <span className="hb-role-badge">{roleName}</span>
        <span className="small muted">{hb.person?.instituteName || data.handbook.title}{!isTeam && value.course ? ` · ${value.course} курс` : ''}</span>
        <span className="faint small">
          {hb.user.id === 7_700_001
            ? 'В браузерном демо показан модельный профиль. В MAX здесь будут ваше имя и фото.'
            : 'Имя и фото берутся из MAX. Изменить их можно в профиле мессенджера.'}
        </span>
      </section>

      {/* Переходы — строками списка, а не крупными кнопками: они не должны спорить с заголовками карточек */}
      {isTeam ? <section className="stack" aria-labelledby="profile-work">
        <h2 className="section-title" id="profile-work">Работа со справочником</h2>
        <div className="card hb-list">
          {hb.editorRole ? <button type="button" className="hb-list__row" onClick={() => hb.nav.push({ name: 'hb-analytics' })}><span className="hb-reader-round" aria-hidden="true"><Icon name="chart" /></span><span className="hb-list__title hb-reader-grow">Аналитика справочника</span><Icon name="chevron" /></button> : null}
          {!hb.editorRole && hb.person?.role === 'dean' ? <button type="button" className="hb-list__row" onClick={() => hb.nav.push({ name: 'hb-create' })}><span className="hb-reader-round" aria-hidden="true"><Icon name="books" /></span><span className="hb-list__title hb-reader-grow">Справочники факультетов</span><Icon name="chevron" /></button> : null}
          <button type="button" className="hb-list__row" aria-expanded={previewSettings} aria-controls="profile-preview" onClick={() => setPreviewSettings(!previewSettings)}><span className="hb-reader-round" aria-hidden="true"><Icon name="book" /></span><span className="stack hb-reader-grow" style={{ gap: 2 }}><span className="hb-list__title">Предпросмотр студента</span><span className="small muted">Курс и общежитие, с которыми вы видите справочник</span></span><span className={`hb-list__toggle ${previewSettings ? 'hb-list__toggle--open' : ''}`}><Icon name="chevron-down" /></span></button>
        </div>
      </section> : null}

      {!isTeam || previewSettings ? <div className="stack" id="profile-preview">
      {isTeam ? <p className="small muted">Параметры читателя для предпросмотра. Они не меняют вашу роль в команде.</p> : null}
      <div className="card hb-settings">
        <section className="hb-settings-group">
          <label className="hb-field"><span className="hb-field__label">Направление или программа</span>
            <ProgramInput value={value.program ?? ''} live={saveState === 'idle' || saveState === 'saved'} onSave={(program) => set({ program: program || null })} />
          </label>
          <CourseSlider value={value.course} onCommit={(course) => set({ course })} />
        </section>
        <section className="hb-settings-group">
          <span className="hb-field__label" id="profile-dorm">Живу в общежитии</span>
          <div className="hb-segment" role="radiogroup" aria-labelledby="profile-dorm">
            {[{ label: 'Да', value: true }, { label: 'Нет', value: false }].map((option) => <button key={option.label} type="button" role="radio" aria-checked={value.dorm === option.value} onClick={() => value.dorm !== option.value && set({ dorm: option.value })}>{option.label}</button>)}
          </div>
        </section>
        <section className="hb-settings-group">
          <h2 className="hb-block__title">Уведомления</h2>
          <label className="hb-check hb-check--row"><input type="checkbox" checked={value.reminders} onChange={(event) => set({ reminders: event.target.checked })} /><span className="hb-check__box" aria-hidden="true" /><span className="hb-check__text">Напоминать о сроках в чате</span></label>
        </section>
        {/* Подтверждение сохранения — внутри карточки настроек и только после изменения */}
        <div className={`hb-settings-status ${saveState === 'idle' ? 'hb-settings-status--idle' : ''} ${saveState === 'error' ? 'hb-error' : ''}`} role="status" aria-live="polite">
          {saveState === 'saved' ? <Icon name="done" size={16} /> : null}
          {saveState === 'saving'
            ? 'Сохраняю…'
            : saveState === 'saved'
              ? 'Сохранено — справочник уже показывает ваше'
              : saveState === 'error'
                ? 'Не сохранилось — попробуйте ещё раз'
                : ''}
        </div>
      </div>

      {saveState === 'error' ? <Button variant="secondary" size="medium" onClick={() => set(failedChoice ?? value)}>Повторить сохранение</Button> : null}
      </div> : null}

      <div className="card hb-block">
        <h2 className="hb-block__title">Оформление</h2>
        <div className="hb-segment" role="radiogroup" aria-label="Тема оформления">
          {THEMES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={theme.pref === option.value}
              onClick={() => theme.setPref(option.value)}
            >
{option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="card hb-list">
        {!isTeam ? <button type="button" className="hb-list__row" onClick={() => hb.nav.push({ name: 'hb-ask' })}><span className="hb-reader-round" aria-hidden="true"><Icon name="chat" /></span><span className="hb-list__title hb-reader-grow">Мои вопросы</span><Icon name="chevron" /></button> : null}
        <button type="button" className="hb-list__row" onClick={() => hb.nav.push({ name: 'hb-handbooks' })}><span className="hb-reader-round" aria-hidden="true"><Icon name="books" /></span><span className="hb-list__title hb-reader-grow">Сменить справочник</span><Icon name="chevron" /></button>
      </div>

    </>
  );
}

/**
 * Сохраняем программу после паузы, при потере фокуса и при уходе с экрана.
 * live — сохранений нет и они не сорвались: свежий ответ сервера можно показать в поле.
 */
function ProgramInput({ value, live, onSave }: { value: string; live: boolean; onSave: (value: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const draft = useRef(value);
  const saved = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    const next = draft.current.trim();
    if (next !== saved.current) { saved.current = next; saveRef.current(next); }
  };
  useEffect(() => () => flush(), []);
  // Экран открылся с кэшем, а сервер прислал другое: показываем свежее, если человек сейчас не печатает
  useEffect(() => {
    const input = ref.current;
    if (!live || !input || value === saved.current || document.activeElement === input || draft.current.trim() !== saved.current) return;
    input.value = value;
    draft.current = value;
    saved.current = value;
  }, [value, live]);
  return <input ref={ref} className="hb-input" defaultValue={value} maxLength={120} placeholder="Например, Информатика" onChange={(event) => {
    draft.current = event.target.value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  }} onBlur={flush} />;
}

const COURSE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Курс — шкала 1–6: ползунок можно тянуть или нажать на деление.
 * Пока тянут, число меняется на месте; сохраняем, когда палец отпущен, — без шести запросов подряд.
 */
function CourseSlider({ value, onCommit }: { value: number | null; onCommit: (course: number | null) => void }) {
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => setDraft(value), [value]);
  const shown = draft ?? 1;
  const commit = (next: number) => { if (next !== value) onCommit(next); };
  return (
    <div className="hb-course-slider">
      <h3 className="hb-field__label" id="profile-course">Курс</h3>
      <input
        type="range" min={1} max={6} step={1} value={shown}
        className={`hb-range ${draft === null ? 'hb-range--empty' : ''}`}
        style={{ ['--p' as string]: `${((shown - 1) / 5) * 100}%` }}
        aria-labelledby="profile-course" aria-valuetext={draft === null ? 'Курс не указан' : `${shown} курс`}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        // Сохраняем только клавиши, которые двигают шкалу: переход Tab на пустую шкалу не выбирает 1 курс
        onKeyUp={(event) => { if (COURSE_KEYS.has(event.key)) commit(Number(event.currentTarget.value)); }}
        // Уход со шкалы сохраняет лишь то, что успели передвинуть (например, палец сорвался без отпускания)
        onBlur={() => { if (draft !== null) commit(draft); }}
      />
      <div className="hb-range__ticks" aria-hidden="true">
        {[1, 2, 3, 4, 5, 6].map((course) => (
          <button key={course} type="button" tabIndex={-1} className={draft === course ? 'hb-range__tick--on' : ''} onClick={() => { setDraft(course); commit(course); }}>{course}</button>
        ))}
      </div>
      {value === null ? <span className="small muted">Передвиньте ползунок — покажем материалы вашего курса.</span> : null}
    </div>
  );
}
