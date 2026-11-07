import { notFound, redirect } from 'next/navigation';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { isLocale, t } from '@/lib/kb/locale';
import { AccountLink, AccountShell } from '../shell';
import { LoginForm } from './form';

export const dynamic = 'force-dynamic';

export default async function PortalLoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string; reset?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const { next, reset } = await searchParams;

  // Already signed in as a customer: the sign-in page has nothing to offer.
  // Agents are deliberately not redirected — a colleague signing in to their
  // customer account here is a legitimate thing to want.
  if (await getSessionCustomer()) redirect(`/${locale}/portal`);

  return (
    <AccountShell
      title={t(locale, 'signInTitle')}
      intro={t(locale, 'signInIntro')}
      footer={
        // `justify-between`, not `ms-auto` on the second link: the two sit at
        // either end while they fit on one line, as they do on a desktop, and
        // each starts its own line once they wrap, as the English pair does in
        // a phone's 358px. `ms-auto` pushed the wrapped one to the far edge, a
        // staircase that read as misplaced.
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-2">
          <AccountLink locale={locale} path="forgot">
            {t(locale, 'forgotPassword')}
          </AccountLink>
          <span>
            {t(locale, 'noAccount')}{' '}
            <AccountLink locale={locale} path="register">
              {t(locale, 'createAccount')}
            </AccountLink>
          </span>
        </div>
      }
    >
      <LoginForm locale={locale} next={next} justReset={reset === '1'} />
    </AccountShell>
  );
}
