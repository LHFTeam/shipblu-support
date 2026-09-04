import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { SlaTargets, WeeklySchedule } from '@/db/schema/config';
import type { HoursConfig } from '@/lib/hours';
import { emptyCatalog, ticketHours, type HoursCatalog } from '@/lib/hours/resolve';
import type { Facts } from '@/lib/rules/conditions';
import {
  dueAt,
  dueDatesOnCreate,
  nextResponseDueAt,
  selectPolicy,
  targetFor,
  type LoadedPolicy,
} from './policy';

const CAIRO: WeeklySchedule = {
  sun: [{ start: '09:00', end: '17:00' }],
  mon: [{ start: '09:00', end: '17:00' }],
  tue: [{ start: '09:00', end: '17:00' }],
  wed: [{ start: '09:00', end: '17:00' }],
  thu: [{ start: '09:00', end: '17:00' }],
  fri: [],
  sat: [],
};

const TARGETS: SlaTargets = {
  low: { firstResponseMins: 480, nextResponseMins: null, resolutionMins: 2880 },
  medium: { firstResponseMins: 240, nextResponseMins: null, resolutionMins: 1440 },
  high: { firstResponseMins: 60, nextResponseMins: 120, resolutionMins: 480 },
  urgent: { firstResponseMins: 30, nextResponseMins: 30, resolutionMins: 240 },
};

function policy(overrides: Partial<LoadedPolicy> = {}): LoadedPolicy {
  return {
    id: 'policy-1',
    name: 'Default',
    conditions: {},
    targets: TARGETS,
    escalations: {},
    position: 0,
    isDefault: false,
    hoursSource: 'round_the_clock',
    businessHoursId: null,
    ...overrides,
  };
}

/**
 * The resolved schedule is passed in rather than read off the policy: which
 * calendar applies depends on the ticket's group, and `lib/hours/resolve.ts` is
 * what decides it.
 */
const CAIRO_HOURS: HoursConfig = { schedule: CAIRO, timezone: 'Africa/Cairo' };

function at(iso: string): Date {
  return DateTime.fromISO(iso, { zone: 'Africa/Cairo' }).toJSDate();
}

function inCairo(date: Date | null): string | null {
  if (!date) return null;
  return DateTime.fromJSDate(date, { zone: 'Africa/Cairo' }).toFormat("yyyy-MM-dd'T'HH:mm");
}

const facts: Facts = { priority: 'urgent', channel: 'whatsapp', 'group.id': 'shipping' };

describe('selectPolicy', () => {
  it('takes the first match by position, not the best match', () => {
    const chosen = selectPolicy(
      [
        policy({ id: 'catch-all', position: 10, conditions: {} }),
        policy({
          id: 'urgent-whatsapp',
          position: 1,
          conditions: {
            all: [
              { field: 'priority', op: 'eq', value: 'urgent' },
              { field: 'channel', op: 'eq', value: 'whatsapp' },
            ],
          },
        }),
      ],
      facts,
    );

    expect(chosen?.id).toBe('urgent-whatsapp');
  });

  it('falls back to the default policy when nothing matches', () => {
    const chosen = selectPolicy(
      [
        policy({
          id: 'email-only',
          position: 1,
          conditions: { field: 'channel', op: 'eq', value: 'email' },
        }),
        policy({
          id: 'fallback',
          position: 2,
          isDefault: true,
          conditions: { field: 'channel', op: 'eq', value: 'email' },
        }),
      ],
      facts,
    );

    // Chosen despite its own conditions not matching: that is what default means,
    // and a ticket with no policy at all is invisible to every breach sweep.
    expect(chosen?.id).toBe('fallback');
  });

  it('returns null when nothing matches and there is no default', () => {
    const chosen = selectPolicy(
      [policy({ conditions: { field: 'channel', op: 'eq', value: 'email' } })],
      facts,
    );
    expect(chosen).toBeNull();
  });

  it('ignores a policy whose conditions are corrupt', () => {
    const chosen = selectPolicy(
      [
        policy({ id: 'broken', position: 1, conditions: 'priority = urgent' }),
        policy({ id: 'good', position: 2, conditions: {} }),
      ],
      facts,
    );
    expect(chosen?.id).toBe('good');
  });
});

