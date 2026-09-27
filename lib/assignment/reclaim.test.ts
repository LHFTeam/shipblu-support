import { describe, expect, it } from 'vitest';
import { reclaimDue } from './reclaim';

const NOW = new Date('2026-09-27T10:00:00Z');
const WAIT = 10;

function minutesAgo(mins: number): Date {
  return new Date(NOW.getTime() - mins * 60_000);
}

/** Connected and accepting, holding a ticket assigned an hour ago. */
const PRESENT = {
  isActive: true,
  isAcceptingTickets: true,
  presence: 'online',
  lastSeenAt: minutesAgo(0.2),
  acceptingChangedAt: null,
  assignedAt: minutesAgo(60),
};

describe('reclaimDue', () => {
  it('never takes a ticket from somebody connected and accepting', () => {
    expect(reclaimDue(PRESENT, WAIT, NOW)).toBe(false);
    expect(reclaimDue({ ...PRESENT, assignedAt: null }, 0, NOW)).toBe(false);
  });

  it('measures a closed console from its last heartbeat', () => {
    const gone = { ...PRESENT, presence: 'offline' };
    expect(reclaimDue({ ...gone, lastSeenAt: minutesAgo(9) }, WAIT, NOW)).toBe(false);
    expect(reclaimDue({ ...gone, lastSeenAt: minutesAgo(10) }, WAIT, NOW)).toBe(true);
  });

  it('reads a heartbeat past the TTL as gone, whatever presence says', () => {
    // The instance that held the stream died without marking them offline.
    expect(reclaimDue({ ...PRESENT, lastSeenAt: minutesAgo(3) }, 2, NOW)).toBe(true);
    expect(reclaimDue({ ...PRESENT, lastSeenAt: minutesAgo(1) }, 0, NOW)).toBe(false);
  });

  it('measures an away agent from the switch, although their open tab keeps beating', () => {
    const away = { ...PRESENT, isAcceptingTickets: false };
    expect(reclaimDue({ ...away, acceptingChangedAt: minutesAgo(9) }, WAIT, NOW)).toBe(false);
    expect(reclaimDue({ ...away, acceptingChangedAt: minutesAgo(10) }, WAIT, NOW)).toBe(true);
  });

  it('falls back to the heartbeat for an away switch with no timestamp', () => {
    const away = { ...PRESENT, isAcceptingTickets: false, acceptingChangedAt: null };
    expect(reclaimDue(away, WAIT, NOW)).toBe(false);
    expect(
      reclaimDue({ ...away, presence: 'offline', lastSeenAt: minutesAgo(30) }, WAIT, NOW),
    ).toBe(true);
  });

  it('counts from the earlier start when somebody went away and then left', () => {
    const both = {
      ...PRESENT,
      presence: 'offline',
      lastSeenAt: minutesAgo(2),
      isAcceptingTickets: false,
      acceptingChangedAt: minutesAgo(30),
    };
    expect(reclaimDue(both, WAIT, NOW)).toBe(true);
  });

  it('never starts the wait before the assignment', () => {
    const gone = { ...PRESENT, presence: 'offline', lastSeenAt: minutesAgo(120) };
    expect(reclaimDue({ ...gone, assignedAt: minutesAgo(5) }, WAIT, NOW)).toBe(false);
    expect(reclaimDue({ ...gone, assignedAt: minutesAgo(10) }, WAIT, NOW)).toBe(true);
  });

  it('measures a deactivated agent from their last heartbeat', () => {
    const departed = { ...PRESENT, isActive: false };
    expect(reclaimDue(departed, WAIT, NOW)).toBe(false);
    expect(reclaimDue({ ...departed, lastSeenAt: minutesAgo(10) }, WAIT, NOW)).toBe(true);
  });
});
