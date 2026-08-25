import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env, sessionDatabaseUrl } from '@/lib/env';
import * as schema from './schema';

/**
 * Two connection paths, as designed:
 *
 *  - `db` goes through Supavisor's TRANSACTION pooler. Prepared statements must be
 *    disabled there, because the pooler multiplexes connections and a prepared
 *    statement created on one backend will not exist on the next.
 *  - `sessionSql()` opens a SESSION-mode connection, which is the only way to use
 *    LISTEN. It is opened on demand so the worker and one-shot jobs (which never
 *    listen) do not pay for a connection they will not use.
 *
 * Everything here initialises lazily. `next build` imports route modules to
 * collect page data without runtime secrets present, so opening a pool (or even
 * reading env) at module scope would fail the build.
 */

declare global {
  /**
   * The pool hangs off `globalThis` in every environment, for two unrelated
   * reasons.
   *
   * In development, Next's dev server hot-reloads modules, and a module-local
   * pool would be rebuilt on every reload until Postgres ran out of connections.
   *
   * In production the reason is the one that cost us an outage. Next bundles
   * pages and route handlers separately, so a module-local `pool` is a
   * different variable in each of them — two pools in one process, neither able
   * to see the other's state. On 2026-08-25 the pool behind every page was
   * wedged for eighty-five minutes while `/api/health` answered `select 1` in
   * 2 ms from its own, so Render saw a healthy instance and never restarted it.
   * One pool per process is what makes the health check measure the connections
   * the pages are actually queued on.
   */
  var __shipbluSql: ReturnType<typeof postgres> | undefined;
}

let pool: ReturnType<typeof postgres> | undefined;

export function getSql(): ReturnType<typeof postgres> {
  if (pool) return pool;

  pool =
    globalThis.__shipbluSql ??
    postgres(env().DATABASE_URL, {
      prepare: false,
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      /*
       * Explicit, rather than postgres.js's default of a random 30–60 minutes
       * per process. A connection the pooler abandons mid-transaction is never
       * handed back to the pool (see §5.5), and recycling is the only thing
       * that reclaims that slot short of a restart — so the interval wants to
       * be one we picked and can reason about when reading a graph, not one
       * that differs on every instance.
       */
      max_lifetime: 60 * 15,
    });

  globalThis.__shipbluSql = pool;
  return pool;
}

/** Thrown when a database wait runs past its deadline. */
export class DbTimeout extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${ms}ms`);
    this.name = 'DbTimeout';
  }
}

/**
 * Bounds a database wait.
 *
 * postgres.js has no query timeout, and the wait that matters here is not the
 * query anyway — it is waiting for a free slot in the pool. A connection the
 * pooler abandoned mid-transaction is never returned, so once `max` of them
 * have accumulated, every later caller waits for the life of the process: no
 * error, no log line, nothing to retry. That is what "frozen" looked like from
 * the outside on 2026-08-25 — pages that never sent a byte while the database
 * itself was idle.
 *
 * The rejection is the guarantee, not any cancellation. postgres.js cancels by
 * opening a second connection and racing it, and says itself that the query may
 * not stop; the statement may well still be out there. What the caller gains is
 * the ability to fail — to answer 503, or render an error — instead of holding
 * a request open until someone notices.
 */
export async function withDeadline<T>(work: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // `race` subscribes to `work` immediately, so a rejection arriving after the
    // deadline is already handled and cannot surface as an unhandled rejection.
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DbTimeout(label, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Db = PostgresJsDatabase<typeof schema>;

let instance: Db | undefined;

function getDb(): Db {
  if (!instance) instance = drizzle(getSql(), { schema });
  return instance;
}

/**
 * Proxy so call sites can keep importing `db` directly while the underlying
 * connection is still created on first use rather than on import.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, property) {
    const target = getDb();
    const value = Reflect.get(target, property) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

/**
 * A dedicated session-mode connection for LISTEN. Callers own the lifetime and
 * must close it. `max: 1` because a listener only ever needs one backend.
 */
export function sessionSql() {
  return postgres(sessionDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 0,
    connect_timeout: 10,
  });
}

/** Closes the pool if one was ever opened. Used by the worker and job runner. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    globalThis.__shipbluSql = undefined;
  }
}
