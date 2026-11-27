import { and, eq, gt, gte, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, passwordResets } from '@/db/schema';
import { enqueueNotificationEmail } from '@/lib/email/notify';
import { env } from '@/lib/env';
import { logger } from '@/lib/log';
import { enqueue } from '@/lib/queue';
import { looksLikeEmail } from './normalise';
import { hashPassword, validatePasswordStrength } from './password';
import { passwordChangedEmail } from './password-reset-email';
import { destroyAllSessionsForAgent } from './session';
import { generateToken, hashToken } from './tokens';

/**
 * An agent's forgotten password: asking for a link, and redeeming it.
 *
 * The one module that names `password_resets`. Four decisions shape it, and
 * each closes something the obvious implementation leaves open:
 *
 * - **The worker mints the link, not the request.** A request only queues
 *   `send_agent_password_reset` with the agent's id, and the token is generated
 *   in the job that mails it (`issueAgentPasswordReset`). Minted here and
 *   carried in the payload, the way the portal's mail is, a working credential
 *   for a console account would sit in `jobs.payload` for seven days after the
 *   job completes and for good if it died — the reason the invitation carries
 *   an id too (`worker/handlers/send-agent-invite.ts`). Only the hash is ever
 *   stored, so the link exists in the email and nowhere else.
 * - **A newer link does not cancel an older one.** A job runs at least once,
 *   so under "newest wins" a second run after a successful send would kill the
 *   link already in the inbox, and anybody who knows an agent's address could
 *   keep cancelling theirs. Every link an agent holds dies together instead:
 *   when one is redeemed, when the account is deactivated, when its address
 *   changes. `MAX_LIVE_LINKS` bounds how many can be outstanding, which the
 *   in-memory throttle cannot do across instances and restarts.
 * - **Eligible is exactly what can sign in**: active, with a password. A reset
 *   must not activate an account nobody activated, so a deactivated agent and
 *   an invited one who never set a password get nothing here — asked at the
 *   request, at the mint and again at redemption, under the agent's row lock.
 * - **The agent's row is locked before a reset row is touched**, everywhere.
 *   `saveAgentProfile` holds that lock when an address change revokes the
 *   agent's links, so a redemption that claimed its reset row first and then
 *   wrote the agent would wait on it in the opposite order.
 *
 * A redeemed link signs nobody in. It changes the password and ends every
 * session, and sign-in stays the one place a session is made: a link in an
 * inbox somebody else can read should not also be a session.
 *
 * Log lines name the agent's id, never an address or a token.
 */

const log = logger('password_reset');

/** The portal's, on purpose: one hour is the answer a customer is given too. */
const RESET_TTL_MS = 60 * 60 * 1000;

/** Unused, unexpired links one agent may hold at once. */
const MAX_LIVE_LINKS = 5;

/** Active, with a password: `authenticate()`'s test for an agent, in SQL. */
const canSignIn = and(eq(agents.isActive, true), isNotNull(agents.passwordHash));

/**
 * Queues a reset link for the agent who signs in with this address.
 *
 * Answers whether the address is an agent's, so the caller can stop there: an
 * agent never falls through to the customer lookup, as in `authenticate()`.
 * The caller must not tell the person which it was.
 *
 * It writes no reset row, and nothing at all for an address that is nobody's:
 * a form anybody can post to must not be a way to fill a table.
 */
export async function requestAgentPasswordReset(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: agents.id, email: agents.email })
    .from(agents)
    .where(and(eq(agents.email, email), canSignIn))
    .limit(1);

  const agent = rows[0];
  if (!agent) return false;

  // Both are faults somebody has to fix, not answers for the form: with no
  // sender every job would retry and die, and an address the provider refuses
  // is one no link can reach (§6.117). Still an agent's address, so still
  // `true` — falling through would send a customer's reset in its place.
  if (!env().EMAIL_FROM_ADDRESS) {
    log.warn(`not queued: EMAIL_FROM_ADDRESS is not configured agent=${agent.id}`);
    return true;
  }
  if (!looksLikeEmail(agent.email)) {
    log.warn(`not queued: the send path refuses this agent's address agent=${agent.id}`);
    return true;
  }

  // No dedupe key: a key is spent for good, and asking again next month is the
  // same work legitimately wanted again. Priority 40, where the portal's links
  // run, because somebody is watching an inbox.
  await enqueue('send_agent_password_reset', { agentId: agent.id }, { priority: 40 });
  log.info('queued', { agent: agent.id });
  return true;
}

