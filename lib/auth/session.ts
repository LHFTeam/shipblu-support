import { cookies } from 'next/headers';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, sessions } from '@/db/schema';
import { generateToken, hashToken } from './tokens';

export const SESSION_COOKIE = 'shipblu_session';

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

  const rows = await db
    .select({
      id: agents.id,
      email: agents.email,
      name: agents.name,
      role: agents.role,
      permissions: agents.permissions,
      avatarUrl: agents.avatarUrl,
      isActive: agents.isActive,
      lastUsedAt: sessions.lastUsedAt,
    })
    .from(sessions)
    .innerJoin(agents, eq(agents.id, sessions.agentId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) return null;

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

/** Called by the cleanup cron job. */
export async function deleteExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ tokenHash: sessions.tokenHash });
  return deleted.length;
}
