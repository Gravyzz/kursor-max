import { useEffect, useRef, useState } from 'react';
import type { Block, BlockType } from '../../lib/types';
import { plural } from '../../lib/format';
import { Sheet } from '../../components/ui';
import { Icon, type IconName } from '../../components/icons';

/**
 * Конструктор страницы: блоки добавляются, редактируются и переставляются с телефона.
 * Специально без «богатого текста» — редактор выбирает тип блока, а вид обеспечивает приложение,
 * поэтому страницы всех факультетов выглядят одинаково аккуратно.
 */

export const BLOCK_LABEL: Record<BlockType, { title: string; hint: string; icon: IconName }> = {
  text: { title: 'Текст', hint: 'Абзац объяснения', icon: 'text' },
  steps: { title: 'Пошаговая инструкция', hint: 'Что делать по порядку', icon: 'list' },
  checklist: { title: 'Чек-лист', hint: 'Студент отмечает сделанное', icon: 'check' },
  faq: { title: 'Вопросы и ответы', hint: 'Частые вопросы по теме', icon: 'question' },
  contact: { title: 'Контакт', hint: 'Кто, где и когда принимает', icon: 'user' },
  place: { title: 'Место', hint: 'Адрес и как найти', icon: 'pin' },
  deadline: { title: 'Срок', hint: 'Дата, о которой напомнит бот', icon: 'clock' },
  link: { title: 'Ссылка', hint: 'На сайт или форму', icon: 'link' },
  file: { title: 'Файл', hint: 'Шаблон заявления, бланк', icon: 'file' },
  alert: { title: 'Важное', hint: 'Предупреждение или пометка', icon: 'warn' },
  chat: { title: 'Чат в MAX', hint: 'Официальный чат', icon: 'chat' },
  glossary: { title: 'Словарь', hint: 'Термины и их значения', icon: 'book' },
};

const rid = () => Math.random().toString(36).slice(2, 8);

export function emptyBlock(type: BlockType): Block {
  const id = rid();
  switch (type) {
    case 'text':
      return { id, type, text: '' };
    // Заголовок у инструкции и чек-листа необязательный: пустой не отправляем вовсе
    case 'steps':
      return { id, type, items: [{ id: rid(), text: '' }] };
    case 'checklist':
      return { id, type, items: [{ id: rid(), text: '' }] };
    case 'faq':
      return { id, type, items: [{ id: rid(), question: '', answer: '' }] };
    case 'contact':
      return { id, type, name: '' };
    case 'place':
      return { id, type, title: '' };
    case 'deadline':
      return { id, type, title: '', startsOn: new Date().toISOString().slice(0, 10) };
    case 'link':
    case 'file':
    case 'chat':
      return { id, type, title: '', url: '' };
    case 'alert':
      return { id, type, tone: 'info', text: '' };
    case 'glossary':
      return { id, type, items: [{ id: rid(), term: '', meaning: '' }] };
    default:
      return { id, type: 'text', text: '' };
  }
}

// ─── Ссылки: только https (для «Чата в MAX» — только https://max.ru/…), как проверяет сервер ───

const HTTPS = 'https://';
const MAX_CHAT = 'https://max.ru/';

function validUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** Что не так со ссылкой; null — всё хорошо. Пустая ссылка — отдельный случай («Вставьте ссылку»). */
export function urlProblem(value: string, chat = false): string | null {
  const url = value.trim();
  if (!url) return null;
  if (chat && !url.toLowerCase().startsWith(MAX_CHAT)) return 'Ссылка на чат должна начинаться с https://max.ru/';
  if (!url.toLowerCase().startsWith(HTTPS) || !validUrl(url)) return 'Ссылка должна начинаться с https://';
  return null;
}

/** Подсказка под полем ссылки, пока человек печатает: не ругаемся, пока он ещё набирает «https://». */
function urlHint(value: string, chat: boolean): string | null {
  const url = value.trim().toLowerCase();
  const prefix = chat ? MAX_CHAT : HTTPS;
  if (!url || prefix.startsWith(url)) return null;
  return urlProblem(value, chat);
}

