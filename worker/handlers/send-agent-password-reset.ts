import { discardUnsentReset, issueAgentPasswordReset } from '@/lib/auth/password-reset';
import { agentPasswordResetEmail } from '@/lib/auth/password-reset-email';
import { senderAddress } from '@/lib/email/sender';
import { sendTransactionalEmail } from '@/lib/email/transactional';
import { appUrl } from '@/lib/env';
import { logger } from '@/lib/log';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';

const log = logger('send_agent_password_reset');

/**
 * A request this old is not mailed. Somebody who asked for a link and got
 * nothing has asked again or asked an admin by now, and a reset email arriving
 * hours after a worker outage reads as somebody else trying the account.
 */
const STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Emails an agent the link that resets their password.
 *
 * **The link is minted here, not where it was asked for.** The payload is the
 * agent's id. A link rendered at enqueue time would be a working credential for
 * a console account, in plaintext in `jobs.payload` for seven days after the
 * job completes and for good if it died; the invitation avoids the same thing
 * by sealing its token (`send-agent-invite.ts`), and a reset has no screen that
 * shows the link again, so it needs no envelope either — only the hash is
 * stored, and the token exists in this function and in the email.
 *
 * So a retry mints another link rather than re-sending the first. A link whose
 * send failed is withdrawn before the retry, so only links handed to the
 * provider count against the five an agent may hold: kept, one request made
 * during a provider outage filled all five with links nobody received, and the
 * agent could get none for an hour. A send that failed after the provider had
 * in fact accepted it leaves a dead link in the inbox, and the retry mails one
 * that works.
 */
export async function sendAgentPasswordReset(job: ClaimedJob): Promise<void> {
  const { agentId } = parseJobPayload(job, 'send_agent_password_reset');

  if (Date.now() - job.createdAt.getTime() > STALE_AFTER_MS) {
    log.info('nothing sent: the request is too old', { agent: agentId });
    return;
  }

  // Both before the mint, so a deploy missing either fails the attempt with a
  // sentence naming the variable and leaves no link nobody was sent.
  const base = appUrl();
  senderAddress();

  const issued = await issueAgentPasswordReset(agentId, new Date(), job.createdAt);
  // The agent was deactivated, already holds every link allowed, or has reset
  // their password since asking: an ordinary sequence of events, logged where
  // it was decided.
  if (!issued) return;

  try {
    await sendTransactionalEmail(
      {
        to: issued.to,
        ...agentPasswordResetEmail({
          url: `${base}/reset/${issued.token}`,
          name: issued.name,
          expiresAt: issued.expiresAt,
        }),
      },
      'send_agent_password_reset',
    );
  } catch (error) {
    // Best-effort: the send's failure is what the queue must hear.
    await discardUnsentReset(issued.token).catch((cause: unknown) =>
      log.warn(`could not withdraw an unsent link agent=${agentId}`, cause),
    );
    throw error;
  }
}
