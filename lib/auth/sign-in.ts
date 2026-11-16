import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { createCustomerSession } from '@/lib/auth/customer-session';
import { authenticate } from '@/lib/auth/identity';
import { createSession } from '@/lib/auth/session';
import { allowEmailDispatch, allowLoginAttempt, clearLoginAttempts } from '@/lib/auth/throttle';
import { requestMeta } from '@/lib/http/request-meta';
import type { Locale } from '@/lib/kb/locale';
import { recordSignIn, requestPasswordReset } from '@/lib/portal/accounts';

/**
 * What a password sign-in came to, for the form that asked.
 *
 * `agent` and `customer` mean a session now exists for that population, and the
 * caller only has to decide where to send them.
 */
export type SignInOutcome = 'throttled' | 'invalid' | 'unverified' | 'agent' | 'customer';

/**
 * Whether the console is served on the host the form was posted to. Only the
 * help centre's form can be posted where it is not — on the hostname
 * `KB_PUBLIC_HOST` names — and only that form passes this.
 */
export type SignInPlace = { consoleServedHere: boolean };

/**
 * The sign-in both forms run: the console's and the help centre's.
 *
 * One sequence because both forms accept both populations — `authenticate`
 * says why — and two copies of it were two places for the order of these steps
 * to drift apart: the throttle before the password check, the attempts cleared
 * only once the password was right, a session only for an address that was
 * confirmed. What each form does with the outcome is not shared. The console
 * answers in English sentences and the help centre in string keys, and each
 * sends the person to a different place; those stay in the actions.
 *
 * `locale` is the language of the confirmation link re-sent to an address that
 * was never confirmed. Correct password, unconfirmed address: they have just
 * proved the account is theirs, and the first email is old by the time anyone
 * reads the refusal.
 *
 * `agent_elsewhere` is an agent's right password where no console is served:
 * the attempts are cleared, as for any right password, and no session is
 * started, because the session cookie is host-only and a console session on
 * the help centre's host opens nothing. Started there, the help centre's
 * sign-in sent the agent to `/inbox`, which a server action's redirect renders
 * in the same request without passing the proxy: the inbox drew on
 * support.shipblu.com, and every view, ticket and filter in it then answered
 * the help centre's 404 (2026-11-15). The overloads keep the outcome off the
 * console's form, which is only ever posted where the console is.
 */
export async function signInWithPassword(
  email: string,
  password: string,
  locale: Locale,
): Promise<SignInOutcome>;
export async function signInWithPassword(
  email: string,
  password: string,
  locale: Locale,
  place: SignInPlace,
): Promise<SignInOutcome | 'agent_elsewhere'>;
export async function signInWithPassword(
  email: string,
  password: string,
  locale: Locale,
  place: SignInPlace = { consoleServedHere: true },
): Promise<SignInOutcome | 'agent_elsewhere'> {
  const { ip, userAgent } = await requestMeta();
  if (!allowLoginAttempt(email, ip)) return 'throttled';

  const principal = await authenticate(email, password);

  if (principal.kind === 'invalid') return 'invalid';

  if (principal.kind === 'unverified') {
    if (allowEmailDispatch(email, ip)) await requestPasswordReset(email, locale);
    return 'unverified';
  }

  clearLoginAttempts(email, ip);

  if (principal.kind === 'customer') {
    await createCustomerSession(principal.identityId, { ip, userAgent });
    await recordSignIn(principal.identityId);
    return 'customer';
  }

  if (!place.consoleServedHere) return 'agent_elsewhere';

  await createSession(principal.agentId, { ip, userAgent });
  await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.id, principal.agentId));
  return 'agent';
}
