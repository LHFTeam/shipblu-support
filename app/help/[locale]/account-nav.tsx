import Link from 'next/link';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { t, type Locale } from '@/lib/kb/locale';
import { portalSignOut } from './account/actions';

/**
 * The one Sign in link, in the help centre header.
 *
 * Rendered on the server on every request — the header is the only place that
 * tells a customer whether they are signed in, and a cached "Sign in" shown to
 * somebody who is (or the reverse) is worse than no link at all.
 *
 * Text rather than a button: the filled button beside it in the header is the
 * page's one call to action, and two solid buttons side by side leave a reader
 * with no idea which is the thing to press.
 */
export async function AccountNav({ locale }: { locale: Locale }) {
  const customer = await getSessionCustomer();

  if (!customer) {
    return (
      <Link
        href={`/${locale}/account/login`}
        className="font-medium text-[var(--kb-heading)] underline-offset-4 hover:underline"
      >
        {t(locale, 'signIn')}
      </Link>
    );
  }

  return (
    <span className="flex items-center gap-4">
      <Link
        href={`/${locale}/portal`}
        className="font-medium text-[var(--kb-heading)] underline-offset-4 hover:underline"
      >
        {t(locale, 'myTickets')}
      </Link>
      <form action={portalSignOut}>
        <input type="hidden" name="locale" value={locale} />
        <button
          type="submit"
          className="text-[var(--kb-muted)] underline-offset-4 hover:text-[var(--kb-heading)] hover:underline"
        >
          {t(locale, 'signOut')}
        </button>
      </form>
    </span>
  );
}
