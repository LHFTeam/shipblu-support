'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, groupMembers, invites } from '@/db/schema';
import { createCustomerSession } from '@/lib/auth/customer-session';
import { needsBootstrap } from '@/lib/auth/guard';
import { authenticate } from '@/lib/auth/identity';
import { safePath } from '@/lib/auth/next-path';
import { normaliseEmail } from '@/lib/auth/normalise';
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { allowEmailDispatch, allowLoginAttempt, clearLoginAttempts } from '@/lib/auth/throttle';
import { hashToken } from '@/lib/auth/tokens';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';
import { recordSignIn, requestPasswordReset } from '@/lib/portal/accounts';

export type AuthFormState = { error: string | null };

async function requestMeta() {
  const headerList = await headers();
  return {
    ip:
      headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      headerList.get('x-real-ip') ??
      null,
    userAgent: headerList.get('user-agent'),
  };
}

export async function signIn(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const password = String(formData.get('password') ?? '');
  const next = safePath(formData.get('next'), '/inbox');

  if (!email || !password) return { error: 'Enter your email and password' };

  const { ip, userAgent } = await requestMeta();

  if (!allowLoginAttempt(email, ip)) {
    return { error: 'Too many attempts. Try again in a few minutes.' };
  }

  // The same check the help centre's Sign in runs. One form for both
  // populations means a customer who followed a link into the console — or who
  // simply knows this URL — is signed in and sent to their tickets, rather than
  // being told their own password is wrong.
  const principal = await authenticate(email, password);

  // One message for every failure mode. Distinguishing "no such account" from
  // "wrong password" tells an attacker which addresses are real.
  if (principal.kind === 'invalid') return { error: 'Email or password is incorrect' };

  if (principal.kind === 'unverified') {
    if (allowEmailDispatch(email, ip)) await requestPasswordReset(email, DEFAULT_LOCALE);
    return { error: 'Confirm your email address first — check your inbox for the link we sent.' };
  }

  clearLoginAttempts(email, ip);

  if (principal.kind === 'customer') {
    await createCustomerSession(principal.identityId, { ip, userAgent });
    await recordSignIn(principal.identityId);
    // `next` here is a console path — that is the only kind this page is
    // reached with — and a customer cannot use it.
    redirect(`/${DEFAULT_LOCALE}/portal`);
  }

  await createSession(principal.agentId, { ip, userAgent });
  await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.id, principal.agentId));

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

  const name = String(formData.get('name') ?? '').trim();
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
  const name = String(formData.get('name') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!token) return { error: 'This invite link is not valid' };

  const strength = validatePasswordStrength(password);
  if (!strength.ok) return { error: strength.reason };

  const rows = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.tokenHash, hashToken(token)),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const invite = rows[0];
  if (!invite) return { error: 'This invite has expired or has already been used' };

  const passwordHash = await hashPassword(password);

  const agentId = await db.transaction(async (tx) => {
    // Marking the invite accepted first, conditional on it still being open,
    // makes a double-submit lose here rather than creating two agents.
    const claimed = await tx
      .update(invites)
      .set({ acceptedAt: new Date() })
      .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)))
      .returning({ id: invites.id });

    if (claimed.length === 0) return null;

    const inserted = await tx
      .insert(agents)
      .values({
        name: name || invite.name || invite.email,
        email: invite.email,
        passwordHash,
        role: invite.role,
      })
      .onConflictDoUpdate({
        // An agent invited again after being deactivated keeps their history.
        target: agents.email,
        set: { passwordHash, isActive: true, role: invite.role },
      })
      .returning({ id: agents.id });

    const id = inserted[0]!.id;

    for (const groupId of invite.groupIds) {
      await tx.insert(groupMembers).values({ groupId, agentId: id }).onConflictDoNothing();
    }

    return id;
  });

  if (!agentId) return { error: 'This invite has already been used' };

  const { ip, userAgent } = await requestMeta();
  await createSession(agentId, { ip, userAgent });

  redirect('/inbox');
}
