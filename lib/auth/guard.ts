import { redirect } from 'next/navigation';
import { count, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { can, type Permission } from './permissions';
import { currentSessionHash, getSessionAgent, type SessionAgent } from './session';

/**
 * Server-side access checks for console pages and actions.
 *
 * `middleware.ts` only checks that a session cookie exists — it runs on the edge
 * without database access, so it can redirect an obviously-signed-out visitor
 * but cannot tell a revoked session from a live one. Every page and every action
 * therefore re-checks here, against the database. The middleware is a
 * convenience; this is the control.
 */

export async function requireAgent(): Promise<SessionAgent> {
  const agent = await getSessionAgent();
  if (agent) return agent;

  // A cookie with no session behind it is a session that ended while somebody
  // was using it — revoked, expired, or timed out for inactivity. Saying so is
  // the difference between a setting and an apparent fault: an agent who is
  // dumped on a login form with nothing on screen concludes the system logged
  // them out at random, which is the guess the sign-out feature has to avoid.
  //
  // Deliberately not "inactivity", which this cannot know. Only the browser's
  // own countdown reaching zero knows that much.
  redirect((await currentSessionHash()) ? '/login?signedOut=session' : '/login');
}

export async function requirePermission(permission: Permission): Promise<SessionAgent> {
  const agent = await requireAgent();
  if (!can(agent, permission)) redirect('/inbox?error=forbidden');
  return agent;
}

/**
 * Latched once an agent exists, and in that direction only.
 *
 * `false` is permanent by the definition below — "the page stops working
 * permanently the moment the first account is made" — so once this has been
 * answered `false` it can never truthfully be `true` again, and the query is
 * pure cost on every render of `/login` thereafter. That cost is not
 * theoretical: `login/page.tsx` awaits this ahead of `getSessionAgent()`, so a
 * signed-out visitor with no cookie at all still waits for a pool slot, which
 * is where one `/login` spent 390 seconds during the 2026-09-08 freeze (§62).
 *
 * Caching a `true` would be a security bug rather than a stale read.
 * `bootstrapAdmin` in `app/(auth)/actions.ts` re-checks this *inside* the
 * action precisely so a replayed POST cannot create a second admin, and that
 * guard only works if the `true` is re-derived from the database every time.
 */
let agentsExist = false;

/** Test-only, as `resetEnvCache` is: the latch outlives a single test. */
export function resetBootstrapLatch(): void {
  agentsExist = false;
}

/**
 * True when the instance has no agents yet, which unlocks the one-time
 * first-admin setup page. Gating on "no agents exist" rather than on an
 * invite token means a fresh deploy is usable without shell access, and the
 * page stops working permanently the moment the first account is made.
 */
export async function needsBootstrap(): Promise<boolean> {
  if (agentsExist) return false;

  const rows = await db.select({ total: count() }).from(agents);
  const empty = (rows[0]?.total ?? 0) === 0;
  if (!empty) agentsExist = true;
  return empty;
}

export async function agentExists(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.email, email))
    .limit(1);
  return rows.length > 0;
}
