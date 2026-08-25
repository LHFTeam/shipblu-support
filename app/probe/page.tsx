import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export const dynamic = 'force-dynamic';

// Never indexed: this is instrumentation, not a page anyone should land on.
export const metadata = { robots: { index: false, follow: false } };

/**
 * The page `/api/health` renders to prove that rendering works.
 *
 * It has to be a *page*, and that is the entire point of it. On 2026-08-25 every
 * page in the app hung on the database for eighty-five minutes while route
 * handlers — the health check among them — answered in milliseconds. Next
 * bundles the two separately, so a route handler can be perfectly healthy on
 * connections of its own while every render in the same process is queued
 * behind connections the pooler abandoned. A check that never renders anything
 * cannot see that, and Render restarts an instance only when its check fails.
 *
 * One statement, no joins, no tables of ours: the question is "can a render
 * reach the database", not "is the data right". Anything heavier would run
 * every few seconds forever, which is the other half of why this is not simply
 * a request to `/ar`.
 *
 * Public in `proxy.ts`, like `/api/health` and for the same reason — the health
 * check holds no session. It discloses nothing: `select 1` reads no row of ours,
 * and the cost of serving it is the cost of the check that already runs on this
 * schedule.
 */
export default async function ProbePage() {
  await db.execute(sql`select 1`);

  /*
   * The marker the health check looks for. A 200 on its own proves nothing here:
   * an RSC prefetch of a `force-dynamic` route returns one without running the
   * page (§6.2), and a redirect to /login would answer 200 carrying somebody
   * else's HTML. Asserting on text that only this page can produce closes both.
   */
  return <p>probe ok</p>;
}