export type IssuedReset = { to: string; name: string; token: string; expiresAt: Date };

/**
 * Mints a link for the agent, for the job that mails it.
 *
 * Null when there is nothing to send: the agent is gone or can no longer sign
 * in, their address is one the provider refuses, they already hold
 * `MAX_LIVE_LINKS`, or they have redeemed a link since this one was asked for.
 * The count and the insert are under the agent's row lock, so two jobs for one
 * agent cannot both find room for the fifth.
 *
 * `requestedAt` is when the job was queued. "Every link ends when one is
 * redeemed" is about rows, and a job still queued or backing off is not one:
 * an agent who asked three times while the provider was failing, and reset
 * with the first mail that got through, was then mailed two more working
 * links saying somebody had asked to reset a password already changed. The
 * spent row is kept until cleanup, and is what says so.
 */
export async function issueAgentPasswordReset(
  agentId: string,
  now: Date,
  requestedAt: Date,
): Promise<IssuedReset | null> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({
        email: agents.email,
        name: agents.name,
        isActive: agents.isActive,
        passwordHash: agents.passwordHash,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('no key update');

    if (!agent || !agent.isActive || !agent.passwordHash) {
      log.info('not issued: the agent cannot sign in any more', { agent: agentId });
      return null;
    }
    if (!looksLikeEmail(agent.email)) {
      log.warn(`not issued: the send path refuses this agent's address agent=${agentId}`);
      return null;
    }

    const redeemedSince = await tx
      .select({ tokenHash: passwordResets.tokenHash })
      .from(passwordResets)
      .where(and(eq(passwordResets.agentId, agentId), gte(passwordResets.usedAt, requestedAt)))
      .limit(1);
    if (redeemedSince.length > 0) {
      log.info('not issued: a link was redeemed after this was asked for', { agent: agentId });
      return null;
    }

    const live = await tx
      .select({ tokenHash: passwordResets.tokenHash })
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.agentId, agentId),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, now),
        ),
      );
    if (live.length >= MAX_LIVE_LINKS) {
      log.info('not issued: the agent already holds every link allowed', { agent: agentId });
      return null;
    }

    const token = generateToken();
    const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
    await tx.insert(passwordResets).values({ tokenHash: hashToken(token), agentId, expiresAt });

    return { to: agent.email, name: agent.name, token, expiresAt };
  });
}

/**
 * Withdraws a link whose email was never handed to the provider.
 *
 * Without it every failed attempt of one job leaves a link nobody received,
 * and the five attempts of one request made while the provider is down fill
 * `MAX_LIVE_LINKS`: for the next hour the agent is told to check an inbox
 * nothing can be sent to. One statement holding one row's lock, so it closes
 * no cycle with a redemption, which locks the agent first. Never a used link:
 * that one reached somebody.
 */
export async function discardUnsentReset(token: string): Promise<void> {
  await db
    .delete(passwordResets)
    .where(and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt)));
}

/**
 * Whose link this is, without spending it, so the page can draw its form.
 *
 * A mail scanner follows every link before the person does; a read is all a
 * GET may cost. Null for a link that is unknown, used, expired, or whose agent
 * can no longer sign in.
 */
