import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { formatDay, formatTime, sentenceCase } from './format';

describe('sentenceCase', () => {
  it('capitalises the first letter and spaces every underscore', () => {
    expect(sentenceCase('published')).toBe('Published');
    expect(sentenceCase('agents_only')).toBe('Agents only');
    expect(sentenceCase('account_admin_role')).toBe('Account admin role');
  });

  it('leaves an empty string empty', () => {
    expect(sentenceCase('')).toBe('');
  });
});

/*
  Wall-clock fixtures, converted by the timezone database: Cairo observes DST
  again, so a summer instant is UTC+3 and a winter one UTC+2, and a day break
  placed in UTC would land an evening message on the next day in one season
  and not the other.
*/
function cairo(fields: { year: number; month: number; day: number; hour: number; minute: number }) {
  return DateTime.fromObject(fields, { zone: 'Africa/Cairo' }).toJSDate();
}

describe('formatDay / formatTime', () => {
  it('breaks the day at Cairo midnight in summer (UTC+3)', () => {
    const beforeMidnight = cairo({ year: 2026, month: 8, day: 29, hour: 23, minute: 59 });
    const afterMidnight = cairo({ year: 2026, month: 8, day: 30, hour: 0, minute: 5 });

    // 20:59Z and 21:05Z, the same UTC day — and two Cairo days.
    expect(beforeMidnight.toISOString()).toBe('2026-08-29T20:59:00.000Z');
    expect(afterMidnight.toISOString()).toBe('2026-08-29T21:05:00.000Z');
    expect(formatDay(beforeMidnight)).toBe('Saturday, 29 August 2026');
    expect(formatDay(afterMidnight)).toBe('Sunday, 30 August 2026');
    expect(formatTime(beforeMidnight)).toBe('23:59');
    expect(formatTime(afterMidnight)).toBe('00:05');
  });

  it('breaks the day at Cairo midnight in winter (UTC+2)', () => {
    const beforeMidnight = cairo({ year: 2026, month: 1, day: 15, hour: 23, minute: 59 });
    const afterMidnight = cairo({ year: 2026, month: 1, day: 16, hour: 0, minute: 5 });

    expect(beforeMidnight.toISOString()).toBe('2026-01-15T21:59:00.000Z');
    expect(afterMidnight.toISOString()).toBe('2026-01-15T22:05:00.000Z');
    expect(formatDay(beforeMidnight)).toBe('Thursday, 15 January 2026');
    expect(formatDay(afterMidnight)).toBe('Friday, 16 January 2026');
    expect(formatTime(beforeMidnight)).toBe('23:59');
    expect(formatTime(afterMidnight)).toBe('00:05');
  });

  it('writes midnight as 00:00, never 24:00, and pads the hour', () => {
    expect(formatTime(cairo({ year: 2026, month: 3, day: 1, hour: 0, minute: 0 }))).toBe('00:00');
    expect(formatTime(cairo({ year: 2026, month: 3, day: 1, hour: 9, minute: 5 }))).toBe('09:05');
  });
});
