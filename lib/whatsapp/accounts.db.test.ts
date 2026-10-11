import { asc, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { whatsappAccounts } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { ensureAccountForWaba } from './accounts';

/**
 * The account row an Embedded Signup connection writes, against Postgres
 * because the race it must survive is decided by a unique index.
 *
 * `ensureAccountForWaba` runs in the transaction that stores the credential,
 * after the business's one-use sign-in code was spent. Throwing there is not a
 * retry: it sends the business through Meta's window again, which unlinks the
 * phone's linked devices again.
 */

withCleanDatabase();

/**
 * Until a backend in this database is waiting on a lock — the second insert,
 * held on the first transaction's uncommitted row in the name index. Polled
 * rather than slept for, so the test does not depend on how fast the machine
 * is; bounded, so a second connection that never blocks fails loudly instead
 * of hanging.
 */
async function untilAnInsertWaitsOnALock(): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    const [row] = await db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the second connection never waited on the first');
}

describe('ensureAccountForWaba', () => {
  /**
   * Both read the names before either commits, so both choose "Acme"; the
   * second insert loses to the name index rather than to its own WABA's row,
   * and reading back by WABA id found nothing — which threw.
   */
  it('gives two WABAs with the same Meta name a row each when they connect at once', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let insertedFirst!: () => void;
    const firstInserted = new Promise<void>((resolve) => (insertedFirst = resolve));

    const first = db.transaction(async (tx) => {
      const account = await ensureAccountForWaba(tx, '333', 'Acme');
      insertedFirst();
      await held;
      return account;
    });
    await firstInserted;

    const second = db.transaction((tx) => ensureAccountForWaba(tx, '444', 'Acme'));
    await untilAnInsertWaitsOnALock();
    release();

    const [winner, loser] = await Promise.all([first, second]);
    expect(winner).toMatchObject({ created: true });
    expect(loser).toMatchObject({ created: true, reactivated: false, previousVariable: null });

    expect(
      await db
        .select({ name: whatsappAccounts.name, wabaId: whatsappAccounts.wabaId })
        .from(whatsappAccounts)
        .orderBy(asc(whatsappAccounts.wabaId)),
    ).toEqual([
      { name: 'Acme', wabaId: '333' },
      { name: 'Acme 444', wabaId: '444' },
    ]);
  });

  /** The other race: the same WABA twice. The loser answers with the winner's row. */
  it('answers a second connection of the same WABA with the row the first made', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let insertedFirst!: () => void;
    const firstInserted = new Promise<void>((resolve) => (insertedFirst = resolve));

    const first = db.transaction(async (tx) => {
      const account = await ensureAccountForWaba(tx, '333', 'Acme');
      insertedFirst();
      await held;
      return account;
    });
    await firstInserted;

    const second = db.transaction((tx) => ensureAccountForWaba(tx, '333', 'Acme'));
    await untilAnInsertWaitsOnALock();
    release();

    const [winner, loser] = await Promise.all([first, second]);
    expect(loser).toEqual({
      id: winner.id,
      created: false,
      reactivated: false,
      previousVariable: null,
    });
    expect(await db.select({ id: whatsappAccounts.id }).from(whatsappAccounts)).toHaveLength(1);
  });
});
