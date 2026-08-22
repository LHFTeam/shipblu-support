import { cookies } from 'next/headers';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { contactIdentities, contactSessions, contacts } from '@/db/schema';
import { CUSTOMER_SESSION_COOKIE } from './cookie';
import { generateToken, hashToken } from './tokens';

export { CUSTOMER_SESSION_COOKIE };

/**
 * Sessions for the customer portal, mirroring `session.ts` for the console.
 *
 * Deliberately shorter-lived than an agent's thirty days. An agent's browser is
 * a work machine they sign into every morning; a customer checks a ticket from
 * whatever device is to hand, including shared ones, and a month-long cookie on
 * one of those is a month of somebody else reading their support history.
 */
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Only rewrite last_used_at/expiry once an hour, to avoid a write per request. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

export type SessionCustomer = {
  /** The verified email identity the person signed in with. */
  identityId: string;
  contactId: string;
  email: string;
  name: string | null;
  locale: string;
  /**
   * `contacts.company_id`, for the help centre's `selected_companies` articles.
   * Null is the normal case — most contacts belong to no company.
   */
  companyId: string | null;
};

export async function createCustomerSession(
  identityId: string,
  meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<string> {
  const token = generateToken();

  await db.insert(contactSessions).values({
    tokenHash: hashToken(token),
    identityId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
  });

  const store = await cookies();
  store.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });

  return token;
}

/**
 * Resolves the signed-in customer, or null.
 *
 * Re-checks `is_verified` and the presence of a password on every request, for
 * the same reason the agent version re-checks `is_active`: revoking portal
 * access has to take effect now, not whenever a cookie happens to expire. A
 * blocked contact is refused here too — the one place that cannot be forgotten.
 */
export async function getSessionCustomer(): Promise<SessionCustomer | null> {
  const store = await cookies();
  const token = store.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);

  const rows = await db
    .select({
      identityId: contactIdentities.id,
      contactId: contacts.id,
      email: contactIdentities.identifier,
      name: contacts.name,
      locale: contacts.locale,
      companyId: contacts.companyId,
      isVerified: contactIdentities.isVerified,
      passwordHash: contactIdentities.passwordHash,
      isBlocked: contacts.isBlocked,
      deletedAt: contacts.deletedAt,
      lastUsedAt: contactSessions.lastUsedAt,
    })
    .from(contactSessions)
    .innerJoin(contactIdentities, eq(contactIdentities.id, contactSessions.identityId))
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(and(eq(contactSessions.tokenHash, tokenHash), gt(contactSessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (!row.isVerified || !row.passwordHash || row.isBlocked || row.deletedAt) return null;

  if (Date.now() - row.lastUsedAt.getTime() > REFRESH_AFTER_MS) {
    await db
      .update(contactSessions)
      .set({ lastUsedAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
      .where(eq(contactSessions.tokenHash, tokenHash));
  }

  return {
    identityId: row.identityId,
    contactId: row.contactId,
    email: row.email,
    name: row.name,
    locale: row.locale,
    companyId: row.companyId,
  };
}

export async function destroyCustomerSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(CUSTOMER_SESSION_COOKIE)?.value;

  if (token) {
    await db.delete(contactSessions).where(eq(contactSessions.tokenHash, hashToken(token)));
  }
  store.delete(CUSTOMER_SESSION_COOKIE);
}

/** Sign the customer out everywhere — used after a password reset. */
export async function destroyAllCustomerSessions(identityId: string): Promise<void> {
  await db.delete(contactSessions).where(eq(contactSessions.identityId, identityId));
}

/** Called by the cleanup cron job, alongside the agent one. */
export async function deleteExpiredCustomerSessions(): Promise<number> {
  const deleted = await db
    .delete(contactSessions)
    .where(lt(contactSessions.expiresAt, new Date()))
    .returning({ tokenHash: contactSessions.tokenHash });
  return deleted.length;
}
