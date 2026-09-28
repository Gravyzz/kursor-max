import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, formatDateRu, formatDateTimeRu, localDate, notBefore, pluralDays, zonedToUtc } from '../src/domain/dates.js';

describe('даты в часовом поясе вуза', () => {
  it('переводит локальное время в UTC и обратно', () => {
    const moment = zonedToUtc('2026-09-25', '14:00', 'Europe/Moscow');
    assert.equal(moment.toISOString(), '2026-09-25T11:00:00.000Z');
    assert.equal(localDate(new Date('2026-09-25T22:30:00Z'), 'Asia/Tomsk'), '2026-09-26');
    assert.equal(zonedToUtc('2026-09-25', '09:30', 'Asia/Tomsk').toISOString(), '2026-09-25T02:30:00.000Z');
  });

  it('форматирует по-русски', () => {
    assert.equal(formatDateRu('2026-10-15'), '15 октября');
    assert.equal(formatDateTimeRu(new Date('2026-09-25T11:00:00Z'), 'Europe/Moscow'), 'пт, 25 сентября, 14:00');
    assert.equal(addDays('2026-09-30', 2), '2026-10-02');
    assert.deepEqual([1, 2, 5, 11, 21, 24].map(pluralDays), ['1 день', '2 дня', '5 дней', '11 дней', '21 день', '24 дня']);
  });

  it('напоминания не будят: с 10:00 до 21:00, поздно вечером — на следующее утро', () => {
    const tz = 'Europe/Moscow';
    // 08:00 МСК → сегодня в 10:00
    assert.equal(notBefore(tz, '10:00', '21:00', new Date('2026-10-01T05:00:00Z')).toISOString(), '2026-10-01T07:00:00.000Z');
    // 15:00 МСК → сразу
    const day = new Date('2026-10-01T12:00:00Z');
    assert.equal(notBefore(tz, '10:00', '21:00', day).toISOString(), day.toISOString());
    // 23:30 МСК → завтра в 10:00
    assert.equal(notBefore(tz, '10:00', '21:00', new Date('2026-10-01T20:30:00Z')).toISOString(), '2026-10-02T07:00:00.000Z');
    // без верхней границы вечером — сразу, как раньше
    const late = new Date('2026-10-01T20:30:00Z');
    assert.equal(notBefore(tz, '10:00', undefined, late).toISOString(), late.toISOString());
  });
});
