import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, extensionSessions } from '@/db/schema';
import { authenticate } from './identity';
import { allowLoginAttempt, clearLoginAttempts } from './throttle';
import { generateToken, hashToken } from './tokens';
import type { SessionAgent } from './session';

/**
 * Sessions for the WhatsApp Web extension: a bearer token rather than a cookie.
 *
 * The extension runs beside WhatsApp Web, not on our origin, so the console's
 * cookie would reach it only while a console tab kept that session alive — and
 * the console's inactivity sign-out would end it under an agent typing in
 * WhatsApp all day. `extensionSessions` in `db/schema/agents.ts` says why the
 * row lives in a table of its own.
 */

/** A week from sign-in, never extended — see `extensionSessions`. */
export const EXTENSION_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ExtensionSignIn =
  | { kind: 'throttled' }
  | { kind: 'invalid' }
  | { kind: 'signed_in'; token: string; expiresAt: Date; agentId: string };

/**
 * Email and password, agents only.
 *
 * `authenticate` answers for customers too, because the help centre's form
 * signs in both. A customer's correct password answers `invalid` here, as a
 * wrong one does: the extension has nothing to offer a customer, and a
 * different answer would tell whoever is guessing that the address has a portal
 * account. The attempts are cleared only for an agent, so a customer password
 * cannot be used to reset the throttle on an agent's address.
 */
export async function signInExtension(
  email: string,
  password: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<ExtensionSignIn> {
  if (!allowLoginAttempt(email, meta.ip)) return { kind: 'throttled' };

  const principal = await authenticate(email, password);
  if (principal.kind !== 'agent') return { kind: 'invalid' };

  clearLoginAttempts(email, meta.ip);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + EXTENSION_SESSION_TTL_MS);
  await db.insert(extensionSessions).values({
    tokenHash: hashToken(token),
    agentId: principal.agentId,
    expiresAt,
    userAgent: meta.userAgent,
    ip: meta.ip,
  });

  return { kind: 'signed_in', token, expiresAt, agentId: principal.agentId };
}

/**
 * The bearer token on a request, or null.
 *
 * Pure so the parsing can be tested without a database: the scheme is matched
 * case-insensitively, as RFC 9110 has it, and anything but exactly one token is
 * no token.
 */
export function bearerToken(header: string | null): string | null {
  const match = /^bearer\s+([A-Za-z0-9_-]+)\s*$/i.exec(header ?? '');
  return match?.[1] ?? null;
}

/**
 * The agent a request's bearer token belongs to, or null.
 *
 * Joins `agents` on every call so deactivation takes effect at once, as
 * `getSessionAgent` does. Answers a whole `SessionAgent` because every read
 * model the extension reuses — `loadConversation`, `conversationVisibility`,
 * `canSeeChannel` — takes one, and a narrower type would mean a second copy of
 * each. `sessionIdleForMs` is 0: it is the console's inactivity countdown, and
 * nothing here counts down.
 */
export async function extensionAgentFor(request: Request): Promise<SessionAgent | null> {
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return null;

  const rows = await db
    .select({
      id: agents.id,
      email: agents.email,
      name: agents.name,
      role: agents.role,
      permissions: agents.permissions,
      avatarUrl: agents.avatarUrl,
      avatarColor: agents.avatarColor,
      isAcceptingTickets: agents.isAcceptingTickets,
      acceptingOffReason: agents.acceptingOffReason,
    })
    .from(extensionSessions)
    .innerJoin(agents, eq(agents.id, extensionSessions.agentId))
    .where(
      and(
        eq(extensionSessions.tokenHash, hashToken(token)),
        gt(extensionSessions.expiresAt, new Date()),
        eq(agents.isActive, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  return row ? { ...row, sessionIdleForMs: 0 } : null;
}

/** Signing out of the extension. Answers whether a session was there to end. */
export async function destroyExtensionSession(request: Request): Promise<boolean> {
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return false;
  const deleted = await db
    .delete(extensionSessions)
    .where(eq(extensionSessions.tokenHash, hashToken(token)));
  return deleted.count > 0;
}

/** Called by the cleanup cron job, beside `deleteExpiredSessions`. */
export async function deleteExpiredExtensionSessions(): Promise<number> {
  const deleted = await db
    .delete(extensionSessions)
    .where(lt(extensionSessions.expiresAt, new Date()));
  return deleted.count;
}
