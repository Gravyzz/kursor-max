/** Работа с датами в часовом поясе вуза без сторонних библиотек. */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

function parts(date: Date, timeZone: string) {
  const map: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) map[part.type] = part.value;
  return map as { year: string; month: string; day: string; hour: string; minute: string };
}

/** Дата YYYY-MM-DD в часовом поясе. */
export function localDate(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function todayIn(timeZone: string, now = new Date()): string {
  return localDate(now, timeZone);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Смещение часового пояса (мс) для момента времени. */
function offsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return asUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

/** Переводит локальные дату и время вуза в абсолютный момент. */
export function zonedToUtc(isoDate: string, time: string, timeZone: string): Date {
  const [h = '0', m = '0'] = time.split(':');
  const guess = new Date(`${isoDate}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00Z`);
  const first = new Date(guess.getTime() - offsetMs(guess, timeZone));
  return new Date(guess.getTime() - offsetMs(first, timeZone));
}

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function formatDateRu(isoDate: string): string {
  const [, month, day] = isoDate.split('-').map(Number);
  return `${day} ${MONTHS_GEN[(month ?? 1) - 1]}`;
}

export function formatDateTimeRu(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  const weekday = WEEKDAYS[new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay()];
  return `${weekday}, ${Number(p.day)} ${MONTHS_GEN[Number(p.month) - 1]}, ${p.hour}:${p.minute}`;
}

export function formatTime(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.hour}:${p.minute}`;
}

export function pluralDays(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} дней`;
  if (last === 1) return `${n} день`;
  if (last >= 2 && last <= 4) return `${n} дня`;
  return `${n} дней`;
}

/** Разница в днях между датами YYYY-MM-DD (b − a). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * Когда можно отправить: сегодня в `time` по часовому поясу вуза; если это время прошло — сейчас;
 * если уже позже `until` — завтра в `time`, чтобы не писать ночью.
 */
export function notBefore(timeZone: string, time: string, until?: string, now = new Date()): Date {
  const today = todayIn(timeZone, now);
  const at = zonedToUtc(today, time, timeZone);
  if (at.getTime() > now.getTime()) return at;
  if (until && zonedToUtc(today, until, timeZone).getTime() <= now.getTime()) return zonedToUtc(addDays(today, 1), time, timeZone);
  return now;
}
