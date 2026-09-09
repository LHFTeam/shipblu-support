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
  // Next's dev server hot-reloads modules; without this the pool is recreated on
  // every reload and Postgres runs out of connections.
  var __shipbluSql: ReturnType<typeof postgres> | undefined;
}

const POOL_MAX = 10;

/**
 * Queries in flight or waiting for one of the `POOL_MAX` slots.
 *
 * postgres.js keeps no such number and exposes none: its `queues` object and its
 * pending-query list are closure-locals that never reach the `sql` handle. That
 * absence is why the 2026-09-08 freeze left one misattributed `Failed query`
 * line as its entire app-side evidence (§62), so the counter exists to be
 * reported rather than because anything branches on it.
 */
let inFlight = 0;
let peakInFlight = 0;

/** For `/api/health`, which is the one caller that should say this out loud. */
export function poolPressure(): { inFlight: number; peak: number; max: number } {
  return { inFlight, peak: peakInFlight, max: POOL_MAX };
}

/**
 * The completion hooks postgres.js calls on a query. They are instance
 * properties assigned in its `Query` constructor, not part of its public types,
 * so `deadline()` below declares the shape it wraps and `db/client.test.ts`
 * asserts the wrapping still takes effect — a library upgrade that renamed
 * either one would otherwise silently stop bounding anything.
 */
type Settleable = {
  resolve: (value: unknown) => unknown;
  reject: (error: unknown) => unknown;
  cancel: () => unknown;
};

/**
 * Gives every query a deadline, because the pool's queue has none.
 *
 * postgres.js parks a query beyond `max` in an unbounded, untimed array and
 * returns a promise that settles when a slot frees and **never rejects**. So a
 * saturated pool does not fail — it stops answering, Postgres logs nothing
 * because nothing arrives, and the CPU idles. That is the whole of the
 * 2026-09-08 outage: requests queued from 20 seconds to 40 minutes behind ten
 * busy slots while every external signal said the database was healthy.
 *
 * `query.cancel()` is the one primitive that helps. For a query still in the
 * queue it removes it and rejects with `57014`; for one already sent it opens a
 * *separate* socket to send a protocol CancelRequest, which is what makes it
 * work at all when the pool is the thing that is exhausted.
 *
 * Two things this deliberately does not do. It does not call `.then()` on the
 * query: that would run postgres.js's `handle()` and dispatch immediately,
 * racing the `.values()` that drizzle chains on the next expression — the flag
 * lands in time today only because `handle()` defers by a microtask, which is
 * far too fine a thread to hang this on. And it does not set
 * `connection: { statement_timeout }`: that is a one-shot StartupMessage
 * parameter, and on Supavisor's transaction pooler nothing guarantees it reaches
 * the backend our statement actually runs on.
 */
function deadline<T>(query: T, timeoutMs: number): T {
  const settleable = query as T & Settleable;

  inFlight += 1;
  if (inFlight > peakInFlight) peakInFlight = inFlight;

  // Logged at the boundary rather than every query: the number is only ever
  // interesting when it is near the ceiling, and that is exactly the moment the
  // last incident had nothing to say for itself.
  if (inFlight >= POOL_MAX) {
    console.warn(`[db] ${inFlight} queries in flight against max ${POOL_MAX}`);
  }

  const timer = setTimeout(() => settleable.cancel(), timeoutMs);

  const settle = () => {
    clearTimeout(timer);
    inFlight -= 1;
  };

  const { resolve, reject } = settleable;
  settleable.resolve = (value) => (settle(), resolve.call(settleable, value));
  settleable.reject = (error) => (settle(), reject.call(settleable, error));

  return query;
}

let pool: ReturnType<typeof postgres> | undefined;

export function getSql(): ReturnType<typeof postgres> {
  if (pool) return pool;

  pool =
    globalThis.__shipbluSql ??
    postgres(env().DATABASE_URL, {
      prepare: false,
      max: POOL_MAX,
      idle_timeout: 20,
      connect_timeout: 10,
    });

  // Every drizzle query reaches the driver as `client.unsafe(text, params)` —
  // the one chokepoint where a deadline can be attached without touching call
  // sites, and without wrapping the returned query in something that would lose
  // `.values()` and `.cursor()`.
  const native = pool.unsafe.bind(pool);
  const timeoutMs = env().DB_QUERY_TIMEOUT_MS;
  pool.unsafe = ((...args: Parameters<typeof native>) =>
    deadline(native(...args), timeoutMs)) as typeof pool.unsafe;

  if (env().NODE_ENV !== 'production') globalThis.__shipbluSql = pool;
  return pool;
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

/**
 * Closes the pool if one was ever opened. Used by the worker and job runner.
 *
 * The timeout is not tidiness. A bare `end()` sets the flag that refuses *new*
 * queries but never rejects the ones already queued, and its own close path will
 * hand a freed connection to the next one in the queue — so shutting down with a
 * backlog waits for the backlog. Passing a timeout is what arms the destroy that
 * rejects them, which is the difference between a worker that exits on SIGTERM
 * and one Render eventually kills.
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end({ timeout: 5 });
    pool = undefined;
    globalThis.__shipbluSql = undefined;
  }
}
