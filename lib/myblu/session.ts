import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { cache } from 'react';
import { db } from '@/db/client';
import { channels, contactIdentities, contacts, mobileSessions } from '@/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import type { HoursConfig } from '@/lib/hours';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { groupHours } from '@/lib/hours/resolve';
import { linkIdentity, resolveContact } from '@/lib/tickets/contacts';
import type { ResolvedIdentity } from './identity';

/**
 * Sessions for the myBlu app's support chat.
 *
 * The token is a bearer credential the app keeps in secure storage, and only its
 * SHA-256 is stored — the same rule as every other credential in this system.
 * What is different from the widget's visitor token is that this one **rotates**,
 * which is why identity is not keyed on it: see `contactFor` below.
 */

/**
 * Seven days, sliding.
 *
 * Not the agent console's thirty and not the portal's fourteen. Those are
 * calibrated for how personal the device is, and a phone is the most personal
 * of the three — so on that axis alone this could be the longest. It is the
 * shortest for a different reason: **this system cannot observe a myBlu-side
 * logout or a platform token revocation.** The app calls `DELETE /session` on
 * the one logout it performs itself, and everything else — a revoked platform
 * token, a phone sold on, a reinstall that never signs out — propagates only
 * when the session expires. Seven days is how long that window is allowed to
 * be. A daily user slides it forward and never re-handshakes.
 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Rewrite the row at most once an hour, so a poll is not a write per request. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

export type MobileSession = {
  contactId: string;
  verified: boolean;
  locale: string | null;
};

/**
 * Which contact a handshake belongs to, and whether this is a new device.
 *
 * Two paths, and which one runs is decided entirely by whether anybody who may
 * assert an identity did so.
 *
 * **Platform-asserted (`identity.subject` is set).** `resolveContact` on the
 * asserted value, which threads the app onto the contact that person's WhatsApp
 * or email history already hangs off. A phone goes in as a `whatsapp` identity
 * rather than under a channel of its own: same string, same normalisation, and
 * it is the *only* value that makes the two one customer. A separate `mobile`
 * phone identity would guarantee two identities for one number and defeat the
 * point — and `normaliseIdentifier` phone-normalises for `whatsapp` alone, so a
 * number filed anywhere else keeps its `+` and never joins.
 *
 * **Nobody asserted anything.** The session is device-scoped: a `mobile`
 * identity on the SHA-256 of the install id, adopting nothing. The claimed
 * phone still reaches `contacts.primary_phone` through `decorate` below, which
 * is what surfaces the person as a merge candidate for an agent to confirm —
 * the same trade-off `lib/widget/conversation.ts` reasons through for the
 * out-of-hours form, in the same country, against the same mistyped-number
 * failure mode. Unification becomes an agent's decision rather than a thing a
 * request can cause.
 *
 * The install id is the key rather than the session token because the token
 * rotates: keying on it would mint a fresh contact on every re-handshake and
 * strand the previous session's tickets on the previous contact.
 */
export async function contactFor(identity: ResolvedIdentity, installId: string): Promise<string> {
  if (identity.subject) {
    const resolved = identity.phone
      ? await resolveContact({
          channel: 'whatsapp',
          identifier: identity.phone,
          displayName: identity.name,
        })
      : await resolveContact({
          channel: 'email',
          identifier: identity.email!,
          displayName: identity.name,
        });

    // The app's own identity alongside it, so a later handshake that arrives
    // with the platform unreachable still finds the same contact rather than
    // opening a second one. Safe here and only here: the contact was selected
    // by a value the platform asserted, not by the install id.
    await linkIdentity(resolved.contactId, {
      channel: 'mobile',
      identifier: hashToken(installId),
      displayName: identity.name,
    });

    return resolved.contactId;
  }

  const resolved = await resolveContact({
    channel: 'mobile',
    identifier: hashToken(installId),
    displayName: identity.name,
  });

  return resolved.contactId;
}

/**
 * Write what we were told onto the contact, without overwriting what we know.
 *
 * `applyVisitorIdentity`'s rules, and for its reasons: a field is filled **only
 * when empty**, because the value there may be one an agent corrected and a
 * handshake on every app launch must not undo that. The email gets an identity
 * row with `onConflictDoNothing` — an address that already belongs to somebody
 * stays with them, because merging two customers is an agent's decision.
 *
 * `primaryPhone` is written from an unverified claim deliberately. It is the
 * only thing `mergeCandidates` can match a device-scoped contact on — its
 * clauses are email, phone and name — so without it the person's real history
 * is invisible to the agent looking at their ticket. The exposure is the one
 * the widget's out-of-hours form already carries and is bounded the same way: a
 * suggestion an agent can decline, never a routing rule.
 */
