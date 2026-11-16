'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { localeOf, text } from '@/lib/http/form-data';
import { requestMeta } from '@/lib/http/request-meta';
import { signInWithPassword } from '@/lib/auth/sign-in';
import { destroyCustomerSession } from '@/lib/auth/customer-session';
import { customerPath, HELP_CENTRE_SIGN_IN, safePath } from '@/lib/auth/next-path';
import { looksLikeEmail, normaliseEmail } from '@/lib/auth/normalise';
import { allowEmailDispatch } from '@/lib/auth/throttle';
import { type Locale, type StringKey } from '@/lib/kb/locale';
import { consoleBaseUrl, isHelpCentreHost } from '@/lib/kb/site';
import { logger } from '@/lib/log';
import { completePasswordReset, requestAccount, requestPasswordReset } from '@/lib/portal/accounts';

/**
 * The help centre's sign-in, registration and password actions.
 *
 * Errors are returned as string *keys* rather than sentences: the form knows
 * which language it is rendering in and the action does not, and a server
 * action that returns English into an Arabic page is how half-translated
 * interfaces happen.
 */
export type PortalFormState = { error: StringKey | null; done?: boolean };

const log = logger('portal_sign_in');

function customerHome(locale: Locale): string {
  return `/${locale}/portal`;
}

export async function portalSignIn(
  _state: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const locale = localeOf(formData);
  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const password = String(formData.get('password') ?? '');

  if (!email || !password) return { error: 'errorMissingFields' };
  // No customer's account can stand on an address the send path refuses — it
  // could never have been verified — and every agent's address passed it when
  // the checks were made one, as every form that makes an agent now asks it.
  // So saying it is malformed gives nothing away, and it tells the one
  // customer whose registration was let through with one what to change,
  // where `errorUnverified` sent them to an inbox nothing reaches (§6.117).
  if (!looksLikeEmail(email)) return { error: 'errorInvalidEmail' };

  const consoleServedHere = !isHelpCentreHost((await headers()).get('host'));
  const outcome = await signInWithPassword(email, password, locale, { consoleServedHere });

  if (outcome === 'throttled') return { error: 'errorThrottled' };
  if (outcome === 'invalid') return { error: 'errorCredentials' };
  // The link was re-sent, in this page's language; see `signInWithPassword`.
  if (outcome === 'unverified') return { error: 'errorUnverified' };

  if (outcome === 'agent') {
    // Staff go to the console, wherever they pressed Sign in. The help centre is
    // not where an agent works, and landing them in the customer portal — which
    // their address may well have tickets in — reads as a broken login.
    redirect(safePath(formData.get('next'), '/inbox'));
  }

  if (outcome === 'agent_elsewhere') {
    // The same, on the help centre's own host, which serves no console: to the
    // console's sign-in on its own host, where the session can live. The agent
    // signs in once more there, and `from` has that page say why, so a second
    // password box reads as a change of address rather than a failed sign-in.
    const origin = consoleBaseUrl();
    if (!origin) {
      log.error('an agent signed in on the help-centre host, and APP_URL names no console');
      return { error: 'errorGeneric' };
    }
    const query = new URLSearchParams({
      next: safePath(formData.get('next'), '/inbox'),
      from: HELP_CENTRE_SIGN_IN,
    });
    redirect(`${origin}/login?${query.toString()}`);
  }

  redirect(customerPath(formData.get('next'), locale, customerHome(locale)));
}

export async function portalRegister(
  _state: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const locale = localeOf(formData);
  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const name = text(formData, 'name');
  const password = String(formData.get('password') ?? '');

  if (!email || !password) return { error: 'errorMissingFields' };
  // The check the verification email's job makes, not one of the form's own:
  // a looser regex here accepted two dots in a row, stored the account, said
  // a link was on its way, and the job refused the address (§6.117). Asked
  // before the throttle, so a typo is answered with a sentence rather than
  // the silent success a throttled request gets.
  if (!looksLikeEmail(email)) return { error: 'errorInvalidEmail' };
  if (password.length > 200) return { error: 'errorPasswordLong' };

  const { ip } = await requestMeta();
  // Reported as success. Telling a script it was throttled tells it the address
  // was worth throttling, and the customer sees the same page either way.
  if (!allowEmailDispatch(email, ip)) return { error: null, done: true };

  const result = await requestAccount({ email, name: name || null, password, locale });
  if (!result.ok) {
    return {
      error: result.reason === 'invalid_email' ? 'errorInvalidEmail' : 'errorPasswordShort',
    };
  }

  return { error: null, done: true };
}

export async function portalForgotPassword(
  _state: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const locale = localeOf(formData);
  const email = normaliseEmail(String(formData.get('email') ?? ''));

  if (!email) return { error: 'errorMissingFields' };
  // About the spelling alone, the same for every address, so it is no oracle;
  // without it a mistyped address read "check your inbox" with nothing sent.
  if (!looksLikeEmail(email)) return { error: 'errorInvalidEmail' };

  const { ip } = await requestMeta();
  if (allowEmailDispatch(email, ip)) {
    await requestPasswordReset(email, locale);
  }

  // Same answer whether or not the address has an account: see the note on
  // AccountRequestResult in lib/portal/accounts.ts.
  return { error: null, done: true };
}

export async function portalResetPassword(
  _state: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const locale = localeOf(formData);
  const token = String(formData.get('token') ?? '');
  const password = String(formData.get('password') ?? '');

  if (!token || !password) return { error: 'errorMissingFields' };
  if (password.length > 200) return { error: 'errorPasswordLong' };

  const result = await completePasswordReset(token, password);
  if (!result.ok) {
    return { error: result.reason === 'weak_password' ? 'errorPasswordShort' : 'errorGeneric' };
  }

  redirect(`/${locale}/account/login?reset=1`);
}

export async function portalSignOut(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  await destroyCustomerSession();
  redirect(`/${locale}`);
}
