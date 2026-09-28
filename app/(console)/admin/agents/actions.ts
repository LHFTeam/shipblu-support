'use server';

import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text } from '@/lib/http/form-data';
import { validatePolicy } from '@/lib/presence/idle';
import { savePresencePolicy } from '@/lib/presence/policy';
import { refresh, type SettingsState, type AdminState } from '../settings-shared';
import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, invites } from '@/db/schema';
import { isAgentRole } from '@/lib/auth/permissions';
import { canonicalUuid } from '@/lib/http/uuid';
import { looksLikeEmail, normaliseEmail } from '@/lib/auth/normalise';
import { sealInviteToken } from '@/lib/auth/invite-token';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { destroyAllSessionsForAgent } from '@/lib/auth/session';
import { enqueue } from '@/lib/queue';
import { appUrl, env } from '@/lib/env';
import { logger } from '@/lib/log';

const log = logger('createInvite');

// --- Presence policy ---------------------------------------------------------

/**
 * When the console decides somebody has stopped working.
 *
 * Under `admin.agents` rather than a permission of its own: it is a rule about
 * the team, and it sits on the page that lists them.
 *
 * Blank means the timer is off, and that is the only way to turn one off — so
 * an unreadable value has to be an error rather than a silent null, which is
 * what `optionalMinutes` would give. A typo quietly disabling the
 * sign-out is exactly the failure this form must not have: nothing would look
 * wrong afterwards, because "nobody was ever signed out" and "the timeout is
 * working" look identical from the outside.
 *
 * Everything else about the numbers — whole, in range, and the sign-out no
 * shorter than the away — is `validatePolicy`'s, so the form and the tests
 * agree on the wording of each refusal.
 */
export async function savePresenceSettings(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const admin = await requirePermission('admin.agents');

  const away = minutesOrOff(formData, 'autoAwayAfterMins');
  const signout = minutesOrOff(formData, 'autoSignoutAfterMins');

  if (away === 'not_a_number' || signout === 'not_a_number') {
    return { error: 'Enter a number of minutes, or leave the box empty to turn it off.' };
  }

  const policy = { autoAwayAfterMins: away, autoSignoutAfterMins: signout };
  const problem = validatePolicy(policy);
  if (problem) return { error: problem };

  await savePresencePolicy(policy, admin.id);

  refresh('/admin/agents');
  return ok();
}

/**
 * Blank is "off", anything numeric is a window, and text is the admin's typo.
 *
 * Deliberately does *not* check that the number is whole or in range —
 * `validatePolicy` owns both, and it has the wording for each. Checking here
 * too made that function's "has to be a whole number of minutes" message
 * unreachable from the only form that writes these, which is how a tested
 * message ends up being one nobody can ever see.
 */
