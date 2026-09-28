import { createElement, useState, type ReactNode } from 'react';
import { Button } from '@maxhub/max-ui';
import { bridge } from '../../lib/bridge';
import { dateOnly, days } from '../../lib/format';
import type { Block } from '../../lib/types';
import { Icon } from '../../components/icons';

/**
 * Рендер блоков страницы справочника. Блоки намеренно простые: их редактируют с телефона,
 * по ним работает поиск, а сроки и чек-листы превращаются в напоминания и личный прогресс.
 */

type HeadingLevel = 2 | 3 | 4;

/** Заголовок блока: на странице — h2 под h1 страницы, в предпросмотре внутри листа — ниже. */
function Heading({ level, children, style }: { level: HeadingLevel; children: ReactNode; style?: React.CSSProperties }) {
  return createElement(`h${level}`, { className: 'hb-block__title', style }, children);
}

export function daysUntil(iso: string, today: string): number {
  const a = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const b = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  return Math.round((a - b) / 86_400_000);
}

/**
 * Подпись срока. Для периода важно, начался ли он: «через 8 дней» до начала,
 * «идёт, осталось 5 дней» внутри периода, «последний день» в его конце.
 */
export function deadlineWhen(startsOn: string, endsOn: string | null | undefined, today: string): { text: string; tone: 'risk' | 'warn' | 'neutral' } {
  const range = Boolean(endsOn && endsOn !== startsOn);
  if (!range) return whenLabel(daysUntil(startsOn, today));
  const toStart = daysUntil(startsOn, today);
  const toEnd = daysUntil(endsOn!, today);
  if (toEnd < 0) return { text: 'срок прошёл', tone: 'risk' };
  if (toStart > 0) {
    const early = whenLabel(toStart);
    return { text: toStart === 1 ? 'начинается завтра' : `начало ${early.text}`, tone: toStart <= 3 ? 'warn' : 'neutral' };
  }
  if (toEnd === 0) return { text: 'последний день', tone: 'risk' };
  return { text: `идёт · осталось ${days(toEnd)}`, tone: toEnd <= 3 ? 'risk' : toEnd <= 7 ? 'warn' : 'neutral' };
}

export function whenLabel(left: number): { text: string; tone: 'risk' | 'warn' | 'neutral' } {
  if (left < 0) return { text: 'срок прошёл', tone: 'risk' };
  if (left === 0) return { text: 'сегодня', tone: 'risk' };
  if (left === 1) return { text: 'завтра', tone: 'risk' };
  if (left <= 7) return { text: `через ${days(left)}`, tone: 'warn' };
  return { text: `через ${days(left)}`, tone: 'neutral' };
}

const toneStyle = (tone: 'risk' | 'warn' | 'neutral') =>
  tone === 'neutral' ? undefined : { color: `var(--pd-${tone})`, fontWeight: 600 };

