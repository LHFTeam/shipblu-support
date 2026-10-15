import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { ago, formatDateTime, formatDay, formatRelative, formatTime, sentenceCase } from './format';

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

  it('writes the same text whatever separators the engine’s locale data carries', () => {
    // These are drawn on the server and again in the browser, so they have to
    // read the same in both. Node 22's ICU puts a comma after the weekday and
    // Chromium 141's does not. Each pass stands in for an engine with other
    // locale data — another separator between the fields, or the fields in
    // another order — through both ways of asking it.
    const proto = Intl.DateTimeFormat.prototype;
    const parts = proto.formatToParts;
    const format = Object.getOwnPropertyDescriptor(proto, 'format')!;
    const at = cairo({ year: 2026, month: 10, day: 14, hour: 9, minute: 5 });
    const engines: ((written: Intl.DateTimeFormatPart[]) => Intl.DateTimeFormatPart[])[] = [
      ...[', ', ' ', '|'].map(
        (separator) => (written: Intl.DateTimeFormatPart[]) =>
          written.map((part) => (part.type === 'literal' ? { ...part, value: separator } : part)),
      ),
      (written) => [...written].reverse(),
    ];
    for (const locale of engines) {
      const engine = function (this: Intl.DateTimeFormat, date?: Date | number) {
        return locale(parts.call(this, date));
      };
      vi.spyOn(proto, 'formatToParts').mockImplementation(engine);
      // A getter in the specification, which TypeScript types as a method, so
      // `vi.spyOn` cannot reach it.
      Object.defineProperty(proto, 'format', {
        configurable: true,
        get(this: Intl.DateTimeFormat) {
          return (date?: Date | number) =>
            engine
              .call(this, date)
              .map((part) => part.value)
              .join('');
        },
      });
      try {
        expect(formatDay(at)).toBe('Wednesday, 14 October 2026');
        expect(formatDateTime(at)).toBe('14 Oct 2026, 09:05');
        expect(formatTime(at)).toBe('09:05');
      } finally {
        vi.restoreAllMocks();
        Object.defineProperty(proto, 'format', format);
      }
    }
  });

  it('falls back to the engine’s own text rather than writing "undefined"', () => {
    const at = cairo({ year: 2026, month: 10, day: 14, hour: 9, minute: 5 });
    const whole = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Africa/Cairo',
    }).format(at);
    const parts = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function (
      this: Intl.DateTimeFormat,
      date,
    ) {
      return parts.call(this, date).filter((part) => part.type !== 'weekday');
    });
    try {
      expect(formatDay(at)).toBe(whole);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('writes midnight as 00:00, never 24:00, and pads the hour', () => {
    expect(formatTime(cairo({ year: 2026, month: 3, day: 1, hour: 0, minute: 0 }))).toBe('00:00');
    expect(formatTime(cairo({ year: 2026, month: 3, day: 1, hour: 9, minute: 5 }))).toBe('09:05');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const ago = (ms: number) => formatRelative(new Date(now.getTime() - ms), now);
  const MINUTE = 60_000;

  it('counts against the clock it is given, not the one it runs under', () => {
    // Whatever the machine's own clock says: that is the reading a server and
    // a browser disagree about, and why the argument is required.
    expect(formatRelative('2026-10-15T11:57:00Z', now)).toBe('3m');
  });

  it('steps from minutes to hours to days at each whole unit', () => {
    expect(ago(59_999)).toBe('now');
    expect(ago(MINUTE)).toBe('1m');
    expect(ago(60 * MINUTE - 1)).toBe('59m');
    expect(ago(60 * MINUTE)).toBe('1h');
    expect(ago(24 * 60 * MINUTE)).toBe('1d');
    expect(ago(29 * 24 * 60 * MINUTE)).toBe('29d');
  });

  it('writes the date itself from a month back', () => {
    expect(ago(30 * 24 * 60 * MINUTE)).toBe('15 Sept 2026, 15:00');
  });

  it('reads an instant later than the clock as now, not as a negative count', () => {
    // A row written after the clock reading it is compared with — a message
    // that landed between a server render and the bucket it is drawn against.
    expect(ago(-5 * MINUTE)).toBe('now');
  });
});

describe('ago', () => {
  it('ends a sentence with whatever formatRelative answered', () => {
    expect(`Opened ${ago('3m')}`).toBe('Opened 3m ago');
    expect(`Opened ${ago('2h')}`).toBe('Opened 2h ago');
    expect(`Opened ${ago('29d')}`).toBe('Opened 29d ago');
  });

  it('says "just now" in the first minute, never "now ago"', () => {
    expect(`checked ${ago('now')}`).toBe('checked just now');
  });

  it('leaves a date a date, never "<date> ago"', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    const old = formatRelative('2026-07-03T11:02:00Z', now);
    expect(`Opened ${ago(old)}`).toBe('Opened 3 Jul 2026, 14:02');
  });
});
