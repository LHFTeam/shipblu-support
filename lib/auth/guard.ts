import { redirect } from 'next/navigation';
import { count, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { can, type Permission } from './permissions';
import { getSessionAgent, type SessionAgent } from './session';

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
  if (!agent) redirect('/login');
  return agent;
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
