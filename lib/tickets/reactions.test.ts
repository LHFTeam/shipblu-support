import { describe, expect, it } from 'vitest';
import { foldReactions, type ReactionRow, storedReaction } from './reactions';

// The same reply, named from the customer's chat and from the business app's
// echo — see lib/whatsapp/wamid.test.ts for how these are built.
const REPLY_BY_PHONE = 'wamid.HBgMMjAxMDAwMDAwMDAxFQIAERgWM0VCMEFBQUExMTExMjIyMkJCQkIzMwA=';
const REPLY_BY_ECHO = 'wamid.HBgTRUcuMTAwMDAwMDAwMDAwMDAwMRUUABEYFjNFQjBBQUFBMTExMTIyMjJCQkJCMzMA';

function row(id: string, overrides: Partial<ReactionRow> = {}): ReactionRow {
  return {
    id,
    direction: 'inbound',
    authorContactId: 'contact-1',
    channelMessageId: `wamid.${id}`,
    reaction: null,
    ...overrides,
  };
}

function react(id: string, target: string, emoji: string, overrides: Partial<ReactionRow> = {}) {
  return row(id, { reaction: { targetWamid: target, emoji }, ...overrides });
}

describe('foldReactions', () => {
  it("puts a customer's reaction on the reply typed on the phone", () => {
    const fold = foldReactions([
      row('reply', {
        direction: 'outbound',
        authorContactId: null,
        channelMessageId: REPLY_BY_ECHO,
      }),
      react('r1', REPLY_BY_PHONE, '🙏'),
    ]);

    expect(fold.rows.get('r1')?.targetId).toBe('reply');
    expect(fold.shown.get('reply')).toEqual([{ messageId: 'r1', emoji: '🙏' }]);
  });

  it('matches a wamid named the same way exactly', () => {
    const fold = foldReactions([row('m'), react('r1', 'wamid.m', '👍')]);
    expect(fold.rows.get('r1')?.targetId).toBe('m');
  });

  it('shows the latest reaction from each side, and lets either side take theirs back', () => {
    const fold = foldReactions([
      row('m'),
      react('r1', 'wamid.m', '👍'),
      react('r2', 'wamid.m', '❤️', { direction: 'outbound', authorContactId: null }),
      react('r3', 'wamid.m', '🙏'),
    ]);

    // The customer changed 👍 to 🙏, so 🙏 is the newer and is drawn last.
    expect(fold.shown.get('m')).toEqual([
      { messageId: 'r2', emoji: '❤️' },
      { messageId: 'r3', emoji: '🙏' },
    ]);

    const withdrawn = foldReactions([
      row('m'),
      react('r1', 'wamid.m', '👍'),
      react('r2', 'wamid.m', ''),
    ]);
    expect(withdrawn.shown.has('m')).toBe(false);
    // Both rows are still about `m`, so neither is drawn as a line of its own.
    expect(withdrawn.rows.get('r1')?.targetId).toBe('m');
    expect(withdrawn.rows.get('r2')?.targetId).toBe('m');
  });

  it('keeps two customers on one thread from overwriting each other', () => {
    const fold = foldReactions([
      row('m'),
      react('r1', 'wamid.m', '👍'),
      react('r2', 'wamid.m', '😂', { authorContactId: 'contact-2' }),
    ]);
    expect(fold.shown.get('m')).toHaveLength(2);
  });

  it('answers null for a reaction whose message is not on the ticket', () => {
    const fold = foldReactions([row('m'), react('r1', REPLY_BY_PHONE, '👍')]);

    expect(fold.rows.get('r1')?.targetId).toBeNull();
    expect(fold.shown.size).toBe(0);
  });

  it('places an unreadable reaction nowhere, and never as a target', () => {
    const fold = foldReactions([
      row('m'),
      row('broken', { reaction: { targetWamid: null, emoji: null } }),
      react('r1', 'wamid.broken', '👍'),
    ]);

    expect(fold.rows.get('broken')).toEqual({ emoji: null, targetId: null });
    // Its own wamid is not something another reaction can land on.
    expect(fold.rows.get('r1')?.targetId).toBeNull();
    expect(fold.shown.size).toBe(0);
  });

  it('never puts a reaction on another reaction', () => {
    const fold = foldReactions([react('r1', 'wamid.x', '👍'), react('r2', 'wamid.r1', '❤️')]);
    expect(fold.rows.get('r2')?.targetId).toBeNull();
  });

  it('keeps the earlier of two rows holding one message under different wamids', () => {
    const fold = foldReactions([
      row('history', { direction: 'outbound', channelMessageId: REPLY_BY_PHONE }),
      row('echo', { direction: 'outbound', channelMessageId: REPLY_BY_ECHO }),
      react('r1', REPLY_BY_ECHO, '👍'),
    ]);
    // The exact match wins over the key: it is the one the reactor named.
    expect(fold.rows.get('r1')?.targetId).toBe('echo');

    const byKey = foldReactions([
      row('history', { direction: 'outbound', channelMessageId: REPLY_BY_PHONE }),
      row('echo', {
        direction: 'outbound',
        channelMessageId:
          'wamid.HBgTRUcuMTAwMDAwMDAwMDAwMDAwMhUUABEYFjNFQjBBQUFBMTExMTIyMjJCQkJCMzMA',
      }),
      react('r1', REPLY_BY_ECHO, '👍'),
    ]);
    expect(byKey.rows.get('r1')?.targetId).toBe('history');
  });
});

describe('storedReaction', () => {
  const meta = { whatsappType: 'reaction' };

  it('reads the target and emoji off the stored delivery', () => {
    const raw = JSON.stringify({
      type: 'reaction',
      reaction: { message_id: 'wamid.x', emoji: '🙏' },
    });
    expect(storedReaction(meta, raw)).toEqual({ targetWamid: 'wamid.x', emoji: '🙏' });
  });

  it('reads a removal as an empty emoji', () => {
    const raw = JSON.stringify({ reaction: { message_id: 'wamid.x' } });
    expect(storedReaction(meta, raw)).toEqual({ targetWamid: 'wamid.x', emoji: '' });
  });

  it('answers null for a row that is not tagged as a reaction', () => {
    const raw = JSON.stringify({ reaction: { message_id: 'wamid.x', emoji: '🙏' } });
    expect(storedReaction({ whatsappType: 'text' }, raw)).toBeNull();
    expect(storedReaction(null, raw)).toBeNull();
  });

  it('keeps a tagged row a reaction when its payload cannot be read', () => {
    // Null rather than "not a reaction": the row is still not something the
    // customer said, and must not come back as a `[reacted 👍]` bubble.
    const unreadable = { targetWamid: null, emoji: null };
    expect(storedReaction(meta, null)).toEqual(unreadable);
    expect(storedReaction(meta, '{not json')).toEqual(unreadable);
    expect(storedReaction(meta, 'null')).toEqual(unreadable);
    expect(storedReaction(meta, JSON.stringify({ reaction: { emoji: '🙏' } }))).toEqual(unreadable);
    expect(storedReaction(meta, JSON.stringify({ message_id: 'wamid.x' }))).toEqual(unreadable);
  });
});
