import Link from 'next/link';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { t, type Locale } from '@/lib/kb/locale';
import { portalSignOut } from './account/actions';

/**
 * The one Sign in button, in the help centre header.
 *
 * Rendered on the server on every request — the header is the only place that
 * tells a customer whether they are signed in, and a cached "Sign in" shown to
 * somebody who is (or the reverse) is worse than no button at all.
 */
export async function AccountNav({ locale }: { locale: Locale }) {
  const customer = await getSessionCustomer();

  if (!customer) {
    return (
      <Link
        href={`/${locale}/account/login`}
        className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium transition-colors hover:bg-[var(--muted)]"
      >
        {t(locale, 'signIn')}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      <Link href={`/${locale}/portal`} className="font-medium hover:underline">
        {t(locale, 'myTickets')}
      </Link>
      <form action={portalSignOut}>
        <input type="hidden" name="locale" value={locale} />
        <button type="submit" className="opacity-60 hover:opacity-100">
          {t(locale, 'signOut')}
        </button>
      </form>
    </div>
  );
}
