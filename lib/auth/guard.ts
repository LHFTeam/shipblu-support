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
 * True when the instance has no agents yet, which unlocks the one-time
 * first-admin setup page. Gating on "no agents exist" rather than on an
 * invite token means a fresh deploy is usable without shell access, and the
 * page stops working permanently the moment the first account is made.
 */
export async function needsBootstrap(): Promise<boolean> {
  const rows = await db.select({ total: count() }).from(agents);
  return (rows[0]?.total ?? 0) === 0;
}

export async function agentExists(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.email, email))
    .limit(1);
  return rows.length > 0;
}