export async function decorate(contactId: string, identity: ResolvedIdentity): Promise<void> {
  const rows = await db
    .select({
      name: contacts.name,
      primaryEmail: contacts.primaryEmail,
      primaryPhone: contacts.primaryPhone,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const contact = rows[0];
  if (!contact) return;

  const patch: Record<string, unknown> = {};
  if (!contact.name && identity.name) patch.name = identity.name;
  if (!contact.primaryEmail && identity.email) patch.primaryEmail = identity.email;
  if (!contact.primaryPhone && identity.phone) patch.primaryPhone = identity.phone;

  if (Object.keys(patch).length > 0) {
    await db.update(contacts).set(patch).where(eq(contacts.id, contactId));
  }

  if (identity.email) {
    await db
      .insert(contactIdentities)
      .values({
        contactId,
        channel: 'email',
        identifier: identity.email,
        displayName: identity.name,
      })
      .onConflictDoNothing({ target: [contactIdentities.channel, contactIdentities.identifier] });
  }
}

/**
 * Whether this install last belonged to somebody else.
 *
 * `applyVisitorIdentity`'s `'reset'` case, and the only thing standing between a
 * shared phone — or a second account on the same handset — and one person
 * opening the other's support history. A changed subject means the device is
 * now a different customer, so the caller starts a fresh session rather than
 * resuming: nothing is rewritten, and the previous contact keeps its tickets.
 *
 * A session whose subject was null is not evidence of anything, so it never
 * causes a reset: the device was anonymous then and the platform has named
 * somebody now, which is the ordinary upgrade rather than a change of person.
 */
export async function installChangedHands(
  installId: string,
  subject: string | null,
): Promise<boolean> {
  if (!subject) return false;

  const rows = await db
    .select({ subject: mobileSessions.subject })
    .from(mobileSessions)
    .where(
      and(eq(mobileSessions.app, 'myblu'), eq(mobileSessions.installIdHash, hashToken(installId))),
    )
    .orderBy(asc(mobileSessions.createdAt))
    .limit(20);

  return rows.some((row) => row.subject !== null && row.subject !== subject);
}

export type IssuedSession = { token: string; expiresAt: Date };

export async function issueSession(input: {
  contactId: string;
  installId: string;
  identity: ResolvedIdentity;
  locale: string | null;
  appVersion: string | null;
  platform: string | null;
}): Promise<IssuedSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(mobileSessions).values({
    tokenHash: hashToken(token),
    contactId: input.contactId,
    installIdHash: hashToken(input.installId),
    subject: input.identity.subject,
    verified: input.identity.verified,
    locale: input.locale,
    appVersion: input.appVersion,
    platform: input.platform,
    expiresAt,
  });

  return { token, expiresAt };
}

/**
 * The session behind a bearer, or null.
 *
 * `cache()` because a route handler reads it once to authorise and the modules
 * below it would otherwise read it again; one request, one lookup.
 *
 * The expiry is in the `where` clause rather than checked afterwards, so an
 * expired row is indistinguishable from no row at every call site — there is no
 * variant of this that returns a session and a flag for somebody to forget.
 */
export const resolveSession = cache(async (token: string): Promise<MobileSession | null> => {
  if (!token) return null;

  const tokenHash = hashToken(token);

  const rows = await db
    .select({
      contactId: mobileSessions.contactId,
      verified: mobileSessions.verified,
      locale: mobileSessions.locale,
      lastUsedAt: mobileSessions.lastUsedAt,
    })
    .from(mobileSessions)
    .where(and(eq(mobileSessions.tokenHash, tokenHash), gt(mobileSessions.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Slide it, but at most hourly. The app polls an open thread every few
  // seconds; a write per poll would make reading a conversation the most
  // write-heavy thing in the product.
  if (Date.now() - row.lastUsedAt.getTime() > REFRESH_AFTER_MS) {
    const now = new Date();
    await db
      .update(mobileSessions)
      .set({ lastUsedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(mobileSessions.tokenHash, tokenHash));
  }

  return { contactId: row.contactId, verified: row.verified, locale: row.locale };
});

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  await db.delete(mobileSessions).where(eq(mobileSessions.tokenHash, hashToken(token)));
}

/**
 * Swept nightly by `cleanup`, the same as the console's and the portal's.
 *
 * Expiry is already enforced in `resolveSession`'s `where`, so this is
 * retention rather than security — but an app session is a bearer credential,
 * and there is no reason to keep a dead one. It is also the row that carries the
 * subject, which names a customer.
 */
export async function deleteExpiredMobileSessions(): Promise<number> {
  const deleted = await db
    .delete(mobileSessions)
    .where(lt(mobileSessions.expiresAt, new Date()))
    .returning({ tokenHash: mobileSessions.tokenHash });
  return deleted.length;
}

/**
 * The configured `mobile` channel, for default routing and opening hours.
 *
 * Ordered oldest-first for the same reason `webchatChannel()` is: nothing stops
 * an admin adding a second row, and without an order Postgres may return either
 * — so the admin would configure one row while the API read the other.
 *
 * Null is a working state for the API and a misconfiguration for the team: a
 * ticket still opens, but with no group, so nothing routes it and auto-assignment
 * never sees it. `/admin` reports the missing row, the same way it reports a
 * skill no active agent holds.
 */
export const mobileChannel = cache(async () => {
  const rows = await db
    .select({ id: channels.id, defaultGroupId: channels.defaultGroupId, config: channels.config })
    .from(channels)
    .where(and(eq(channels.type, 'mobile'), eq(channels.isActive, true)))
    .orderBy(asc(channels.createdAt), asc(channels.id))
    .limit(1);

  return rows[0] ?? null;
});

/** The schedule the app's "we are here" is gated on. */
export async function mobileHours(): Promise<HoursConfig | null> {
  const [catalog, channel] = await Promise.all([loadHoursCatalog(), mobileChannel()]);
  return groupHours(catalog, channel?.defaultGroupId ?? null);
}
