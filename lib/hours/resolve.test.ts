import { describe, expect, it } from 'vitest';
import type { WeeklySchedule } from '@/db/schema/config';
import type { HoursConfig } from './index';
import {
  defaultHours,
  emptyCatalog,
  groupHours,
  ticketHours,
  type HoursCatalog,
  type PolicyHours,
} from './resolve';

/** The company week: Sunday–Thursday, 09:00–17:00 Cairo. */
const CAIRO: WeeklySchedule = {
  sun: [{ start: '09:00', end: '17:00' }],
  mon: [{ start: '09:00', end: '17:00' }],
  tue: [{ start: '09:00', end: '17:00' }],
  wed: [{ start: '09:00', end: '17:00' }],
  thu: [{ start: '09:00', end: '17:00' }],
  fri: [],
  sat: [],
};

/** A team that covers the weekend instead, out of Dubai. */
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

  built.schedules.set('default-schedule', {
    schedule: CAIRO,
    timezone: 'Africa/Cairo',
    holidays: [{ date: '2026-08-17', name: 'Company day' }],
  } satisfies HoursConfig);

  built.schedules.set('weekend-schedule', {
    schedule: WEEKEND,
    timezone: 'Asia/Dubai',
    holidays: [{ date: '2026-08-22', name: 'Weekend team day' }],
  } satisfies HoursConfig);

  built.defaultId = 'default-schedule';
  built.overrides.set('weekend-group', 'weekend-schedule');

  return built;
}

function policy(overrides: Partial<PolicyHours> = {}): PolicyHours {
  return { hoursSource: 'group', businessHoursId: null, ...overrides };
}

describe('defaultHours', () => {
  it('is the schedule flagged default', () => {
    expect(defaultHours(catalog())?.timezone).toBe('Africa/Cairo');
  });

  it('is null when nobody has marked one', () => {
    const withoutDefault = catalog();
    withoutDefault.defaultId = null;
    expect(defaultHours(withoutDefault)).toBeNull();
  });
});

describe('groupHours', () => {
  it('is the group own schedule when it has one', () => {
    const hours = groupHours(catalog(), 'weekend-group');
    expect(hours?.timezone).toBe('Asia/Dubai');
    expect(hours?.schedule.sat).toHaveLength(1);
  });

  it('brings the group own holidays rather than the default schedule holidays', () => {
    // The holiday list travels with the schedule, which is the whole reason a
    // group override is one setting and not three.
    expect(groupHours(catalog(), 'weekend-group')?.holidays).toEqual([
      { date: '2026-08-22', name: 'Weekend team day' },
    ]);
    expect(groupHours(catalog(), 'cairo-group')?.holidays).toEqual([
      { date: '2026-08-17', name: 'Company day' },
    ]);
  });

  it('falls back to the default for a group with no schedule of its own', () => {
    expect(groupHours(catalog(), 'cairo-group')?.timezone).toBe('Africa/Cairo');
  });

  it('falls back to the default for a ticket with no group at all', () => {
    expect(groupHours(catalog(), null)?.timezone).toBe('Africa/Cairo');
  });

  it('is null when there is no override and no default', () => {
    const bare = emptyCatalog();
    expect(groupHours(bare, 'cairo-group')).toBeNull();
  });
});

describe('ticketHours', () => {
  it('lets the group override the global default', () => {
    expect(ticketHours(catalog(), 'weekend-group', policy())?.timezone).toBe('Asia/Dubai');
    expect(ticketHours(catalog(), 'cairo-group', policy())?.timezone).toBe('Africa/Cairo');
  });

  it('honours a schedule named on the policy over the group', () => {
    // An admin who pointed this policy at one calendar meant it; swapping in the
    // group's would make the setting a lie.
    const pinned = policy({ hoursSource: 'schedule', businessHoursId: 'default-schedule' });
    expect(ticketHours(catalog(), 'weekend-group', pinned)?.timezone).toBe('Africa/Cairo');
  });

  it('falls back to the default when the policy names a schedule that is gone', () => {
    const dangling = policy({ hoursSource: 'schedule', businessHoursId: 'deleted-schedule' });
    expect(ticketHours(catalog(), 'weekend-group', dangling)?.timezone).toBe('Africa/Cairo');
  });

  it('is round the clock when the policy says so, whatever the group works', () => {
    const alwaysOn = policy({ hoursSource: 'round_the_clock' });
    expect(ticketHours(catalog(), 'weekend-group', alwaysOn)).toBeNull();
    expect(ticketHours(catalog(), null, alwaysOn)).toBeNull();
  });

  it('still resolves the group hours for a ticket with no policy', () => {
    // Reporting measures every ticket. The same overnight wait must not count
    // differently depending on whether anyone got round to writing an SLA.
    expect(ticketHours(catalog(), 'weekend-group', null)?.timezone).toBe('Asia/Dubai');
    expect(ticketHours(catalog(), 'cairo-group', null)?.timezone).toBe('Africa/Cairo');
  });

  it('ignores the named schedule when the policy counts against the group', () => {
    // A policy switched back to group hours must not quietly keep using the
    // schedule it was pinned to before.
    const stale = policy({ hoursSource: 'group', businessHoursId: 'weekend-schedule' });
    expect(ticketHours(catalog(), 'cairo-group', stale)?.timezone).toBe('Africa/Cairo');
  });
});