const blank = (value: string | undefined | null) => !value || value.trim() === '';

/**
 * Что мешает опубликовать блок — теми же словами, что подписи полей формы.
 * Проверка на телефоне повторяет строгую проверку сервера: кнопка публикации недоступна сразу,
 * а не после ответа сервера.
 */
export function blockProblem(block: Block): string | null {
  switch (block.type) {
    case 'text':
    case 'alert':
      return blank(block.text) ? 'Напишите текст' : null;
    case 'steps': {
      if (block.items.length === 0) return 'Добавьте хотя бы один шаг';
      const index = block.items.findIndex((item) => blank(item.text));
      return index >= 0 ? `Заполните шаг ${index + 1}` : null;
    }
    case 'checklist': {
      if (block.items.length === 0) return 'Добавьте хотя бы один пункт';
      const index = block.items.findIndex((item) => blank(item.text));
      return index >= 0 ? `Заполните пункт ${index + 1}` : null;
    }
    case 'faq': {
      if (block.items.length === 0) return 'Добавьте хотя бы один вопрос';
      for (const [index, item] of block.items.entries()) {
        if (blank(item.question)) return `Заполните вопрос ${index + 1}`;
        if (blank(item.answer)) return `Напишите ответ на вопрос ${index + 1}`;
      }
      return null;
    }
    case 'glossary': {
      if (block.items.length === 0) return 'Добавьте хотя бы один термин';
      for (const [index, item] of block.items.entries()) {
        if (blank(item.term)) return `Заполните термин ${index + 1}`;
        if (blank(item.meaning)) return `Объясните термин ${index + 1}`;
      }
      return null;
    }
    case 'contact':
      if (blank(block.name)) return 'Укажите, кто принимает';
      return block.maxLink ? urlProblem(block.maxLink) : null;
    case 'place':
      if (blank(block.title)) return 'Заполните название';
      return block.mapLink ? urlProblem(block.mapLink) : null;
    case 'deadline':
      if (blank(block.title)) return 'Напишите, что нужно успеть';
      if (blank(block.startsOn)) return 'Укажите дату начала';
      if (block.endsOn && block.endsOn < block.startsOn) return 'Конец раньше начала';
      return null;
    case 'link':
    case 'file':
    case 'chat':
      if (blank(block.title)) return 'Заполните название';
      if (blank(block.url)) return 'Вставьте ссылку';
      return urlProblem(block.url, block.type === 'chat');
    default:
      return null;
  }
}

/** Необязательное поле без текста не отправляем: пустая строка — не «нет значения». */
function omitBlank<T extends object>(value: T, keys: string[]): T {
  const next = { ...value } as Record<string, unknown>;
  for (const key of keys) {
    const field = next[key];
    if (field === undefined || (typeof field === 'string' && field.trim() === '')) delete next[key];
  }
  return next as T;
}

/** Блок для сохранения: без пустых необязательных полей (заголовок инструкции, пояснение ссылки…). */
export function cleanBlock(block: Block): Block {
  switch (block.type) {
    case 'steps':
      return { ...omitBlank(block, ['title']), items: block.items.map((item) => omitBlank(item, ['hint'])) };
    case 'checklist':
      return { ...omitBlank(block, ['title']), items: block.items.map((item) => omitBlank(item, ['dueOn'])) };
    case 'contact':
      return omitBlank(block, ['role', 'room', 'hours', 'phone', 'email', 'maxLink']);
    case 'place':
      return omitBlank(block, ['address', 'howTo', 'mapLink']);
    case 'deadline':
      return omitBlank(block, ['endsOn']);
    case 'link':
    case 'file':
    case 'chat':
      return omitBlank(block, ['note']);
    case 'alert':
      return omitBlank(block, ['endsOn']);
    default:
      return block;
  }
}

