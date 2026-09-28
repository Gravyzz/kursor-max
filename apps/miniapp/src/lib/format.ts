const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', { timeZone, ...options });
    cache.set(key, f);
  }
  return f;
}

/** Часовой пояс устройства: время событий (изменена, задан вопрос) показываем по часам человека. */
export const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
  } catch {
    return 'Europe/Moscow';
  }
})();

/** Сегодняшняя дата в формате ГГГГ-ММ-ДД по часам устройства (для полей type="date"). */
export function todayIso(tz: string = LOCAL_TZ) {
  const parts = Object.fromEntries(
    fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Число с разделением разрядов: «4 851». */
export const num = (n: number) => n.toLocaleString('ru-RU');

export const dateTime = (iso: string | Date, tz: string = LOCAL_TZ) =>
  fmt(tz, { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/**
 * Короткая дата для списков: «сегодня, 06:34», «вчера, 17:22», «12 марта, 21:34».
 * День недели не нужен: в рабочих списках важно, насколько это свежо.
 */
export function relativeDateTime(iso: string | Date, tz: string = LOCAL_TZ, now: Date = new Date()) {
  const date = new Date(iso);
  const key = (value: Date) => fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  const clock = fmt(tz, { hour: '2-digit', minute: '2-digit' }).format(date);
  if (key(date) === key(now)) return `сегодня, ${clock}`;
  if (key(date) === key(new Date(now.getTime() - 86_400_000))) return `вчера, ${clock}`;
  const sameYear = fmt(tz, { year: 'numeric' }).format(date) === fmt(tz, { year: 'numeric' }).format(now);
  return `${fmt(tz, { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) }).format(date)}, ${clock}`;
}

export const dayLong = (iso: string | Date, tz: string) => fmt(tz, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
export const time = (iso: string | Date, tz: string) => fmt(tz, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const dayKey = (iso: string | Date, tz: string) => fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** Дата из YYYY-MM-DD без сдвига часового пояса. */
export function dateOnly(isoDate: string, withYear = false) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(
    new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)),
  );
}

export function plural(n: number, one: string, few: string, many: string) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export const days = (n: number) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

export function relativeDeadline(daysLeft: number) {
  if (daysLeft < 0) return `срок прошёл ${days(-daysLeft)} назад`;
  if (daysLeft === 0) return 'срок сегодня';
  if (daysLeft === 1) return 'остался 1 день';
  return `осталось ${days(daysLeft)}`;
}

export const CONTROL_TYPE: Record<string, string> = {
  exam: 'Экзамен',
  credit: 'Зачёт',
  graded_credit: 'Дифзачёт',
  course_work: 'Курсовая',
  practice: 'Практика',
};

export const HELP_KIND: Record<string, string> = {
  consultation: 'Нужна консультация',
  reschedule: 'Не могу в эти даты',
  dont_understand: 'Не понимаю требования',
  other: 'Другое',
};

export const minutesAgo = (iso: string | Date) => {
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diff < 1) return 'только что';
  if (diff < 60) return `${diff} мин назад`;
  const hours = Math.round(diff / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
};
