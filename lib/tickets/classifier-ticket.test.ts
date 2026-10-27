import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The memo, not the query. No database: `db` is stubbed so each read is
 * counted and its answer chosen, which is what these tests are about — that
 * the two enqueuers share one read, and that a read the pool refused is not
 * handed to the second as though the ticket had failed for it too.
 */
const reads = vi.hoisted(() => ({
  count: 0,
  answers: [] as (unknown[] | Error)[],
}));

vi.mock('@/db/client', () => {
  // Enough of the builder for `select().from().where().limit()`.
  const query = {
    from: () => query,
    where: () => query,
    limit: () => {
      const answer = reads.answers[reads.count] ?? [];
      reads.count += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { db: { select: () => query } };
});

const { classifierTicket } = await import('./classifier-ticket');

const open = { channel: 'whatsapp', firstRespondedAt: null };

beforeEach(() => {
  reads.count = 0;
  reads.answers = [];
});

describe('classifierTicket', () => {
  it('reads the ticket once however many enqueuers ask', async () => {
    reads.answers = [[open]];
    const ticket = classifierTicket('c1');

    await expect(ticket()).resolves.toEqual(open);
    await expect(ticket()).resolves.toEqual(open);
    expect(reads.count).toBe(1);
  });

  // Priority's read refused at the admission gate: the category enqueuer, in
  // its own try/catch, reads again rather than inheriting the refusal.
  it('forgets a read that failed, so the next enqueuer reads again', async () => {
    reads.answers = [new Error('waited past its deadline'), [open]];
    const ticket = classifierTicket('c1');

    await expect(ticket()).rejects.toThrow('waited past its deadline');
    await expect(ticket()).resolves.toEqual(open);
    expect(reads.count).toBe(2);
  });

  it('answers null for the bot, and for a ticket that is gone', async () => {
    reads.answers = [[{ channel: 'whatsapp_bot', firstRespondedAt: null }], []];

    await expect(classifierTicket('bot')()).resolves.toBeNull();
    await expect(classifierTicket('gone')()).resolves.toBeNull();
  });
});
