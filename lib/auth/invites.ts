import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { invites } from '@/db/schema';
import { hashToken } from './tokens';

/**
 * The invite a token opens, when it is still open at `now`: not accepted and
 * not expired. Null for anything else, and a caller never learns which.
 *
 * One lookup for the activation page and the action that accepts it, so the
 * page cannot offer a form the action then refuses. The action re-reads it on
 * submit rather than trusting the page, and claims it conditionally on it
 * still being open, so a double submit creates one agent.
 */
export async function findOpenInvite(token: string, now: Date) {
  const rows = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, hashToken(token)),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
