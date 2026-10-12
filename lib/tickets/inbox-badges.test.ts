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
  priority: 'medium',
  sideState: null,
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
});
