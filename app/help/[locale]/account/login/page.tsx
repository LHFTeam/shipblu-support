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
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <AccountLink locale={locale} path="forgot">
            {t(locale, 'forgotPassword')}
          </AccountLink>
          <span className="ms-auto">
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
