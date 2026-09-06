import { cookies } from 'next/headers';
import { and, eq, gt, inArray, lt, lte } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, sessions } from '@/db/schema';
import { shouldSignOut } from '@/lib/presence/idle';
import { loadPresencePolicy } from '@/lib/presence/policy';
import { SESSION_COOKIE } from './cookie';
import { generateToken, hashToken } from './tokens';

export { SESSION_COOKIE };

/**
 * What "live" means for a session row, in one place.
 *
 * Three callers ask it — the session lookup, the presence stream's re-check and
 * the post-sweep offline decision — and the next change to the definition (an
 * inactivity clause, say) has to reach all three, or the one that missed it
 * becomes the hole.
 */
function liveSession() {
  return gt(sessions.expiresAt, new Date());
}

/** Sliding window: a session survives 30 days, refreshed on use. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Only rewrite last_used_at/expiry once an hour, to avoid a write per request. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

export type SessionAgent = {
  id: string;
  email: string;
  name: string;
  role: (typeof agents.$inferSelect)['role'];
  permissions: Record<string, boolean>;
  avatarUrl: string | null;
  /**
   * Their own "route new work to me" switch. On the session rather than fetched
   * where it is needed because the console header renders it on every page, and
   * the session row is already being read there.
   */
  isAcceptingTickets: boolean;
  /**
   * How long this session has been idle *as the server measures it*, in
   * milliseconds — the gap the inactivity sign-out is actually decided on.
   *
   * A duration rather than the instant, and that is the point of it. The console
   * counts down in the browser, and the browser's clock is not ours: handing over
   * `last_activity_at` would have every countdown wrong by whatever the two
   * machines disagree by. A duration is skew-free — the browser subtracts it from
   * its own `Date.now()` and lands on its own clock's version of the same moment.
   *
   * It exists because the two ends were measuring different things. The browser
   * counted from the last key it saw; the server counts from the last beat it was
   * *told* about, which the beat throttle puts up to a minute earlier. With a
   * minute of warning that difference is the whole warning, so "Stay signed in"
   * could arrive after the server had already given up — losing exactly the
   * unsent reply the countdown is there to protect.
   */
  sessionIdleForMs: number;
};

export async function createSession(
  agentId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<string> {
  const token = generateToken();

  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    agentId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });

  return token;
}

/**
 * Resolves the current agent, or null. Joins against `agents` on every call so
 * that deactivating an agent takes effect immediately — the whole reason this is
 * a database session rather than a JWT.
 */
export async function getSessionAgent(): Promise<SessionAgent | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);

  // Together, not in sequence. The policy read has no dependency on the session
  // row and is needed either way, and this function runs on every page, every
  // action and every API route — a serial round trip here is one added to every
  // request in the console.
  const [rows, policy] = await Promise.all([
    db
      .select({
        id: agents.id,
        email: agents.email,
        name: agents.name,
        role: agents.role,
        permissions: agents.permissions,
        avatarUrl: agents.avatarUrl,
        isAcceptingTickets: agents.isAcceptingTickets,
        isActive: agents.isActive,
        lastUsedAt: sessions.lastUsedAt,
        lastActivityAt: sessions.lastActivityAt,
      })
      .from(sessions)
      .innerJoin(agents, eq(agents.id, sessions.agentId))
      .where(and(eq(sessions.tokenHash, tokenHash), liveSession()))
      .limit(1),
    loadPresencePolicy(),
  ]);

  const row = rows[0];
  if (!row || !row.isActive) return null;

  // Inactivity sign-out, enforced here because here is the one place every page
  // and every action already passes through. The browser counts down and signs
  // itself out politely, but a browser is a claim: a tab restored from history,
  // a second window nobody closed, or a script replaying the cookie would
  // otherwise keep a session that the policy says is over. This is the control;
  // the countdown is the courtesy.
  if (shouldSignOut(row, policy, new Date())) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }

  if (Date.now() - row.lastUsedAt.getTime() > REFRESH_AFTER_MS) {
    await db
      .update(sessions)
      .set({ lastUsedAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
      .where(eq(sessions.tokenHash, tokenHash));
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    permissions: row.permissions,
    avatarUrl: row.avatarUrl,
    isAcceptingTickets: row.isAcceptingTickets,
    // Never negative. A row written by an instance whose clock runs ahead of
    // this one's would otherwise read as idle for minus three minutes, and the
    // browser would subtract that into the future and never warn at all.
    sessionIdleForMs: Math.max(0, Date.now() - row.lastActivityAt.getTime()),
  };
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }
  store.delete(SESSION_COOKIE);
}

/** Sign the agent out everywhere — used on password change and offboarding. */
export async function destroyAllSessionsForAgent(agentId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.agentId, agentId));
}

/**
 * The current session's fingerprint, for callers that outlive the request.
 *
 * The presence stream is the one that needs it: it opens once, holds a
 * connection for hours, and cannot read a cookie again from inside its own
 * keepalive. Handing it the hash lets it re-check that the session still exists
 * without keeping anything a leak could replay — the hash is what the table
 * stores, and it cannot be turned back into a cookie.
 */
export async function currentSessionHash(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token ? hashToken(token) : null;
}

/** Whether a session is still present and unexpired. */
export async function sessionIsLive(tokenHash: string): Promise<boolean> {
  const rows = await db
    .select({ tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), liveSession()))
    .limit(1);

  return rows.length > 0;
}

/**
 * Mark that a human did something in this session.
 *
 * The only writer of `last_activity_at`, and deliberately not called from
 * anywhere on the ordinary request path — see the column's comment. It moves
 * only when the console reports real input.
 */
export async function touchSessionActivity(): Promise<void> {
  const tokenHash = await currentSessionHash();
  if (!tokenHash) return;

  await db
    .update(sessions)
    .set({ lastActivityAt: new Date() })
    .where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Sign out every session that has gone quiet for longer than the policy allows.
 *
 * The backstop to the check in `getSessionAgent`, which can only fire when a
 * request arrives: a console left open makes no requests, so without this the
 * abandoned tab keeps its session — and its presence stream, and its place in
 * the rota — until somebody touches it.
 *
 * Takes the cutoff rather than a window, because deciding *whether* the sweep
 * may run at all is `signOutCutoff`'s job — it is the one place that knows a
 * just-enabled window owes the fleet a grace period first.
 *
 * Returns the agents affected, because a signed-out session should not leave
 * its owner showing as online on the dashboard.
 */
export async function deleteSessionsIdleSince(cutoff: Date): Promise<string[]> {
  const deleted = await db
    .delete(sessions)
    // `lte`, matching `shouldSignOut`'s inclusive boundary — see the comment
    // there.
    .where(lte(sessions.lastActivityAt, cutoff))
    .returning({ agentId: sessions.agentId });

  return [...new Set(deleted.map((row) => row.agentId))];
}

/**
 * Which of these agents still have a session — asked once, not once each.
 *
 * `inArray`, not `any(...)` in a raw fragment: a JS array interpolated into
 * `any()` reaches Postgres as a row constructor and is refused outright
 * (docs/PROJECT-STATE.md §6.46). The two read identically, which is why it is
 * worth saying out loud at the one call site that wants a list.
 */
export async function agentsWithLiveSessions(agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();

  const rows = await db
    .selectDistinct({ agentId: sessions.agentId })
    .from(sessions)
    .where(and(inArray(sessions.agentId, agentIds), liveSession()));

  return new Set(rows.map((row) => row.agentId));
}

/** Called by the cleanup cron job. */
export async function deleteExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ tokenHash: sessions.tokenHash });
  return deleted.length;
}
