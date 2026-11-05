import Link from 'next/link';
import { buttonClass } from '@/components/ui';
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
 * A secondary button, as the design draws it, at the end of the header: an
 * outline rather than a fill, because the filled blue belongs to whatever the
 * page itself is asking the reader to do, and a header with a solid button in it
 * competes with every page it sits on.
 */
export async function AccountNav({ locale }: { locale: Locale }) {
  const customer = await getSessionCustomer();

  if (!customer) {
    return (
      <Link href={`/${locale}/account/login`} className={buttonClass({ variant: 'secondary' })}>
        {t(locale, 'signIn')}
      </Link>
    );
  }

  return (
    <span className="flex items-center gap-4">
      <Link href={`/${locale}/portal`} className={buttonClass({ variant: 'secondary' })}>
        {t(locale, 'myTickets')}
      </Link>
      <form action={portalSignOut}>
        <input type="hidden" name="locale" value={locale} />
        <button
          type="submit"
          className="text-(--color-text-secondary) underline-offset-4 hover:text-(--color-text-primary) hover:underline"
        >
          {t(locale, 'signOut')}
        </button>
      </form>
    </span>
  );
}
