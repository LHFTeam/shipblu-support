'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, groupMembers, invites } from '@/db/schema';
import { needsBootstrap } from '@/lib/auth/guard';
import { normaliseEmail } from '@/lib/auth/normalise';
import { hashPassword, validatePasswordStrength, verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { allowLoginAttempt, clearLoginAttempts } from '@/lib/auth/throttle';
import { hashToken } from '@/lib/auth/tokens';

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

/** Redirect target, restricted to same-site paths so `next` cannot be an open redirect. */
function safeNext(next: FormDataEntryValue | null): string {
  const value = typeof next === 'string' ? next : '';
  if (!value.startsWith('/') || value.startsWith('//')) return '/inbox';
  return value;
}

export async function signIn(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const password = String(formData.get('password') ?? '');
  const next = safeNext(formData.get('next'));

  if (!email || !password) return { error: 'Enter your email and password' };

  const { ip, userAgent } = await requestMeta();

  if (!allowLoginAttempt(email, ip)) {
    return { error: 'Too many attempts. Try again in a few minutes.' };
  }

  const rows = await db
    .select({
      id: agents.id,
      passwordHash: agents.passwordHash,
      isActive: agents.isActive,
    })
    .from(agents)
    .where(eq(agents.email, email))
    .limit(1);

  const agent = rows[0];

  // One message for every failure mode. Distinguishing "no such agent" from
  // "wrong password" tells an attacker which addresses are real.
  const invalid = { error: 'Email or password is incorrect' };

  if (!agent?.passwordHash || !agent.isActive) {
    // Spend the same ~50ms an argon2 verify costs, so an absent or deactivated
    // account is not identifiable by how quickly the request comes back.
    // Hashing rather than verifying a dummy digest, because verify() rejects a
    // malformed hash immediately and would give the timing away.
    await hashPassword(password);
    return invalid;
  }

  if (!(await verifyPassword(agent.passwordHash, password))) return invalid;

  clearLoginAttempts(email, ip);
  await createSession(agent.id, { ip, userAgent });
  await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.id, agent.id));

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
