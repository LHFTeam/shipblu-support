import { redirect } from 'next/navigation';
import { getSessionCustomer, type SessionCustomer } from '@/lib/auth/customer-session';
import type { Locale } from '@/lib/kb/locale';

/**
 * Access control for portal pages.
 *
 * The proxy cannot help here the way it does for the console: help-centre paths
 * are rewritten before the auth check and are public by design, so every portal
 * page calls this itself. It is the only control, which is why it re-reads the
 * session from the database rather than trusting the cookie's presence.
 */
export async function requireCustomer(locale: Locale, next?: string): Promise<SessionCustomer> {
  const customer = await getSessionCustomer();
  if (customer) return customer;

  const target = next ? `?next=${encodeURIComponent(next)}` : '';
  redirect(`/${locale}/account/login${target}`);
}
