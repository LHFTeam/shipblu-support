import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, invites } from '@/db/schema';
import { inviteEmail } from '@/lib/auth/invite-email';
import { unsealInviteToken } from '@/lib/auth/invite-token';
import { sendTransactionalEmail } from '@/lib/email/transactional';
import { appUrl, env } from '@/lib/env';
import { PermanentJobError, type ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';

/**
 * Emails an invited agent their activation link.
 *
 * **The payload carries an id, not the link.** Every other transactional email
 * puts its rendered body in `jobs.payload`, and for an invitation that would
 * mean a working credential sitting in plaintext in a table the whole app can
 * read — for seven days after the job completes, and forever if it reaches
 * `dead`, which `cleanup` never removes. `invites` goes to real trouble to
 * avoid exactly that: it stores a SHA-256 for the lookup and an AES-GCM
 * envelope for redisplay, so that a database dump alone yields no usable
 * token. Rendering the body at enqueue time would have handed the same
 * credential straight back in plaintext one table over.
 *
 * So this handler reads the row and unseals the envelope, which is the same
 * path the pending-invites screen takes. The cost is that the email is built
 * here rather than by the caller; the invitation is English-only, so unlike
 * the portal's mail there is no locale the worker would have to be told.
 */

export async function sendAgentInvite(job: ClaimedJob): Promise<void> {
  const { inviteId } = parseJobPayload(job, 'send_agent_invite');

  const rows = await db
    .select({
      email: invites.email,
      name: invites.name,
      tokenCiphertext: invites.tokenCiphertext,
      expiresAt: invites.expiresAt,
      acceptedAt: invites.acceptedAt,
      invitedByName: agents.name,
    })
    .from(invites)
    .leftJoin(agents, eq(agents.id, invites.invitedByAgentId))
    .where(eq(invites.id, inviteId))
    .limit(1);

  const invite = rows[0];

  // All three of these are ordinary races, not failures: a resend supersedes
  // the row by deleting it, and the invitee may have activated or let the link
  // lapse before the worker got here. Returning rather than throwing keeps a
  // normal sequence of events out of the dead queue.
  if (!invite) {
    console.log(`[send_agent_invite] ${inviteId} is gone — superseded or withdrawn`);
    return;
  }
  if (invite.acceptedAt) {
    console.log(`[send_agent_invite] ${invite.email} has already activated`);
    return;
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    console.log(`[send_agent_invite] the invite for ${invite.email} expired before it was sent`);
    return;
  }

  // These two are real faults, and retrying will not help either: the envelope
  // is written in the same statement as the row, and a token sealed under a
  // rotated APP_SECRET can never be recovered. Throwing is right — the admin
  // still holds the link the action returned, and a dead job is the only thing
  // that will tell anybody this happened — and throwing them as permanent sends
  // the job there on its first attempt instead of after four retries that
  // cannot change the row.
  if (!invite.tokenCiphertext) {
    throw new PermanentJobError(`send_agent_invite: ${inviteId} has no retained token`);
  }

  const token = unsealInviteToken(invite.tokenCiphertext, env().APP_SECRET);
  if (!token) {
    throw new PermanentJobError(
      `send_agent_invite: the token for ${inviteId} cannot be unsealed — APP_SECRET may have been rotated`,
    );
  }

  await sendTransactionalEmail(
    {
      to: invite.email,
      ...inviteEmail({
        url: `${appUrl()}/invite/${token}`,
        name: invite.name,
        invitedByName: invite.invitedByName,
        expiresAt: invite.expiresAt,
      }),
    },
    'send_agent_invite',
  );
}
