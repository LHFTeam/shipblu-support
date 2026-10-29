import { and, asc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, invites } from '@/db/schema';
import { looksLikeEmail, normaliseEmail } from '@/lib/auth/normalise';
import { isAgentRole } from '@/lib/auth/permissions';
import { logger } from '@/lib/log';
import { applyAgentGroups, type MembershipChoice } from './group-members';

const log = logger('agent_profile');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A cap on an agent's name, checked server-side because an action is reachable
 * without its form. Unbounded, a name reaches every inbox row and assignment
 * dropdown that renders an agent — one paste of a large clipboard buffer away.
 * The invite and the agent editor share it, so a name the invite accepted is
 * one the editor will save back.
 */
export const MAX_AGENT_NAME = 120;

export const EMAIL_TAKEN = 'Another agent already signs in with that address';

export const GROUP_GONE = 'One of those groups no longer exists — reload the page and try again';

/**
 * What the agent editor posts, read but not yet judged. `role` is null when
 * the form sent none: the select is disabled on your own row, and a disabled
 * control is left out of the submission.
 */
export type AgentProfileInput = {
  name: string;
  email: string;
  role: string | null;
  groups: MembershipChoice;
};

/**
 * Saves an agent's name, sign-in address, role and groups, or answers why not.
 *
 * Who may do it is the caller's question (`admin.agents`), as it is for the
 * invite; who may be given which role is the invite's answer too. Any role,
 * `account_admin` included — the handbook's account-owner article records
 * that every admin being able to create a peer of the owner is intended, and
 * an editor that refused what the invite allows would only move the same
 * decision to a second screen. Two refusals are added, and both are about
 * locking a team out rather than about who outranks whom:
 *
 * - Nobody changes their own role. Demoting yourself from admin takes away the
 *   permission that would let you undo it, for the reason nobody may
 *   deactivate themselves (`setAgentActive`).
 * - The last active account admin keeps the role. Without one the account has
 *   nobody holding billing, and nothing says so: the console works the same,
 *   and the role comes back only if some admin happens to notice and grant it.
 *   The handbook already tells the owner to keep more than one.
 *
 * The address is what they sign in with, so it is held to what the invite
 * holds it to, and refused while an invite for it is open: accepting one
 * finds the agent by address and overwrites its password, so a pending link
 * for the new address would become a way into this account and its history.
 * Their sessions are left alone — a session names the agent, not the address.
 */
export async function saveAgentProfile(
  editorId: string,
  agentId: string,
  input: AgentProfileInput,
  now: Date = new Date(),
): Promise<string | null> {
  const name = input.name.trim();
  if (!name) return 'Enter their name';
  if (name.length > MAX_AGENT_NAME) {
    return `A name cannot be longer than ${MAX_AGENT_NAME} characters`;
  }
  const email = normaliseEmail(input.email);
  if (!looksLikeEmail(email)) return 'Enter a valid email address';
  if (input.role !== null && !isAgentRole(input.role)) return 'Unknown role';
  const askedRole = input.role;

  try {
    return await db.transaction(async (tx) => {
      // The agent and every account admin, locked in one statement in id
      // order. The count of the other account admins has to stay true until
      // this commits — two admins each demoting a different one of the last two
      // would otherwise both see one left. One statement in one order is what
      // stops two such saves deadlocking on each other's rows. A row whose role
      // changed while we waited is re-read and drops out of the set.
      //
      // `no key update`, not `update`: it still holds off another save, a role
      // change or a deactivation of these rows until this commits, but not the
      // key-share lock a `group_members` insert's foreign key takes on an
      // agent. Under `update`, a group save adding this agent waited on this
      // lock while this save's insert of the same pair waited on that one's.
      const rows = await tx
        .select({
          id: agents.id,
          email: agents.email,
          role: agents.role,
          isActive: agents.isActive,
        })
        .from(agents)
        .where(or(eq(agents.id, agentId), eq(agents.role, 'account_admin')))
        .orderBy(asc(agents.id))
        .for('no key update');

      const current = rows.find((row) => row.id === agentId);
      if (!current) return 'Unknown agent';

      const role = askedRole ?? current.role;
      if (role !== current.role) {
        if (agentId === editorId) return 'You cannot change your own role';
        const otherOwners = rows.filter(
          (row) => row.id !== agentId && row.role === 'account_admin' && row.isActive,
        );
        if (current.role === 'account_admin' && current.isActive && otherOwners.length === 0) {
          return 'They are the only active account admin. Make somebody else one first.';
        }
      }

      if (email !== current.email) {
        await lockAddress(tx, email);

        const taken = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.email, email), ne(agents.id, agentId)))
          .limit(1);
        if (taken.length > 0) return EMAIL_TAKEN;

        const invited = await tx
          .select({ id: invites.id })
          .from(invites)
          .where(
            and(eq(invites.email, email), isNull(invites.acceptedAt), gt(invites.expiresAt, now)),
          )
          .limit(1);
        if (invited.length > 0) {
          return 'That address has an invite waiting to be accepted, and accepting it would sign in to this account. Use another address, or let the invite expire first.';
        }
      }

      // Before the agent's row is written, so a stale form is refused with
      // nothing to undo.
      if (!(await applyAgentGroups(tx, agentId, input.groups))) return GROUP_GONE;

      await tx
        .update(agents)
        .set({ name, email, role, updatedAt: now })
        .where(eq(agents.id, agentId));

      if (role !== current.role) {
        log.info('role changed', { agent: agentId, from: current.role, to: role, by: editorId });
      }
      return null;
    });
  } catch (error) {
    // Another agent took the address between the check and the update — an
    // invite accepted in that moment. The update is the transaction's last
    // statement, so the whole save is undone and saying so is the answer.
    if (isUniqueViolation(error)) return EMAIL_TAKEN;
    throw error;
  }
}

/**
 * Serialises what decides who may hold a sign-in address: an email change
 * here, and creating an invite (`createInvite`).
 *
 * Each checks the other's table — this for an open invite, the invite for an
 * agent already holding the address — and neither check can see what the
 * other has not committed. Without a lock both pass, both commit, and the
 * invite's acceptance then overwrites the renamed agent's password. Under it
 * the second to arrive waits, and its checks, each a statement after the wait,
 * read what the first committed. A transaction lock, never a session one: the
 * pooler hands the backend to another client when the transaction ends.
 */
export async function lockAddress(tx: Tx, email: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`agent-address:${email}`}::text, 0))`,
  );
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return (
    (error as { code?: unknown } | null)?.code === '23505' ||
    (typeof cause === 'object' && cause !== null && cause.code === '23505')
  );
}
