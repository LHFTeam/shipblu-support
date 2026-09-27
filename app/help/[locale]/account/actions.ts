'use server';

import { redirect } from 'next/navigation';
import { localeOf, text } from '@/lib/http/form-data';
import { requestMeta } from '@/lib/http/request-meta';
import { signInWithPassword } from '@/lib/auth/sign-in';
import { destroyCustomerSession } from '@/lib/auth/customer-session';
import { customerPath, safePath } from '@/lib/auth/next-path';
import { normaliseEmail } from '@/lib/auth/normalise';
import { allowEmailDispatch } from '@/lib/auth/throttle';
import { type Locale, type StringKey } from '@/lib/kb/locale';
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

  const outcome = await signInWithPassword(email, password, locale);

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
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'errorInvalidEmail' };
  if (password.length > 200) return { error: 'errorPasswordLong' };

  const { ip } = await requestMeta();
  // Reported as success. Telling a script it was throttled tells it the address
  // was worth throttling, and the customer sees the same page either way.
  if (!allowEmailDispatch(email, ip)) return { error: null, done: true };

  const result = await requestAccount({ email, name: name || null, password, locale });
  if (!result.ok) return { error: 'errorPasswordShort' };

  return { error: null, done: true };
}

export async function portalForgotPassword(
  _state: PortalFormState,
  formData: FormData,
): Promise<PortalFormState> {
  const locale = localeOf(formData);
  const email = normaliseEmail(String(formData.get('email') ?? ''));

  if (!email) return { error: 'errorMissingFields' };

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
