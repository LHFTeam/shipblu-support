import assert from 'node:assert/strict';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { DatabaseDeadlineError, WebPool } from '../../db/web-pool';

async function main() {
  // Fault injection belongs only on the disposable CI database, never Supabase.
  const url = new URL(process.env.DATABASE_URL!);
  assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/shipblu_ci');
  const makeRaw = () => postgres(url.toString(), { max: 1, prepare: false });
  const events: Record<string, unknown>[] = [];
  const raw = makeRaw();
  const pool = new WebPool(
    () => raw,
    { statementMs: 100, deadlineMs: 2_000, cooldownMs: 50 },
    (e) => events.push(e),
  );
  const db = drizzle(pool.getSql());
  try {
    const rows = await db.select({ value: sql<number>`42` }).from(sql`(select 1) as probe`);
    assert.equal(rows[0]?.value, 42); // Drizzle's .values() path
    const setting = await db.execute(sql`select current_setting('statement_timeout') as value`);
    assert.equal(setting[0]?.value, '100ms');
    await db.transaction(
      async (tx) => {
        const inside = await tx.execute(sql`select current_setting('statement_timeout') as value`);
        assert.equal(inside[0]?.value, '100ms');
        await tx.transaction(async (nested) => {
          await nested.execute(sql`select 1`);
        });
      },
      { isolationLevel: 'read committed', accessMode: 'read only' },
    );
    await assert.rejects(db.execute(sql`select pg_sleep(0.3)`), (error: unknown) => {
      const cause = (error as { cause?: { code?: string } }).cause;
      return cause?.code === '57014';
    });
    assert.equal(events.filter((e) => e.event === 'deadline').length, 0);
    await db.execute(sql`select 1`); // Ordinary 57014 must leave the pool usable.
    const outside = await raw.unsafe('show statement_timeout');
    assert.notEqual(outside[0]?.statement_timeout, '100ms'); // SET LOCAL did not leak.
    console.log(
      'web-db: Drizzle rows, transactions, savepoints, SET LOCAL and 57014 recovery passed',
    );
  } finally {
    await pool.close();
  }

  // Hold the only client slot before BEGIN. No statement has reached Postgres,
  // so this specifically proves the client timer covers pool acquisition.
  const queuedRaw = makeRaw();
  const reserved = await queuedRaw.reserve();
  const queuedPool = new WebPool(
    () => queuedRaw,
    { statementMs: 100, deadlineMs: 200, cooldownMs: 50 },
    () => {},
  );
  try {
    await assert.rejects(
      Promise.resolve(queuedPool.getSql().unsafe('select 1')),
      DatabaseDeadlineError,
    );
    console.log('web-db: deadline before connection acquisition passed');
  } finally {
    reserved.release();
    await queuedPool.close();
    await queuedRaw.end({ timeout: 0 });
  }

  const slowPool = new WebPool(
    makeRaw,
    { statementMs: 5_000, deadlineMs: 1_000, cooldownMs: 50 },
    () => {},
  );
  try {
    const old = slowPool.getSql();
    await assert.rejects(Promise.resolve(old.unsafe('select pg_sleep(2)')), DatabaseDeadlineError);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await slowPool.getSql().unsafe('select 1');
    await assert.rejects(Promise.resolve(old.unsafe('select 1')), DatabaseDeadlineError);
    console.log('web-db: in-flight deadline, pool replacement and stale-client refusal passed');
  } finally {
    await slowPool.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
