import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, contactIdentities, contacts } from '@/db/schema';
import { normaliseEmail } from './normalise';
import { hashPassword, verifyPassword } from './password';

/**
 * One sign-in for two populations.
 *
 * The help centre has a single Sign in button, and the person pressing it is
 * either a ShipBlu agent or a ShipBlu customer. Asking them which — a tab, a
 * second form, a different URL — is a question they should not have to answer
 * about our internal table layout, and one most people would answer wrong.
 *
 * Agents are checked first and never fall through. If a staff address is also a
 * contact — which it is the moment a colleague emails support — the console
 * password is the one that works, and a customer account can never be used to
 * reach an agent's mailbox or the other way round.
 */

export type Principal =
  | { kind: 'agent'; agentId: string }
  | { kind: 'customer'; identityId: string }
  /** Correct password, address never confirmed. Cannot be signed in. */
  | { kind: 'unverified'; identityId: string; email: string }
  | { kind: 'invalid' };

export async function authenticate(rawEmail: string, password: string): Promise<Principal> {
  const email = normaliseEmail(rawEmail);
  if (!email || !password) return { kind: 'invalid' };

  const agentRows = await db
    .select({ id: agents.id, passwordHash: agents.passwordHash, isActive: agents.isActive })
    .from(agents)
    .where(eq(agents.email, email))
    .limit(1);

  const agent = agentRows[0];
  if (agent?.passwordHash && agent.isActive) {
    return (await verifyPassword(agent.passwordHash, password))
      ? { kind: 'agent', agentId: agent.id }
      : { kind: 'invalid' };
  }

  const identityRows = await db
    .select({
      id: contactIdentities.id,
      passwordHash: contactIdentities.passwordHash,
      isVerified: contactIdentities.isVerified,
      isBlocked: contacts.isBlocked,
      deletedAt: contacts.deletedAt,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(and(eq(contactIdentities.channel, 'email'), eq(contactIdentities.identifier, email)))
    .limit(1);

  const identity = identityRows[0];
  if (identity?.passwordHash && !identity.isBlocked && !identity.deletedAt) {
    if (!(await verifyPassword(identity.passwordHash, password))) return { kind: 'invalid' };
    return identity.isVerified
      ? { kind: 'customer', identityId: identity.id }
      : { kind: 'unverified', identityId: identity.id, email };
  }

  // No account of either kind. Spend the same ~50ms an argon2 verify costs, so
  // an address that is not registered is not identifiable by how quickly the
  // request comes back. Hashing rather than verifying a dummy digest, because
  // verify() rejects a malformed hash immediately and gives the timing away.
  await hashPassword(password);
  return { kind: 'invalid' };
}