describe('dueDatesOnCreate', () => {
  it('adds wall-clock time when no schedule applies', () => {
    const due = dueDatesOnCreate(policy(), 'urgent', at('2026-08-20T16:00'), null);

    expect(inCairo(due.firstResponseDueAt)).toBe('2026-08-20T16:30');
    expect(inCairo(due.resolutionDueAt)).toBe('2026-08-20T20:00');
  });

  it('adds working time when a schedule applies', () => {
    // Thursday 16:00 plus the 8-hour resolution target: one hour before closing
    // on Thursday, then seven on Sunday. Friday and Saturday are not time
    // anyone owed the customer, so they are not spent.
    const due = dueDatesOnCreate(policy(), 'high', at('2026-08-20T16:00'), CAIRO_HOURS);

    expect(inCairo(due.firstResponseDueAt)).toBe('2026-08-20T17:00');
    expect(inCairo(due.resolutionDueAt)).toBe('2026-08-23T16:00');
  });

  it('leaves the next-response clock unset on a new ticket', () => {
    // Until someone has replied once, the first-response target is the one that
    // applies; two countdowns on a brand new ticket is just noise.
    expect(
      dueDatesOnCreate(policy(), 'urgent', at('2026-08-20T16:00'), null).nextResponseDueAt,
    ).toBeNull();
  });

  it('leaves an unset target null rather than making it due immediately', () => {
    const partial = policy({
      targets: {
        ...TARGETS,
        medium: { firstResponseMins: 240, nextResponseMins: null, resolutionMins: null },
      },
    });

    expect(
      dueDatesOnCreate(partial, 'medium', at('2026-08-17T10:00'), null).resolutionDueAt,
    ).toBeNull();
  });
});

describe('group business hours', () => {
  /** A team that works the weekend instead of Sunday–Thursday. */
  const WEEKEND: WeeklySchedule = {
    sun: [],
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [{ start: '10:00', end: '18:00' }],
    sat: [{ start: '10:00', end: '18:00' }],
  };

  function catalog(): HoursCatalog {
    const built = emptyCatalog();
    built.schedules.set('cairo', { schedule: CAIRO, timezone: 'Africa/Cairo' });
    built.schedules.set('weekend', { schedule: WEEKEND, timezone: 'Africa/Cairo' });
    built.defaultId = 'cairo';
    built.overrides.set('weekend-group', 'weekend');
    return built;
  }

  it('lands the same target on a different instant per group', () => {
    // Thursday 16:00, an 8-hour resolution target, one policy. The company
    // schedule spends the last hour of Thursday and finds the other seven on
    // Sunday; the weekend team is shut on Thursday, so its eight hours are the
    // whole of Friday, 10:00 to 18:00.
    const arrived = at('2026-08-20T16:00');
    const onGroupHours = policy({ hoursSource: 'group' });

    const company = dueDatesOnCreate(
      onGroupHours,
      'high',
      arrived,
      ticketHours(catalog(), 'cairo-group', onGroupHours),
    );
    const weekend = dueDatesOnCreate(
      onGroupHours,
      'high',
      arrived,
      ticketHours(catalog(), 'weekend-group', onGroupHours),
    );

    expect(inCairo(company.resolutionDueAt)).toBe('2026-08-23T16:00');
    expect(inCairo(weekend.resolutionDueAt)).toBe('2026-08-21T18:00');
  });

  it('holds a policy pinned to one schedule to that schedule in every group', () => {
    const pinned = policy({ hoursSource: 'schedule', businessHoursId: 'cairo' });

    const due = dueDatesOnCreate(
      pinned,
      'high',
      at('2026-08-20T16:00'),
      ticketHours(catalog(), 'weekend-group', pinned),
    );

    expect(inCairo(due.resolutionDueAt)).toBe('2026-08-23T16:00');
  });

  it("skips the group own holidays, not the company's", () => {
    // Sunday is a holiday for the weekend team and a working day for everyone
    // else, so the same Thursday ticket is due at different times again.
    const built = catalog();
    built.schedules.set('weekend', {
      schedule: CAIRO,
      timezone: 'Africa/Cairo',
      holidays: [{ date: '2026-08-23', nameEn: 'Team day' }],
    });

    const onGroupHours = policy({ hoursSource: 'group' });
    const due = dueDatesOnCreate(
      onGroupHours,
      'high',
      at('2026-08-20T16:00'),
      ticketHours(built, 'weekend-group', onGroupHours),
    );

    expect(inCairo(due.resolutionDueAt)).toBe('2026-08-24T16:00');
  });
});

describe('nextResponseDueAt', () => {
  it('uses the next-response target when there is one', () => {
    expect(inCairo(nextResponseDueAt(policy(), 'high', at('2026-08-17T10:00'), null))).toBe(
      '2026-08-17T12:00',
    );
  });

  it('falls back to the first-response target when there is not', () => {
    // Most teams configure one number and mean it for every reply.
    expect(inCairo(nextResponseDueAt(policy(), 'medium', at('2026-08-17T10:00'), null))).toBe(
      '2026-08-17T14:00',
    );
  });
});

describe('dueAt', () => {
  it('refuses nonsense rather than producing a date in the past', () => {
    const from = at('2026-08-17T10:00');
    expect(dueAt(null, null, from)).toBeNull();
    expect(dueAt(null, -60, from)).toBeNull();
    expect(dueAt(CAIRO_HOURS, Number.NaN, from)).toBeNull();
  });
});

describe('targetFor', () => {
  it('returns an empty target for a priority the policy never configured', () => {
    const sparse = policy({ targets: { high: TARGETS.high } as unknown as SlaTargets });
    expect(targetFor(sparse, 'low')).toEqual({
      firstResponseMins: null,
      nextResponseMins: null,
      resolutionMins: null,
    });
  });
});
