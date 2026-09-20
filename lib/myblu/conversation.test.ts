import { describe, expect, it } from 'vitest';
import { messagesSince } from './conversation';

/**
 * The poll cursor, which is where this feature's real bug would live.
 *
 * Everything else in `conversation.ts` delegates to `lib/portal/tickets.ts`,
 * which already has the properties that matter and is exercised by the portal.
 * The cursor is the one piece written here, and its failure mode is quiet: an
 * off-by-one does not error, it duplicates a customer's conversation slowly on
 * their own screen while every server-side check stays green.
 */

function message(id: string, at: string) {
  return {
    id,
    from: 'agent' as const,
    authorName: 'Ahmed',
    body: `message ${id}`,
    createdAt: new Date(at),
  };
}

const thread = [
  message('a', '2026-09-20T09:00:00.000Z'),
  message('b', '2026-09-20T09:00:01.000Z'),
  message('c', '2026-09-20T09:05:00.000Z'),
];

describe('the poll cursor', () => {
  it('is exclusive, so the message the client already holds is not resent', () => {
    // The app polls with the timestamp of its last message. An inclusive
    // comparison returns that message on every poll, and a client that appends
    // what it receives duplicates the thread one message at a time.
    const since = new Date('2026-09-20T09:00:01.000Z');
    expect(messagesSince(thread, since).map((m) => m.id)).toEqual(['c']);
  });

  it('returns a message written one millisecond after the cursor', () => {
    const since = new Date('2026-09-20T09:00:00.999Z');
    expect(messagesSince(thread, since).map((m) => m.id)).toEqual(['b', 'c']);
  });

  it('returns nothing when the cursor is the newest message', () => {
    expect(messagesSince(thread, new Date('2026-09-20T09:05:00.000Z'))).toEqual([]);
  });

  it('returns the whole thread with no cursor', () => {
    expect(messagesSince(thread).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(messagesSince(thread, null).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('round-trips its own output as the next cursor', () => {
    // The contract the app actually implements: take `createdAt` off the last
    // message you received and send it back. Anything that does not survive
    // that loop resends or drops a message every poll.
    let cursor: Date | null = null;
    const seen: string[] = [];

    for (let poll = 0; poll < 4; poll += 1) {
      const batch = messagesSince(thread, cursor);
      seen.push(...batch.map((m) => m.id));
      const last = batch.at(-1);
      if (last) cursor = new Date(last.createdAt);
    }

    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('serialises instants as ISO strings so the cursor is exact', () => {
    // A locale-formatted date would lose the milliseconds the comparison above
    // depends on, and two messages a few hundred milliseconds apart would then
    // be indistinguishable to the cursor.
    expect(messagesSince(thread)[1]!.createdAt).toBe('2026-09-20T09:00:01.000Z');
  });
});