function Field({ label, children, hint, error }: { label: string; children: React.ReactNode; hint?: string; error?: string | null }) {
  return (
    <label className="hb-field">
      <span className="hb-field__label">{label}</span>
      {children}
      {error ? (
        <span className="small hb-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="faint small">{hint}</span>
      ) : null}
    </label>
  );
}

function ItemList<T extends { id: string }>({
  items,
  onChange,
  render,
  make,
  addLabel,
  itemLabel,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  render: (item: T, update: (patch: Partial<T>) => void, index: number) => React.ReactNode;
  make: () => T;
  addLabel: string;
  /** Подпись пункта с номером: «Шаг 2» — так же пункт называют сообщения об ошибках. */
  itemLabel: (index: number) => string;
}) {
  return (
    <div className="stack">
      {items.map((item, index) => (
        <div key={item.id} className="hb-item">
          <div className="stack" style={{ flex: 1, gap: 6 }}>
            <span className="hb-field__label" aria-hidden="true">
              {itemLabel(index)}
            </span>
            {render(item, (patch) => onChange(items.map((value) => (value.id === item.id ? { ...value, ...patch } : value))), index)}
          </div>
          <div className="hb-item__tools">
            <button
              type="button"
              aria-label={`${itemLabel(index)}: выше`}
              disabled={index === 0}
              onClick={() => {
                const next = [...items];
                [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                onChange(next);
              }}
            >
              <Icon name="up" size={18} />
            </button>
            <button
              type="button"
              aria-label={`${itemLabel(index)}: удалить`}
              disabled={items.length === 1}
              onClick={() => onChange(items.filter((value) => value.id !== item.id))}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="hb-add" onClick={() => onChange([...items, make()])}>
        + {addLabel}
      </button>
    </div>
  );
}

export function BlockForm({ block, onChange }: { block: Block; onChange: (block: Block) => void }) {
  const set = (patch: Record<string, unknown>) => onChange({ ...block, ...patch } as Block);

  switch (block.type) {
    case 'text':
      return (
        <Field label="Текст" hint="Пустая строка разделяет абзацы">
          <textarea className="hb-textarea" rows={4} value={block.text} maxLength={4000} onChange={(event) => set({ text: event.target.value })} />
        </Field>
      );
    case 'alert':
      return (
        <>
          <Field label="Текст">
            <textarea className="hb-textarea" rows={3} value={block.text} maxLength={1000} onChange={(event) => set({ text: event.target.value })} />
          </Field>
          <div className="hb-chips" role="radiogroup" aria-label="Вид пометки">
            {(['info', 'warn'] as const).map((tone) => (
              <button
                key={tone}
                type="button"
                role="radio"
                aria-checked={block.tone === tone}
                className={`hb-chip ${block.tone === tone ? 'hb-chip--on' : ''}`}
                onClick={() => set({ tone })}
              >
                {tone === 'info' ? 'Пометка' : 'Предупреждение'}
              </button>
            ))}
          </div>
        </>
      );
    case 'steps':
      return (
        <>
          <Field label="Заголовок (необязательно)">
            <input
              className="hb-input"
              value={block.title ?? ''}
              maxLength={200}
              onChange={(event) => set({ title: event.target.value || undefined })}
            />
          </Field>
          <ItemList<{ id: string; text: string; hint?: string }>
            items={block.items}
            onChange={(items) => set({ items })}
            make={() => ({ id: rid(), text: '' })}
            addLabel="Шаг"
            itemLabel={(index) => `Шаг ${index + 1}`}
            render={(item, update, index) => (
              <>
                <input
                  className="hb-input"
                  value={item.text}
                  maxLength={200}
                  placeholder="Что сделать"
                  aria-label={`Шаг ${index + 1}: что сделать`}
                  onChange={(event) => update({ text: event.target.value })}
                />
                <input
                  className="hb-input hb-input--sub"
                  value={item.hint ?? ''}
                  maxLength={400}
                  placeholder="Подсказка, если нужна"
                  aria-label={`Подсказка к шагу ${index + 1} (необязательно)`}
                  onChange={(event) => update({ hint: event.target.value || undefined })}
                />
              </>
            )}
          />
        </>
      );
    case 'checklist':
      return (
        <>
          <Field label="Заголовок (необязательно)">
            <input
              className="hb-input"
              value={block.title ?? ''}
              maxLength={200}
              onChange={(event) => set({ title: event.target.value || undefined })}
            />
          </Field>
          <ItemList<{ id: string; text: string; dueOn?: string }>
            items={block.items}
            onChange={(items) => set({ items })}
            make={() => ({ id: rid(), text: '' })}
            addLabel="Пункт"
            itemLabel={(index) => `Пункт ${index + 1}`}
            render={(item, update, index) => (
              <>
                <input
                  className="hb-input"
                  value={item.text}
                  maxLength={200}
                  placeholder="Что нужно сделать"
                  aria-label={`Пункт ${index + 1}: что нужно сделать`}
                  onChange={(event) => update({ text: event.target.value })}
                />
                <input
                  className="hb-input hb-input--sub"
                  type="date"
                  value={item.dueOn ?? ''}
                  aria-label={`Срок пункта ${index + 1} (необязательно)`}
                  onChange={(event) => update({ dueOn: event.target.value || undefined })}
                />
              </>
            )}
          />
        </>
      );
    case 'faq':
      return (
        <ItemList
          items={block.items}
          onChange={(items) => set({ items })}
          make={() => ({ id: rid(), question: '', answer: '' })}
          addLabel="Вопрос"
          itemLabel={(index) => `Вопрос ${index + 1}`}
          render={(item, update, index) => (
            <>
              <input
                className="hb-input"
                value={item.question}
                maxLength={200}
                placeholder="Вопрос"
                aria-label={`Вопрос ${index + 1}`}
                onChange={(event) => update({ question: event.target.value })}
              />
              <textarea
                className="hb-textarea"
                rows={3}
                value={item.answer}
                maxLength={2000}
                placeholder="Ответ"
                aria-label={`Ответ на вопрос ${index + 1}`}
                onChange={(event) => update({ answer: event.target.value })}
              />
            </>
          )}
        />
      );
    case 'glossary':
      return (
        <ItemList
          items={block.items}
          onChange={(items) => set({ items })}
          make={() => ({ id: rid(), term: '', meaning: '' })}
          addLabel="Термин"
          itemLabel={(index) => `Термин ${index + 1}`}
          render={(item, update, index) => (
            <>
              <input
                className="hb-input"
                value={item.term}
                maxLength={80}
                placeholder="Термин"
                aria-label={`Термин ${index + 1}`}
                onChange={(event) => update({ term: event.target.value })}
              />
              <textarea
                className="hb-textarea"
                rows={2}
                value={item.meaning}
                maxLength={600}
                placeholder="Что это значит"
                aria-label={`Что значит термин ${index + 1}`}
                onChange={(event) => update({ meaning: event.target.value })}
              />
            </>
          )}
        />
      );
    case 'contact':
      return (
        <>
          <Field label="Кто принимает">
            <input className="hb-input" value={block.name} maxLength={200} placeholder="ФИО или название службы" onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label="Должность или с чем помогает">
            <input className="hb-input" value={block.role ?? ''} maxLength={120} onChange={(event) => set({ role: event.target.value })} />
          </Field>
          <Field label="Где">
            <input className="hb-input" value={block.room ?? ''} maxLength={120} placeholder="Корпус 2, каб. 121" onChange={(event) => set({ room: event.target.value })} />
          </Field>
          <Field label="Когда">
            <input className="hb-input" value={block.hours ?? ''} maxLength={200} placeholder="Пн–Пт 10:00–17:00" onChange={(event) => set({ hours: event.target.value })} />
          </Field>
          <Field label="Телефон">
            <input className="hb-input" value={block.phone ?? ''} maxLength={40} inputMode="tel" onChange={(event) => set({ phone: event.target.value })} />
          </Field>
          <Field label="Почта">
            <input className="hb-input" value={block.email ?? ''} maxLength={120} inputMode="email" onChange={(event) => set({ email: event.target.value })} />
          </Field>
        </>
      );
    case 'place':
      return (
        <>
          <Field label="Название">
            <input className="hb-input" value={block.title} maxLength={200} onChange={(event) => set({ title: event.target.value })} />
          </Field>
          <Field label="Адрес">
            <input className="hb-input" value={block.address ?? ''} maxLength={300} onChange={(event) => set({ address: event.target.value })} />
          </Field>
          <Field label="Как найти" hint="Вход, этаж, ориентиры — то, что не видно на карте">
            <textarea className="hb-textarea" rows={2} value={block.howTo ?? ''} maxLength={600} onChange={(event) => set({ howTo: event.target.value })} />
          </Field>
        </>
      );
    case 'deadline':
      return (
        <>
          <Field label="Что нужно успеть">
            <input className="hb-input" value={block.title} maxLength={200} onChange={(event) => set({ title: event.target.value })} />
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <Field label="Начало">
              <input className="hb-input" type="date" value={block.startsOn} onChange={(event) => set({ startsOn: event.target.value })} />
            </Field>
            <Field label="Конец (необязательно)">
              <input className="hb-input" type="date" value={block.endsOn ?? ''} onChange={(event) => set({ endsOn: event.target.value || undefined })} />
            </Field>
          </div>
          <span className="faint small">Бот напомнит о сроке за 3 дня и накануне — тем, кто включил напоминания.</span>
        </>
      );
    case 'link':
    case 'file':
    case 'chat': {
      const chat = block.type === 'chat';
      return (
        <>
          <Field label="Название">
            <input className="hb-input" value={block.title} maxLength={200} onChange={(event) => set({ title: event.target.value })} />
          </Field>
          <Field
            label="Ссылка"
            hint={chat ? 'Ссылка-приглашение в чат MAX: https://max.ru/…' : 'Только https:// — например, https://example.edu/form'}
            error={urlHint(block.url, chat)}
          >
            <input
              className="hb-input"
              type="url"
              value={block.url}
              maxLength={1024}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={chat ? MAX_CHAT : HTTPS}
              onChange={(event) => set({ url: event.target.value.trim() })}
            />
          </Field>
          <Field label="Пояснение (необязательно)">
            <input className="hb-input" value={block.note ?? ''} maxLength={300} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </>
      );
    }
    default:
      return null;
  }
}

export function AddBlockSheet({ onPick, onClose }: { onPick: (type: BlockType) => void; onClose: () => void }) {
  const order: BlockType[] = ['text', 'steps', 'checklist', 'faq', 'contact', 'place', 'deadline', 'alert', 'link', 'file', 'chat', 'glossary'];
  return (
    <Sheet title="Добавить блок" onClose={onClose}>
      <div className="hb-blocktypes">
        {order.map((type) => (
          <button key={type} type="button" className="hb-blocktype" onClick={() => onPick(type)}>
            <span className="hb-blocktype__icon" aria-hidden="true">
              <Icon name={BLOCK_LABEL[type].icon} size={18} />
            </span>
            <span className="stack" style={{ gap: 2, textAlign: 'left' }}>
              <span style={{ fontWeight: 600 }}>{BLOCK_LABEL[type].title}</span>
              <span className="small muted">{BLOCK_LABEL[type].hint}</span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** Плавная прокрутка — только если человек не просил уменьшить движение на экране. */
function scrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  } catch {
    return 'auto';
  }
}

export function BlockCard({
  block,
  index,
  total,
  onChange,
  onRemove,
  onMove,
  defaultOpen = false,
  problem,
}: {
  block: Block;
  index: number;
  total: number;
  onChange: (block: Block) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  /** Только что добавленный блок сразу раскрыт: его нужно заполнить. */
  defaultOpen?: boolean;
  /** Что мешает опубликовать этот блок. */
  problem?: string | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Удаление в два касания: случайный тап по ✕ не должен стирать заполненный блок
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Порядок и удаление — за кнопкой «⋯»: в покое карточка показывает только содержание,
  // а удалить блок случайным касанием нельзя (нужно открыть меню и подтвердить)
  const [tools, setTools] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (defaultOpen) ref.current?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  }, [defaultOpen]);
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);
  const label = BLOCK_LABEL[block.type];
  return (
    <div ref={ref} className={`card hb-editblock ${open ? 'hb-editblock--open' : ''} ${problem ? 'hb-editblock--problem' : ''}`}>
      <div className="hb-editblock__heading">
        <button type="button" className="hb-editblock__head" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={`block-fields-${block.id}`}>
          <span className="hb-blocktype__icon" aria-hidden="true">
            <Icon name={label.icon} size={18} />
          </span>
          <span className="stack" style={{ gap: 2, textAlign: 'left' }}>
            <span style={{ fontWeight: 600 }}>{label.title}</span>
            <span className="small muted">{summaryOf(block) || 'Не заполнен — нажмите, чтобы заполнить'}</span>
          </span>
          <span className="hb-editblock__chevron"><Icon name="chevron-down" size={20} /></span>
        </button>
        <button type="button" className="hb-editblock__more" aria-label={`Блок ${index + 1}: порядок и удаление`} aria-expanded={tools}
          aria-controls={`block-tools-${block.id}`} onClick={() => { setTools(!tools); setConfirmRemove(false); }}>
          <Icon name="more" size={20} />
        </button>
      </div>
      {tools ? (
        <div className="hb-editblock__tools" id={`block-tools-${block.id}`} role="group" aria-label={`Блок «${label.title}»`}>
          <button type="button" className="hb-chip" disabled={index === 0} onClick={() => onMove(-1)}><Icon name="up" size={16} />Выше</button>
          <button type="button" className="hb-chip" disabled={index === total - 1} onClick={() => onMove(1)}><Icon name="down" size={16} />Ниже</button>
          {confirmRemove ? (
            <button type="button" className="hb-chip hb-chip--danger-solid" onClick={onRemove}>Удалить блок?</button>
          ) : (
            <button type="button" className="hb-chip hb-chip--danger" onClick={() => setConfirmRemove(true)}><Icon name="trash" size={16} />Удалить</button>
          )}
        </div>
      ) : null}
      {problem ? <span className="hb-editblock__problem small">{problem}</span> : null}
      {open ? (
        <div className="stack hb-editblock__body" id={`block-fields-${block.id}`}>
          <BlockForm block={block} onChange={onChange} />
        </div>
      ) : null}
    </div>
  );
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd()}…`;
}

function summaryOf(block: Block): string {
  const count = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, one, few, many)}`;
  switch (block.type) {
    case 'text':
    case 'alert':
      // Обрезка по слову и с многоточием; две строки дальше ограничивает CSS — тоже с «…»
      return clip(block.text, 140);
    case 'steps':
      return block.title || (block.items.some((item) => item.text.trim()) ? count(block.items.length, 'шаг', 'шага', 'шагов') : '');
    case 'checklist':
      return block.title || (block.items.some((item) => item.text.trim()) ? count(block.items.length, 'пункт', 'пункта', 'пунктов') : '');
    case 'faq':
      return block.items[0]?.question || '';
    case 'contact':
      return block.name;
    case 'place':
    case 'deadline':
    case 'link':
    case 'file':
    case 'chat':
      return block.title;
    case 'glossary':
      return block.items.some((item) => item.term.trim()) ? count(block.items.length, 'термин', 'термина', 'терминов') : '';
    default:
      return '';
  }
}
