import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { contactIdentities, contactTokens, contacts } from '@/db/schema';
import { destroyAllCustomerSessions } from '@/lib/auth/customer-session';
import { normaliseEmail } from '@/lib/auth/normalise';
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { enqueueNotificationEmail } from '@/lib/email/notify';
import type { Locale } from '@/lib/kb/locale';
import { resolveContact } from '@/lib/tickets/contacts';
import { passwordResetEmail, verificationEmail } from './emails';

/**
 * Customer portal accounts.
 *
 * A ShipBlu customer already exists in this database long before they ever
 * think about signing in — they emailed support, or messaged the WhatsApp
 * number, and `contact_identities` has held their address since. Registering is
 * therefore not "create a customer": it is attaching a password to an identity
 * we already have, which is what makes a customer's existing tickets appear the
 * first time they sign in rather than starting them at an empty list.
 *
 * The whole design rests on one rule: **an unverified identity cannot sign in.**
 * Anyone can type anyone's address into the form, so the password set here is
 * inert until somebody opens the link we send to that address.
 */

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Every entry point returns the same shape, and the success cases are
 * deliberately indistinguishable from "that address is not registered". A
 * support portal that says "no account with that email" is an address oracle
 * for a customer list that includes every merchant we work with.
 */
export type AccountRequestResult = { ok: true } | { ok: false; reason: 'weak_password' };

