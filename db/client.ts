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
/**
 * When the peak happened.
 *
 * A high-water mark with no clock beside it cannot distinguish pressure now
 * from pressure an hour ago: one transient spike pins `peak` at the ceiling for
 * the life of the instance, and the number stops being attributable to the
 * measurement anybody is taking with it.
 */
let peakAt: string | null = null;

/**
 * Transactions currently open.
 *
 * Counted separately because a transaction *reserves* one of the `POOL_MAX`
 * connections for its whole lifetime rather than queueing for one — so
 * `inFlight` alone can read zero while every slot is held, which is exactly the
 * misattribution these counters exist to prevent. See `instrumentClient()`.
 */
let openTransactions = 0;

/** Latched by the ceiling warning in `deadline()`, so saturation is one line. */
let atCeiling = false;

/** For `/api/health`, which is the one caller that should say this out loud. */
export function poolPressure(): {
  inFlight: number;
  transactions: number;
  peak: number;
  peakAt: string | null;
  max: number;
} {
  return { inFlight, transactions: openTransactions, peak: peakInFlight, peakAt, max: POOL_MAX };
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
  /**
   * The cancel primitive itself, rather than the `cancel()` method that calls
   * it. `cancelQuietly()` below says why the method cannot be used.
   */
  canceller: ((query: unknown) => unknown) | null;
};

/**
 * `query.cancel()`, minus the unhandled rejection.
 *
 * postgres.js's method is `this.canceller && (this.canceller(this),
 * this.canceller = null)`, and the comma operator throws away the promise the
 * canceller returns. For a query already on the wire that promise is a *new*
 * TCP connection carrying a protocol CancelRequest, and it rejects through
 * `socket.once('error', reject)` when that connection is refused or reset —
 * which is what a saturated pooler does to a new connection. Nothing would be
 * listening to it, and Node 22 exits the process on an unhandled rejection: the
 * worker and the job runner both run under plain `tsx` with no handler of their
 * own, so the mitigation would crash-loop them on precisely the condition this
 * timer fires against.
 *
 * So the canceller is called directly, its promise is given a handler, and it is
 * nulled exactly as `cancel()` does so a second call is a no-op. A cancel that
 * could not be delivered needs no log line of its own: the query rejects either
 * way, and that rejection is what the caller sees.
 */
function cancelQuietly(query: Settleable): void {
  const { canceller } = query;
  if (!canceller) return;

  query.canceller = null;
  void Promise.resolve(canceller.call(query, query)).catch(() => {
    /* the CancelRequest could not be delivered; the query still rejects */
  });
}

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
 * Cancelling is the one primitive that helps. For a query still in the queue it
 * removes it and rejects with `57014`; for one already sent it opens a
 * *separate* socket to send a protocol CancelRequest, which is what makes it
 * work at all when the pool is the thing that is exhausted. It goes through
 * `cancelQuietly()` rather than the library's own `cancel()`, for the reason
 * stated there.
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
  if (inFlight > peakInFlight) {
    peakInFlight = inFlight;
    peakAt = new Date().toISOString();
  }

  // Latched on the way up rather than tested on every query. As a level test
  // this logged once per `client.unsafe()` for as long as the pressure lasted —
  // thousands of identical lines over the fifty minutes of §62, pushing the one
  // useful signal out of Render's retention, which is the opposite of what it
  // is for. Re-armed on the way down, so a saturation event is one line and its
  // recovery is another.
  if (inFlight >= POOL_MAX && !atCeiling) {
    atCeiling = true;
    // eslint-disable-next-line no-console -- moves with the pool instrumentation fix (plans/refactor-in-stages.md, Out of scope)
    console.warn(`[db] ${inFlight} queries in flight against max ${POOL_MAX}`);
  }

  const timer = setTimeout(() => cancelQuietly(settleable), timeoutMs);

  const settle = () => {
    clearTimeout(timer);
    inFlight -= 1;
    if (atCeiling && inFlight < POOL_MAX) {
      atCeiling = false;
      // eslint-disable-next-line no-console -- moves with the pool instrumentation fix (plans/refactor-in-stages.md, Out of scope)
      console.warn(`[db] pool pressure cleared, ${inFlight} in flight`);
    }
  };

  const { resolve, reject } = settleable;
  settleable.resolve = (value) => (settle(), resolve.call(settleable, value));
  settleable.reject = (error) => (settle(), reject.call(settleable, error));

  return query;
}