export async function findLiveAgentReset(
  token: string,
  now: Date,
): Promise<{ agentId: string; email: string } | null> {
  const rows = await db
    .select({ agentId: agents.id, email: agents.email })
    .from(passwordResets)
    .innerJoin(agents, eq(agents.id, passwordResets.agentId))
    .where(
      and(
        eq(passwordResets.tokenHash, hashToken(token)),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, now),
        canSignIn,
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export type AgentResetResult =
  /** `email` is the address the agent signs in with, for the caller's throttle. */
  | { ok: true; email: string }
  /** `message` is the sentence `validatePasswordStrength` gave. */
  | { ok: false; reason: 'weak_password'; message: string }
  | { ok: false; reason: 'bad_token' };

/**
 * Redeems a link: the new password, and every session ended, in one
 * transaction.
 *
 * In one, because a password changed while the old sessions survive is the
 * state a reset exists to end — it is what somebody does when they suspect the
 * answer to "who is signed in as me" is "not only me".
 */
export async function completeAgentPasswordReset(
  token: string,
  password: string,
  now: Date = new Date(),
): Promise<AgentResetResult> {
  // Before the link is spent, so a password the form refuses does not also
  // burn the one link the agent has.
  const strength = validatePasswordStrength(password);
  if (!strength.ok) return { ok: false, reason: 'weak_password', message: strength.reason };

  // Unlocked, and decides nothing: the claim below is the check. It keeps
  // argon2's 19 MiB from being spent on a token that was never issued, and
  // names the agent whose row is locked first.
  const live = await findLiveAgentReset(token, now);
  if (!live) return { ok: false, reason: 'bad_token' };

  // Outside the transaction: ~50 ms of hashing is no time to hold a row lock
  // and a pooled connection for. So is the environment, read before it.
  const passwordHash = await hashPassword(password);
  const canSend = Boolean(env().EMAIL_FROM_ADDRESS);

  const done = await db.transaction(async (tx) => {
    // The agent first, then the reset row: the order the header gives.
    const [agent] = await tx
      .select({
        email: agents.email,
        name: agents.name,
        isActive: agents.isActive,
        passwordHash: agents.passwordHash,
      })
      .from(agents)
      .where(eq(agents.id, live.agentId))
      .for('no key update');
    // Deactivated since the page was drawn. Nothing is spent: the
    // deactivation deleted the row, or is about to.
    if (!agent || !agent.isActive || !agent.passwordHash) return null;

    // Conditional on the link still being unused, so two submissions of one
    // link — two tabs, a double click — come to one change of password.
    const tokenHash = hashToken(token);
    const claimed = await tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResets.tokenHash, tokenHash),
          eq(passwordResets.agentId, live.agentId),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, now),
        ),
      )
      .returning({ agentId: passwordResets.agentId });
    if (claimed.length === 0) return null;

    await tx
      .update(agents)
      .set({ passwordHash, updatedAt: now })
      .where(eq(agents.id, live.agentId));

    await destroyAllSessionsForAgent(live.agentId, tx);

    // Every other link the agent was sent. The spent one stays until cleanup,
    // as the record that it was used.
    await tx
      .delete(passwordResets)
      .where(
        and(eq(passwordResets.agentId, live.agentId), ne(passwordResets.tokenHash, tokenHash)),
      );

    // The one signal to an agent whose mailbox somebody else used. It carries
    // no link, so nothing in its payload is a credential, and it is queued on
    // the transaction so it exists exactly when the change does.
    if (canSend && looksLikeEmail(agent.email)) {
      await enqueueNotificationEmail(
        { to: agent.email, ...passwordChangedEmail({ name: agent.name }) },
        { on: tx },
      );
    }

    // Read under the lock, not off the unlocked look above: an address
    // changed in between would have revoked this link.
    return { email: agent.email };
  });

  if (!done) return { ok: false, reason: 'bad_token' };

  log.info('completed', { agent: live.agentId });
  return { ok: true, email: done.email };
}

/**
 * Cancels every link the agent holds.
 *
 * For the two changes after which a link in an inbox must stop working: a
 * deactivation, which a later reactivation must not undo for the link, and a
 * change of address, after which the old mailbox is no longer the agent's.
 */
export async function revokePasswordResets(
  on: Pick<typeof db, 'delete'>,
  agentId: string,
): Promise<void> {
  await on.delete(passwordResets).where(eq(passwordResets.agentId, agentId));
}

/** Called by the cleanup cron job. Spent links go with the expired ones. */
export async function deleteExpiredPasswordResets(): Promise<number> {
  const deleted = await db.delete(passwordResets).where(lt(passwordResets.expiresAt, new Date()));
  return deleted.count;
}
