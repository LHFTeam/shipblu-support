import { describe, expect, it, vi } from 'vitest';
import { rowBadges } from './inbox-badges';

// The WhatsApp window badges sit behind `answeredFromConsole`, which is false
// for WhatsApp today. The rule under test is the window's, so the channel
// policy is opened up here rather than the test going quiet on WhatsApp.
vi.mock('./channel-policy', async (original) => ({
  ...(await original<typeof import('./channel-policy')>()),
  answeredFromConsole: () => true,
}));

const NOW = new Date('2026-10-12T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

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
});
