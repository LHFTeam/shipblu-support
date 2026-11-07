import { sql } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { vi } from 'vitest';

/**
 * Holds the next `db.transaction` the code under test opens until released —
 * `before` its first statement, so it has begun and its `now()` is fixed, or
 * `after` its last one, so it holds every lock it took and has not committed.
 *
 * How a test puts a second writer exactly between two others: a race decided by
 * when a transaction began, or by a lock somebody holds, cannot be reproduced
 * by running the two writers one after the other.
 */
export function holdNextTransaction(at: 'before' | 'after') {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const atHold = new Promise<void>((resolve) => (reached = resolve));
  const real = PgDatabase.prototype.transaction;
  const spy = vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementationOnce(function (
    this: PgDatabase<never>,
    run,
    config,
  ) {
    return real.call(
      this,
      async (tx) => {
        if (at === 'before') {
          await tx.execute(sql`select 1`);
          reached();
          await held;
          return run(tx);
        }
        const result = await run(tx);
        reached();
        await held;
        return result;
      },
      config,
    ) as never;
  });
  return { atHold: atHold.then(() => spy.mockRestore()), release };
}

/**
 * Resolves once some session is waiting on a lock, so a release lands behind
 * it: true then, and false if none was after two seconds. `statement`, a
 * Postgres regular expression, narrows it to a session waiting in a statement
 * whose text matches.
 *
 * A test whose point is the wait asserts the answer, and names the statement
 * when which one waited is the point: an unlocked read followed by an UPDATE
 * queues too, on the UPDATE, having read the row before the writer it waited
 * on committed.
 */
export async function untilWaitingOnALock(
  executor: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  statement?: string,
): Promise<boolean> {
  const matching = statement ? sql`and query ~* ${statement}` : sql``;
  for (let i = 0; i < 100; i++) {
    const [{ waiting }] = (await executor.execute(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' ${matching}`,
    )) as unknown as [{ waiting: number }];
    if (waiting > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
