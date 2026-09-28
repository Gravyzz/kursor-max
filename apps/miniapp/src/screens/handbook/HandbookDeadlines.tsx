import { Button } from '@maxhub/max-ui';
import { useHandbook } from './context';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/useLoad';
import { dateOnly } from '../../lib/format';
import type { HandbookHome } from '../../lib/types';
import { EmptyState, ErrorState, Skeletons } from '../../components/ui';
import { Icon } from '../../components/icons';
import { deadlineWhen } from './Blocks';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

type Tone = 'risk' | 'warn' | 'neutral';
type DeadlineItem = HandbookHome['deadlines'][number];

/** Дата, которую показываем в кружке: для идущего срока — его конец, иначе начало. */
export const deadlineDate = (item: Pick<DeadlineItem, 'startsOn' | 'endsOn'>, today: string) => item.startsOn <= today && item.endsOn ? item.endsOn : item.startsOn;

/**
 * Срочность для цвета: к тону из текста добавляем «скоро» — неделя и меньше до даты.
 * Так «начало через 7 дней» тоже подсвечивается, а не выглядит обычной строкой.
 */
export function deadlineTone(item: Pick<DeadlineItem, 'startsOn' | 'endsOn'>, today: string): Tone {
  const base = deadlineWhen(item.startsOn, item.endsOn, today).tone;
  if (base !== 'neutral') return base;
  const left = Math.round((Date.parse(deadlineDate(item, today)) - Date.parse(today)) / 86_400_000);
  return left >= 0 && left <= 7 ? 'warn' : 'neutral';
}

/** Кружок с датой: число и месяц, цвет — по срочности. */
export function DeadlineDate({ date, tone }: { date: string; tone: Tone }) {
  return <span className={`hb-reader-date hb-reader-date--${tone}`} aria-hidden="true"><b>{Number(date.slice(8, 10))}</b><small>{MONTHS[Number(date.slice(5, 7)) - 1]}</small></span>;
}

/** Первая буква заглавная: подписи сроков стоят первыми в строке. */
export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function HandbookDeadlines() {
  const hb = useHandbook();
  const { data, error, loading, reload } = useLoad((signal) => api<HandbookHome>(hb.url('/api/handbook'), { signal }), [hb.handbookId], `home:${hb.handbookId}`);
  if (loading && !data) return <Skeletons count={3} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  return <>
    <header className="hb-page__head"><h1 className="hb-page__title">Ближайшие сроки</h1><p className="hb-page__summary">До 20 ближайших сроков на 30 дней для вашего профиля.</p></header>
    {data.deadlines.length ? <div className="stack">{data.deadlines.map((item) => {
      const date = deadlineDate(item, data.today);
      const when = deadlineWhen(item.startsOn, item.endsOn, data.today);
      const tone = deadlineTone(item, data.today);
      return <button type="button" className="card hb-reader-deadline" key={item.id} onClick={() => hb.nav.push({ name: 'hb-page', id: item.pageId })}>
        <DeadlineDate date={date} tone={tone} />
        <span className="stack hb-reader-grow"><strong>{item.title}</strong><span className={`small hb-when hb-when--${tone}`}>{dateOnly(date)} · {when.text}</span><small className="muted">{item.pageTitle}</small></span><Icon name="chevron" />
      </button>;
    })}</div> : <EmptyState icon="calendar" title="Ближайших сроков нет">Когда появятся новые даты для вашего курса, они будут здесь.</EmptyState>}
    <section className="card hb-block"><div className="row"><Icon name="bell" /><strong>{data.profile.reminders ? 'Напоминания включены' : 'Напоминания выключены'}</strong></div><p className="small muted">{data.profile.reminders ? 'Бот напомнит в чате о сроках, для которых редакторы настроили напоминания.' : 'Включите напоминания в профиле, чтобы получать их в чате с ботом.'}</p><Button variant="secondary" size="medium" onClick={() => hb.nav.tab({ name: 'hb-profile' })}>Настроить напоминания</Button></section>
  </>;
}
