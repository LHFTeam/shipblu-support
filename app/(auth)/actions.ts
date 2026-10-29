'use server';

import { redirect } from 'next/navigation';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, invites } from '@/db/schema';
import { lockAddress } from '@/lib/admin/agent-profile';
import { joinGroups } from '@/lib/admin/group-members';
import { needsBootstrap } from '@/lib/auth/guard';
import { safePath } from '@/lib/auth/next-path';
import { normaliseEmail } from '@/lib/auth/normalise';
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';
import { text } from '@/lib/http/form-data';
import { requestMeta } from '@/lib/http/request-meta';
import { findOpenInvite } from '@/lib/auth/invites';
import { signInWithPassword } from '@/lib/auth/sign-in';

export type AuthFormState = { error: string | null };

export async function signIn(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const password = String(formData.get('password') ?? '');
  const next = safePath(formData.get('next'), '/inbox');

  if (!email || !password) return { error: 'Enter your email and password' };

  // The same sign-in the help centre's form runs. One form for both
  // populations means a customer who followed a link into the console — or who
  // simply knows this URL — is signed in and sent to their tickets, rather than
  // being told their own password is wrong.
  const outcome = await signInWithPassword(email, password, DEFAULT_LOCALE);

  if (outcome === 'throttled') return { error: 'Too many attempts. Try again in a few minutes.' };

  // One message for every failure mode. Distinguishing "no such account" from
  // "wrong password" tells an attacker which addresses are real.
  if (outcome === 'invalid') return { error: 'Email or password is incorrect' };

  if (outcome === 'unverified') {
    return { error: 'Confirm your email address first — check your inbox for the link we sent.' };
  }

  if (outcome === 'customer') {
    // `next` here is a console path — that is the only kind this page is
    // reached with — and a customer cannot use it.
    redirect(`/${DEFAULT_LOCALE}/portal`);
  }

  redirect(next);
}

/**
 * One-time first-admin creation.
 *
 * Re-checks `needsBootstrap()` inside the action, not just when rendering the
 * page: otherwise anyone who kept the form open — or replayed the POST — could
 * create a second admin after the first one existed.
 */
export async function bootstrapAdmin(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  if (!(await needsBootstrap())) {
    return { error: 'Setup has already been completed. Sign in instead.' };
  }

  const name = text(formData, 'name');
  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const password = String(formData.get('password') ?? '');

  if (!name || !email) return { error: 'Enter your name and email' };

  const strength = validatePasswordStrength(password);
  if (!strength.ok) return { error: strength.reason };

  const passwordHash = await hashPassword(password);

  const inserted = await db
    .insert(agents)
    .values({ name, email, passwordHash, role: 'account_admin' })
    // Loses the race rather than throwing a unique-violation page at whoever
    // submitted second.
    .onConflictDoNothing({ target: agents.email })
    .returning({ id: agents.id });

  if (!inserted[0]) return { error: 'That email is already registered. Sign in instead.' };

  const { ip, userAgent } = await requestMeta();
  await createSession(inserted[0].id, { ip, userAgent });

  redirect('/inbox');
}

export async function acceptInvite(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const token = String(formData.get('token') ?? '');
  const name = text(formData, 'name');
  const password = String(formData.get('password') ?? '');

  if (!token) return { error: 'This invite link is not valid' };

  const strength = validatePasswordStrength(password);
  if (!strength.ok) return { error: strength.reason };

  const invite = await findOpenInvite(token, new Date());
  if (!invite) return { error: 'This invite has expired or has already been used' };

  const passwordHash = await hashPassword(password);
  const agentName = name || invite.name;

  let agentId: string | null;
  try {
    agentId = await db.transaction(async (tx) => {
      // Under the address's lock, taken by the agent editor too
      // (`lockAddress`): an admin moving an existing agent onto this address
      // while the password above was hashing is either finished, and refused
      // below, or waits for this and finds the address taken.
      await lockAddress(tx, invite.email);

      // Marking the invite accepted first, conditional on it still being open,
      // makes a double-submit lose here rather than creating two agents. Open
      // includes unexpired: the editor treats a lapsed invite as harmless, so
      // one that lapses while the password hashes must not still be accepted.
      const now = new Date();
      const claimed = await tx
        .update(invites)
        // The recoverable copy has served its only purpose once the invite leaves
        // the pending list. The hash remains as the audit-safe record of which
        // one-time token was accepted.
        .set({ acceptedAt: now, tokenCiphertext: null })
        .where(
          and(eq(invites.id, invite.id), isNull(invites.acceptedAt), gt(invites.expiresAt, now)),
        )
        .returning({ id: invites.id });

      if (claimed.length === 0) return null;

      const inserted = await tx
        .insert(agents)
        .values({
          // Two names, no third fallback: what they typed on the activation page,
          // or the one the invite was raised with. `invites.name` is NOT NULL, so
          // the old `|| invite.email` could no longer fire — and an agent record
          // named after an email address was never an answer anybody wanted.
          name: agentName,
          email: invite.email,
          passwordHash,
          role: invite.role,
        })
        .onConflictDoUpdate({
          // An agent invited again after being deactivated keeps their history.
          target: agents.email,
          // `name` included deliberately. The activation page invites them to
          // correct it — "the one moment somebody can correct a misspelling of
          // their own name is before the account carries it into every ticket
          // they ever answer" — and leaving it out of the update is precisely the
          // case where that promise would be broken instead of kept.
          set: { name: agentName, passwordHash, isActive: true, role: invite.role },
          // Only a deactivated one. An active agent holding the address got it
          // after this invite was sent — `createInvite` refuses an address
          // somebody holds — and overwriting their password would hand whoever
          // has this link their account.
          setWhere: eq(agents.isActive, false),
        })
        .returning({ id: agents.id });

      const id = inserted[0]?.id;
      // Thrown rather than returned, so the claim above is undone with the rest:
      // the invite stays as it was, for an admin to see on the pending list.
      if (!id) throw new AddressHeld();

      await joinGroups(tx, id, invite.groupIds);

      return id;
    });
  } catch (error) {
    if (error instanceof AddressHeld) {
      return { error: 'Somebody already signs in with this address. Ask for a new invite.' };
    }
    throw error;
  }

  if (!agentId) return { error: 'This invite has expired or has already been used' };

  const { ip, userAgent } = await requestMeta();
  await createSession(agentId, { ip, userAgent });

  redirect('/inbox');
}

/** An active agent holds the invite's address; see `acceptInvite`. */
class AddressHeld extends Error {}