export async function requestAccount(input: {
  email: string;
  name: string | null;
  password: string;
  locale: Locale;
}): Promise<AccountRequestResult> {
  const email = normaliseEmail(input.email);
  const strength = validatePasswordStrength(input.password);
  if (!strength.ok) return { ok: false, reason: 'weak_password' };

  const passwordHash = await hashPassword(input.password);

  // Links to whatever history this address already has: tickets, WhatsApp
  // chats merged onto the same contact, a company matched by email domain.
  const { contactId } = await resolveContact({
    channel: 'email',
    identifier: email,
    displayName: input.name,
  });

  const rows = await db
    .select({
      id: contactIdentities.id,
      isVerified: contactIdentities.isVerified,
      isBlocked: contacts.isBlocked,
      contactName: contacts.name,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(and(eq(contactIdentities.channel, 'email'), eq(contactIdentities.identifier, email)))
    .limit(1);

  const identity = rows[0];
  // resolveContact just guaranteed this row, and a blocked contact is dropped
  // silently — telling a blocked address why would be the one useful reply.
  if (!identity || identity.isBlocked) return { ok: true };

  if (identity.isVerified) {
    // The address is already somebody's confirmed account. Overwriting the
    // password here is account takeover by re-registration, so the request is
    // answered with a reset link to the address itself instead: harmless if it
    // was the owner who forgot they had an account, useless to anybody else.
    await issueToken(identity.id, 'reset_password', RESET_TTL_MS, email, input.locale);
    return { ok: true };
  }

  // Unverified: the pending password is replaced outright. Whoever holds the
  // mailbox is the only one who can act on it, so the last submission winning
  // costs nothing — and it is what lets the real owner take over an address
  // somebody else typed into the form first.
  await db
    .update(contactIdentities)
    .set({ passwordHash, passwordSetAt: new Date() })
    .where(eq(contactIdentities.id, identity.id));

  if (input.name && !identity.contactName) {
    await db.update(contacts).set({ name: input.name }).where(eq(contacts.id, contactId));
  }

  await issueToken(identity.id, 'verify_email', VERIFY_TTL_MS, email, input.locale);
  return { ok: true };
}

/** Always reports success: see the note on AccountRequestResult. */
export async function requestPasswordReset(rawEmail: string, locale: Locale): Promise<void> {
  const email = normaliseEmail(rawEmail);
  if (!email) return;

  const rows = await db
    .select({
      id: contactIdentities.id,
      isVerified: contactIdentities.isVerified,
      passwordHash: contactIdentities.passwordHash,
      isBlocked: contacts.isBlocked,
      deletedAt: contacts.deletedAt,
    })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(and(eq(contactIdentities.channel, 'email'), eq(contactIdentities.identifier, email)))
    .limit(1);

  const identity = rows[0];
  if (!identity || identity.isBlocked || identity.deletedAt) return;

  // No account here yet, only a contact we have emailed before. Sending a reset
  // link would create an account nobody asked for, so this stays silent.
  if (!identity.passwordHash) return;

  // A password set but never confirmed: the useful link is the confirmation
  // one, not a reset. Otherwise the reset completes, the identity is still
  // unverified, and sign-in keeps refusing with no way out.
  const purpose = identity.isVerified ? 'reset_password' : 'verify_email';
  const ttl = identity.isVerified ? RESET_TTL_MS : VERIFY_TTL_MS;
  await issueToken(identity.id, purpose, ttl, email, locale);
}

export type RedeemResult = { ok: true; identityId: string } | { ok: false };

/**
 * Confirms an address.
 *
 * Marking the identity verified is the moment the pending password becomes
 * usable — and the moment the contact record is known to belong to the person
 * holding the mailbox.
 *
 * A spent token whose identity is already verified reports success rather than
 * failure. Corporate mail scanners follow every link in an inbound email before
 * the recipient sees it, so the first request is often a machine's; refusing the
 * human's click afterwards would break verification for exactly the customers
 * whose employers filter their mail. Replay is harmless here in a way it is not
 * for a reset link: this token grants no session and no password change, only a
 * flag that is already set.
 */
export async function redeemVerification(token: string): Promise<RedeemResult> {
  const claimed = await claimToken(token, 'verify_email');

  if (claimed) {
    await db
      .update(contactIdentities)
      .set({ isVerified: true })
      .where(eq(contactIdentities.id, claimed));

    return { ok: true, identityId: claimed };
  }

  const rows = await db
    .select({ identityId: contactTokens.identityId, isVerified: contactIdentities.isVerified })
    .from(contactTokens)
    .innerJoin(contactIdentities, eq(contactIdentities.id, contactTokens.identityId))
    .where(
      and(eq(contactTokens.tokenHash, hashToken(token)), eq(contactTokens.purpose, 'verify_email')),
    )
    .limit(1);

  const already = rows[0];
  return already?.isVerified ? { ok: true, identityId: already.identityId } : { ok: false };
}

/** Checks a reset link without spending it, so the form can render. */
export async function resetTokenIsLive(token: string): Promise<boolean> {
  const rows = await db
    .select({ identityId: contactTokens.identityId })
    .from(contactTokens)
    .where(
      and(
        eq(contactTokens.tokenHash, hashToken(token)),
        eq(contactTokens.purpose, 'reset_password'),
        isNull(contactTokens.usedAt),
        gt(contactTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export type ResetResult = { ok: true } | { ok: false; reason: 'weak_password' | 'bad_token' };

export async function completePasswordReset(token: string, password: string): Promise<ResetResult> {
  const strength = validatePasswordStrength(password);
  // Checked before the token is spent, so a password the form rejects does not
  // also burn the only link the customer has.
  if (!strength.ok) return { ok: false, reason: 'weak_password' };

  const identityId = await claimToken(token, 'reset_password');
  if (!identityId) return { ok: false, reason: 'bad_token' };

  const passwordHash = await hashPassword(password);

  await db
    .update(contactIdentities)
    .set({
      passwordHash,
      passwordSetAt: new Date(),
      // Redeeming a link sent to the address proves control of it just as the
      // verification link does, so an account stuck unverified is unstuck here.
      isVerified: true,
    })
    .where(eq(contactIdentities.id, identityId));

  // Whoever knew the old password is signed out everywhere. A reset is what
  // somebody does when they suspect the answer is "not me".
  await destroyAllCustomerSessions(identityId);

  return { ok: true };
}

export async function recordSignIn(identityId: string): Promise<void> {
  await db
    .update(contactIdentities)
    .set({ lastSignInAt: new Date() })
    .where(eq(contactIdentities.id, identityId));
}

/**
 * Issues a single-use link and queues the email carrying it.
 *
 * Any earlier unspent token for the same purpose is deleted first: a customer
 * who presses the button three times should find that the newest link is the
 * one that works, rather than three live links of which two are forgeries
 * waiting in an inbox somebody else may later read.
 */
async function issueToken(
  identityId: string,
  purpose: 'verify_email' | 'reset_password',
  ttlMs: number,
  email: string,
  locale: Locale,
): Promise<void> {
  const token = generateToken();

  await db
    .delete(contactTokens)
    .where(
      and(
        eq(contactTokens.identityId, identityId),
        eq(contactTokens.purpose, purpose),
        isNull(contactTokens.usedAt),
      ),
    );

  await db.insert(contactTokens).values({
    tokenHash: hashToken(token),
    identityId,
    purpose,
    expiresAt: new Date(Date.now() + ttlMs),
  });

  const body =
    purpose === 'verify_email'
      ? verificationEmail(locale, token)
      : passwordResetEmail(locale, token);

  await enqueueNotificationEmail({ to: email, ...body });
}

/**
 * Spends a token, returning the identity it belonged to.
 *
 * The update is conditional on the token still being unused, so two clicks on
 * the same link — a mail client prefetching it, then the person — resolve to
 * one redemption and the second reports failure rather than acting twice.
 */
async function claimToken(
  token: string,
  purpose: 'verify_email' | 'reset_password',
): Promise<string | null> {
  const claimed = await db
    .update(contactTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(contactTokens.tokenHash, hashToken(token)),
        eq(contactTokens.purpose, purpose),
        isNull(contactTokens.usedAt),
        gt(contactTokens.expiresAt, new Date()),
      ),
    )
    .returning({ identityId: contactTokens.identityId });

  return claimed[0]?.identityId ?? null;
}

/** Called by the cleanup cron job. */
export async function deleteExpiredContactTokens(): Promise<number> {
  const deleted = await db
    .delete(contactTokens)
    .where(lt(contactTokens.expiresAt, new Date()))
    .returning({ tokenHash: contactTokens.tokenHash });
  return deleted.length;
}