function TextBlock({ text }: { text: string }) {
  return (
    <div className="hb-text">
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

function Steps({ block, level }: { block: Extract<Block, { type: 'steps' }>; level: HeadingLevel }) {
  return (
    <div className="card hb-block">
      {block.title ? <Heading level={level}>{block.title}</Heading> : null}
      <ol className="hb-steps">
        {block.items.map((item, index) => (
          <li key={item.id}>
            <span className="hb-steps__num" aria-hidden="true">{index + 1}</span>
            <span className="stack" style={{ gap: 2 }}>
              <span>{item.text}</span>
              {item.hint ? <span className="small muted">{item.hint}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Checklist({
  block,
  done,
  onToggle,
  today,
  level,
}: {
  block: Extract<Block, { type: 'checklist' }>;
  done: Set<string>;
  onToggle: (itemId: string, next: boolean) => void;
  today: string;
  level: HeadingLevel;
}) {
  const completed = block.items.filter((item) => done.has(item.id)).length;
  return (
    <div className="card hb-block">
      <div className="row row--between">
        <Heading level={level} style={{ margin: 0 }}>
          {block.title || 'Чек-лист'}
        </Heading>
        <span className="small muted num">
          {completed} из {block.items.length}
        </span>
      </div>
      <div className="hb-progress" aria-hidden="true">
        <span style={{ width: `${block.items.length ? Math.round((completed / block.items.length) * 100) : 0}%` }} />
      </div>
      <ul className="hb-checklist">
        {block.items.map((item) => {
          const checked = done.has(item.id);
          const due = item.dueOn ? whenLabel(daysUntil(item.dueOn, today)) : null;
          return (
            <li key={item.id}>
              <label className={`hb-check ${checked ? 'hb-check--on' : ''}`}>
                <input type="checkbox" checked={checked} onChange={(event) => onToggle(item.id, event.target.checked)} />
                <span className="hb-check__box" aria-hidden="true" />
                <span className="stack" style={{ gap: 2 }}>
                  <span className="hb-check__text">{item.text}</span>
                  {due && !checked ? (
                    <span className={`small ${due.tone === 'neutral' ? 'muted' : ''}`} style={toneStyle(due.tone)}>
                      {dateOnly(item.dueOn!)} · {due.text}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Faq({ block, level }: { block: Extract<Block, { type: 'faq' }>; level: HeadingLevel }) {
  const [open, setOpen] = useState<string | null>(block.items.length === 1 ? block.items[0]!.id : null);
  return (
    <div className="card hb-block">
      <Heading level={level}>Частые вопросы</Heading>
      <div className="hb-faq">
        {block.items.map((item) => {
          const expanded = open === item.id;
          return (
            <div key={item.id} className="hb-faq__item">
              <button type="button" className="hb-faq__q" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : item.id)}>
                <span>{item.question}</span>
                <span className="hb-faq__chevron" aria-hidden="true"><Icon name={expanded ? 'up' : 'chevron-down'} size={18} /></span>
              </button>
              {expanded ? <div className="hb-faq__a">{item.answer}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Contact({ block }: { block: Extract<Block, { type: 'contact' }> }) {
  return (
    <div className="card hb-block hb-contact">
      <div className="stack" style={{ gap: 2 }}>
        <span className="hb-contact__name">{block.name}</span>
        {block.role ? <span className="small muted">{block.role}</span> : null}
      </div>
      <dl className="hb-facts">
        {block.room ? (
          <div>
            <dt>Где</dt>
            <dd>{block.room}</dd>
          </div>
        ) : null}
        {block.hours ? (
          <div>
            <dt>Когда</dt>
            <dd>{block.hours}</dd>
          </div>
        ) : null}
        {block.phone ? (
          <div>
            <dt>Телефон</dt>
            <dd>
              <a href={`tel:${block.phone.replace(/\s/g, '')}`}>{block.phone}</a>
            </dd>
          </div>
        ) : null}
        {block.email ? (
          <div>
            <dt>Почта</dt>
            <dd>
              <a href={`mailto:${block.email}`}>{block.email}</a>
            </dd>
          </div>
        ) : null}
      </dl>
      {block.maxLink ? (
        <Button variant="secondary" size="medium" onClick={() => bridge.openLink(block.maxLink!)}>
          Написать в MAX
        </Button>
      ) : null}
    </div>
  );
}

function Place({ block, level }: { block: Extract<Block, { type: 'place' }>; level: HeadingLevel }) {
  return (
    <div className="card hb-block">
      <div className="row" style={{ gap: 10, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <span className="hb-block__icon" aria-hidden="true">
          <Icon name="pin" />
        </span>
        <div className="stack" style={{ gap: 4, flex: 1, minWidth: 0 }}>
          <Heading level={level} style={{ margin: 0 }}>
            {block.title}
          </Heading>
          {block.address ? <span className="small">{block.address}</span> : null}
          {block.howTo ? <span className="small muted">{block.howTo}</span> : null}
        </div>
      </div>
      {block.mapLink ? (
        <Button variant="secondary" size="medium" onClick={() => bridge.openLink(block.mapLink!)}>
          Открыть на карте
        </Button>
      ) : null}
    </div>
  );
}

function Deadline({
  block,
  today,
  level,
  reminders,
  onOpenProfile,
}: {
  block: Extract<Block, { type: 'deadline' }>;
  today: string;
  level: HeadingLevel;
  reminders: boolean | null | undefined;
  onOpenProfile?: () => void;
}) {
  const left = daysUntil(block.endsOn ?? block.startsOn, today);
  const when = deadlineWhen(block.startsOn, block.endsOn, today);
  return (
    <div className={`card hb-block hb-deadline hb-deadline--${when.tone}`}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <span className="hb-block__icon" aria-hidden="true">
          <Icon name="clock" />
        </span>
        <div className="stack" style={{ gap: 4, flex: 1, minWidth: 0 }}>
          <Heading level={level} style={{ margin: 0 }}>
            {block.title}
          </Heading>
          <span className="small num">
            {block.endsOn && block.endsOn !== block.startsOn
              ? `${dateOnly(block.startsOn)} — ${dateOnly(block.endsOn)}`
              : dateOnly(block.startsOn)}
            {' · '}
            <span style={toneStyle(when.tone)}>{when.text}</span>
          </span>
          {left < 0 ? null : reminders === false ? (
            // Напоминания выключены в «О себе» — не обещаем того, чего не будет
            <span className="faint small">
              Напоминания о сроках выключены.{' '}
              {onOpenProfile ? (
                <button type="button" className="linkbtn small" onClick={onOpenProfile}>
                  Включить в «О себе»
                </button>
              ) : (
                'Включить можно в «О себе».'
              )}
            </span>
          ) : (
            <span className="faint small">Напомню заранее в чате</span>
          )}
        </div>
      </div>
    </div>
  );
}

function LinkLike({ block }: { block: Extract<Block, { type: 'link' | 'file' | 'chat' }> }) {
  const icon = block.type === 'file' ? 'file' : block.type === 'chat' ? 'chat' : 'link';
  const action = block.type === 'file' ? 'Открыть файл' : block.type === 'chat' ? 'Войти в чат' : 'Перейти';
  return (
    <button type="button" className="card hb-block hb-link" onClick={() => bridge.openLink(block.url)}>
      <span className="hb-block__icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="stack" style={{ gap: 2, textAlign: 'left', flex: 1 }}>
        <span style={{ fontWeight: 600 }}>{block.title}</span>
        {block.note ? <span className="small muted">{block.note}</span> : null}
      </span>
      <span className="hb-link__action small">{action} ›</span>
    </button>
  );
}

function Alert({ block }: { block: Extract<Block, { type: 'alert' }> }) {
  return (
    <div className={`hb-alert hb-alert--${block.tone}`} role="note">
      <span className="hb-block__icon" aria-hidden="true">
        <Icon name={block.tone === 'warn' ? 'warn' : 'info'} />
      </span>
      <span>{block.text}</span>
    </div>
  );
}

function Glossary({ block, level }: { block: Extract<Block, { type: 'glossary' }>; level: HeadingLevel }) {
  return (
    <div className="card hb-block">
      <Heading level={level}>Словарь</Heading>
      <dl className="hb-glossary">
        {block.items.map((item) => (
          <div key={item.id}>
            <dt>{item.term}</dt>
            <dd>{item.meaning}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export interface BlocksProps {
  blocks: Block[];
  today: string;
  done: Set<string>;
  onToggle: (itemId: string, next: boolean) => void;
  /** Уровень заголовков блоков: 2 — на странице (под h1), 4 — в предпросмотре внутри листа. */
  headingLevel?: HeadingLevel;
  /** Напоминания о сроках у читателя: false — выключены в «О себе»; null — неизвестно. */
  reminders?: boolean | null;
  /** Открыть «О себе», чтобы включить напоминания. */
  onOpenProfile?: () => void;
}

export function Blocks({ blocks, today, done, onToggle, headingLevel = 2, reminders, onOpenProfile }: BlocksProps) {
  const level = headingLevel;
  return (
    <div className="stack--lg hb-reader-blocks">
      {blocks.map((block) => {
        switch (block.type) {
          case 'text':
            return <TextBlock key={block.id} text={block.text} />;
          case 'steps':
            return <Steps key={block.id} block={block} level={level} />;
          case 'checklist':
            return <Checklist key={block.id} block={block} done={done} onToggle={onToggle} today={today} level={level} />;
          case 'faq':
            return <Faq key={block.id} block={block} level={level} />;
          case 'contact':
            return <Contact key={block.id} block={block} />;
          case 'place':
            return <Place key={block.id} block={block} level={level} />;
          case 'deadline':
            return <Deadline key={block.id} block={block} today={today} level={level} reminders={reminders} onOpenProfile={onOpenProfile} />;
          case 'link':
          case 'file':
          case 'chat':
            return <LinkLike key={block.id} block={block} />;
          case 'alert':
            return <Alert key={block.id} block={block} />;
          case 'glossary':
            return <Glossary key={block.id} block={block} level={level} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