function minutesOrOff(formData: FormData, key: string): number | null | 'not_a_number' {
  const raw = text(formData, key);
  if (!raw) return null;

  const value = Number(raw);
  return Number.isFinite(value) ? value : 'not_a_number';
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A cap on the invited name, checked server-side because the action is
 * reachable without the form. Unbounded, it would reach `invites.name`, then
 * `agents.name`, and from there every inbox row and assignment dropdown that
 * renders an agent — one paste of a large clipboard buffer away.
 */
const MAX_INVITE_NAME = 120;

/**
 * Creates an invite, emails the invitee a link to activate it, and returns that
 * link to the admin as well.
 *
 * Both, not either. The email is how an invite is delivered, but it is only
 * attempted when `EMAIL_FROM_ADDRESS` is configured — and the one moment that
 * is guaranteed *not* to be true is a fresh deploy adding its first agents,
 * which is exactly when invites have to work. So the link keeps coming back for
 * the admin to send by hand, and the return value says which of the two
 * happened rather than leaving them to guess.
 *
 * The token's hash handles acceptance and an encrypted copy lets the same link
 * remain on the pending-invites screen without making a database dump
 * sufficient to use it.
 */
export async function createInvite(_state: AdminState, formData: FormData): Promise<AdminState> {
  const admin = await requirePermission('admin.agents');

  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const name = text(formData, 'name');
  const role = String(formData.get('role') ?? 'agent');

  // `looksLikeEmail`, not `includes('@')`: the send path validates with
  // `z.email()`, which rejects `foo@` and `@b.com`. Accepting them here would
  // commit the invite, tell the admin it was emailed, and leave the job to die
  // in the worker where they will never see it.
  if (!looksLikeEmail(email)) return { error: 'Enter a valid email address' };
  // `required` on the input is a courtesy to whoever is typing, not a
  // constraint — the action is reachable without it. Checked here because
  // `invites.name` is NOT NULL and a blank one would otherwise reach the
  // insert as '', which satisfies the column and satisfies nobody else.
  if (!name) return { error: 'Enter the name of the person you are inviting' };
  if (name.length > MAX_INVITE_NAME) {
    return { error: `A name cannot be longer than ${MAX_INVITE_NAME} characters` };
  }
  if (!isAgentRole(role)) {
    return { error: 'Unknown role' };
  }

  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.email, email))
    .limit(1);
  if (existing.length > 0) return { error: 'That agent already exists' };

  let inviteBaseUrl: string;
  try {
    // Resolve the configuration before superseding a working invite. Calling
    // this after the writes would leave a new row behind while returning an
    // error with no URL for the admin to send.
    inviteBaseUrl = appUrl();
  } catch {
    return { error: 'APP_URL must be configured before creating an invite' };
  }

  const token = generateToken();
  const tokenCiphertext = sealInviteToken(token, env().APP_SECRET);
  // One value for the row and for the email. Recomputing the deadline for the
  // message would put a date in the invitee's inbox that is minutes off the one
  // the database will enforce, and the copy would stop matching the
  // pending-invites screen the moment the TTL changed.
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const inviteId = await db.transaction(async (tx) => {
    // Supersede any open invite for the same address, so a resend does not leave
    // two working links with different roles. Delete and insert are one unit:
    // an insertion failure must leave the existing invitation usable.
    await tx.delete(invites).where(and(eq(invites.email, email), isNull(invites.acceptedAt)));

    const inserted = await tx
      .insert(invites)
      .values({
        tokenHash: hashToken(token),
        tokenCiphertext,
        email,
        name,
        role,
        invitedByAgentId: admin.id,
        expiresAt,
      })
      .returning({ id: invites.id });

    return inserted[0]!.id;
  });

  const inviteUrl = `${inviteBaseUrl}/invite/${token}`;

  // After the commit, never inside it. `enqueue` writes on its own connection,
  // so a job queued from inside the transaction would survive a rollback and
  // point the worker at an invite that does not exist.
  //
  // The payload is the row's id and nothing else. The rendered link must not go
  // in it: `jobs` keeps a completed row for seven days and a dead one forever,
  // so a body containing the activation URL would leave a working credential in
  // plaintext for longer than the invite itself is valid — undoing the whole
  // reason `invites` stores a hash and an AES-GCM envelope instead of a token.
  // `send_agent_invite` rebuilds the link from that envelope.
  //
  // Priority 60, behind ticket replies at 50. `enqueueNotificationEmail` uses 40
  // on the grounds that somebody is sitting on a form waiting for the link,
  // which is exactly what is *not* true here — the admin already has it in this
  // response. A batch of invitations must not overtake customers waiting on an
  // answer.
  //
  // Nothing here may throw. The invite is committed by this point, so an
  // exception would do what the `appUrl()` check above exists to prevent: leave
  // a new row behind and hand the admin an error page with no link on it. A
  // queue insert that fails degrades to the same state as an unconfigured
  // mailbox — the admin is told no email went out and sends the link
  // themselves, which is a working invitation either way.
  let queuedFor: string | null = null;
  if (env().EMAIL_FROM_ADDRESS) {
    try {
      await enqueue('send_agent_invite', { inviteId }, { priority: 60 });
      queuedFor = email;
    } catch (error) {
      // The cause belongs in the logs; the admin only needs to know it is on
      // them to deliver the link, which the response already tells them.
      log.error(`could not queue the invitation email for ${email}`, error);
    }
  }

  revalidatePath('/admin/agents');

  return {
    error: null,
    inviteUrl,
    ...(queuedFor ? { inviteQueuedFor: queuedFor } : {}),
  };
}

export async function setAgentActive(_state: AdminState, formData: FormData): Promise<AdminState> {
  const admin = await requirePermission('admin.agents');

  // Canonical, so the comparison below agrees with the one the update makes:
  // Postgres matches an upper-case uuid to the same row, and `===` did not, so
  // the upper-case spelling of your own id got past the guard.
  const agentId = canonicalUuid(formData.get('agentId'));
  const active = formData.get('active') === 'true';
  if (!agentId) return { error: 'Unknown agent' };

  // Locking yourself out is always a mistake, and recovering needs shell access.
  if (agentId === admin.id && !active) {
    return { error: 'You cannot deactivate your own account' };
  }

  const updated = await db
    .update(agents)
    .set({ isActive: active })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  if (!updated.length) return { error: 'Unknown agent' };

  // Deactivation must take effect now, not when their cookie expires.
  if (!active) await destroyAllSessionsForAgent(agentId);

  revalidatePath('/admin/agents');
  return { error: null };
}

/**
 * An agent's own ticket cap.
 *
 * Blank clears it, which puts them back on their group's default rather than on
 * "no limit" — the two are different answers and only one of them is a decision
 * about this person.
 *
 * Deliberately not gated behind deactivation or self-editing checks the way
 * `setAgentActive` is: raising your own cap is not a way to lock anybody out,
 * and an admin adjusting their own number while the queue is backing up is the
 * expected use rather than the abuse.
 */
export async function setAgentCapacity(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.agents');

  const agentId = canonicalUuid(formData.get('agentId'));
  if (!agentId) return { error: 'Unknown agent' };
  const raw = text(formData, 'maxOpenTickets');

  let maxOpenTickets: number | null = null;
  if (raw) {
    const value = Number(raw);
    // The column is a 32-bit integer, and Postgres answers anything larger with
    // 22003 — a throw, where the form promises a sentence.
    if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
      return { error: 'That is not a number of tickets' };
    }
    maxOpenTickets = Math.trunc(value);
  }

  const updated = await db
    .update(agents)
    .set({ maxOpenTickets })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  if (!updated.length) return { error: 'Unknown agent' };

  revalidatePath('/admin/agents');
  return { error: null };
}
