import { describe, expect, it, vi } from 'vitest';
import { ROUTING_GRACE_MS } from '@/lib/routing/hold';
import { rowBadges, routingHold, routingLabel } from './inbox-badges';

// The WhatsApp window badges sit behind `answeredFromConsole`, which is false
// for WhatsApp today. The rule under test is the window's, so the channel
// policy is opened up here rather than the test going quiet on WhatsApp.
vi.mock('./channel-policy', async (original) => ({
  ...(await original<typeof import('./channel-policy')>()),
  answeredFromConsole: () => true,
}));

const NOW = new Date('2026-10-12T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
const inMinutes = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const row = (overrides: Partial<Parameters<typeof rowBadges>[0]> = {}) => ({
  channel: 'email',
  isComment: false,
  lastCustomerMessageAt: hoursAgo(1),
  statusCategory: 'open' as const,
  statusName: 'Open',
  statusIsDefault: true,
  priority: 'medium',
  sideState: null,
  categoryLabel: null,
  assigneeId: null,
  routingUntil: null,
  isSpam: false,
  ...overrides,
});

const labels = (...args: Parameters<typeof rowBadges>) => rowBadges(...args).map((b) => b.label);

describe('rowBadges', () => {
  it('counts a WhatsApp window down only inside its last two hours', () => {
    const closing = rowBadges(
      row({ channel: 'whatsapp', lastCustomerMessageAt: hoursAgo(22.5) }),
      NOW,
      'avatar',
    );
    expect(closing).toEqual([{ key: 'window', tone: 'window-closing', label: '1h 30m left' }]);

    // Exactly two hours left is not yet "closing".
    expect(
      labels(row({ channel: 'whatsapp', lastCustomerMessageAt: hoursAgo(22) }), NOW, 'avatar'),
    ).toEqual([]);
    expect(
      labels(row({ channel: 'whatsapp', lastCustomerMessageAt: hoursAgo(25) }), NOW, 'avatar'),
    ).toEqual(['Window closed']);
  });

  it('draws no window before the list has a clock', () => {
    expect(
      labels(row({ channel: 'whatsapp', lastCustomerMessageAt: hoursAgo(25) }), null, 'ticket'),
    ).toEqual(['Open']);
  });

  it('gives a comment ticket no window, and says it is public', () => {
    const comment = row({
      channel: 'facebook',
      isComment: true,
      lastCustomerMessageAt: hoursAgo(200),
    });
    expect(rowBadges(comment, NOW, 'avatar')).toEqual([
      { key: 'comment', tone: 'public', label: 'Public comment' },
    ]);
  });

  // `listInbox` decides `isComment` once, through `isCommentTicket`, which is
  // true on a comment channel whatever its external id; the badges read it.
  it('gives a comment channel no window and calls it public', () => {
    for (const channel of ['facebook_comment', 'instagram_comment']) {
      expect(
        rowBadges(
          row({ channel, isComment: true, lastCustomerMessageAt: hoursAgo(200) }),
          NOW,
          'avatar',
        ),
      ).toEqual([{ key: 'comment', tone: 'public', label: 'Public comment' }]);
    }
  });

  it('marks a Messenger thread outside 24 hours and after seven days', () => {
    expect(
      labels(row({ channel: 'instagram', lastCustomerMessageAt: hoursAgo(30) }), NOW, 'avatar'),
    ).toEqual(['Outside 24h']);
    expect(
      labels(row({ channel: 'facebook', lastCustomerMessageAt: hoursAgo(200) }), NOW, 'avatar'),
    ).toEqual(['Window closed']);
  });

  it('gives the bot channel no window', () => {
    expect(
      labels(row({ channel: 'whatsapp_bot', lastCustomerMessageAt: hoursAgo(25) }), NOW, 'avatar'),
    ).toEqual([]);
  });

  it('keeps every badge in the ticket row, in its old order', () => {
    const busy = row({
      channel: 'facebook',
      lastCustomerMessageAt: hoursAgo(30),
      priority: 'urgent',
      sideState: 'waiting',
    });
    expect(labels(busy, NOW, 'ticket')).toEqual(['Open', 'Outside 24h', 'Urgent', 'Awaiting hub']);
  });

  it('orders the avatar row by urgency and drops the open status alone', () => {
    const busy = row({
      channel: 'whatsapp',
      lastCustomerMessageAt: hoursAgo(23),
      statusCategory: 'pending',
      statusName: 'Waiting on finance',
      priority: 'high',
      sideState: 'replied',
    });
    expect(labels(busy, NOW, 'avatar')).toEqual([
      '1h 0m left',
      'Hub replied',
      'High',
      'Waiting on finance',
    ]);

    const closed = row({
      channel: 'whatsapp',
      lastCustomerMessageAt: hoursAgo(30),
      sideState: 'waiting',
    });
    expect(labels(closed, NOW, 'avatar')).toEqual(['Window closed', 'Awaiting hub']);
  });

  it('badges a status an admin added to the open category', () => {
    // Only the category's default goes unbadged; "Escalated" is open too, and
    // without its badge it would read exactly like a plain open ticket.
    expect(labels(row(), NOW, 'avatar')).toEqual([]);
    expect(labels(row({ statusName: 'Escalated', statusIsDefault: false }), NOW, 'avatar')).toEqual(
      ['Escalated'],
    );
  });

  it('names the category in words, and draws nothing while there is none', () => {
    expect(rowBadges(row({ categoryLabel: 'Merchant support' }), NOW, 'avatar')).toEqual([
      { key: 'category', tone: 'neutral', label: 'Merchant support' },
    ]);
    expect(rowBadges(row({ categoryLabel: null }), NOW, 'avatar')).toEqual([]);
    expect(labels(row({ categoryLabel: null }), NOW, 'ticket')).toEqual(['Open']);
  });

  // Only what the ticket is: after everything going wrong or waiting on
  // somebody, and after the comment marker, which changes how the reply goes
  // out — in both rows, whatever else they reorder.
  it('puts the category last in both rows', () => {
    const busy = row({
      channel: 'facebook',
      isComment: true,
      lastCustomerMessageAt: hoursAgo(200),
      statusCategory: 'pending',
      statusName: 'Waiting on finance',
      priority: 'urgent',
      sideState: 'replied',
      categoryLabel: 'Sales',
    });
    expect(labels(busy, NOW, 'ticket')).toEqual([
      'Waiting on finance',
      'Urgent',
      'Hub replied',
      'Public comment',
      'Sales',
    ]);
    expect(labels(busy, NOW, 'avatar')).toEqual([
      'Hub replied',
      'Urgent',
      'Waiting on finance',
      'Public comment',
      'Sales',
    ]);

    const closing = row({
      channel: 'whatsapp',
      lastCustomerMessageAt: hoursAgo(23),
      categoryLabel: 'Courier jobs',
    });
    expect(labels(closing, NOW, 'avatar')).toEqual(['1h 0m left', 'Courier jobs']);
    expect(labels(closing, NOW, 'ticket')).toEqual(['Open', '1h 0m left', 'Courier jobs']);
  });
  // NOW is 15:00 in Cairo (summer time, UTC+3).
  it('says a held ticket is routing, and until when while the window is ahead', () => {
    expect(rowBadges(row({ routingUntil: inMinutes(5) }), NOW, 'avatar')).toEqual([
      { key: 'routing', tone: 'automated', label: 'Routing until 15:05' },
    ]);
    // Past the window and inside the grace the settle is due: still held, and
    // a time already gone would read as a broken promise.
    expect(labels(row({ routingUntil: inMinutes(-3) }), NOW, 'avatar')).toEqual(['Routing…']);
  });

  it('draws no hold once somebody holds the ticket, routing decided it, or the grace ran out', () => {
    expect(
      labels(row({ routingUntil: inMinutes(5), assigneeId: 'agent-1' }), NOW, 'avatar'),
    ).toEqual([]);
    // `listInbox` folds a decided ticket's window to null.
    expect(labels(row({ routingUntil: null }), NOW, 'avatar')).toEqual([]);
    const lapsed = new Date(NOW.getTime() - ROUTING_GRACE_MS - 1);
    expect(labels(row({ routingUntil: lapsed }), NOW, 'avatar')).toEqual([]);
  });

  // Nothing routes a ticket that is not work — `decide` answers `not_open` —
  // and no status, spam or merge writer ends its hold, so its window stays on
  // the row until `settle_routing` records that. The badge would promise a
  // route that never comes.
  it('draws no hold on a ticket that is not work, whatever its window says', () => {
    const held = { routingUntil: inMinutes(5) };
    for (const statusCategory of ['resolved', 'closed'] as const) {
      expect(
        labels(row({ ...held, statusCategory, statusName: statusCategory }), NOW, 'ticket'),
      ).toEqual([statusCategory]);
      // Before there is a clock too: the server's paint says the same.
      expect(
        labels(row({ ...held, statusCategory, statusName: statusCategory }), null, 'ticket'),
      ).toEqual([statusCategory]);
    }
    expect(labels(row({ ...held, isSpam: true }), NOW, 'avatar')).toEqual([]);
    expect(labels(row({ ...held, isSpam: true }), null, 'avatar')).toEqual([]);

    // Pending is work, and still held.
    expect(
      labels(row({ ...held, statusCategory: 'pending', statusName: 'Pending' }), NOW, 'ticket'),
    ).toEqual(['Pending', 'Routing until 15:05']);
  });

  // The server and the browser's first render agree on the columns alone; the
  // grace and the time are the clock's to add after mount.
  it('draws the hold from the columns alone before the list has a clock', () => {
    expect(labels(row({ routingUntil: inMinutes(5) }), null, 'avatar')).toEqual(['Routing…']);
    const lapsed = new Date(NOW.getTime() - ROUTING_GRACE_MS - 1);
    expect(labels(row({ routingUntil: lapsed }), null, 'avatar')).toEqual(['Routing…']);
    expect(
      labels(row({ routingUntil: inMinutes(5), assigneeId: 'agent-1' }), null, 'avatar'),
    ).toEqual([]);
  });

  // Pages after the first arrive from /api/inbox as JSON, where the type still
  // says Date and the value is a string.
  it('reads a window that crossed JSON as a string', () => {
    const crossed = inMinutes(5).toISOString() as unknown as Date;
    expect(labels(row({ routingUntil: crossed }), NOW, 'avatar')).toEqual(['Routing until 15:05']);
  });

  it('puts the hold after what is going wrong in the avatar row, and after the status in the ticket row', () => {
    const busy = row({
      channel: 'whatsapp',
      lastCustomerMessageAt: hoursAgo(23),
      priority: 'urgent',
      sideState: 'replied',
      categoryLabel: 'Sales',
      routingUntil: inMinutes(5),
    });
    expect(labels(busy, NOW, 'avatar')).toEqual([
      '1h 0m left',
      'Hub replied',
      'Routing until 15:05',
      'Urgent',
      'Sales',
    ]);
    expect(labels(busy, NOW, 'ticket')).toEqual([
      'Open',
      'Routing until 15:05',
      '1h 0m left',
      'Urgent',
      'Hub replied',
      'Sales',
    ]);
  });
});

describe('routingHold', () => {
  const held = {
    routingWindowEndsAt: inMinutes(5),
    routingDecidedAt: null,
    assigneeAgentId: null,
    statusCategory: 'open' as const,
    isSpam: false,
    mergedIntoId: null,
  };

  it('is the open ticket’s answer as well as the row’s', () => {
    expect(routingHold(held, NOW)).toEqual({ until: inMinutes(5) });
    expect(routingHold({ ...held, routingDecidedAt: hoursAgo(1) }, NOW)).toBeNull();
    expect(routingHold({ ...held, routingWindowEndsAt: null }, NOW)).toBeNull();
    expect(routingLabel({ until: null })).toBe('Routing…');
  });

  // The header's badge and the sidebar's hints read the open ticket, which
  // can be one merged into another: the hold is over for it as for a
  // resolved one, and the hint "choosing its category now routes it" with it.
  it('answers none on a ticket resolved, closed, spam or merged inside its window', () => {
    expect(routingHold({ ...held, statusCategory: 'pending' }, NOW)).toEqual({
      until: inMinutes(5),
    });
    expect(routingHold({ ...held, statusCategory: 'resolved' }, NOW)).toBeNull();
    expect(routingHold({ ...held, statusCategory: 'closed' }, null)).toBeNull();
    expect(routingHold({ ...held, isSpam: true }, NOW)).toBeNull();
    expect(routingHold({ ...held, mergedIntoId: 'ticket-2' }, NOW)).toBeNull();
  });
});