/**
 * Handles that already carry the deadline.
 *
 * Not belt and braces: `getSql()` adopts `globalThis.__shipbluSql` across a dev
 * hot reload, so a re-run module scope would otherwise wrap the previous
 * scope's wrapper — after N reloads every query arms N timers and N module
 * scopes keep N disagreeing `inFlight` counters, none of them right.
 */
const instrumented = new WeakSet<object>();

/** The three members of a postgres.js handle this needs to reach. */
type Instrumentable = {
  unsafe: (...args: unknown[]) => unknown;
  begin?: (...args: unknown[]) => unknown;
  savepoint?: (...args: unknown[]) => unknown;
};

/**
 * Installs the deadline on one postgres.js handle, once.
 *
 * `unsafe` is an **own property of each handle** rather than something
 * inherited: the library's `Sql(handler)` factory declares its own `unsafe`
 * closure and `Object.assign`s it onto the handle it returns. That is what makes
 * patching a handle possible at all — and what makes patching the pool alone
 * insufficient, because a transaction body is handed a *fresh* handle:
 * `begin()` calls `scope()`, which calls `Sql(handler)` again, and drizzle then
 * runs every statement of the transaction through that handle's `unsafe`.
 *
 * Leaving that half out would have left ~20 call sites unbounded, the three
 * five-minute sweeps among them, and it is the worse half: a transaction
 * *reserves* one of the `POOL_MAX` connections for its whole lifetime, so one
 * that never finishes takes a slot with it rather than queueing behind one.
 * `savepoint` is wrapped for the same reason, one level further in.
 *
 * Exported for `db/client.test.ts`, in the same spirit as `interactionWindowSet`
 * — the wrapping is the whole mechanism and there is no other way to reach it
 * without a live connection.
 */
export function instrumentClient<T>(client: T, timeoutMs: number): T {
  const handle = client as unknown as Instrumentable & object;
  if (instrumented.has(handle)) return client;
  instrumented.add(handle);

  const native = handle.unsafe.bind(handle);
  handle.unsafe = (...args: unknown[]) => deadline(native(...args), timeoutMs);

  const nativeBegin = handle.begin;
  if (nativeBegin) {
    handle.begin = (...args: unknown[]) =>
      nativeBegin.apply(handle, instrumentScope(args, timeoutMs, true));
  }

  const nativeSavepoint = handle.savepoint;
  if (nativeSavepoint) {
    handle.savepoint = (...args: unknown[]) =>
      nativeSavepoint.apply(handle, instrumentScope(args, timeoutMs, false));
  }

  return client;
}

/**
 * Rewrites a `begin`/`savepoint` argument list so the scoped handle its body is
 * called with is instrumented too. Both take the body as their last argument,
 * with an optional name or option string before it.
 *
 * `counts` is true only for `begin`, so a savepoint inside a transaction does
 * not count as a second open transaction.
 */
function instrumentScope(args: unknown[], timeoutMs: number, counts: boolean): unknown[] {
  const last = args.length - 1;
  const body = args[last];
  if (typeof body !== 'function') return args;

  const run = body as (client: unknown) => unknown;
  const wrapped = async (client: unknown) => {
    if (counts) openTransactions += 1;
    try {
      return await run(instrumentClient(client, timeoutMs));
    } finally {
      if (counts) openTransactions -= 1;
    }
  };

  return args.map((arg, index) => (index === last ? wrapped : arg));
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
  instrumentClient(pool, env().DB_QUERY_TIMEOUT_MS);

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
 * `select 1`, in a form `/api/health` can abandon.
 *
 * Raced against a timer there, and the cancel is the reason this exists rather
 * than a plain `db.execute`: losing a race does nothing to the query, which
 * keeps its place in postgres.js's queue for the whole `DB_QUERY_TIMEOUT_MS`.
 * Render polls the health endpoint far more often than that, so an endpoint
 * that only raced would add a queued query per poll to the saturation it exists
 * to report on.
 *
 * A tagged template rather than `unsafe`, so it carries no deadline of its own —
 * the caller's is shorter and is the one that should apply.
 */
export function databaseProbe(): { done: Promise<unknown>; abandon: () => void } {
  const query = getSql()`select 1`;
  return {
    done: query as unknown as Promise<unknown>,
    abandon: () => cancelQuietly(query as unknown as Settleable),
  };
}

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
