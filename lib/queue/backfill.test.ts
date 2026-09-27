import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { withTestEnv } from '@/lib/testing/env';
import { logChannelTable, scanMessagesInKeysetOrder } from './backfill';

// Building a query validates the environment but never opens a connection.
withTestEnv();

const IDS = ['a1', 'b2', 'c3', 'd4', 'e5'];

/** Answers like the database would: ids after the cursor, in order, up to `size`. */
function fakeTable() {
  const calls: { after: string | null; size: number }[] = [];
  const fetchBatch = async (after: SQL | undefined, size: number) => {
    const cursor = after
      ? (db.select().from(messages).where(after).toSQL().params[0] as string)
      : null;
    calls.push({ after: cursor, size });
    return IDS.filter((id) => cursor === null || id > cursor)
      .slice(0, size)
      .map((id) => ({ id }));
  };
  return { calls, fetchBatch };
}

describe('scanMessagesInKeysetOrder', () => {
  it('visits every row once, a batch at a time, paging after the last id seen', async () => {
    const table = fakeTable();
    const visited: string[] = [];

    const scanned = await scanMessagesInKeysetOrder(
      { batchSize: 2 },
      table.fetchBatch,
      async (row) => {
        visited.push(row.id);
      },
    );

    expect(scanned).toBe(5);
    expect(visited).toEqual(IDS);
    expect(table.calls).toEqual([
      { after: null, size: 2 },
      { after: 'b2', size: 2 },
      { after: 'd4', size: 2 },
      // The empty batch after the last row is what ends the scan.
      { after: 'e5', size: 2 },
    ]);
  });

  it('stops at the limit, asking for no more than it still needs', async () => {
    const table = fakeTable();

    const scanned = await scanMessagesInKeysetOrder(
      { batchSize: 2, limit: 3 },
      table.fetchBatch,
      async () => {},
    );

    expect(scanned).toBe(3);
    expect(table.calls.map((call) => call.size)).toEqual([2, 1]);
  });

  it('reads a zero limit as no limit, as a hand-run with limit=0 means', async () => {
    const table = fakeTable();

    expect(
      await scanMessagesInKeysetOrder(
        { batchSize: 10, limit: 0 },
        table.fetchBatch,
        async () => {},
      ),
    ).toBe(5);
  });
});

describe('logChannelTable', () => {
  it('prints a fixed-width line per channel, sorted, under a header', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tallies = new Map([
      ['whatsapp', { seen: 12, kept: 3 }],
      ['email', { seen: 4, kept: 0 }],
    ]);

    logChannelTable('[tag]', tallies, [
      { heading: 'seen', width: 6, value: (tally) => tally.seen },
      { heading: 'kept', width: 6, value: (tally) => tally.kept },
    ]);

    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[tag] channel         seen  kept',
      '[tag] email              4     0',
      '[tag] whatsapp          12     3',
    ]);
    log.mockRestore();
  });
});
