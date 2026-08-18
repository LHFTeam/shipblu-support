import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { SlaTargets, WeeklySchedule } from '@/db/schema/config';
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
    hours: null,
    ...overrides,
  };
}

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
  it('adds wall-clock time when the policy is round-the-clock', () => {
    const due = dueDatesOnCreate(policy(), 'urgent', at('2026-08-20T16:00'));

    expect(inCairo(due.firstResponseDueAt)).toBe('2026-08-20T16:30');
    expect(inCairo(due.resolutionDueAt)).toBe('2026-08-20T20:00');
  });

  it('adds working time when the policy has business hours', () => {
    const withHours = policy({ hours: { schedule: CAIRO, timezone: 'Africa/Cairo' } });
    // Thursday 16:00 plus the 8-hour resolution target: one hour before closing
    // on Thursday, then seven on Sunday. Friday and Saturday are not time
    // anyone owed the customer, so they are not spent.
    const due = dueDatesOnCreate(withHours, 'high', at('2026-08-20T16:00'));

    expect(inCairo(due.firstResponseDueAt)).toBe('2026-08-20T17:00');
    expect(inCairo(due.resolutionDueAt)).toBe('2026-08-23T16:00');
  });

  it('leaves the next-response clock unset on a new ticket', () => {
    // Until someone has replied once, the first-response target is the one that
    // applies; two countdowns on a brand new ticket is just noise.
    expect(
      dueDatesOnCreate(policy(), 'urgent', at('2026-08-20T16:00')).nextResponseDueAt,
    ).toBeNull();
  });

  it('leaves an unset target null rather than making it due immediately', () => {
    const partial = policy({
      targets: {
        ...TARGETS,
        medium: { firstResponseMins: 240, nextResponseMins: null, resolutionMins: null },
      },
    });

    expect(dueDatesOnCreate(partial, 'medium', at('2026-08-17T10:00')).resolutionDueAt).toBeNull();
  });
});

describe('nextResponseDueAt', () => {
  it('uses the next-response target when there is one', () => {
    expect(inCairo(nextResponseDueAt(policy(), 'high', at('2026-08-17T10:00')))).toBe(
      '2026-08-17T12:00',
    );
  });

  it('falls back to the first-response target when there is not', () => {
    // Most teams configure one number and mean it for every reply.
    expect(inCairo(nextResponseDueAt(policy(), 'medium', at('2026-08-17T10:00')))).toBe(
      '2026-08-17T14:00',
    );
  });
});

describe('dueAt', () => {
  it('refuses nonsense rather than producing a date in the past', () => {
    const from = at('2026-08-17T10:00');
    expect(dueAt(policy(), null, from)).toBeNull();
    expect(dueAt(policy(), -60, from)).toBeNull();
    expect(dueAt(policy(), Number.NaN, from)).toBeNull();
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
