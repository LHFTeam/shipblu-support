import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env, sessionDatabaseUrl } from '@/lib/env';
import * as schema from './schema';
import { WebPool } from './web-pool';

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
  // Production also needs this: Next bundles route handlers and page renders
  // separately. A module-local singleton gave /api/health a different pool.
  var __shipbluSql: ReturnType<typeof postgres> | undefined;
  var __shipbluWebPool: WebPool | undefined;
}

export function getSql(): ReturnType<typeof postgres> {
  const create = () =>
    postgres(env().DATABASE_URL, {
      prepare: false,
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });

  // Next replaces NEXT_RUNTIME with 'nodejs' in its server bundles. Worker,
  // cron, seed and migration processes run outside Next and keep their existing
  // budgets; NODE_ENV=production alone must never enable interactive deadlines.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    globalThis.__shipbluWebPool ??= new WebPool(create);
    return globalThis.__shipbluWebPool.getSql();
  }
  return (globalThis.__shipbluSql ??= create());
}

type Db = PostgresJsDatabase<typeof schema>;

let instance: Db | undefined;
let instanceSql: ReturnType<typeof postgres> | undefined;

function getDb(): Db {
  const client = getSql();
  if (!instance || instanceSql !== client) {
    instance = drizzle(client, { schema });
    instanceSql = client;
  }
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
  const webPool = globalThis.__shipbluWebPool;
  const pool = globalThis.__shipbluSql;
  globalThis.__shipbluWebPool = undefined;
  globalThis.__shipbluSql = undefined;
  instance = undefined;
  instanceSql = undefined;
  await Promise.all([webPool?.close(), pool?.end()]);
}
